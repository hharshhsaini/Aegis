/**
 * NASA FIRMS area request construction.
 *
 * Portable: builds URLs and snaps bounding boxes, and does no fetching, so the
 * same request shape serves the local development proxy today and an AWS Lambda
 * later. The MAP_KEY is passed in by the caller and never stored here — it
 * lives in server-side configuration and must never reach a browser bundle.
 *
 * FIRMS allows 5,000 transactions per 10 minutes per key, and one transaction
 * is one source for one area. The grid snapping below is the main defence:
 * every viewport within the same cell asks the same question, so it can be
 * answered from one cached response instead of one request per pan.
 */

const AREA_ENDPOINT = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

/**
 * VIIRS near-real-time sources, in coverage order.
 *
 * The three satellites are independent instruments, not duplicates of one
 * feed — a fire seen by NOAA-20 may be missed by SNPP on a different overpass —
 * so detections across sources are kept separate rather than deduplicated.
 * `DEFAULT_SOURCES` deliberately starts with ONE: it is the smallest set that
 * gives reliable coverage, and each extra source multiplies transaction cost by
 * the number of cells in view.
 */
export const VIIRS_SOURCES = Object.freeze([
  'VIIRS_NOAA20_NRT',
  'VIIRS_NOAA21_NRT',
  'VIIRS_SNPP_NRT',
]);

/** Sources queried unless a caller asks for more. */
export const DEFAULT_SOURCES = Object.freeze(['VIIRS_NOAA20_NRT']);

/**
 * Cache grid size in degrees.
 *
 * Five degrees is roughly a 550 km cell: large enough that panning across a
 * region reuses one response, small enough that a city-scale view is not paying
 * to parse a continent.
 */
export const GRID_DEGREES = 5;

/**
 * Day window requested.
 *
 * Two, not one. FIRMS counts `day_range` in whole UTC days, so `1` means "the
 * current UTC day so far" — nearly empty just after 00:00Z, which would have
 * Aegis reporting an empty sky every morning. The request covers two days and
 * the parser clamps to the trailing 24 hours, so the window is a real day
 * whatever the hour. (The repository's older world-wide FIRMS proxy learned the
 * same lesson; this keeps the two consistent.)
 */
export const DEFAULT_DAY_RANGE = 2;

/** Detections older than this are dropped after the two-day request. */
export const DETECTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Largest area FIRMS accepts in one area request, in square degrees. */
const MAX_AREA_SQUARE_DEGREES = 8_000;

/**
 * Snap a bounding box outward onto the shared cache grid.
 *
 * Snapping OUTWARD matters: a box rounded inward would exclude detections the
 * viewer can see at the edge of the screen.
 *
 * @param {{west: number, south: number, east: number, north: number}} bbox Requested box.
 * @param {number} [grid] Grid size in degrees.
 * @returns {{west: number, south: number, east: number, north: number}|null} Snapped box, or null when invalid.
 */
export function snapBoundingBox(bbox, grid = GRID_DEGREES) {
  const { west, south, east, north } = bbox || {};
  if (![west, south, east, north].every((value) => Number.isFinite(value)))
    return null;
  if (south >= north || west >= east) return null;
  const snapped = {
    west: Math.max(-180, Math.floor(west / grid) * grid),
    south: Math.max(-90, Math.floor(south / grid) * grid),
    east: Math.min(180, Math.ceil(east / grid) * grid),
    north: Math.min(90, Math.ceil(north / grid) * grid),
  };
  // A view narrower than one cell still needs a cell with area.
  if (snapped.east <= snapped.west)
    snapped.east = Math.min(180, snapped.west + grid);
  if (snapped.north <= snapped.south)
    snapped.north = Math.min(90, snapped.south + grid);
  return snapped;
}

/**
 * Clamp a snapped box to the largest area worth requesting.
 *
 * A globe-wide view would otherwise ask for every fire on Earth and return a
 * response too large to be useful at that zoom. When the view is that wide the
 * box is centred and trimmed, and the caller is told the result is partial.
 *
 * @param {{west: number, south: number, east: number, north: number}} bbox Snapped box.
 * @returns {{bbox: object, clamped: boolean}} Possibly trimmed box.
 */
export function clampBoundingBox(bbox) {
  const width = bbox.east - bbox.west;
  const height = bbox.north - bbox.south;
  if (width * height <= MAX_AREA_SQUARE_DEGREES)
    return { bbox, clamped: false };
  const centreX = (bbox.east + bbox.west) / 2;
  const centreY = (bbox.north + bbox.south) / 2;
  const scale = Math.sqrt(MAX_AREA_SQUARE_DEGREES / (width * height));
  // Round the half-extents DOWN. Rounding outward is the intuitive choice and
  // the wrong one here: it pushes the result back over the very limit this
  // function exists to respect, and FIRMS rejects the request.
  const halfWidth = Math.floor((width * scale) / 2);
  const halfHeight = Math.floor((height * scale) / 2);
  return {
    bbox: {
      west: Math.max(-180, centreX - halfWidth),
      south: Math.max(-90, centreY - halfHeight),
      east: Math.min(180, centreX + halfWidth),
      north: Math.min(90, centreY + halfHeight),
    },
    clamped: true,
  };
}

/**
 * A stable cache key for one area query.
 * @param {object} bbox Snapped box.
 * @param {string} source FIRMS source id.
 * @param {number} dayRange Day window.
 * @returns {string} Cache key.
 */
export function areaKey(bbox, source, dayRange) {
  return `${source}:${dayRange}:${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
}

/**
 * Build one FIRMS area CSV request.
 *
 * @param {object} input Request input.
 * @param {string} input.mapKey FIRMS MAP_KEY — server-side only.
 * @param {string} input.source FIRMS source id, e.g. `VIIRS_NOAA20_NRT`.
 * @param {{west: number, south: number, east: number, north: number}} input.bbox Snapped box.
 * @param {number} [input.dayRange] Day window.
 * @returns {string} Request URL.
 * @throws {TypeError} When the key, source or box is unusable.
 */
export function areaRequestUrl({
  mapKey,
  source,
  bbox,
  dayRange = DEFAULT_DAY_RANGE,
}) {
  const key = String(mapKey || '').trim();
  if (!key) throw new TypeError('A FIRMS MAP_KEY is required');
  if (!VIIRS_SOURCES.includes(source))
    throw new TypeError(`Unsupported FIRMS source: ${source}`);
  if (!bbox || !Number.isFinite(bbox.west))
    throw new TypeError('A valid bounding box is required');
  const days = Math.min(10, Math.max(1, Math.round(dayRange)));
  // FIRMS orders the area as west,south,east,north.
  const area = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
  return `${AREA_ENDPOINT}/${encodeURIComponent(key)}/${source}/${area}/${days}`;
}

/**
 * Redact a MAP_KEY from any string before it is logged or returned.
 *
 * Upstream error messages and stack traces can carry the request URL. This is
 * the last line of defence that keeps the key out of logs and out of responses.
 *
 * @param {string} text Text that may contain the key.
 * @param {string} mapKey Key to redact.
 * @returns {string} Text with the key replaced.
 */
export function redactMapKey(text, mapKey) {
  const key = String(mapKey || '').trim();
  const value = String(text ?? '');
  return key ? value.split(key).join('«FIRMS_KEY»') : value;
}

export { AREA_ENDPOINT, MAX_AREA_SQUARE_DEGREES };
