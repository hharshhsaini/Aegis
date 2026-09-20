import { HOURLY_VARIABLES } from '../sources/openMeteo.js';

/**
 * Turn one Open-Meteo forecast payload into the snapshot every risk model
 * reads.
 *
 * The engine never touches the raw response shape. That indirection is what
 * lets a second provider — or an AWS Lambda reading from DynamoDB — feed the
 * same models later: match this snapshot and every hazard score still works.
 *
 * Open-Meteo returns UTC timestamps without a zone designator (`2026-09-18T08:00`)
 * because it also serves local-time responses. This module requests UTC and
 * parses accordingly; treating those strings as local time would shift every
 * accumulation window by the viewer's offset.
 */

/**
 * Parse an Open-Meteo UTC timestamp to epoch milliseconds.
 * @param {string} value Timestamp such as `2026-09-18T08:00`.
 * @returns {number|null} Epoch milliseconds, or null when unparseable.
 */
export function parseUtc(value) {
  if (typeof value !== 'string' || !value) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? value
    : `${value}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Coerce an API reading to a number, mapping null and NaN alike to null. */
function numeric(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Locate the hour that contains an instant.
 *
 * Open-Meteo's `current` block is sampled at 15-minute intervals while the
 * series is hourly, so the current hour is the last hour at or before the
 * observation — never the next one, whose values are a forecast.
 *
 * @param {number[]} times Epoch milliseconds, ascending.
 * @param {number} instant Epoch milliseconds.
 * @returns {number} Index of the containing hour, clamped into range.
 */
export function hourIndexFor(times, instant) {
  if (!times.length) return -1;
  if (!Number.isFinite(instant)) return 0;
  let index = 0;
  for (let i = 0; i < times.length; i += 1) {
    if (times[i] <= instant) index = i;
    else break;
  }
  return index;
}

/**
 * Normalize an Open-Meteo forecast response.
 *
 * @param {object} payload Raw Open-Meteo JSON.
 * @param {object} [input] Context.
 * @param {number} [input.latitude] Requested latitude, used when the response omits one.
 * @param {number} [input.longitude] Requested longitude.
 * @param {string} [input.retrievedAt] ISO instant the response was fetched.
 * @returns {object|null} Frozen snapshot, or null when the payload is unusable.
 */
export function normalizeForecast(
  payload,
  { latitude, longitude, retrievedAt } = {},
) {
  const hourly = payload?.hourly;
  const times = Array.isArray(hourly?.time)
    ? hourly.time.map(parseUtc).filter((value) => value !== null)
    : [];
  if (times.length < 2) return null;

  const series = { time: Object.freeze(times) };
  for (const variable of HOURLY_VARIABLES) {
    const values = hourly[variable];
    series[variable] = Object.freeze(
      Array.isArray(values)
        ? values.slice(0, times.length).map(numeric)
        : new Array(times.length).fill(null),
    );
  }

  const rawCurrent = payload?.current || {};
  const observedAtMs = parseUtc(rawCurrent.time) ?? times[0];
  const currentIndex = hourIndexFor(times, observedAtMs);
  const current = {};
  for (const [key, value] of Object.entries(rawCurrent)) {
    if (key === 'time' || key === 'interval') continue;
    current[key] = numeric(value);
  }

  return Object.freeze({
    location: Object.freeze({
      latitude: numeric(payload?.latitude) ?? numeric(latitude),
      longitude: numeric(payload?.longitude) ?? numeric(longitude),
      elevation: numeric(payload?.elevation),
      timezone: payload?.timezone || 'UTC',
    }),
    observedAt: new Date(observedAtMs).toISOString(),
    retrievedAt: retrievedAt || new Date().toISOString(),
    currentIndex,
    current: Object.freeze(current),
    series: Object.freeze(series),
    units: Object.freeze({ ...(payload?.hourly_units || {}) }),
  });
}
