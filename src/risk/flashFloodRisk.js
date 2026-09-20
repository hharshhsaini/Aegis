import { FLASH_FLOOD } from './thresholds.js';
import { ramp, driver, assembleHazard } from './scoring.js';
import { explainHazard } from './narrative.js';

/**
 * Flash flood risk — rapid onset, driven by rate rather than total.
 *
 * This is deliberately a separate model from `floodRisk.js`, not a threshold on
 * it. A slow 60 mm over a day and a violent 30 mm in one hour produce similar
 * accumulations and completely different situations, and only the second gives
 * an operator minutes instead of hours. So this model weights the one-hour rate,
 * the sharpest hour forecast in the next three, and how fast the rate is
 * ACCELERATING, with saturated soil as the multiplier that turns intense rain
 * into immediate runoff.
 *
 * Because it is a rate model, it is damped when no meaningful rate exists:
 * saturated ground under a dry sky is a flood-watch signal, not a flash-flood
 * one, and the damping is reported rather than hidden.
 */

/**
 * Score flash-flood conditions from derived metrics.
 * @param {object} metrics Derived metrics from `weather/derived.js`.
 * @returns {object} Frozen hazard assessment with an explanation.
 */
export function assessFlashFloodRisk(metrics) {
  const { weights, ramps, rateFloor } = FLASH_FLOOD;
  const currentRate = metrics.rain_1h ?? 0;
  const forecastRate = metrics.peak_forecast_rain_rate_3h ?? 0;
  const activeRate = Math.max(currentRate, forecastRate);

  const drivers = [
    driver({
      id: 'rainRate1h',
      label: 'Rain rate (1h)',
      value: metrics.rain_1h,
      unit: 'mm/h',
      weight: weights.rainRate1h,
      intensity: ramp(metrics.rain_1h, ramps.rainRate1h),
      detail: `rainfall intensity is ${metrics.rain_1h ?? 0} mm in the last hour`,
    }),
    driver({
      id: 'peakForecastRate3h',
      label: 'Peak forecast rate (3h)',
      value: metrics.peak_forecast_rain_rate_3h,
      unit: 'mm/h',
      weight: weights.peakForecastRate3h,
      intensity: ramp(
        metrics.peak_forecast_rain_rate_3h,
        ramps.peakForecastRate3h,
      ),
      detail: `a peak of ${metrics.peak_forecast_rain_rate_3h ?? 0} mm/h is modeled within 3 hours`,
    }),
    driver({
      id: 'rainAcceleration',
      label: 'Rainfall acceleration',
      value: metrics.rain_acceleration,
      unit: 'mm/h',
      weight: weights.rainAcceleration,
      intensity: ramp(metrics.rain_acceleration, ramps.rainAcceleration),
      detail: 'short-duration rainfall intensity has increased sharply',
    }),
    driver({
      id: 'soilSaturation',
      label: 'Soil saturation',
      value: metrics.soil_saturation,
      unit: 'm³/m³',
      weight: weights.soilSaturation,
      intensity: ramp(metrics.soil_saturation, ramps.soilSaturation),
      detail:
        'near-surface soil is close to saturation, so rainfall runs off rather than soaking in',
    }),
    driver({
      id: 'precipitationProbability3h',
      label: 'Probability (3h)',
      value: metrics.precipitation_probability_3h,
      unit: '%',
      weight: weights.precipitationProbability3h,
      intensity: ramp(
        metrics.precipitation_probability_3h,
        ramps.precipitationProbability3h,
      ),
      detail: `short-term precipitation probability is ${metrics.precipitation_probability_3h ?? 0}%`,
    }),
  ];

  const damped = activeRate < rateFloor.mmPerHour;
  const hazard = assembleHazard({
    id: 'flashFlood',
    label: 'Flash Flood Risk',
    drivers,
    damping: damped ? rateFloor.damping : 1,
    dampingReason: 'no significant short-duration rainfall observed or modeled',
  });

  return Object.freeze({
    ...hazard,
    summary: explainHazard({
      hazard: 'Flash flood',
      level: hazard.level,
      drivers: hazard.leadingDrivers,
      trend: metrics.trends?.rainfall?.direction,
      qualifier: damped
        ? 'Rapid-onset potential is limited while no short-duration rainfall is present'
        : '',
    }),
  });
}
