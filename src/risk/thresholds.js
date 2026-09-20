/**
 * Every number the Aegis risk engine judges a situation by lives here.
 *
 * The engine itself contains no magic constants: a model asks this module where
 * a signal starts to matter and where it saturates, then reports how far along
 * that ramp the observation sits. Tuning risk is therefore a change to this
 * file, reviewable on its own, without touching scoring logic.
 *
 * Units follow the Open-Meteo request this repository sends:
 *   precipitation mm, temperature °C, wind km/h, pressure hPa, visibility m,
 *   soil moisture m³/m³, vapour pressure deficit kPa.
 *
 * Ramps are `[start, saturate]` pairs read by `ramp()` in `scoring.js`. `start`
 * is where a signal begins contributing; `saturate` is where it contributes
 * everything it can. A descending pair (start > saturate) ramps downward — used
 * for signals where LOW values are hazardous, such as humidity and visibility.
 */

/**
 * Score bands shared by every risk model. A band owns its lower bound; the
 * highest matching band wins.
 */
export const RISK_LEVELS = Object.freeze([
  Object.freeze({ id: 'NORMAL', min: 0, color: '#3ddc97' }),
  Object.freeze({ id: 'LOW', min: 21, color: '#9bd94a' }),
  Object.freeze({ id: 'MODERATE', min: 41, color: '#ffd23f' }),
  Object.freeze({ id: 'ELEVATED', min: 61, color: '#ff8c42' }),
  Object.freeze({ id: 'HIGH', min: 81, color: '#ff4d4d' }),
]);

/**
 * How far a driver must climb its own ramp before the explanation calls it out
 * by name. Drivers below `NORMAL` are reported as context, never as a reason.
 */
export const DRIVER_STATES = Object.freeze({
  HIGH: 0.75,
  ELEVATED: 0.5,
  MODERATE: 0.25,
  NORMAL: 0,
});

/**
 * Minimum absolute change in a metric before a trend is called anything other
 * than stable. Below this, hour-to-hour noise would read as a direction.
 */
export const TREND_DEADBANDS = Object.freeze({
  rain: 0.4,
  soilMoisture: 0.008,
  pressure: 0.7,
  wind: 3,
  temperature: 0.8,
  humidity: 3,
  risk: 4,
});

/** Flood risk: slow-building accumulation against ground that cannot absorb it. */
export const FLOOD = Object.freeze({
  weights: Object.freeze({
    recentRain6h: 0.2,
    recentRain24h: 0.12,
    forecastRain6h: 0.22,
    forecastRain12h: 0.11,
    precipitationProbability: 0.09,
    soilMoisture: 0.19,
    rainfallTrend: 0.07,
  }),
  ramps: Object.freeze({
    recentRain6h: Object.freeze([4, 45]),
    recentRain24h: Object.freeze([10, 90]),
    forecastRain6h: Object.freeze([3, 40]),
    forecastRain12h: Object.freeze([6, 70]),
    precipitationProbability: Object.freeze([35, 95]),
    soilMoisture: Object.freeze([0.28, 0.45]),
    rainfallTrend: Object.freeze([0.5, 8]),
  }),
});

/**
 * Flash flood: rate, not total. The same 20 mm is unremarkable over a day and
 * dangerous in an hour, so this model reads short windows and how fast they are
 * changing, gated by whether the ground is already saturated.
 */
export const FLASH_FLOOD = Object.freeze({
  weights: Object.freeze({
    rainRate1h: 0.3,
    peakForecastRate3h: 0.24,
    rainAcceleration: 0.16,
    soilSaturation: 0.2,
    precipitationProbability3h: 0.1,
  }),
  ramps: Object.freeze({
    rainRate1h: Object.freeze([4, 30]),
    peakForecastRate3h: Object.freeze([4, 25]),
    rainAcceleration: Object.freeze([2, 15]),
    soilSaturation: Object.freeze([0.3, 0.45]),
    precipitationProbability3h: Object.freeze([40, 95]),
  }),
  /**
   * Rate-driven risk needs water actually falling or forecast within the hour.
   * Saturated ground alone is a flood signal, not a flash-flood one, so the
   * score is damped until a rate signal exists.
   */
  rateFloor: Object.freeze({ mmPerHour: 1.5, damping: 0.35 }),
});

/** Wind and storm hazard, including gust structure and pressure collapse. */
export const WIND = Object.freeze({
  weights: Object.freeze({
    sustained: 0.32,
    gusts: 0.38,
    gustFactor: 0.1,
    pressureDrop: 0.1,
    shear: 0.1,
  }),
  ramps: Object.freeze({
    sustained: Object.freeze([25, 90]),
    gusts: Object.freeze([40, 120]),
    // Gusts well above the sustained wind mark a turbulent, convective profile.
    gustFactor: Object.freeze([1.4, 2.2]),
    // hPa lost over three hours; 3 hPa/3h is the classic rapid-deepening mark.
    pressureDrop: Object.freeze([1.5, 6]),
    // km/h difference between 10 m and 180 m winds.
    shear: Object.freeze([10, 45]),
  }),
  storm: Object.freeze({
    weights: Object.freeze({
      wind: 0.45,
      weatherCode: 0.3,
      pressureDrop: 0.15,
      precipitation: 0.1,
    }),
    ramps: Object.freeze({ precipitation: Object.freeze([2, 20]) }),
  }),
});

/**
 * Fire-spread conditions — how readily fire would move if one started. This is
 * a weather statement, never a detection claim.
 */
export const FIRE = Object.freeze({
  weights: Object.freeze({
    temperature: 0.18,
    humidity: 0.2,
    wind: 0.2,
    vapourPressureDeficit: 0.19,
    dryness: 0.15,
    soilDryness: 0.08,
  }),
  ramps: Object.freeze({
    temperature: Object.freeze([24, 42]),
    // Descending: dry air spreads fire, so 15% RH scores higher than 60%.
    humidity: Object.freeze([55, 12]),
    wind: Object.freeze([12, 55]),
    vapourPressureDeficit: Object.freeze([1.1, 4.5]),
    // Descending: mm of rain over the past 24 h, where none is worst.
    dryness: Object.freeze([6, 0]),
    // Descending: volumetric soil moisture in the top layers.
    soilDryness: Object.freeze([0.25, 0.06]),
  }),
  /** Live precipitation suppresses spread whatever the other signals say. */
  wetSuppression: Object.freeze({ mmPerHour: 0.3, damping: 0.4 }),
});

/** Heat stress from the combination of temperature, humidity and duration. */
export const HEAT = Object.freeze({
  weights: Object.freeze({
    apparentTemperature: 0.5,
    temperature: 0.18,
    humidex: 0.14,
    duration: 0.18,
  }),
  ramps: Object.freeze({
    apparentTemperature: Object.freeze([30, 46]),
    temperature: Object.freeze([29, 44]),
    // Dew point is the honest measure of how little relief the air offers.
    humidex: Object.freeze([18, 26]),
    // Hours above the apparent-temperature threshold in the next 24 h.
    duration: Object.freeze([2, 14]),
  }),
  durationThresholdC: 32,
});

/** Visibility hazard from fog, precipitation and blowing snow. */
export const VISIBILITY = Object.freeze({
  weights: Object.freeze({
    visibility: 0.52,
    precipitation: 0.14,
    snowfall: 0.16,
    fogPotential: 0.18,
  }),
  ramps: Object.freeze({
    // Descending: metres of visibility, where less is worse.
    visibility: Object.freeze([6000, 200]),
    precipitation: Object.freeze([1.5, 12]),
    snowfall: Object.freeze([0.2, 3]),
    // Descending: °C spread between temperature and dew point. A closing
    // spread with low cloud is the standard fog-formation signal.
    fogPotential: Object.freeze([4, 0.2]),
  }),
});

/**
 * WMO weather codes that carry hazard on their own, with the severity each
 * contributes (0..1). Codes absent from this table contribute nothing.
 * @see https://open-meteo.com/en/docs — WMO 4677 weather interpretation codes.
 */
export const WEATHER_CODE_SEVERITY = Object.freeze({
  45: 0.3,
  48: 0.35, // fog / depositing rime fog
  55: 0.35,
  57: 0.4, // dense drizzle, dense freezing drizzle
  65: 0.55,
  67: 0.7, // heavy rain, heavy freezing rain
  75: 0.6,
  77: 0.35, // heavy snowfall, snow grains
  82: 0.7, // violent rain showers
  86: 0.6, // heavy snow showers
  95: 0.8, // thunderstorm
  96: 0.9,
  99: 1, // thunderstorm with hail
});

/**
 * How the per-hazard scores combine into one environmental figure. The blend is
 * deliberately dominated by the worst active hazard — an area with one HIGH
 * risk is not "moderate overall" because its other hazards are quiet — with a
 * smaller contribution from the breadth of concurrent hazards.
 */
export const OVERALL = Object.freeze({
  peakWeight: 0.75,
  breadthWeight: 0.25,
});

/**
 * Change detection. A metric must move by at least `minimum` in its own units
 * AND clear the `severity` bands to be reported as a significant change, so a
 * drizzle starting does not read like a squall line arriving.
 */
export const CHANGE_DETECTION = Object.freeze({
  metrics: Object.freeze({
    rain_1h: Object.freeze({
      label: 'Rainfall rate',
      unit: 'mm/h',
      minimum: 2,
      severity: Object.freeze({ MODERATE: 2, ELEVATED: 6, HIGH: 12 }),
    }),
    wind_gusts_10m: Object.freeze({
      label: 'Wind gusts',
      unit: 'km/h',
      minimum: 15,
      severity: Object.freeze({ MODERATE: 15, ELEVATED: 30, HIGH: 50 }),
    }),
    wind_speed_10m: Object.freeze({
      label: 'Wind speed',
      unit: 'km/h',
      minimum: 12,
      severity: Object.freeze({ MODERATE: 12, ELEVATED: 25, HIGH: 40 }),
    }),
    pressure_msl: Object.freeze({
      label: 'Pressure',
      unit: 'hPa',
      minimum: 2.5,
      severity: Object.freeze({ MODERATE: 2.5, ELEVATED: 5, HIGH: 8 }),
    }),
    temperature_2m: Object.freeze({
      label: 'Temperature',
      unit: '°C',
      minimum: 4,
      severity: Object.freeze({ MODERATE: 4, ELEVATED: 7, HIGH: 11 }),
    }),
    soil_moisture_index: Object.freeze({
      label: 'Soil moisture',
      unit: 'm³/m³',
      minimum: 0.04,
      severity: Object.freeze({ MODERATE: 0.04, ELEVATED: 0.08, HIGH: 0.13 }),
    }),
  }),
  /** Risk-score movement that is itself worth an event. */
  riskScore: Object.freeze({
    minimum: 10,
    severity: Object.freeze({ MODERATE: 10, ELEVATED: 18, HIGH: 28 }),
  }),
});

/** Forecast horizons, in hours, the engine projects each hazard across. */
export const FORECAST_HORIZONS = Object.freeze([3, 6, 12, 24]);

/**
 * Resolve a 0–100 score to its band.
 * @param {number} score Risk score.
 * @returns {string} Level id from {@link RISK_LEVELS}.
 */
export function riskLevel(score) {
  const value = Number.isFinite(score) ? score : 0;
  let level = RISK_LEVELS[0].id;
  for (const band of RISK_LEVELS) if (value >= band.min) level = band.id;
  return level;
}

/**
 * Resolve the display color for a score.
 * @param {number} score Risk score.
 * @returns {string} Hex color from {@link RISK_LEVELS}.
 */
export function riskColor(score) {
  const id = riskLevel(score);
  return (RISK_LEVELS.find((band) => band.id === id) || RISK_LEVELS[0]).color;
}

/**
 * Name how strongly one driver is contributing, on its own ramp.
 * @param {number} intensity Normalized 0..1 driver position.
 * @returns {string} One of HIGH, ELEVATED, MODERATE, NORMAL.
 */
export function driverState(intensity) {
  const value = Number.isFinite(intensity) ? intensity : 0;
  if (value >= DRIVER_STATES.HIGH) return 'HIGH';
  if (value >= DRIVER_STATES.ELEVATED) return 'ELEVATED';
  if (value >= DRIVER_STATES.MODERATE) return 'MODERATE';
  return 'NORMAL';
}
