/**
 * USGS historical catalog access.
 *
 * The summary feeds (`all_day.geojson` and friends) are the live observation
 * source, but they hold at most a month and cannot train anything. Historical
 * work uses the FDSN event web service — the same catalog, queryable by time,
 * magnitude and region. It is official, documented and keyless; nothing here
 * scrapes a page.
 *
 * Queries are chunked by time because the service caps a single response at
 * 20,000 events, and because a polite client asks for a month at a time rather
 * than a decade in one request.
 *
 * @see https://earthquake.usgs.gov/fdsnws/event/1/
 */

const FDSN_ENDPOINT = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

/** Events one FDSN response may carry. The service rejects more. */
export const MAX_EVENTS_PER_QUERY = 20_000;

/** Default chunk when walking a long history, in days. */
export const DEFAULT_CHUNK_DAYS = 30;

/**
 * Seismic regions the forecaster is trained and evaluated on.
 *
 * A model trained on one tectonic setting does not transfer to another, so the
 * training set spans several: subduction zones, transform faults and a
 * volcanic-rift system. Each is a box because that is what both the FDSN
 * service and a map viewport speak.
 */
export const SEISMIC_REGIONS = Object.freeze([
  Object.freeze({
    id: 'japan',
    label: 'Japan',
    west: 128,
    south: 28,
    east: 148,
    north: 46,
  }),
  Object.freeze({
    id: 'california',
    label: 'California & Nevada',
    west: -125,
    south: 32,
    east: -114,
    north: 42,
  }),
  Object.freeze({
    id: 'chile',
    label: 'Chile',
    west: -76,
    south: -45,
    east: -66,
    north: -17,
  }),
  Object.freeze({
    id: 'indonesia',
    label: 'Indonesia',
    west: 95,
    south: -11,
    east: 141,
    north: 6,
  }),
  Object.freeze({
    id: 'alaska',
    label: 'Alaska',
    west: -170,
    south: 51,
    east: -130,
    north: 72,
  }),
  Object.freeze({
    id: 'aegean',
    label: 'Greece & western Türkiye',
    west: 19,
    south: 34,
    east: 32,
    north: 42,
  }),
  Object.freeze({
    id: 'iceland',
    label: 'Iceland',
    west: -25,
    south: 63,
    east: -13,
    north: 67,
  }),
]);

/**
 * Build one FDSN catalog query.
 *
 * @param {object} input Query input.
 * @param {{west: number, south: number, east: number, north: number}} input.region Bounding box.
 * @param {number|string|Date} input.start Inclusive start time.
 * @param {number|string|Date} input.end Exclusive end time.
 * @param {number} [input.minMagnitude] Magnitude floor.
 * @param {number} [input.limit] Event cap.
 * @returns {string} Request URL.
 * @throws {TypeError} When the region or window is unusable.
 */
export function catalogQueryUrl({
  region,
  start,
  end,
  minMagnitude = 2.5,
  limit = MAX_EVENTS_PER_QUERY,
}) {
  const from = new Date(start);
  const to = new Date(end);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()))
    throw new TypeError('A valid time window is required');
  if (from >= to) throw new TypeError('The window must start before it ends');
  for (const key of ['west', 'south', 'east', 'north'])
    if (!Number.isFinite(region?.[key]))
      throw new TypeError('A valid region is required');

  const params = new URLSearchParams({
    format: 'geojson',
    starttime: from.toISOString(),
    endtime: to.toISOString(),
    minlatitude: String(region.south),
    maxlatitude: String(region.north),
    minlongitude: String(region.west),
    maxlongitude: String(region.east),
    minmagnitude: String(minMagnitude),
    // Ascending keeps chunk boundaries predictable when a chunk hits the cap.
    orderby: 'time-asc',
    limit: String(
      Math.min(MAX_EVENTS_PER_QUERY, Math.max(1, Math.round(limit))),
    ),
  });
  return `${FDSN_ENDPOINT}?${params}`;
}

/**
 * Split a long window into chunks the service will answer.
 *
 * @param {number|string|Date} start Window start.
 * @param {number|string|Date} end Window end.
 * @param {number} [chunkDays] Chunk length.
 * @returns {{start: string, end: string}[]} Chunks, oldest first.
 */
export function timeChunks(start, end, chunkDays = DEFAULT_CHUNK_DAYS) {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  const step = chunkDays * 86_400_000;
  const chunks = [];
  for (let cursor = from; cursor < to; cursor += step) {
    chunks.push({
      start: new Date(cursor).toISOString(),
      end: new Date(Math.min(cursor + step, to)).toISOString(),
    });
  }
  return chunks;
}

/**
 * Sort, deduplicate and bound a catalog.
 *
 * Chunk boundaries can repeat an event, and a training set with the same event
 * twice would weight that moment twice, so identity is enforced on the USGS id.
 *
 * @param {object[]} events Normalized events.
 * @returns {object[]} Events, oldest first, unique by id.
 */
export function consolidateCatalog(events) {
  const byId = new Map();
  for (const event of events)
    if (event?.id && Number.isFinite(event.time)) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.time - b.time);
}

export { FDSN_ENDPOINT };
