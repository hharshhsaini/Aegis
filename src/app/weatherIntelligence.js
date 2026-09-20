import * as Cesium from 'cesium';
import { createWeatherIntelligenceService } from '../data/weatherIntelligence.js';
import { createIntelligencePanel } from '../ui/intelligencePanel.js';
import { createRiskOverlay } from './riskOverlay.js';

/**
 * Wire the weather intelligence engine into the running application.
 *
 * Three rules shape this module, and all three are about not wasting calls:
 *
 *  1. Analysis follows an INTENT, not the camera. A click on the globe is a
 *     question about that place; a camera drifting during a flight is not. So
 *     clicks analyze immediately, while camera movement only re-analyzes after
 *     the camera has settled AND has actually moved to a different area.
 *  2. One location is active at a time. The panel and the overlay describe the
 *     same place, and polling refreshes that one place.
 *  3. Polling is slower than the data changes. Open-Meteo publishes hourly;
 *     asking every five minutes is already generous, and the service and proxy
 *     caches absorb anything more frequent.
 */

/** How often the active location is re-analyzed. */
const POLL_INTERVAL_MS = 5 * 60_000;

/** How often the panel's "updated" line is recomputed. */
const AGE_TICK_MS = 30_000;

/** Camera settle delay before a view-driven analysis is considered. */
const CAMERA_SETTLE_MS = 1_500;

/**
 * Minimum movement before the camera re-analyzes, in degrees (~15 km).
 *
 * Below this the answer would come from the same cached cell anyway; the check
 * simply avoids the round trip.
 */
const CAMERA_MOVE_DEGREES = 0.15;

/**
 * Resolve the geographic point at the centre of the current view.
 * @param {object} viewer Cesium viewer.
 * @returns {{latitude: number, longitude: number}|null} View centre, or null off-globe.
 */
export function pickGroundPoint(viewer, windowPosition) {
  const scene = viewer?.scene;
  const camera = scene?.camera;
  if (!camera || !windowPosition) return null;
  const ray = camera.getPickRay(windowPosition);
  // Terrain first, so a click in a valley analyzes the valley. `globe.pick`
  // reads RENDERED tiles, so it returns nothing while terrain is still
  // streaming — the ellipsoid fallback keeps early clicks working instead of
  // silently doing nothing.
  const position =
    (ray && scene.globe?.pick(ray, scene)) ||
    camera.pickEllipsoid(windowPosition, scene.globe?.ellipsoid);
  if (!position) return null;
  const carto = Cesium.Cartographic.fromCartesian(position);
  if (!carto) return null;
  return {
    latitude: Cesium.Math.toDegrees(carto.latitude),
    longitude: Cesium.Math.toDegrees(carto.longitude),
  };
}

export function viewCenter(viewer) {
  const scene = viewer?.scene;
  const camera = scene?.camera;
  if (!camera) return null;
  const center = pickGroundPoint(
    viewer,
    new Cesium.Cartesian2(
      Math.round(scene.canvas.clientWidth / 2),
      Math.round(scene.canvas.clientHeight / 2),
    ),
  );
  if (center) return center;
  // Looking at space past the limb: fall back to where the camera itself is,
  // which is still the area the operator is working in.
  const carto = camera.positionCartographic;
  if (!carto) return null;
  return {
    latitude: Cesium.Math.toDegrees(carto.latitude),
    longitude: Cesium.Math.toDegrees(carto.longitude),
  };
}

/**
 * Start weather intelligence for the application.
 *
 * @param {object} input Startup input.
 * @param {object} input.viewer Cesium viewer.
 * @param {object} input.requests Application request services.
 * @param {Document} [input.document] Document holding the panel markup.
 * @param {number} [input.pollIntervalMs] Refresh interval for the active location.
 * @returns {object} Controller with `analyzeAt`, `getActive` and `destroy`.
 */
export function startWeatherIntelligence({
  viewer,
  requests,
  document: doc = globalThis.document,
  pollIntervalMs = POLL_INTERVAL_MS,
}) {
  const transport = requests?.weatherIntelligence;
  if (!transport?.analyze)
    throw new TypeError('Weather intelligence request services are required');

  const service = createWeatherIntelligenceService({
    fetchAnalysis: (latitude, longitude, options) =>
      transport.analyze(latitude, longitude, options),
  });

  let active = null;
  let destroyed = false;

  const overlay = viewer ? createRiskOverlay({ viewer }) : null;
  const panel = createIntelligencePanel({
    document: doc,
    onRefresh: () => {
      if (active)
        void analyzeAt(active.latitude, active.longitude, { force: true });
    },
  });

  /**
   * Analyze one point and update every surface that describes it.
   * @param {number} latitude Degrees north.
   * @param {number} longitude Degrees east.
   * @param {object} [options] Options forwarded to the service.
   * @returns {Promise<object|null>} The service record.
   */
  async function analyzeAt(latitude, longitude, options = {}) {
    if (destroyed) return null;
    active = { latitude, longitude };
    panel?.setBusy(true);
    const record = await service.analyze(latitude, longitude, options);
    if (destroyed || !record) {
      panel?.setBusy(false);
      return record;
    }
    panel?.render(record);
    if (record.analysis) overlay?.show(record.analysis, record.point);
    return record;
  }

  // --- Map interaction ----------------------------------------------------
  let clickHandler = null;
  if (viewer?.scene?.canvas) {
    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((movement) => {
      const scene = viewer.scene;
      // A click that lands on an entity belongs to that entity's layer — it is
      // a selection, not a question about the ground. Analyzing it too would
      // hijack every aircraft and camera click in the application.
      if (scene.pick?.(movement.position)) return;
      const point = pickGroundPoint(viewer, movement.position);
      if (point) void analyzeAt(point.latitude, point.longitude);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  let settleTimer = null;
  const onCameraSettled = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (destroyed) return;
      const center = viewCenter(viewer);
      if (!center) return;
      // Only follow the camera once it has left the area already analyzed.
      if (
        active &&
        Math.abs(center.latitude - active.latitude) < CAMERA_MOVE_DEGREES &&
        Math.abs(center.longitude - active.longitude) < CAMERA_MOVE_DEGREES
      )
        return;
      void analyzeAt(center.latitude, center.longitude);
    }, CAMERA_SETTLE_MS);
  };
  const removeCameraListener =
    viewer?.camera?.moveEnd?.addEventListener?.(onCameraSettled) || null;

  // --- Polling and age display -------------------------------------------
  const pollTimer = setInterval(() => {
    if (!destroyed && active)
      void analyzeAt(active.latitude, active.longitude, { force: true });
  }, pollIntervalMs);
  const ageTimer = setInterval(() => panel?.tick(), AGE_TICK_MS);

  return Object.freeze({
    analyzeAt,
    service,
    panel,
    overlay,
    getActive: () => active,
    destroy() {
      destroyed = true;
      clearTimeout(settleTimer);
      clearInterval(pollTimer);
      clearInterval(ageTimer);
      removeCameraListener?.();
      clickHandler?.destroy?.();
      overlay?.destroy();
      panel?.destroy();
      service.clear();
    },
  });
}

export { POLL_INTERVAL_MS, CAMERA_MOVE_DEGREES };
