import { HOURLY_VARIABLES } from '../../sources/openMeteo.js';

/**
 * Synthetic Open-Meteo payloads for risk-model tests.
 *
 * Real responses cannot exercise the models: the tests need a saturated
 * catchment under a cloudburst, a 45°C afternoon and a fog bank on demand, and
 * they must not reach the network to get them. This builder produces payloads
 * in exactly the shape `normalizeForecast` parses, so a test constructs a
 * SITUATION and the production path handles it unchanged.
 *
 * Defaults describe a quiet, temperate day, so any hazard a test sees comes
 * from what that test asked for.
 */

/** Baseline hourly values for an unremarkable day. */
const CALM = Object.freeze({
  temperature_2m: 18,
  relative_humidity_2m: 60,
  dew_point_2m: 10,
  apparent_temperature: 18,
  precipitation_probability: 5,
  precipitation: 0,
  rain: 0,
  showers: 0,
  snowfall: 0,
  snow_depth: 0,
  weather_code: 1,
  pressure_msl: 1015,
  surface_pressure: 1010,
  cloud_cover: 20,
  cloud_cover_low: 10,
  cloud_cover_mid: 10,
  cloud_cover_high: 10,
  visibility: 24000,
  evapotranspiration: 0.1,
  et0_fao_evapotranspiration: 0.2,
  vapour_pressure_deficit: 0.6,
  wind_speed_10m: 8,
  wind_speed_80m: 12,
  wind_speed_120m: 14,
  wind_speed_180m: 16,
  wind_direction_10m: 200,
  wind_direction_80m: 205,
  wind_direction_120m: 210,
  wind_direction_180m: 215,
  wind_gusts_10m: 14,
  temperature_80m: 17,
  temperature_120m: 16,
  temperature_180m: 15,
  soil_temperature_0cm: 17,
  soil_temperature_6cm: 17,
  soil_temperature_18cm: 16,
  soil_temperature_54cm: 15,
  soil_moisture_0_to_1cm: 0.18,
  soil_moisture_1_to_3cm: 0.18,
  soil_moisture_3_to_9cm: 0.19,
  soil_moisture_9_to_27cm: 0.2,
  soil_moisture_27_to_81cm: 0.22,
});

export const PAST_HOURS = 24;
export const FORECAST_HOURS = 48;

/**
 * Build a synthetic forecast payload.
 *
 * @param {object} [options] Build options.
 * @param {object} [options.base] Overrides applied to every hour.
 * @param {(hour: number, values: object) => object} [options.shape]
 *   Per-hour transform. `hour` is relative to now: negative is observed past,
 *   0 is the current hour, positive is forecast.
 * @param {number} [options.latitude] Payload latitude.
 * @param {number} [options.longitude] Payload longitude.
 * @param {string} [options.now] ISO instant for the current hour.
 * @returns {object} Payload shaped like an Open-Meteo forecast response.
 */
export function syntheticForecast({
  base = {},
  shape = (_hour, values) => values,
  latitude = 27.7,
  longitude = 85.3,
  now = '2026-09-18T12:00:00Z',
} = {}) {
  const currentMs = Date.parse(now);
  const hourly = { time: [] };
  for (const variable of HOURLY_VARIABLES) hourly[variable] = [];

  for (let hour = -PAST_HOURS; hour <= FORECAST_HOURS; hour += 1) {
    const stamp = new Date(currentMs + hour * 3_600_000)
      .toISOString()
      .slice(0, 16);
    hourly.time.push(stamp);
    const values = shape(hour, { ...CALM, ...base });
    for (const variable of HOURLY_VARIABLES)
      hourly[variable].push(
        values[variable] === undefined ? null : values[variable],
      );
  }

  const currentValues = shape(0, { ...CALM, ...base });
  return {
    latitude,
    longitude,
    elevation: 1300,
    timezone: 'GMT',
    utc_offset_seconds: 0,
    hourly_units: {
      precipitation: 'mm',
      wind_speed_10m: 'km/h',
      visibility: 'm',
    },
    current: {
      time: now.slice(0, 16),
      interval: 900,
      temperature_2m: currentValues.temperature_2m,
      relative_humidity_2m: currentValues.relative_humidity_2m,
      apparent_temperature: currentValues.apparent_temperature,
      is_day: 1,
      precipitation: currentValues.precipitation,
      rain: currentValues.rain,
      showers: currentValues.showers,
      snowfall: currentValues.snowfall,
      weather_code: currentValues.weather_code,
      cloud_cover: currentValues.cloud_cover,
      pressure_msl: currentValues.pressure_msl,
      surface_pressure: currentValues.surface_pressure,
      wind_speed_10m: currentValues.wind_speed_10m,
      wind_direction_10m: currentValues.wind_direction_10m,
      wind_gusts_10m: currentValues.wind_gusts_10m,
    },
    hourly,
  };
}

export { CALM };
