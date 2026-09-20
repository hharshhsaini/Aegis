import * as Cesium from 'cesium';
import { buildReconstruction } from '../incidents/reconstruction.js';
import { INCIDENT_KINDS } from '../incidents/model.js';
import {
  cameraFlyTo,
  expandAffectedArea,
  pulsePoint,
  showDirectionVector,
  sleep,
} from '../incidents/animation.js';

/**
 * Playing a live incident's reconstruction.
 *
 * This is the live-data counterpart to the Nepal director: it walks the phases
 * that `reconstruction.js` generated, driving the camera and the overlays
 * through the shared primitives. Nepal keeps its own authored playback — this
 * never runs for it.
 *
 * Two behaviours are the point of the module rather than details of it:
 *
 *  1. ONE RUN AT A TIME, ALWAYS CLEANED UP. Starting a reconstruction stops any
 *     other, and every entity a run adds is removed when it ends — including
 *     when it ends by being superseded, cancelled, or thrown out of. Overlays
 *     that outlive their incident are how a console ends up drawing a boundary
 *     around something that stopped being true.
 *  2. CANCELLATION IS CHECKED, NOT ASSUMED. Each phase re-reads the token
 *     before it acts, so an operator who changes their mind mid-flight is not
 *     waiting out four more phases of something they have left.
 */

/** Accent per incident kind, matching the panels. */
const KIND_COLOR = Object.freeze({
  [INCIDENT_KINDS.EARTHQUAKE]: () => Cesium.Color.fromCssColorString('#c77dff'),
  [INCIDENT_KINDS.FIRE]: () => Cesium.Color.fromCssColorString('#ff8c42'),
  [INCIDENT_KINDS.WEATHER]: () => Cesium.Color.fromCssColorString('#00d4ff'),
});

/**
 * Create the reconstruction player.
 *
 * @param {object} input Input.
 * @param {object} input.viewer Cesium viewer.
 * @param {(state: object) => void} [input.onPhase] Called as each phase begins.
 * @returns {object} Frozen controller.
 */
export function createIncidentReconstruction({ viewer, onPhase }) {
  let token = null;
  let overlays = [];
  let plan = null;

  /** Remove everything the current run drew. */
  function clearOverlays() {
    for (const overlay of overlays) {
      try {
        overlay.remove();
      } catch {
        // A viewer torn down mid-run takes its entities with it.
      }
    }
    overlays = [];
  }

  /** Stop any run in progress and clean up after it. */
  function stop(reason = 'stopped') {
    if (token) token.cancelled = true;
    token = null;
    const finished = plan;
    plan = null;
    clearOverlays();
    viewer?.camera?.cancelFlight?.();
    if (finished)
      onPhase?.({
        status: 'STOPPED',
        reason,
        plan: finished,
        phase: null,
        index: -1,
      });
  }

  /**
   * Play an incident's reconstruction.
   *
   * @param {object} incident Incident record.
   * @returns {Promise<object|null>} The plan that ran, or null if none applied.
   */
  async function play(incident) {
    const next = buildReconstruction(incident);
    // An authored scenario, or an incident with no location, has no generated
    // reconstruction — and saying so beats inventing a generic one.
    if (!next) {
      stop('not-reconstructable');
      return null;
    }

    stop('superseded');
    const runToken = { cancelled: false };
    token = runToken;
    plan = next;

    const colorFor = KIND_COLOR[next.kind] || (() => Cesium.Color.ORANGE);
    const color = colorFor();
    const { latitude, longitude } = next.location;

    try {
      for (const phase of next.phases) {
        if (runToken.cancelled) break;
        onPhase?.({
          status: 'RUNNING',
          plan: next,
          phase,
          index: phase.index,
          total: next.phases.length,
        });

        await cameraFlyTo({
          viewer,
          latitude,
          longitude,
          altitude: phase.camera?.altitude ?? 300_000,
          pitchDegrees: phase.camera?.pitchDegrees ?? -70,
          durationSeconds: phase.index === 0 ? 2.4 : 1.6,
          token: runToken,
        });
        if (runToken.cancelled) break;

        // Marks are additive across phases: each phase declares everything that
        // should be on screen while it holds, and anything already drawn stays.
        if (
          phase.marks?.includes('pulse') &&
          !overlays.some((o) => o.kind === 'pulse')
        ) {
          const pulse = pulsePoint({
            viewer,
            latitude,
            longitude,
            color,
            label: next.title,
          });
          pulse.kind = 'pulse';
          overlays.push(pulse);
        }

        if (
          phase.marks?.includes('radius') &&
          !overlays.some((o) => o.kind === 'radius')
        ) {
          const area = await expandAffectedArea({
            viewer,
            latitude,
            longitude,
            radiusMetres: next.radiusMetres,
            color,
            token: runToken,
          });
          area.kind = 'radius';
          overlays.push(area);
        }

        if (
          phase.marks?.includes('vector') &&
          !overlays.some((o) => o.kind === 'vector')
        ) {
          const bearing = incident?.detail?.spreadBearingDegrees;
          if (Number.isFinite(bearing)) {
            const vector = showDirectionVector({
              viewer,
              latitude,
              longitude,
              bearingDegrees: bearing,
              lengthMetres: next.radiusMetres * 1.4,
              color,
            });
            vector.kind = 'vector';
            overlays.push(vector);
          }
        }

        if (runToken.cancelled) break;
        await sleep(1400, runToken);
      }

      if (!runToken.cancelled)
        onPhase?.({
          status: 'COMPLETE',
          plan: next,
          phase: next.phases[next.phases.length - 1] || null,
          index: next.phases.length - 1,
          total: next.phases.length,
        });
      return next;
    } finally {
      // Overlays outlive a completed run on purpose — the operator is now
      // looking at the incident and the marks are the context. A cancelled run
      // takes them with it, because the operator has moved on.
      if (runToken.cancelled) clearOverlays();
      if (token === runToken) token = null;
    }
  }

  return Object.freeze({
    play,
    stop,
    /** @returns {boolean} Whether a run is in progress. */
    isRunning: () => Boolean(token && !token.cancelled),
    /** @returns {object|null} The plan currently playing. */
    current: () => plan,
    destroy() {
      stop('destroyed');
    },
  });
}
