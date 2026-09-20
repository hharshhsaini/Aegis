import { SEQUENCE } from './thresholds.js';

/**
 * Earthquake clustering and sequence context.
 *
 * Events that fall close together in BOTH space and time are grouped. The
 * result is called an earthquake sequence and nothing more specific: deciding
 * that a group is a mainshock with aftershocks needs criteria this layer does
 * not have — a clear largest event, a decay rate, a tectonic context — and
 * guessing would put an interpretation on the data that USGS itself has not
 * published.
 *
 * Clustering is single-link over a spatial radius and a time window, so a swarm
 * that migrates along a fault stays one sequence rather than splitting.
 */

const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance in kilometres.
 * @param {{latitude: number, longitude: number}} a First point.
 * @param {{latitude: number, longitude: number}} b Second point.
 * @returns {number} Distance in kilometres.
 */
export function distanceKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const meanLat = ((a.latitude + b.latitude) / 2) * toRad;
  const dLon = (b.longitude - a.longitude) * toRad * Math.cos(meanLat);
  return Math.sqrt(dLat * dLat + dLon * dLon) * EARTH_RADIUS_KM;
}

/** Whether two events are neighbours in space and time. */
function linked(a, b, radiusKm, windowMs) {
  if (!Number.isFinite(a.time) || !Number.isFinite(b.time)) return false;
  if (Math.abs(a.time - b.time) > windowMs) return false;
  return distanceKm(a, b) <= radiusKm;
}

/**
 * Group events into spatio-temporal clusters.
 *
 * @param {object[]} events Normalized events.
 * @param {object} [options] Options.
 * @param {number} [options.radiusKm] Linking radius.
 * @param {number} [options.windowHours] Linking time window.
 * @returns {object[][]} Groups of events.
 */
export function groupEvents(events, options = {}) {
  const radiusKm = options.radiusKm ?? SEQUENCE.radiusKm;
  const windowMs = (options.windowHours ?? SEQUENCE.windowHours) * 3_600_000;
  // A degree of latitude is ~111 km, so this cell size guarantees that any
  // event within the radius is in this cell or one adjacent to it.
  const cellDegrees = radiusKm / 111;
  const grid = new Map();
  const key = (event) =>
    `${Math.floor(event.latitude / cellDegrees)}:${Math.floor(
      event.longitude / cellDegrees,
    )}`;
  events.forEach((event, index) => {
    const cell = key(event);
    if (!grid.has(cell)) grid.set(cell, []);
    grid.get(cell).push(index);
  });
  const neighbours = (event) => {
    const lat = Math.floor(event.latitude / cellDegrees);
    const lon = Math.floor(event.longitude / cellDegrees);
    const found = [];
    for (let dLat = -1; dLat <= 1; dLat += 1)
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        const bucket = grid.get(`${lat + dLat}:${lon + dLon}`);
        if (bucket) found.push(...bucket);
      }
    return found;
  };

  const assigned = new Array(events.length).fill(false);
  const groups = [];
  for (let seed = 0; seed < events.length; seed += 1) {
    if (assigned[seed]) continue;
    assigned[seed] = true;
    const queue = [seed];
    const group = [];
    while (queue.length) {
      const index = queue.pop();
      group.push(events[index]);
      for (const candidate of neighbours(events[index])) {
        if (assigned[candidate]) continue;
        if (!linked(events[index], events[candidate], radiusKm, windowMs))
          continue;
        assigned[candidate] = true;
        queue.push(candidate);
      }
    }
    groups.push(group);
  }
  return groups;
}

/** Mean of finite values, or null. */
function mean(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

/**
 * Summarize one group of events.
 *
 * `eventsPerHour` is the observed rate across the group's own span, not a
 * projection: a group spanning ten minutes reports the rate over those ten
 * minutes and says so through `spanHours`.
 *
 * @param {object[]} events Events in the group.
 * @param {object} [options] Options.
 * @param {number} [options.now] Clock.
 * @param {number} [options.minEvents] Events needed before a group is a sequence.
 * @returns {object} Frozen cluster record.
 */
export function summarizeCluster(events, { now = Date.now(), minEvents } = {}) {
  const threshold = minEvents ?? SEQUENCE.minEvents;
  const magnitudes = events.map((event) => event.magnitude);
  const depths = events.map((event) => event.depth);
  const times = events.map((event) => event.time).filter(Number.isFinite);
  const latitudes = events.map((event) => event.latitude);
  const longitudes = events.map((event) => event.longitude);

  const largest = events.reduce(
    (worst, event) =>
      (event.magnitude ?? -Infinity) > (worst?.magnitude ?? -Infinity)
        ? event
        : worst,
    null,
  );
  const first = times.length ? Math.min(...times) : null;
  const latest = times.length ? Math.max(...times) : null;
  const spanHours =
    first !== null && latest !== null ? (latest - first) / 3_600_000 : null;
  const center = {
    latitude: Number(mean(latitudes).toFixed(4)),
    longitude: Number(mean(longitudes).toFixed(4)),
  };

  return Object.freeze({
    id: `eq:${center.latitude.toFixed(2)},${center.longitude.toFixed(2)}:${events.length}`,
    // Named neutrally: a group of events, not an interpretation of them.
    kind: events.length >= threshold ? 'SEQUENCE' : 'EVENTS',
    eventCount: events.length,
    center: Object.freeze(center),
    maxMagnitude: magnitudes.some(Number.isFinite)
      ? Math.max(...magnitudes.filter(Number.isFinite))
      : null,
    averageMagnitude: (() => {
      const value = mean(magnitudes);
      return value === null ? null : Number(value.toFixed(2));
    })(),
    minDepthKm: depths.some(Number.isFinite)
      ? Math.min(...depths.filter(Number.isFinite))
      : null,
    maxDepthKm: depths.some(Number.isFinite)
      ? Math.max(...depths.filter(Number.isFinite))
      : null,
    firstEventAt: first === null ? null : new Date(first).toISOString(),
    latestEventAt: latest === null ? null : new Date(latest).toISOString(),
    latestAgeMs: latest === null ? null : Math.max(0, now - latest),
    spanHours: spanHours === null ? null : Number(spanHours.toFixed(2)),
    eventsPerHour:
      spanHours && spanHours > 0
        ? Number((events.length / spanHours).toFixed(2))
        : null,
    radiusKm: Number(
      Math.max(0, ...events.map((event) => distanceKm(center, event))).toFixed(
        1,
      ),
    ),
    largestEventId: largest?.id ?? null,
    largestEventMagnitude: largest?.magnitude ?? null,
    events: Object.freeze(events),
  });
}

/**
 * Cluster events and rank them.
 *
 * Ranked by largest magnitude first, then event count: an operator triages the
 * biggest recorded event before the busiest patch of small ones.
 *
 * @param {object[]} events Normalized events.
 * @param {object} [options] Options for grouping and summarizing.
 * @returns {object[]} Frozen clusters.
 */
export function clusterEarthquakes(events, options = {}) {
  if (!Array.isArray(events) || !events.length) return Object.freeze([]);
  const groups = groupEvents(events, options);
  const clusters = groups.map((group) => summarizeCluster(group, options));
  return Object.freeze(
    clusters.sort(
      (a, b) =>
        (b.maxMagnitude ?? -Infinity) - (a.maxMagnitude ?? -Infinity) ||
        b.eventCount - a.eventCount,
    ),
  );
}

/**
 * Describe a cluster in neutral language.
 * @param {object} cluster Cluster record.
 * @returns {string} Sentence describing what was observed.
 */
export function describeSequence(cluster) {
  if (cluster.kind !== 'SEQUENCE')
    return `${cluster.eventCount} recorded event${cluster.eventCount === 1 ? '' : 's'} in this area.`;
  const within = cluster.radiusKm ? ` within ${cluster.radiusKm} km` : '';
  const span =
    cluster.spanHours && cluster.spanHours >= 0.1
      ? ` over ${cluster.spanHours} hours`
      : '';
  return `Earthquake sequence detected: ${cluster.eventCount} events${within}${span}, largest M${cluster.maxMagnitude ?? '—'}.`;
}
