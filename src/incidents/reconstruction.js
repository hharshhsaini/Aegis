import { INCIDENT_KINDS } from './model.js';

/**
 * Turning a live incident into a phased reconstruction.
 *
 * Nepal is the reference: an authored sequence a person choreographed shot by
 * shot. A live earthquake arriving at 04:12 gets no author, so its
 * reconstruction is assembled here from the primitives in `animation.js` and
 * from what the incident record actually contains.
 *
 * The honesty constraint shapes the whole module. A reconstruction MUST NOT
 * imply that Aegis watched an event unfold. For almost every live incident,
 * Aegis received one observation after the fact — a USGS record, a FIRMS
 * cluster — and the phases below are an ANALYTICAL walk through that single
 * observation, not a replay of a progression anybody witnessed. So:
 *
 *  - every generated timeline is labelled RECONSTRUCTED FROM AVAILABLE
 *    OBSERVATIONS, and that label is part of the record rather than something
 *    the UI is trusted to add;
 *  - phase times are offsets into the walkthrough, never wall-clock claims
 *    about the event;
 *  - a phase whose data is missing is dropped, not filled. An earthquake with
 *    no depth gets no depth phase.
 *
 * Nepal keeps its authored sequence and is never routed through here.
 */

/** How a generated timeline must describe itself. */
export const RECONSTRUCTION_LABEL = 'RECONSTRUCTED FROM AVAILABLE OBSERVATIONS';

/** Seconds each generated phase holds before the next begins. */
export const PHASE_SECONDS = 4;

/**
 * Format an offset as the timeline's own clock.
 * @param {number} seconds Offset from the start of the walkthrough.
 * @returns {string} `MM:SS`.
 */
export function offsetLabel(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * Phases for an earthquake incident.
 *
 * @param {object} incident Incident record.
 * @returns {object[]} Phase descriptors.
 */
function earthquakePhases(incident) {
  const detail = incident.detail || {};
  const phases = [
    {
      id: 'signal',
      label: 'INITIAL SIGNAL',
      detail: `${incident.source} recorded ${incident.title}.`,
      camera: { altitude: 900_000, pitchDegrees: -80 },
      marks: ['pulse'],
    },
    {
      id: 'epicentre',
      label: 'EPICENTRE LOCATED',
      detail: incident.place
        ? `Epicentre at ${incident.place}.`
        : 'Epicentre located.',
      camera: { altitude: 380_000, pitchDegrees: -65 },
      marks: ['pulse'],
    },
  ];

  // Only claim an analysis radius when there is a magnitude to derive it from.
  if (Number.isFinite(detail.magnitude) || incident.severity > 0) {
    phases.push({
      id: 'context',
      label: 'GEOGRAPHIC ANALYSIS RADIUS',
      detail:
        'Radius shown for geographic context. It is not a measured impact boundary.',
      camera: { altitude: 520_000, pitchDegrees: -70 },
      marks: ['pulse', 'radius'],
    });
  }

  if (detail.alertLevel) {
    phases.push({
      id: 'alert',
      label: 'ALERT GRADING',
      detail: `${incident.source} alert level: ${detail.alertLevel}.`,
      camera: { altitude: 520_000, pitchDegrees: -70 },
      marks: ['pulse', 'radius'],
    });
  }

  phases.push({
    id: 'current',
    label: 'CURRENT STATUS',
    detail: incident.summary,
    camera: { altitude: 600_000, pitchDegrees: -75 },
    marks: ['pulse', 'radius'],
  });
  return phases;
}

/**
 * Phases for a fire incident.
 *
 * @param {object} incident Incident record.
 * @returns {object[]} Phase descriptors.
 */
function firePhases(incident) {
  const detail = incident.detail || {};
  const phases = [
    {
      id: 'signal',
      label: 'INITIAL SIGNAL',
      detail: `${incident.source} returned ${incident.title.toLowerCase()}.`,
      camera: { altitude: 300_000, pitchDegrees: -75 },
      marks: ['pulse'],
    },
    {
      id: 'detections',
      label: 'DETECTIONS PLOTTED',
      detail: incident.summary,
      camera: { altitude: 120_000, pitchDegrees: -65 },
      marks: ['pulse'],
    },
    {
      id: 'cluster',
      label: 'CLUSTER EXTENT',
      detail: incident.place
        ? `Detection span: ${incident.place}.`
        : 'Cluster extent shown.',
      camera: { altitude: 90_000, pitchDegrees: -60 },
      marks: ['pulse', 'radius'],
    },
  ];

  // The spread vector is weather-derived, so it only appears when the fire
  // engine actually scored conditions for this cluster.
  if (detail.spreadLevel) {
    phases.push({
      id: 'spread',
      label: 'MODELED POTENTIAL SPREAD',
      detail: `Spread conditions: ${detail.spreadLevel}. This describes weather favouring spread, not observed fire behaviour.`,
      camera: { altitude: 110_000, pitchDegrees: -55 },
      marks: ['pulse', 'radius', 'vector'],
    });
  }

  phases.push({
    id: 'current',
    label: 'CURRENT STATUS',
    detail: incident.summary,
    camera: { altitude: 140_000, pitchDegrees: -65 },
    marks: ['pulse', 'radius'],
  });
  return phases;
}

/**
 * Phases for a weather hazard incident.
 *
 * @param {object} incident Incident record.
 * @returns {object[]} Phase descriptors.
 */
function weatherPhases(incident) {
  return [
    {
      id: 'signal',
      label: 'HAZARD SIGNAL',
      detail: `${incident.title} scored ${incident.severity}/100 for this location.`,
      camera: { altitude: 400_000, pitchDegrees: -75 },
      marks: ['pulse'],
    },
    {
      id: 'analysis',
      label: 'CONDITIONS ANALYZED',
      detail: incident.summary,
      camera: { altitude: 200_000, pitchDegrees: -65 },
      marks: ['pulse', 'radius'],
    },
    {
      id: 'current',
      label: 'CURRENT STATUS',
      detail: `Scored from the current forecast for this point by ${incident.source}.`,
      camera: { altitude: 300_000, pitchDegrees: -70 },
      marks: ['pulse', 'radius'],
    },
  ];
}

/** The analysis radius drawn for each kind, in metres. */
const RADIUS_METRES = Object.freeze({
  [INCIDENT_KINDS.EARTHQUAKE]: 120_000,
  [INCIDENT_KINDS.FIRE]: 15_000,
  [INCIDENT_KINDS.WEATHER]: 40_000,
});

/**
 * Build a reconstruction plan for a live incident.
 *
 * Returns null for an authored scenario: Nepal has a director and a 25-shot
 * sequence, and replacing that with five generated phases would be a downgrade
 * dressed as consistency.
 *
 * @param {object} incident Incident record.
 * @returns {object|null} Frozen plan, or null when the incident is authored.
 */
export function buildReconstruction(incident) {
  if (!incident || !incident.live) return null;
  if (!incident.location) return null;

  const byKind = {
    [INCIDENT_KINDS.EARTHQUAKE]: earthquakePhases,
    [INCIDENT_KINDS.FIRE]: firePhases,
    [INCIDENT_KINDS.WEATHER]: weatherPhases,
  };
  const build = byKind[incident.kind];
  if (!build) return null;

  const phases = build(incident).map((phase, index) => ({
    ...phase,
    index,
    offsetSeconds: index * PHASE_SECONDS,
    offsetLabel: offsetLabel(index * PHASE_SECONDS),
  }));

  return Object.freeze({
    incidentId: incident.id,
    kind: incident.kind,
    title: incident.title,
    location: incident.location,
    radiusMetres: RADIUS_METRES[incident.kind] ?? 50_000,
    phases: Object.freeze(phases),
    durationSeconds: phases.length * PHASE_SECONDS,
    // Carried on the record, not left to the renderer to remember.
    provenance: RECONSTRUCTION_LABEL,
    // Single-observation incidents are the norm; saying so is what stops a
    // walkthrough being read as a replay of something Aegis watched happen.
    basis:
      'Assembled from the observations currently held for this incident. Phase times are positions in this walkthrough, not times at which anything was observed to occur.',
    source: incident.source,
  });
}
