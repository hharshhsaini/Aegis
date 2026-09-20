import * as Cesium from 'cesium';
import { RISK_LEVELS } from '../risk/thresholds.js';

/**
 * Satellite fire detections on the globe.
 *
 * Fire has its own visual language here, distinct from every other Aegis layer:
 * warm amber-to-red points and rings, against the weather overlay's risk tints
 * and the cyan chrome of the rest of the application. A viewer should be able to
 * tell at a glance that they are looking at satellite detections rather than a
 * modeled risk area.
 *
 * LEVEL OF DETAIL is the other rule. A continent of detections drawn as
 * individual markers is a smear, not information, so:
 *   - zoomed out, only cluster rings are drawn, sized by detection count;
 *   - zoomed in, individual detections appear as points alongside them.
 * The switch is the camera height, checked when the camera settles rather than
 * per frame.
 *
 * Individual detections are drawn in a PointPrimitiveCollection because there
 * can be thousands and they are not selectable; clusters are entities because
 * they carry labels and are what an operator clicks.
 */

/** Camera height below which individual detections are drawn, in metres. */
export const DETAIL_ALTITUDE_M = 900_000;

/** Clusters that carry a label. Beyond this the map is labelling noise. */
export const MAX_LABELLED_CLUSTERS = 6;

/**
 * How far a cluster may move between observations and still be "the same one"
 * for the purposes of keeping it selected, in degrees (~15 km).
 */
export const SELECTION_MATCH_DEGREES = 0.15;

/** Detection colour ramp by fire radiative power (MW). */
const FRP_COLORS = Object.freeze([
  { min: 0, color: '#ffb347' },
  { min: 20, color: '#ff8c42' },
  { min: 100, color: '#ff5c33' },
  { min: 500, color: '#ff2d2d' },
]);

const SPREAD_LEVEL_COLORS = Object.freeze(
  Object.fromEntries(RISK_LEVELS.map((band) => [band.id, band.color])),
);

/**
 * Colour for one detection's intensity.
 * @param {number|null} frp Fire radiative power.
 * @returns {string} CSS colour.
 */
export function detectionColor(frp) {
  let color = FRP_COLORS[0].color;
  if (!Number.isFinite(frp)) return color;
  for (const band of FRP_COLORS) if (frp >= band.min) color = band.color;
  return color;
}

/**
 * Ring radius for a cluster, in metres.
 *
 * Scaled by the square root of the detection count so a cluster ten times
 * larger reads as bigger without drawing a ring ten times wider than the fire.
 *
 * @param {object} cluster Cluster record.
 * @returns {number} Radius in metres.
 */
export function clusterRadiusM(cluster) {
  const base = Math.max(1, cluster.detectionCount);
  return Math.min(60_000, 3_000 + Math.sqrt(base) * 2_400);
}

/**
 * Create the fire overlay controller.
 *
 * @param {object} input Controller input.
 * @param {object} input.viewer Cesium viewer.
 * @param {(cluster: object) => void} [input.onClusterSelected] Selection callback.
 * @returns {object} Frozen controller.
 */
export function createFireOverlay({ viewer, onClusterSelected }) {
  if (!viewer?.entities) throw new TypeError('A Cesium viewer is required');

  const clusterEntities = [];
  let vectorEntity = null;
  let points = null;
  let detections = [];
  let clusters = [];
  let selectedId = null;

  const scene = viewer.scene;
  if (scene?.primitives?.add)
    points = scene.primitives.add(new Cesium.PointPrimitiveCollection());

  /** Whether the camera is close enough to draw individual detections. */
  function wantsDetail() {
    const height = viewer.camera?.positionCartographic?.height;
    return Number.isFinite(height) && height <= DETAIL_ALTITUDE_M;
  }

  function clearClusters() {
    for (const entity of clusterEntities) viewer.entities.remove(entity);
    clusterEntities.length = 0;
  }

  function clearVector() {
    if (vectorEntity) viewer.entities.remove(vectorEntity);
    vectorEntity = null;
  }

  /** Remove everything this overlay drew. */
  function clear() {
    clearClusters();
    clearVector();
    points?.removeAll();
    detections = [];
    clusters = [];
    selectedId = null;
    scene?.requestRender?.();
  }

  /** Draw individual detections, or remove them when zoomed out. */
  function renderDetections() {
    if (!points) return;
    points.removeAll();
    if (!wantsDetail()) return;
    for (const detection of detections) {
      points.add({
        position: Cesium.Cartesian3.fromDegrees(
          detection.longitude,
          detection.latitude,
        ),
        color: Cesium.Color.fromCssColorString(
          detectionColor(detection.fireRadiativePower),
        ).withAlpha(0.95),
        pixelSize: detection.dayNight === 'NIGHT' ? 6 : 7,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.45),
        outlineWidth: 1,
        // Individual pixels stop being meaningful from orbit; the cluster ring
        // carries the information at that range.
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          DETAIL_ALTITUDE_M,
        ),
      });
    }
  }

  /**
   * Draw one ring per cluster.
   *
   * Only real clusters are labelled, and only the largest few: a fire season
   * puts dozens of groups in one view, and a label on each turns the map into a
   * wall of text that hides the fires it is describing. Loose one- and
   * two-pixel detections get a ring with no label — they are visible, but they
   * do not compete with the clusters that matter.
   */
  function renderClusters() {
    clearClusters();
    const labelled = new Set(
      clusters
        .filter((cluster) => cluster.kind === 'CLUSTER')
        .slice(0, MAX_LABELLED_CLUSTERS)
        .map((cluster) => cluster.id),
    );
    for (const cluster of clusters) {
      const radius = clusterRadiusM(cluster);
      const color = Cesium.Color.fromCssColorString(
        detectionColor(cluster.peakFrp),
      );
      const selected = cluster.id === selectedId;
      const showLabel = selected || labelled.has(cluster.id);
      const label = `ACTIVE FIRE CLUSTER · ${cluster.detectionCount} detections`;
      const entity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(
          cluster.center.longitude,
          cluster.center.latitude,
        ),
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius,
          material: color.withAlpha(selected ? 0.3 : 0.16),
          outline: true,
          outlineColor: color.withAlpha(selected ? 0.95 : 0.6),
          outlineWidth: selected ? 3 : 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: showLabel
          ? {
              text: label,
              font: '500 11px "JetBrains Mono", monospace',
              fillColor: color,
              showBackground: true,
              backgroundColor:
                Cesium.Color.fromCssColorString('#0a0a0f').withAlpha(0.78),
              backgroundPadding: new Cesium.Cartesian2(8, 5),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              pixelOffset: new Cesium.Cartesian2(0, -12),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
                0,
                1_400_000,
              ),
            }
          : undefined,
      });
      // Carried on the entity so a click can resolve back to the cluster.
      entity.aegisFireClusterId = cluster.id;
      clusterEntities.push(entity);
    }
  }

  /**
   * Draw the modeled spread direction for the selected cluster.
   *
   * The arrow is wind-derived only, and its own label says so — this must never
   * read as a predicted fire path.
   */
  function renderVector(cluster) {
    clearVector();
    const vector = cluster?.spreadVector;
    if (!vector) return;
    const start = Cesium.Cartesian3.fromDegrees(
      cluster.center.longitude,
      cluster.center.latitude,
    );
    // Project the endpoint along the bearing with a local flat approximation.
    // The arrow is tens of kilometres long at most, where the error is metres —
    // far below the precision this vector claims to have.
    const bearing = Cesium.Math.toRadians(vector.spreadTowardDegrees);
    const distance = vector.vectorLengthKm * 1000;
    const metresPerDegree = 111_320;
    const endLat =
      cluster.center.latitude +
      (Math.cos(bearing) * distance) / metresPerDegree;
    const endLon =
      cluster.center.longitude +
      (Math.sin(bearing) * distance) /
        (metresPerDegree *
          Math.cos(Cesium.Math.toRadians(cluster.center.latitude)));
    const color = Cesium.Color.fromCssColorString(
      SPREAD_LEVEL_COLORS[cluster.spreadConditions?.level] || '#ffb347',
    );
    vectorEntity = viewer.entities.add({
      polyline: {
        positions: [start, Cesium.Cartesian3.fromDegrees(endLon, endLat)],
        width: 3,
        clampToGround: true,
        material: new Cesium.PolylineArrowMaterialProperty(
          color.withAlpha(0.85),
        ),
      },
      position: Cesium.Cartesian3.fromDegrees(endLon, endLat),
      label: {
        text: `${vector.spreadTowardCardinal} · wind ${Math.round(vector.windSpeedKmh)} km/h\n${vector.label}`,
        font: '400 10px "JetBrains Mono", monospace',
        fillColor: color,
        showBackground: true,
        backgroundColor:
          Cesium.Color.fromCssColorString('#0a0a0f').withAlpha(0.78),
        backgroundPadding: new Cesium.Cartesian2(7, 5),
        verticalOrigin: Cesium.VerticalOrigin.TOP,
        pixelOffset: new Cesium.Cartesian2(0, 10),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          1_500_000,
        ),
      },
    });
  }

  /**
   * Render one fire intelligence observation.
   * @param {object} intelligence Engine output.
   * @param {object[]} observedDetections Detections for the area.
   */
  function show(intelligence, observedDetections = []) {
    const previousSelection = clusters.find(
      (cluster) => cluster.id === selectedId,
    );
    clusters = intelligence?.clusters ? [...intelligence.clusters] : [];
    detections = Array.isArray(observedDetections) ? observedDetections : [];
    // A cluster's id carries its detection count, so every refresh that finds
    // one more hot pixel mints a new id. Matching by id alone would drop the
    // operator's selection each poll — exactly when a growing fire is most
    // worth watching — so the selection follows the cluster to its new id by
    // position instead.
    if (selectedId && !clusters.some((cluster) => cluster.id === selectedId)) {
      const successor = previousSelection
        ? clusters.find(
            (cluster) =>
              Math.abs(
                cluster.center.latitude - previousSelection.center.latitude,
              ) < SELECTION_MATCH_DEGREES &&
              Math.abs(
                cluster.center.longitude - previousSelection.center.longitude,
              ) < SELECTION_MATCH_DEGREES,
          )
        : null;
      selectedId = successor?.id ?? null;
    }
    renderClusters();
    renderDetections();
    const selected = clusters.find((cluster) => cluster.id === selectedId);
    if (selected) renderVector(selected);
    else clearVector();
    scene?.requestRender?.();
  }

  /**
   * Select a cluster, redrawing its emphasis and spread vector.
   * @param {string|null} clusterId Cluster id, or null to clear.
   * @returns {object|null} The selected cluster.
   */
  function select(clusterId) {
    selectedId = clusterId;
    const cluster = clusters.find((entry) => entry.id === clusterId) || null;
    renderClusters();
    if (cluster) renderVector(cluster);
    else clearVector();
    scene?.requestRender?.();
    return cluster;
  }

  /** Re-evaluate the level of detail after the camera settles. */
  function refreshDetail() {
    renderDetections();
    scene?.requestRender?.();
  }

  /**
   * Resolve a picked Cesium object to a cluster, if it is one of ours.
   * @param {object} picked Result of `scene.pick`.
   * @returns {object|null} The cluster, or null.
   */
  function clusterFromPick(picked) {
    const id = picked?.id?.aegisFireClusterId;
    if (!id) return null;
    const cluster = clusters.find((entry) => entry.id === id) || null;
    if (cluster) {
      select(id);
      onClusterSelected?.(cluster);
    }
    return cluster;
  }

  return Object.freeze({
    show,
    select,
    clear,
    refreshDetail,
    clusterFromPick,
    getClusters: () => clusters,
    getSelected: () =>
      clusters.find((entry) => entry.id === selectedId) || null,
    isDetailVisible: () => wantsDetail(),
    destroy() {
      clear();
      if (points && scene?.primitives?.remove) scene.primitives.remove(points);
      points = null;
    },
  });
}
