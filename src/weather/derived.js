import {
  TREND_DEADBANDS,
  WEATHER_CODE_SEVERITY,
  HEAT,
} from '../risk/thresholds.js';

/**
 * Derived metrics — the layer between raw readings and risk scores.
 *
 * A hazard is rarely visible in one number. Flooding lives in accumulation over
 * hours against how much water the ground can still take; a flash flood lives in
 * the RATE and its acceleration; a squall lives in the pressure change. This
 * module turns the hourly series into those quantities, at an arbitrary anchor
 * hour, which is also what makes forecast scoring possible: ask for the metrics
 * anchored at +6 h and every model scores that hour with no special casing.
 *
 * Every function tolerates gaps. A missing variable yields null rather than 0,
 * so a model can tell "no rain" apart from "no rain data" and weight it away.
 */

/** Sum a variable over a window, ignoring gaps. Returns null when all values are missing. */
function windowSum(series, variable, from, to) {
  const values = series[variable];
  if (!Array.isArray(values)) return null;
  let sum = 0;
  let seen = 0;
  for (
    let i = Math.max(0, from);
    i <= Math.min(values.length - 1, to);
    i += 1
  ) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    sum += value;
    seen += 1;
  }
  return seen ? Number(sum.toFixed(3)) : null;
}

/** Mean of a variable over a window, ignoring gaps. */
function windowMean(series, variable, from, to) {
  const values = series[variable];
  if (!Array.isArray(values)) return null;
  let sum = 0;
  let seen = 0;
  for (
    let i = Math.max(0, from);
    i <= Math.min(values.length - 1, to);
    i += 1
  ) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    sum += value;
    seen += 1;
  }
  return seen ? Number((sum / seen).toFixed(3)) : null;
}

/** Maximum of a variable over a window, ignoring gaps. */
function windowMax(series, variable, from, to) {
  const values = series[variable];
  if (!Array.isArray(values)) return null;
  let max = null;
  for (
    let i = Math.max(0, from);
    i <= Math.min(values.length - 1, to);
    i += 1
  ) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    max = max === null ? value : Math.max(max, value);
  }
  return max;
}

/** Read one value, or null when absent. */
function at(series, variable, index) {
  const values = series[variable];
  if (!Array.isArray(values) || index < 0 || index >= values.length)
    return null;
  return Number.isFinite(values[index]) ? values[index] : null;
}

/** Count hours in a window whose value meets a threshold. */
function hoursAtOrAbove(series, variable, from, to, threshold) {
  const values = series[variable];
  if (!Array.isArray(values)) return null;
  let count = 0;
  let seen = 0;
  for (
    let i = Math.max(0, from);
    i <= Math.min(values.length - 1, to);
    i += 1
  ) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    seen += 1;
    if (value >= threshold) count += 1;
  }
  return seen ? count : null;
}

/**
 * Signed difference between two compass bearings, in degrees 0..180.
 * @param {number|null} a First bearing.
 * @param {number|null} b Second bearing.
 * @returns {number|null} Angular separation.
 */
export function bearingDelta(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const delta = Math.abs(((a - b + 540) % 360) - 180);
  return Number(delta.toFixed(1));
}

/**
 * Soil moisture as one index.
 *
 * The five Open-Meteo layers are depth-weighted to the top 27 cm — the column
 * that governs whether rain runs off or soaks in. Deeper layers respond too
 * slowly to matter for a six-hour flood window, so they are weighted lightly.
 *
 * @param {object} series Hourly series.
 * @param {number} index Anchor hour.
 * @returns {number|null} Weighted volumetric water content (m³/m³).
 */
export function soilMoistureIndex(series, index) {
  const layers = [
    ['soil_moisture_0_to_1cm', 0.14],
    ['soil_moisture_1_to_3cm', 0.2],
    ['soil_moisture_3_to_9cm', 0.28],
    ['soil_moisture_9_to_27cm', 0.26],
    ['soil_moisture_27_to_81cm', 0.12],
  ];
  let sum = 0;
  let weight = 0;
  for (const [variable, layerWeight] of layers) {
    const value = at(series, variable, index);
    if (value === null) continue;
    sum += value * layerWeight;
    weight += layerWeight;
  }
  return weight ? Number((sum / weight).toFixed(4)) : null;
}

/**
 * Classify a change as increasing, stable or decreasing.
 *
 * The deadband is the whole point: without one, every metric always has a
 * direction and the UI cries wolf on sensor noise.
 *
 * @param {number|null} change Signed change in the metric's own units.
 * @param {number} deadband Minimum magnitude that counts as movement.
 * @returns {'INCREASING'|'DECREASING'|'STABLE'|'UNKNOWN'} Direction.
 */
export function classifyTrend(change, deadband) {
  if (!Number.isFinite(change)) return 'UNKNOWN';
  if (change >= deadband) return 'INCREASING';
  if (change <= -deadband) return 'DECREASING';
  return 'STABLE';
}

/**
 * Build a trend record for one metric.
 * @param {string} id Metric id.
 * @param {number|null} current Current value.
 * @param {number|null} previous Earlier value.
 * @param {number} deadband Movement threshold.
 * @returns {object} Frozen trend record.
 */
export function trendRecord(id, current, previous, deadband) {
  const change =
    Number.isFinite(current) && Number.isFinite(previous)
      ? Number((current - previous).toFixed(3))
      : null;
  return Object.freeze({
    id,
    current: Number.isFinite(current) ? current : null,
    previous: Number.isFinite(previous) ? previous : null,
    change,
    direction: classifyTrend(change, deadband),
  });
}

/**
 * Severity carried by a WMO weather code on its own, 0..1.
 * @param {number|null} code WMO weather code.
 * @returns {number} Severity contribution.
 */
export function weatherCodeSeverity(code) {
  if (!Number.isFinite(code)) return 0;
  return WEATHER_CODE_SEVERITY[Math.round(code)] ?? 0;
}

/**
 * Compute every derived metric at one anchor hour.
 *
 * Past windows look backward from the anchor inclusive; forecast windows look
 * strictly forward. Anchoring at the current hour gives the live picture;
 * anchoring at +6 h gives the projected picture, and the two are computed by the
 * same code so a forecast score cannot drift from a current one.
 *
 * @param {object} snapshot Normalized snapshot.
 * @param {number} [index] Anchor hour; defaults to the snapshot's current hour.
 * @returns {object} Frozen derived-metric record.
 */
export function deriveMetrics(snapshot, index = snapshot?.currentIndex ?? 0) {
  const series = snapshot?.series || {};
  const anchor = Math.max(0, Math.min(index, (series.time?.length || 1) - 1));

  const rain1h = windowSum(series, 'precipitation', anchor, anchor);
  const rain3h = windowSum(series, 'precipitation', anchor - 2, anchor);
  const rain6h = windowSum(series, 'precipitation', anchor - 5, anchor);
  const rain12h = windowSum(series, 'precipitation', anchor - 11, anchor);
  const rain24h = windowSum(series, 'precipitation', anchor - 23, anchor);
  const priorRain3h = windowSum(
    series,
    'precipitation',
    anchor - 5,
    anchor - 3,
  );
  const priorRain1hMean = windowMean(
    series,
    'precipitation',
    anchor - 3,
    anchor - 1,
  );

  const soilIndex = soilMoistureIndex(series, anchor);
  const soilSaturation = (() => {
    const top = [
      at(series, 'soil_moisture_0_to_1cm', anchor),
      at(series, 'soil_moisture_1_to_3cm', anchor),
      at(series, 'soil_moisture_3_to_9cm', anchor),
    ].filter((value) => value !== null);
    if (!top.length) return null;
    return Number(
      (top.reduce((sum, value) => sum + value, 0) / top.length).toFixed(4),
    );
  })();

  const pressureNow = at(series, 'pressure_msl', anchor);
  const pressure3hAgo = at(series, 'pressure_msl', anchor - 3);
  const windNow = at(series, 'wind_speed_10m', anchor);
  const wind3hAgo = at(series, 'wind_speed_10m', anchor - 3);
  const wind180 = at(series, 'wind_speed_180m', anchor);
  const gusts = at(series, 'wind_gusts_10m', anchor);
  const temperature = at(series, 'temperature_2m', anchor);
  const temperature3hAgo = at(series, 'temperature_2m', anchor - 3);
  const humidity = at(series, 'relative_humidity_2m', anchor);
  const humidity3hAgo = at(series, 'relative_humidity_2m', anchor - 3);
  const dewPoint = at(series, 'dew_point_2m', anchor);
  const soil3hAgo = soilMoistureIndex(series, anchor - 3);

  const forecastRain3h = windowSum(
    series,
    'precipitation',
    anchor + 1,
    anchor + 3,
  );
  const forecastRain6h = windowSum(
    series,
    'precipitation',
    anchor + 1,
    anchor + 6,
  );
  const forecastRain12h = windowSum(
    series,
    'precipitation',
    anchor + 1,
    anchor + 12,
  );
  const forecastRain24h = windowSum(
    series,
    'precipitation',
    anchor + 1,
    anchor + 24,
  );
  const priorForecastRain6h = windowSum(
    series,
    'precipitation',
    anchor - 5,
    anchor,
  );

  const metrics = {
    anchorIndex: anchor,
    anchorTime: series.time?.[anchor]
      ? new Date(series.time[anchor]).toISOString()
      : null,

    // Accumulation — how much water has already arrived.
    rain_1h: rain1h,
    rain_3h: rain3h,
    rain_6h: rain6h,
    rain_12h: rain12h,
    rain_24h: rain24h,
    showers_3h: windowSum(series, 'showers', anchor - 2, anchor),
    snowfall_6h: windowSum(series, 'snowfall', anchor - 5, anchor),
    snow_depth: at(series, 'snow_depth', anchor),

    // Forward-looking precipitation.
    forecast_rain_3h: forecastRain3h,
    forecast_rain_6h: forecastRain6h,
    forecast_rain_12h: forecastRain12h,
    forecast_rain_24h: forecastRain24h,
    peak_forecast_rain_rate_3h: windowMax(
      series,
      'precipitation',
      anchor + 1,
      anchor + 3,
    ),
    peak_forecast_rain_rate_6h: windowMax(
      series,
      'precipitation',
      anchor + 1,
      anchor + 6,
    ),
    precipitation_probability: at(series, 'precipitation_probability', anchor),
    precipitation_probability_3h: windowMax(
      series,
      'precipitation_probability',
      anchor + 1,
      anchor + 3,
    ),
    precipitation_probability_6h: windowMax(
      series,
      'precipitation_probability',
      anchor + 1,
      anchor + 6,
    ),

    // Rate of change — the difference between a soaking and a flash flood.
    rainfall_trend:
      Number.isFinite(rain3h) && Number.isFinite(priorRain3h)
        ? Number((rain3h - priorRain3h).toFixed(3))
        : null,
    rain_acceleration:
      Number.isFinite(rain1h) && Number.isFinite(priorRain1hMean)
        ? Number((rain1h - priorRain1hMean).toFixed(3))
        : null,
    forecast_rain_change:
      Number.isFinite(forecastRain6h) && Number.isFinite(priorForecastRain6h)
        ? Number((forecastRain6h - priorForecastRain6h).toFixed(3))
        : null,

    // Ground state.
    soil_moisture_index: soilIndex,
    soil_saturation: soilSaturation,

    // Atmosphere and wind structure.
    pressure_msl: pressureNow,
    pressure_change_3h:
      Number.isFinite(pressureNow) && Number.isFinite(pressure3hAgo)
        ? Number((pressureNow - pressure3hAgo).toFixed(2))
        : null,
    wind_speed_10m: windNow,
    wind_gusts_10m: gusts,
    wind_change_3h:
      Number.isFinite(windNow) && Number.isFinite(wind3hAgo)
        ? Number((windNow - wind3hAgo).toFixed(2))
        : null,
    wind_shear:
      Number.isFinite(wind180) && Number.isFinite(windNow)
        ? Number((wind180 - windNow).toFixed(2))
        : null,
    gust_factor:
      Number.isFinite(gusts) && Number.isFinite(windNow) && windNow > 1
        ? Number((gusts / windNow).toFixed(2))
        : null,
    wind_direction_10m: at(series, 'wind_direction_10m', anchor),
    wind_direction_change_3h: bearingDelta(
      at(series, 'wind_direction_10m', anchor),
      at(series, 'wind_direction_10m', anchor - 3),
    ),
    peak_forecast_gusts_6h: windowMax(
      series,
      'wind_gusts_10m',
      anchor + 1,
      anchor + 6,
    ),

    // Thermal and moisture state.
    temperature_2m: temperature,
    apparent_temperature: at(series, 'apparent_temperature', anchor),
    relative_humidity_2m: humidity,
    dew_point_2m: dewPoint,
    dew_point_spread:
      Number.isFinite(temperature) && Number.isFinite(dewPoint)
        ? Number((temperature - dewPoint).toFixed(2))
        : null,
    vapour_pressure_deficit: at(series, 'vapour_pressure_deficit', anchor),
    et0_fao_evapotranspiration: at(
      series,
      'et0_fao_evapotranspiration',
      anchor,
    ),
    heat_hours_24h: hoursAtOrAbove(
      series,
      'apparent_temperature',
      anchor + 1,
      anchor + 24,
      HEAT.durationThresholdC,
    ),

    // Visibility and sky.
    visibility: at(series, 'visibility', anchor),
    cloud_cover: at(series, 'cloud_cover', anchor),
    cloud_cover_low: at(series, 'cloud_cover_low', anchor),
    weather_code: at(series, 'weather_code', anchor),
    weather_code_severity: weatherCodeSeverity(
      at(series, 'weather_code', anchor),
    ),
  };

  metrics.trends = Object.freeze({
    rainfall: trendRecord(
      'rainfall',
      rain3h,
      priorRain3h,
      TREND_DEADBANDS.rain,
    ),
    forecastRain: trendRecord(
      'forecastRain',
      forecastRain6h,
      priorForecastRain6h,
      TREND_DEADBANDS.rain,
    ),
    soilMoisture: trendRecord(
      'soilMoisture',
      soilIndex,
      soil3hAgo,
      TREND_DEADBANDS.soilMoisture,
    ),
    pressure: trendRecord(
      'pressure',
      pressureNow,
      pressure3hAgo,
      TREND_DEADBANDS.pressure,
    ),
    wind: trendRecord('wind', windNow, wind3hAgo, TREND_DEADBANDS.wind),
    temperature: trendRecord(
      'temperature',
      temperature,
      temperature3hAgo,
      TREND_DEADBANDS.temperature,
    ),
    humidity: trendRecord(
      'humidity',
      humidity,
      humidity3hAgo,
      TREND_DEADBANDS.humidity,
    ),
  });

  return Object.freeze(metrics);
}
