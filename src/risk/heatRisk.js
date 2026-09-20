import { HEAT } from './thresholds.js';
import { ramp, driver, assembleHazard } from './scoring.js';
import { explainHazard } from './narrative.js';

/**
 * Extreme heat risk.
 *
 * Apparent temperature leads, because what a body experiences is temperature
 * and humidity together, not the thermometer alone. Dew point is scored
 * separately as the honest measure of relief: 38°C at a 12°C dew point cools
 * off at night, while 34°C at a 26°C dew point does not.
 *
 * Duration matters as much as peak, so hours above the heat threshold across
 * the next day carry real weight — a single hot afternoon hour is not a heat
 * event. This module describes environmental conditions only and gives no
 * medical guidance.
 */

/**
 * Score heat risk from derived metrics.
 * @param {object} metrics Derived metrics from `weather/derived.js`.
 * @returns {object} Frozen hazard assessment with an explanation.
 */
export function assessHeatRisk(metrics) {
  const { weights, ramps, durationThresholdC } = HEAT;

  const drivers = [
    driver({
      id: 'apparentTemperature',
      label: 'Apparent temperature',
      value: metrics.apparent_temperature,
      unit: '°C',
      weight: weights.apparentTemperature,
      intensity: ramp(metrics.apparent_temperature, ramps.apparentTemperature),
      detail: `apparent temperature is ${metrics.apparent_temperature ?? 0}°C`,
    }),
    driver({
      id: 'temperature',
      label: 'Temperature',
      value: metrics.temperature_2m,
      unit: '°C',
      weight: weights.temperature,
      intensity: ramp(metrics.temperature_2m, ramps.temperature),
      detail: `air temperature is ${metrics.temperature_2m ?? 0}°C`,
    }),
    driver({
      id: 'humidex',
      label: 'Dew point',
      value: metrics.dew_point_2m,
      unit: '°C',
      weight: weights.humidex,
      intensity: ramp(metrics.dew_point_2m, ramps.humidex),
      detail: `a ${metrics.dew_point_2m ?? 0}°C dew point offers little overnight relief`,
    }),
    driver({
      id: 'duration',
      label: 'Hours above threshold',
      value: metrics.heat_hours_24h,
      unit: 'h',
      weight: weights.duration,
      intensity: ramp(metrics.heat_hours_24h, ramps.duration),
      detail: `${metrics.heat_hours_24h ?? 0} of the next 24 hours are modeled above ${durationThresholdC}°C apparent temperature`,
    }),
  ];

  const hazard = assembleHazard({ id: 'heat', label: 'Heat Risk', drivers });
  return Object.freeze({
    ...hazard,
    summary: explainHazard({
      hazard: 'Heat stress',
      level: hazard.level,
      drivers: hazard.leadingDrivers,
      trend: metrics.trends?.temperature?.direction,
    }),
  });
}
