import { WIND } from './thresholds.js';
import { ramp, driver, assembleHazard, weightedScore } from './scoring.js';
import { explainHazard } from './narrative.js';
import { riskLevel } from './thresholds.js';

/**
 * Wind and storm hazard.
 *
 * Sustained wind alone understates the hazard: damage and danger track GUSTS,
 * and a gust factor well above the sustained wind marks the turbulent,
 * convective profile that produces them. Two structural signals go with it —
 * shear between the 10 m and 180 m winds, and a falling barometer, which is the
 * classic signature of a system deepening over the location.
 *
 * Storm risk is scored separately from raw wind, because a thunderstorm code
 * with modest surface wind is still a storm, and strong steady wind on a clear
 * day is not. Neither score speculates about damage to specific structures.
 */

/**
 * Score wind and storm hazard from derived metrics.
 * @param {object} metrics Derived metrics from `weather/derived.js`.
 * @returns {object} Frozen wind assessment carrying a nested storm assessment.
 */
export function assessWindRisk(metrics) {
  const { weights, ramps, storm } = WIND;
  const pressureDrop = Number.isFinite(metrics.pressure_change_3h)
    ? -metrics.pressure_change_3h
    : null;

  const drivers = [
    driver({
      id: 'sustained',
      label: 'Wind speed',
      value: metrics.wind_speed_10m,
      unit: 'km/h',
      weight: weights.sustained,
      intensity: ramp(metrics.wind_speed_10m, ramps.sustained),
      detail: `sustained wind is ${metrics.wind_speed_10m ?? 0} km/h`,
    }),
    driver({
      id: 'gusts',
      label: 'Wind gusts',
      value: metrics.wind_gusts_10m,
      unit: 'km/h',
      weight: weights.gusts,
      intensity: ramp(metrics.wind_gusts_10m, ramps.gusts),
      detail: `gusts are reaching ${metrics.wind_gusts_10m ?? 0} km/h`,
    }),
    driver({
      id: 'gustFactor',
      label: 'Gust factor',
      value: metrics.gust_factor,
      unit: '×',
      weight: weights.gustFactor,
      intensity: ramp(metrics.gust_factor, ramps.gustFactor),
      detail: 'gusts are running well above the sustained wind',
    }),
    driver({
      id: 'pressureDrop',
      label: 'Pressure change (3h)',
      value: metrics.pressure_change_3h,
      unit: 'hPa/3h',
      weight: weights.pressureDrop,
      intensity: ramp(pressureDrop, ramps.pressureDrop),
      detail: `pressure has fallen ${pressureDrop?.toFixed?.(1) ?? 0} hPa in 3 hours`,
    }),
    driver({
      id: 'shear',
      label: 'Wind shear',
      value: metrics.wind_shear,
      unit: 'km/h',
      weight: weights.shear,
      intensity: ramp(metrics.wind_shear, ramps.shear),
      detail: 'wind speed increases sharply with height',
    }),
  ];

  const hazard = assembleHazard({ id: 'wind', label: 'Wind Risk', drivers });

  // Storm risk reuses the wind result rather than re-reading the wind
  // variables, so the two can never disagree about how windy it is.
  const stormScore = weightedScore([
    { weight: storm.weights.wind, intensity: hazard.score / 100 },
    {
      weight: storm.weights.weatherCode,
      intensity: metrics.weather_code_severity || 0,
    },
    {
      weight: storm.weights.pressureDrop,
      intensity: ramp(pressureDrop, ramps.pressureDrop),
    },
    {
      weight: storm.weights.precipitation,
      intensity: ramp(metrics.rain_3h, storm.ramps.precipitation),
    },
  ]);

  return Object.freeze({
    ...hazard,
    summary: explainHazard({
      hazard: 'Wind',
      level: hazard.level,
      drivers: hazard.leadingDrivers,
      trend: metrics.trends?.wind?.direction,
    }),
    storm: Object.freeze({
      id: 'storm',
      label: 'Storm Risk',
      score: stormScore,
      level: riskLevel(stormScore),
      weatherCodeSeverity: metrics.weather_code_severity || 0,
    }),
  });
}
