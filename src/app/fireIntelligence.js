import * as Cesium from 'cesium';
import { createFireIntelligenceService } from '../data/fireIntelligence.js';
import { createFireIntelligencePanel } from '../ui/fireIntelligencePanel.js';
import { createFireOverlay } from './fireOverlay.js';
import { viewportBoundingBox } from './viewportArea.js';

/**
 * Wire NASA FIRMS fire intelligence into the running application.
 *
 * The viewport drives the query, which is the whole point of the design: Aegis
 * asks FIRMS about the area an operator is actually looking at rather than
 * pulling the planet every few minutes. Because both the client and the server
 * snap that viewport onto the same 5° grid, panning within a region re-uses one
 * answer and costs no transactions at all.
 *
 * Refresh cadence matches the data: FIRMS publishes roughly every 15 minutes,
 * so that is the poll interval. Anything faster would spend transactions to
 * receive the same CSV.
 */

/** Poll interval for the active area, matched to FIRMS publication. */
const POLL_INTERVAL_MS = 15 * 60_000;

/** Camera settle delay before a new area is observed. */
const CAMERA_SETTLE_MS = 2_000;

/**
 * Start fire intelligence for the application.
 *
 * @param {object} input Startup input.
 * @param {object} input.viewer Cesium viewer.
 * @param {object} input.requests Application request services.
 * @param {Document} [input.document] Document holding the panel markup.
 * @param {number} [input.pollIntervalMs] Refresh interval.
 * @returns {object} Controller.
 */
export function startFireIntelligence({
  viewer,
  requests,
  document: doc = globalThis.document,
  pollIntervalMs = POLL_INTERVAL_MS,
  setPanelCollapsed,
  onFocusEvent,
}) {
  const transport = requests?.fireIntelligence;
  if (!transport?.observe)
    throw new TypeError('Fire intelligence request services are required');

  const service = createFireIntelligenceService({
    fetchIntelligence: (bbox, options) => transport.observe(bbox, options),
  });

  let destroyed = false;
  let latest = null;

  const panel = createFireIntelligencePanel({
    document: doc,
    onRefresh: () => {
      const box = viewportBoundingBox(viewer);
      if (box) void observe(box, { force: true });
    },
    // Selecting the busiest cluster is what an operator means by "show me the
    // clusters": it puts the map and the panel on the same one rather than
    // leaving them to find it by clicking around the globe.
    onViewClusters: () => {
      const clusters = (latest?.intelligence?.clusters || []).filter(
        (cluster) => cluster.kind === 'CLUSTER',
      );
      if (!clusters.length) return;
      const busiest = clusters.reduce((best, cluster) =>
        cluster.detectionCount > best.detectionCount ? cluster : best,
      );
      overlay?.select?.(busiest);
      panel?.showCluster(busiest, {
        activity: latest?.intelligence?.activity,
      });
    },
  });

  const overlay = viewer
    ? createFireOverlay({
        viewer,
        onClusterSelected: (cluster) => {
          panel?.showCluster(cluster, {
            activity: latest?.intelligence?.activity,
          });
          // The panel rides the left rail collapsed — selecting a cluster is
          // the moment its detail becomes worth the space it takes.
          setPanelCollapsed?.('fire-panel', false, { explicit: true });
        },
      })
    : null;

  /**
   * Observe one area and update the map and panel.
   * @param {object} bbox Viewport box.
   * @param {object} [options] Service options.
   * @returns {Promise<object|null>} Service record.
   */
  async function observe(bbox, options = {}) {
    if (destroyed) return null;
    panel?.setBusy(true);
    const record = await service.observe(bbox, options);
    if (destroyed || !record) {
      panel?.setBusy(false);
      return record;
    }
    latest = record;
    if (record.intelligence) {
      overlay?.show(record.intelligence, record.detections);
      const selected = overlay?.getSelected();
      if (selected)
        panel?.showCluster(selected, {
          activity: record.intelligence.activity,
        });
      else panel?.showAreaSummary(record);
    } else {
      // A failed observation leaves the previous detections drawn rather than
      // clearing the map, which would read as "the fires went out".
      panel?.showError(
        record.error || 'Satellite fire data temporarily unavailable.',
      );
    }
    return record;
  }

  // --- Map interaction ----------------------------------------------------
  let clickHandler = null;
  if (viewer?.scene?.canvas && overlay) {
    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((movement) => {
      const picked = viewer.scene.pick?.(movement.position);
      const cluster = overlay.clusterFromPick(picked);
      if (cluster) {
        // Same dropped hit as the earthquake handler had: the pick succeeded
        // and nothing was done with it. Selecting the cluster and announcing
        // the focus is what makes a click mean something.
        overlay.select(cluster.id);
        panel?.showCluster?.(cluster);
        onFocusEvent?.(cluster);
        return;
      }
      if (overlay.getSelected()) {
        // Clicking away from every cluster returns the panel to the area view.
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
      // Level of detail first: the answer may already be cached, and the
      // detail switch should not wait on a network round trip.
      overlay?.refreshDetail();
      const box = viewportBoundingBox(viewer);
      if (box) void observe(box);
    }, CAMERA_SETTLE_MS);
  };
  const removeCameraListener =
    viewer?.camera?.moveEnd?.addEventListener?.(onCameraSettled) || null;

  const pollTimer = setInterval(() => {
    if (destroyed) return;
    const box = viewportBoundingBox(viewer);
    if (box) void observe(box, { force: true });
  }, pollIntervalMs);

  // A first observation as soon as the app is up. Without it the panel sat on
  // "scanning" until the operator happened to move the camera, which on a
  // console that opens on a fixed regional view could be indefinitely.
  const openingBox = viewportBoundingBox(viewer);
  if (openingBox) void observe(openingBox);
  else panel?.setBusy(true);

  return Object.freeze({
    observe,
    service,
    panel,
    overlay,
    getLatest: () => latest,
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
