import { parseFirmsCsv, acquisitionMsUtc } from '../data/firmsCsv.js';

/**
 * FIRMS rows to Aegis fire detections.
 *
 * What FIRMS publishes is a THERMAL ANOMALY: a pixel whose infrared signature
 * exceeded a threshold. It is not a confirmed wildfire, and the vocabulary here
 * keeps that straight — `detection`, never `fire event`. Gas flares, industrial
 * heat, and hot bare ground all appear in this feed, which is exactly why a
 * single detection is reported as a detection and only a coherent cluster is
 * described as fire activity.
 *
 * Confidence arrives two different ways depending on the product: VIIRS uses
 * the categorical l/n/h, MODIS a 0–100 number. Both are normalized to 0..1 so
 * the cluster statistics can average them, with the original value kept.
 */

/** Categorical VIIRS confidence to a comparable fraction. */
const CONFIDENCE_CLASSES = Object.freeze({ l: 0.3, n: 0.65, h: 0.9 });

/**
 * Normalize a FIRMS confidence value to 0..1.
 * @param {string|number} value Raw confidence.
 * @returns {number|null} Fraction, or null when unreadable.
 */
export function normalizeConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (text in CONFIDENCE_CLASSES) return CONFIDENCE_CLASSES[text];
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(1, Math.max(0, numeric / 100));
}

/** Friendly satellite names for the panel. FIRMS ships terse platform codes. */
const SATELLITE_NAMES = Object.freeze({
  N: 'Suomi NPP',
  N20: 'NOAA-20',
  N21: 'NOAA-21',
  1: 'Terra',
  A: 'Aqua',
  T: 'Terra',
});

/**
 * A stable id for one detection.
 *
 * FIRMS has no detection id, so identity is the pixel and the acquisition:
 * position, time and platform. This is what lets consecutive observations be
 * compared — which detections are new, which have disappeared — without a
 * database.
 *
 * @param {object} record Normalized detection fields.
 * @returns {string} Detection id.
 */
export function detectionId({ latitude, longitude, acquiredAt, satellite }) {
  return `${latitude.toFixed(5)},${longitude.toFixed(5)}@${acquiredAt}#${satellite || '?'}`;
}

/**
 * Convert one parsed CSV row into an Aegis detection.
 * @param {object} row Row from `parseFirmsCsv`.
 * @param {string} source FIRMS source id the row came from.
 * @returns {object|null} Frozen detection, or null when the row is unusable.
 */
export function toDetection(row, source) {
  if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lon)) return null;
  const acquiredMs = acquisitionMsUtc(row.acqDate, row.acqTime);
  if (!Number.isFinite(acquiredMs)) return null;
  const detection = {
    latitude: row.lat,
    longitude: row.lon,
    acquiredAt: new Date(acquiredMs).toISOString(),
    acquiredMs,
    satellite: row.satellite || '',
    satelliteName: SATELLITE_NAMES[row.satellite] || row.satellite || 'Unknown',
    instrument: row.instrument || 'VIIRS',
    confidence: normalizeConfidence(row.confidence),
    confidenceRaw: row.confidence ?? null,
    brightnessTemperature: Number.isFinite(row.brightness)
      ? row.brightness
      : null,
    brightnessTemperatureTi5: Number.isFinite(row.brightnessTi5)
      ? row.brightnessTi5
      : null,
    fireRadiativePower: Number.isFinite(row.frp) ? row.frp : null,
    dayNight:
      row.daynight === 'D' ? 'DAY' : row.daynight === 'N' ? 'NIGHT' : null,
    source,
    provider: 'NASA FIRMS',
  };
  return Object.freeze({ ...detection, id: detectionId(detection) });
}

/**
 * Parse one FIRMS CSV response into detections.
 *
 * @param {string} csv Raw CSV body.
 * @param {object} [options] Options.
 * @param {string} [options.source] FIRMS source id.
 * @param {number} [options.maxAgeMs] Discard detections older than this.
 * @param {number} [options.now] Clock for the age filter.
 * @returns {object[]} Frozen detections, newest first.
 */
export function parseDetections(
  csv,
  { source = 'UNKNOWN', maxAgeMs, now = Date.now() } = {},
) {
  const rows = parseFirmsCsv(csv);
  if (!Array.isArray(rows)) return [];
  const detections = [];
  for (const row of rows) {
    const detection = toDetection(row, source);
    if (!detection) continue;
    if (Number.isFinite(maxAgeMs) && now - detection.acquiredMs > maxAgeMs)
      continue;
    detections.push(detection);
  }
  return detections.sort((a, b) => b.acquiredMs - a.acquiredMs);
}

/**
 * Keep only detections inside a bounding box.
 *
 * The cache grid is deliberately coarser than the viewport, so a cached cell
 * carries detections outside the area actually asked about. Filtering happens
 * on the way out, not on the way in, so one cached response can serve many
 * different viewports.
 *
 * @param {object[]} detections Detections.
 * @param {{west: number, south: number, east: number, north: number}} bbox Box.
 * @returns {object[]} Detections within the box.
 */
export function withinBoundingBox(detections, bbox) {
  if (!bbox) return detections;
  return detections.filter(
    (detection) =>
      detection.latitude >= bbox.south &&
      detection.latitude <= bbox.north &&
      detection.longitude >= bbox.west &&
      detection.longitude <= bbox.east,
  );
}
