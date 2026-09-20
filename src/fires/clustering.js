/**
 * Fire clustering and cluster statistics.
 *
 * One detection is a pixel that ran hot — it could be a gas flare, a factory,
 * or a burn scar catching the sun. A tight group of detections observed close
 * together in time is a different claim entirely, and clustering is what lets
 * Aegis talk about fire ACTIVITY without overstating any single pixel.
 *
 * The method is single-link spatial clustering (the DBSCAN idea without the
 * minimum-density rule): detections within a linking distance of any member
 * join the cluster. That suits fire perimeters, which are chains and fronts
 * rather than neat circles — a 20 km fire line would be split by a centroid
 * method, and is one cluster here.
 *
 * Distances are metres on a spherical Earth, with longitude scaled by latitude
 * so a link distance means the same thing in Norway as it does at the equator.
 */

const EARTH_RADIUS_M = 6_371_000;

/** Detections within this distance of a cluster member join it. */
export const LINK_DISTANCE_M = 3_000;

/** Below this count a group is reported as loose detections, not a cluster. */
export const MIN_CLUSTER_DETECTIONS = 3;

/** FRP thresholds (MW) for the categorical peak-intensity label. */
export const FRP_BANDS = Object.freeze([
  { id: 'LOW', min: 0 },
  { id: 'MODERATE', min: 20 },
  { id: 'HIGH', min: 100 },
  { id: 'EXTREME', min: 500 },
]);

/**
 * Name an FRP value.
 * @param {number|null} frp Fire radiative power in megawatts.
 * @returns {string|null} Band id, or null without a reading.
 */
export function frpBand(frp) {
  if (!Number.isFinite(frp)) return null;
  let band = FRP_BANDS[0].id;
  for (const entry of FRP_BANDS) if (frp >= entry.min) band = entry.id;
  return band;
}

/**
 * Great-circle distance between two points, in metres.
 * @param {{latitude: number, longitude: number}} a First point.
 * @param {{latitude: number, longitude: number}} b Second point.
 * @returns {number} Distance in metres.
 */
export function distanceMeters(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const meanLat = ((a.latitude + b.latitude) / 2) * toRad;
  const dLon = (b.longitude - a.longitude) * toRad * Math.cos(meanLat);
  return Math.sqrt(dLat * dLat + dLon * dLon) * EARTH_RADIUS_M;
}

/**
 * Group detections into spatial clusters.
 *
 * A uniform grid indexes candidates first, so linking is a neighbourhood check
 * rather than an all-pairs comparison — the difference between usable and
 * unusable once a continent's worth of detections is in view.
 *
 * @param {object[]} detections Detections to group.
 * @param {object} [options] Options.
 * @param {number} [options.linkDistanceM] Linking distance.
 * @returns {object[][]} Groups of detections.
 */
export function groupDetections(
  detections,
  { linkDistanceM = LINK_DISTANCE_M } = {},
) {
  const cellDegrees = linkDistanceM / 111_320;
  const grid = new Map();
  const cellKey = (detection) =>
    `${Math.floor(detection.latitude / cellDegrees)}:${Math.floor(
      detection.longitude / cellDegrees,
    )}`;
  detections.forEach((detection, index) => {
    const key = cellKey(detection);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(index);
  });

  const neighbours = (detection) => {
    const latCell = Math.floor(detection.latitude / cellDegrees);
    const lonCell = Math.floor(detection.longitude / cellDegrees);
    const found = [];
    for (let dLat = -1; dLat <= 1; dLat += 1)
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        const bucket = grid.get(`${latCell + dLat}:${lonCell + dLon}`);
        if (bucket) found.push(...bucket);
      }
    return found;
  };

  const assigned = new Array(detections.length).fill(false);
  const groups = [];
  for (let seed = 0; seed < detections.length; seed += 1) {
    if (assigned[seed]) continue;
    assigned[seed] = true;
    const queue = [seed];
    const group = [];
    while (queue.length) {
      const index = queue.pop();
      const detection = detections[index];
      group.push(detection);
      for (const candidate of neighbours(detection)) {
        if (assigned[candidate]) continue;
        if (distanceMeters(detection, detections[candidate]) > linkDistanceM)
          continue;
        assigned[candidate] = true;
        queue.push(candidate);
      }
    }
    groups.push(group);
  }
  return groups;
}

/** Mean of finite values, or null when none are present. */
function mean(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

/**
 * Summarize one group of detections.
 *
 * `areaKm2` is a DETECTION footprint, not a burned area: VIIRS pixels are
 * roughly 375 m, so the figure is the ground area the hot pixels cover, which
 * is why it is named and labelled as detection area everywhere it surfaces.
 *
 * @param {object[]} detections Detections in the group.
 * @param {object} [options] Options.
 * @param {number} [options.now] Clock for ages.
 * @returns {object} Frozen cluster record.
 */
export function summarizeCluster(detections, { now = Date.now() } = {}) {
  const latitudes = detections.map((detection) => detection.latitude);
  const longitudes = detections.map((detection) => detection.longitude);
  const frps = detections.map((detection) => detection.fireRadiativePower);
  const confidences = detections.map((detection) => detection.confidence);
  const times = detections.map((detection) => detection.acquiredMs);

  const centre = {
    latitude: Number(mean(latitudes).toFixed(5)),
    longitude: Number(mean(longitudes).toFixed(5)),
  };
  const newestMs = Math.max(...times);
  const oldestMs = Math.min(...times);
  const peakFrp = frps.some((value) => Number.isFinite(value))
    ? Math.max(...frps.filter((value) => Number.isFinite(value)))
    : null;
  // VIIRS active-fire pixels are ~375 m on a side.
  const pixelAreaKm2 = 0.375 * 0.375;
  const averageConfidence = mean(confidences);

  return Object.freeze({
    id: `fc:${centre.latitude.toFixed(3)},${centre.longitude.toFixed(3)}:${detections.length}`,
    kind:
      detections.length >= MIN_CLUSTER_DETECTIONS ? 'CLUSTER' : 'DETECTIONS',
    detectionCount: detections.length,
    center: Object.freeze(centre),
    bounds: Object.freeze({
      west: Math.min(...longitudes),
      east: Math.max(...longitudes),
      south: Math.min(...latitudes),
      north: Math.max(...latitudes),
    }),
    detectionAreaKm2: Number((detections.length * pixelAreaKm2).toFixed(2)),
    spanKm: Number(
      (
        distanceMeters(
          {
            latitude: Math.min(...latitudes),
            longitude: Math.min(...longitudes),
          },
          {
            latitude: Math.max(...latitudes),
            longitude: Math.max(...longitudes),
          },
        ) / 1000
      ).toFixed(2),
    ),
    averageConfidence:
      averageConfidence === null ? null : Number(averageConfidence.toFixed(3)),
    averageFrp: (() => {
      const value = mean(frps);
      return value === null ? null : Number(value.toFixed(2));
    })(),
    peakFrp,
    peakFrpBand: frpBand(peakFrp),
    newestDetectionAt: new Date(newestMs).toISOString(),
    oldestDetectionAt: new Date(oldestMs).toISOString(),
    newestAgeMs: Math.max(0, now - newestMs),
    observationSpanMs: newestMs - oldestMs,
    satellites: Object.freeze([
      ...new Set(detections.map((detection) => detection.satelliteName)),
    ]),
    sources: Object.freeze([
      ...new Set(detections.map((detection) => detection.source)),
    ]),
    dayNight: detections[0]?.dayNight ?? null,
    detections: Object.freeze(detections),
  });
}

/**
 * Cluster detections and rank the result.
 *
 * Ranking is by detection count and then peak FRP, because that is the order an
 * operator triages in: the biggest, hottest group of detections first.
 *
 * @param {object[]} detections Detections.
 * @param {object} [options] Options forwarded to grouping and summarizing.
 * @returns {object[]} Frozen clusters, most significant first.
 */
export function clusterDetections(detections, options = {}) {
  if (!Array.isArray(detections) || !detections.length)
    return Object.freeze([]);
  const groups = groupDetections(detections, options);
  const clusters = groups.map((group) => summarizeCluster(group, options));
  return Object.freeze(
    clusters.sort(
      (a, b) =>
        b.detectionCount - a.detectionCount ||
        (b.peakFrp ?? 0) - (a.peakFrp ?? 0),
    ),
  );
}
