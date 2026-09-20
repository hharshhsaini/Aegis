import { magnitudeCategory, depthCategory, USGS_FEEDS } from './thresholds.js';

/**
 * USGS GeoJSON to Aegis earthquake events.
 *
 * Separate from `records.js`, which feeds the existing map layer and keeps only
 * what that layer draws. Intelligence needs the whole record — felt reports,
 * tsunami flag, USGS significance, review status, the event page URL — so this
 * normalizer preserves every field it is given, including the original USGS
 * event id, and keeps the raw property bag for anything not modelled yet.
 *
 * Aegis observes; USGS measures. Nothing here computes a magnitude, a depth or
 * a significance of its own.
 */

const FEED_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';

/**
 * Build a USGS summary feed URL.
 * @param {string} feed Feed id from {@link USGS_FEEDS}.
 * @returns {string} Feed URL.
 * @throws {TypeError} When the feed is not one USGS publishes.
 */
export function feedUrl(feed) {
  if (!USGS_FEEDS[feed]) throw new TypeError(`Unknown USGS feed: ${feed}`);
  return `${FEED_BASE}/${feed}.geojson`;
}

/** Coerce to a finite number, or null. */
function numeric(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Normalize one USGS feature.
 *
 * @param {object} feature GeoJSON feature.
 * @returns {object|null} Frozen event, or null when the feature is unusable.
 */
export function toEarthquakeEvent(feature) {
  const coordinates = feature?.geometry?.coordinates;
  const properties = feature?.properties;
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !properties)
    return null;
  const [longitude, latitude, depth] = coordinates;
  if (
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180 ||
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90
  )
    return null;
  const id = feature.id == null ? null : String(feature.id);
  if (!id) return null;

  const magnitude = numeric(properties.mag);
  const depthKm = numeric(depth);
  const time = numeric(properties.time);

  return Object.freeze({
    // The model the rest of Aegis reads.
    id,
    magnitude,
    place: typeof properties.place === 'string' ? properties.place : null,
    latitude,
    longitude,
    depth: depthKm,
    time,
    timeIso: time === null ? null : new Date(time).toISOString(),
    updated: numeric(properties.updated),
    updatedIso:
      numeric(properties.updated) === null
        ? null
        : new Date(properties.updated).toISOString(),
    // USGS publishes tsunami as 0/1; it is a FLAG SET BY USGS, never inferred.
    tsunami: properties.tsunami === 1 || properties.tsunami === true,
    alert: typeof properties.alert === 'string' ? properties.alert : null,
    felt: numeric(properties.felt),
    significance: numeric(properties.sig),
    eventType: typeof properties.type === 'string' ? properties.type : null,
    status: typeof properties.status === 'string' ? properties.status : null,
    source: 'USGS',
    network: typeof properties.net === 'string' ? properties.net : null,
    url: typeof properties.url === 'string' ? properties.url : null,

    // Derived description of the observation. Categories only; no consequence.
    magnitudeCategory: magnitudeCategory(magnitude),
    depthCategory: depthCategory(depthKm),
    magnitudeType:
      typeof properties.magType === 'string' ? properties.magType : null,
    title: typeof properties.title === 'string' ? properties.title : null,
    // Community and shaking intensity as USGS reports them.
    cdi: numeric(properties.cdi),
    mmi: numeric(properties.mmi),
    detailUrl: typeof properties.detail === 'string' ? properties.detail : null,
    // Anything USGS publishes that Aegis does not model yet stays reachable.
    raw: Object.freeze({ ...properties }),
  });
}

/**
 * Normalize a whole USGS feed.
 *
 * Duplicate ids are dropped rather than rejected: a summary feed occasionally
 * carries the same event twice while a revision propagates, and losing the
 * whole snapshot over it would blank the layer.
 *
 * @param {object} geojson Parsed feed.
 * @param {object} [options] Options.
 * @param {string} [options.feed] Feed id the payload came from.
 * @returns {object|null} Frozen snapshot, or null when the payload is not a feed.
 */
export function normalizeUsgsFeed(geojson, { feed = null } = {}) {
  if (!Array.isArray(geojson?.features)) return null;
  const events = [];
  const seen = new Set();
  for (const feature of geojson.features) {
    const event = toEarthquakeEvent(feature);
    if (!event || seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(event);
  }
  events.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  return Object.freeze({
    feed,
    generatedAt: numeric(geojson?.metadata?.generated),
    title: geojson?.metadata?.title ?? null,
    attribution: 'USGS Earthquake Hazards Program',
    count: events.length,
    events: Object.freeze(events),
  });
}

/**
 * Keep events inside a bounding box.
 * @param {object[]} events Events.
 * @param {{west: number, south: number, east: number, north: number}|null} bbox Box.
 * @returns {object[]} Events within the box.
 */
export function withinBoundingBox(events, bbox) {
  if (!bbox) return events;
  return events.filter(
    (event) =>
      event.latitude >= bbox.south &&
      event.latitude <= bbox.north &&
      event.longitude >= bbox.west &&
      event.longitude <= bbox.east,
  );
}

/**
 * Events within a radius of a point.
 *
 * The bounding-box filter above answers "what is on screen", which is the right
 * question for drawing a globe and the wrong one for deciding what is near a
 * person. A box is also not a radius: at high latitudes its corners reach far
 * further than its edges, so "within 50 km" measured by box would quietly mean
 * something different in Oslo than in Bengaluru.
 *
 * This measures great-circle distance from the point, so the radius means the
 * same thing everywhere on Earth.
 *
 * @param {object[]} events Normalized USGS events.
 * @param {{latitude: number, longitude: number}|null} origin The point.
 * @param {number} radiusKm Radius in kilometres.
 * @returns {object[]} Events within the radius, each carrying its distance.
 */
export function withinRadius(events, origin, radiusKm) {
  if (
    !origin ||
    !Number.isFinite(origin.latitude) ||
    !Number.isFinite(origin.longitude) ||
    !Number.isFinite(radiusKm)
  )
    return events;

  const EARTH_RADIUS_KM = 6371;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const lat1 = toRad(origin.latitude);

  const out = [];
  for (const event of events) {
    if (!Number.isFinite(event?.latitude) || !Number.isFinite(event?.longitude))
      continue;
    const dLat = toRad(event.latitude - origin.latitude);
    const dLon = toRad(event.longitude - origin.longitude);
    const lat2 = toRad(event.latitude);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const distanceKm =
      2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
    if (distanceKm <= radiusKm)
      out.push({ ...event, distanceKm: Number(distanceKm.toFixed(1)) });
  }
  return out;
}

export { FEED_BASE };
