import * as Cesium from 'cesium';
import { createEarthquakeIntelligenceService } from '../data/earthquakeIntelligence.js';
import { createEarthquakePanel } from '../ui/earthquakePanel.js';
import { createQuakeOverlay } from './quakeOverlay.js';
import { seismicRiskModule } from '../layers/earthquakes/seismicModule.js';
import { viewportBoundingBox } from './viewportArea.js';
import { DEFAULT_FEED } from '../layers/earthquakes/thresholds.js';

/**
 * Wire USGS earthquake intelligence into the running application.
 *
 * USGS publishes one feed for the whole planet, so unlike the fire layer the
 * viewport does not drive the REQUEST — it only scopes the answer. Panning
 * therefore costs nothing at all, and the refresh timer is the only thing that
 * ever reaches upstream.
 *
 * Five minutes matches how often USGS regenerates the summary feeds. Polling
 * faster would re-download an identical file.
 */

/** Refresh interval for the active feed. */
const POLL_INTERVAL_MS = 5 * 60_000;

/** Camera settle delay before the view is re-scoped. */
const CAMERA_SETTLE_MS = 1_200;

/**
 * Start earthquake intelligence.
 *
 * @param {object} input Input.
 * @param {object} input.viewer Cesium viewer.
 * @param {object} input.requests Application request services.
 * @param {Document} [input.document] Document holding the panel markup.
 * @param {number} [input.pollIntervalMs] Refresh interval.
 * @param {Function} [input.setPanelCollapsed] Panel disclosure control.
 * @returns {object} Controller.
 */
export function startEarthquakeIntelligence({
  viewer,
  requests,
  document: doc = globalThis.document,
  pollIntervalMs = POLL_INTERVAL_MS,
  setPanelCollapsed,
  onSeismicModule,
  onFocusEvent,
}) {
  const transport = requests?.earthquakeIntelligence;
  if (!transport?.observe)
    throw new TypeError(
      'Earthquake intelligence request services are required',
    );

  const service = createEarthquakeIntelligenceService({
    fetchIntelligence: (query, options) => transport.observe(query, options),
  });

  let destroyed = false;
  let latest = null;
  let latestForecast = null;
  const feed = DEFAULT_FEED;
  const forecastTransport = requests?.seismicForecast;

  const panel = createEarthquakePanel({
    document: doc,
    onRefresh: () => void observe({ force: true }),
    onRadiusChange: (km) => {
      overlay?.setAnalysisRadius(km);
    },
  });

  const overlay = viewer
    ? createQuakeOverlay({
        viewer,
        onEventSelected: (event) => {
          panel?.showEvent(event, {
            intelligence: latest?.intelligence,
            responseWeather: latest?.responseWeather,
          });
          setPanelCollapsed?.('quake-panel', false, { explicit: true });
        },
      })
    : null;

  /**
   * Observe recent earthquakes for the current view.
   * @param {object} [options] Options.
   * @returns {Promise<object|null>} Service record.
   */
  async function observe(options = {}) {
    if (destroyed) return null;
    panel?.setBusy(true);
    const record = await service.observe(
      { bbox: viewportBoundingBox(viewer), feed },
      options,
    );
    if (destroyed || !record) {
      panel?.setBusy(false);
      return record;
    }
    latest = record;
    // The forecast is a separate, slower call on the same viewport. It must not
    // hold up the observation render, and its failure must not blank it.
    if (forecastTransport?.forecast) void refreshForecast();
    if (record.intelligence) {
      // The Aegis Intelligence column shows seismicity beside the weather
      // hazards. It is fed from this one observation rather than from a second
      // request, so both panels always describe the same USGS data.
      onSeismicModule?.(seismicRiskModule(record.intelligence));
      overlay?.show(record.intelligence);
      const selected = overlay?.getSelected();
      if (selected)
        panel?.showEvent(selected, {
          intelligence: record.intelligence,
          responseWeather: record.responseWeather,
        });
      else panel?.showAreaSummary(record);
    } else {
      // A failed refresh leaves the previous events drawn: clearing them would
      // read as "no earthquakes", which is a claim about the world.
      panel?.showError(
        record.error || 'USGS earthquake data temporarily unavailable.',
      );
    }
    return record;
  }

  /** Fetch and render the model forecast for the current view. */
  async function refreshForecast() {
    const bbox = viewportBoundingBox(viewer);
    if (!bbox) return null;
    try {
      const record = await forecastTransport.forecast(bbox);
      if (destroyed) return null;
      latestForecast = record;
      panel?.showForecast(record);
      return record;
    } catch {
      // Observations stand on their own; a missing forecast is not an outage.
      return null;
    }
  }

  let clickHandler = null;
  if (viewer?.scene?.canvas && overlay) {
    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((movement) => {
      const picked = viewer.scene.pick?.(movement.position);
      const event = overlay.eventFromPick(picked);
      if (event) {
        // The hit used to be dropped here: the handler only checked whether
        // the pick had MISSED, so clicking a marker selected nothing, opened
        // nothing and told the intelligence layer nothing. A click is the
        // operator asking what something is, and this is where that question
        // reaches the rest of the system.
        overlay.select(event.id);
        panel?.showEvent?.(event);
        onFocusEvent?.(event);
        return;
      }
      if (overlay.getSelected()) {
        overlay.select(null);
        if (latest) panel?.showAreaSummary(latest);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  let settleTimer = null;
  const onCameraSettled = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (destroyed) return;
      // Re-scoping is local work against data already held, so it happens on
      // every settle; only the poll timer reaches USGS.
      overlay?.refreshDetail();
      void observe();
    }, CAMERA_SETTLE_MS);
  };
  const removeCameraListener =
    viewer?.camera?.moveEnd?.addEventListener?.(onCameraSettled) || null;

  const pollTimer = setInterval(() => {
    if (!destroyed) void observe({ force: true });
  }, pollIntervalMs);

  // A first observation as soon as the app is up, so the globe is not empty
  // until the operator happens to move the camera.
  void observe();

  return Object.freeze({
    observe,
    service,
    panel,
    overlay,
    getLatest: () => latest,
    getForecast: () => latestForecast,
    refreshForecast,
    destroy() {
      destroyed = true;
      clearTimeout(settleTimer);
      clearInterval(pollTimer);
      removeCameraListener?.();
      clickHandler?.destroy?.();
      overlay?.destroy();
      panel?.destroy();
      service.clear();
    },
  });
}

export { POLL_INTERVAL_MS };
