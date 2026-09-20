/**
 * Open-Meteo request construction for the Aegis weather intelligence engine.
 *
 * Portable by design: this module builds a URL and validates a point, and does
 * no fetching, so the same request shape is used by the local development proxy
 * today and by an AWS Lambda later. Open-Meteo's forecast endpoint is public and
 * keyless — there is no credential here to leak — but the request is still made
 * server-side so responses can be cached and coalesced for every client at once.
 *
 * One request carries every variable the engine needs. Open-Meteo bills a call
 * by its weight rather than its variable count, and splitting variables across
 * calls would also hand the engine hours sampled at different moments.
 */

const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/**
 * Hourly variables the risk models read. The list is exhaustive on purpose:
 * accumulation windows, soil columns and the wind/temperature profile all feed
 * derived metrics, and a partial list would silently weaken a hazard score.
 */
export const HOURLY_VARIABLES = Object.freeze([
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'apparent_temperature',
  'precipitation_probability',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'snow_depth',
  'weather_code',
  'pressure_msl',
  'surface_pressure',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'visibility',
  'evapotranspiration',
  'et0_fao_evapotranspiration',
  'vapour_pressure_deficit',
  'wind_speed_10m',
  'wind_speed_80m',
  'wind_speed_120m',
  'wind_speed_180m',
  'wind_direction_10m',
  'wind_direction_80m',
  'wind_direction_120m',
  'wind_direction_180m',
  'wind_gusts_10m',
  'temperature_80m',
  'temperature_120m',
  'temperature_180m',
  'soil_temperature_0cm',
  'soil_temperature_6cm',
  'soil_temperature_18cm',
  'soil_temperature_54cm',
  'soil_moisture_0_to_1cm',
  'soil_moisture_1_to_3cm',
  'soil_moisture_3_to_9cm',
  'soil_moisture_9_to_27cm',
  'soil_moisture_27_to_81cm',
]);

/** Current-conditions variables shown in the panel's situation header. */
export const CURRENT_VARIABLES = Object.freeze([
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'is_day',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'weather_code',
  'cloud_cover',
  'pressure_msl',
  'surface_pressure',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
]);

/**
 * Hours of observation history requested alongside the forecast.
 *
 * The engine's accumulation windows (rain_6h, rain_24h) and its trend and
 * anomaly comparisons are measured against real past hours from this same
 * response — not against whatever the process happened to observe earlier — so
 * a first analysis is as complete as the hundredth.
 */
export const PAST_HOURS = 24;

/** Hours of forecast requested; covers the 24 h horizon with room for windows. */
export const FORECAST_HOURS = 48;

/**
 * Validate and round a coordinate pair.
 *
 * Rounding is the cache key policy: weather fields do not change meaningfully
 * across ~1 km, so two nearby requests should share one upstream call rather
 * than each opening their own.
 *
 * @param {number} latitude Degrees north.
 * @param {number} longitude Degrees east.
 * @param {number} [precision=2] Decimal places to round to.
 * @returns {{latitude: number, longitude: number}|null} Rounded point, or null when invalid.
 */
export function normalizePoint(latitude, longitude, precision = 2) {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  )
    return null;
  const factor = 10 ** precision;
  return {
    latitude: Math.round(latitude * factor) / factor,
    longitude: Math.round(longitude * factor) / factor,
  };
}

/**
 * A stable cache key for a point.
 * @param {{latitude: number, longitude: number}} point Normalized point.
 * @returns {string} Cache key.
 */
export function pointKey({ latitude, longitude }) {
  return `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
}

/**
 * Build the single batched forecast request for a point.
 *
 * @param {object} input Request input.
 * @param {number} input.latitude Degrees north.
 * @param {number} input.longitude Degrees east.
 * @param {string[]} [input.hourly] Hourly variables; defaults to {@link HOURLY_VARIABLES}.
 * @param {string[]} [input.current] Current variables; defaults to {@link CURRENT_VARIABLES}.
 * @param {number} [input.pastHours] Observation hours; defaults to {@link PAST_HOURS}.
 * @param {number} [input.forecastHours] Forecast hours; defaults to {@link FORECAST_HOURS}.
 * @returns {string} Fully formed Open-Meteo request URL.
 * @throws {TypeError} When the coordinates are not valid.
 */
export function forecastRequestUrl({
  latitude,
  longitude,
  hourly = HOURLY_VARIABLES,
  current = CURRENT_VARIABLES,
  pastHours = PAST_HOURS,
  forecastHours = FORECAST_HOURS,
}) {
  const point = normalizePoint(latitude, longitude, 4);
  if (!point) throw new TypeError('Valid coordinates are required');
  const params = new URLSearchParams({
    latitude: point.latitude.toFixed(4),
    longitude: point.longitude.toFixed(4),
    hourly: hourly.join(','),
    current: current.join(','),
    past_hours: String(pastHours),
    forecast_hours: String(forecastHours),
    timezone: 'UTC',
    // Units are named explicitly: every threshold in risk/thresholds.js is
    // written in these units, and an API default change must not rescale them.
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
    precipitation_unit: 'mm',
  });
  return `${FORECAST_ENDPOINT}?${params}`;
}

export { FORECAST_ENDPOINT };
