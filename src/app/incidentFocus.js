import * as Cesium from 'cesium';
import { INCIDENT_KINDS } from '../incidents/model.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

/**
 * Taking the operator to an incident.
 *
 * Selecting an incident should answer "where is this and what do I know about
 * it" in one gesture, so this does three things in order: fly the camera there,
 * open the panel that holds the detail, and — for a weather hazard — ask the
 * risk engine about that exact point, because a hazard incident is about a
 * place the operator may not have analyzed yet.
 *
 * Altitude is chosen per kind rather than fixed. An earthquake is a regional
 * event and reads wrong from 8 km up; a fire cluster spans a few kilometres and
 * is invisible from 300. Neither number is a guess about the event — they are
 * framing choices about how much ground belongs in shot.
 */

/** How far out each kind of incident is framed, in metres. */
export const FOCUS_ALTITUDE = Object.freeze({
  [INCIDENT_KINDS.EARTHQUAKE]: 420_000,
  [INCIDENT_KINDS.FIRE]: 90_000,
  [INCIDENT_KINDS.WEATHER]: 160_000,
  [INCIDENT_KINDS.SCENARIO]: 900_000,
});

/** Default framing for an incident of unknown kind. */
export const DEFAULT_FOCUS_ALTITUDE = 250_000;

/** Flight duration, in seconds. */
const FLIGHT_SECONDS = 2.4;

/** Render-governor hold owner for an incident flight. */
const RENDER_HOLD_ID = 'incident-focus-flight';

/** The panel that holds the detail for each kind of incident. */
const PANEL_FOR_KIND = Object.freeze({
  [INCIDENT_KINDS.EARTHQUAKE]: 'quake-panel',
  [INCIDENT_KINDS.FIRE]: 'fire-panel',
  [INCIDENT_KINDS.WEATHER]: 'intelligence-panel',
});

/**
 * Fly to an incident and open what describes it.
 *
 * @param {object} input Input.
 * @param {object} input.incident The incident.
 * @param {object} input.viewer Cesium viewer.
 * @param {Function} [input.setPanelCollapsed] Panel disclosure control.
 * @param {Function} [input.analyzeAt] Weather analysis entry point.
 * @param {boolean} [input.flyCamera] Whether to fly the camera here.
 * @returns {boolean} Whether a flight was started.
 */
export function focusIncident({
  incident,
  viewer,
  setPanelCollapsed,
  analyzeAt,
  flyCamera = true,
}) {
  if (!incident) return false;

  // Open the panel first, so the detail is already there when the camera
  // arrives rather than appearing a beat later.
  const panelId = PANEL_FOR_KIND[incident.kind];
  if (panelId) setPanelCollapsed?.(panelId, false, { explicit: true });

  // A weather hazard is about a point, and the operator may never have asked
  // the engine about that point. Asking now is what makes the panel agree with
  // the row they just clicked.
  if (incident.kind === INCIDENT_KINDS.WEATHER && incident.location)
    void analyzeAt?.(incident.location.latitude, incident.location.longitude);

  const location = incident.location;
  // A reconstruction owns the camera for its whole run, so the caller turns
  // this off rather than having the two fight over the first two seconds.
  if (
    !flyCamera ||
    !location ||
    !Number.isFinite(location.latitude) ||
    !viewer?.camera
  )
    return false;

  const altitude = FOCUS_ALTITUDE[incident.kind] ?? DEFAULT_FOCUS_ALTITUDE;

  // Cesium advances a flight tween inside Scene.render(), and the governor
  // stops rendering when nothing asks for frames — an unheld flight would
  // simply never move. Released on arrival, on cancellation, and by a failsafe
  // so a superseded flight cannot pin the renderer on.
  let held = true;
  holdContinuousRender(RENDER_HOLD_ID);
  const release = () => {
    if (!held) return;
    held = false;
    releaseContinuousRender(RENDER_HOLD_ID);
  };

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      location.longitude,
      location.latitude,
      altitude,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-70),
      roll: 0,
    },
    duration: FLIGHT_SECONDS,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    complete: release,
    cancel: release,
  });
  setTimeout(release, (FLIGHT_SECONDS + 2) * 1000);
  return true;
}
