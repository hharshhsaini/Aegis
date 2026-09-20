import { FLOOD } from './thresholds.js';
import { ramp, driver, assembleHazard } from './scoring.js';
import { explainHazard } from './narrative.js';

/**
 * Flood risk — water arriving faster than the ground can take it, judged over
 * hours rather than minutes.
 *
 * The model reads three things at once: how much rain has already fallen, how
 * much more is forecast, and whether the soil has any capacity left. Rain onto
 * saturated ground is a different situation from the same rain onto dry ground,
 * and the soil term is what expresses that. Rate-driven, minutes-scale events
 * belong to `flashFloodRisk.js`, which reads the same series differently.
 *
 * The score is a statement about CONDITIONS, not a prediction that a flood will
 * occur.
 */

/**
 * Score flood risk from derived metrics.
 * @param {object} metrics Derived metrics from `weather/derived.js`.
 * @returns {object} Frozen hazard assessment with an explanation.
 */
export function assessFloodRisk(metrics) {
  const { weights, ramps } = FLOOD;
  const drivers = [
    driver({
      id: 'recentRain6h',
      label: 'Rainfall (6h)',
      value: metrics.rain_6h,
      unit: 'mm',
      weight: weights.recentRain6h,
      intensity: ramp(metrics.rain_6h, ramps.recentRain6h),
      detail: `${metrics.rain_6h ?? 0} mm has fallen in the last 6 hours`,
    }),
    driver({
      id: 'recentRain24h',
      label: 'Rainfall (24h)',
      value: metrics.rain_24h,
      unit: 'mm',
      weight: weights.recentRain24h,
      intensity: ramp(metrics.rain_24h, ramps.recentRain24h),
      detail: `${metrics.rain_24h ?? 0} mm has accumulated over 24 hours`,
    }),
    driver({
      id: 'forecastRain6h',
      label: 'Forecast rain (6h)',
      value: metrics.forecast_rain_6h,
      unit: 'mm',
      weight: weights.forecastRain6h,
      intensity: ramp(metrics.forecast_rain_6h, ramps.forecastRain6h),
      detail: `${metrics.forecast_rain_6h ?? 0} mm more is forecast within 6 hours`,
    }),
    driver({
      id: 'forecastRain12h',
      label: 'Forecast rain (12h)',
      value: metrics.forecast_rain_12h,
      unit: 'mm',
      weight: weights.forecastRain12h,
      intensity: ramp(metrics.forecast_rain_12h, ramps.forecastRain12h),
      detail: `${metrics.forecast_rain_12h ?? 0} mm is modeled across 12 hours`,
    }),
    driver({
      id: 'precipitationProbability',
      label: 'Precipitation probability',
      value: metrics.precipitation_probability_6h,
      unit: '%',
      weight: weights.precipitationProbability,
      intensity: ramp(
        metrics.precipitation_probability_6h,
        ramps.precipitationProbability,
      ),
      detail: `precipitation probability reaches ${metrics.precipitation_probability_6h ?? 0}%`,
    }),
    driver({
      id: 'soilMoisture',
      label: 'Soil moisture',
      value: metrics.soil_moisture_index,
      unit: 'm³/m³',
      weight: weights.soilMoisture,
      intensity: ramp(metrics.soil_moisture_index, ramps.soilMoisture),
      detail: 'soil moisture is elevated, leaving limited absorption capacity',
    }),
    driver({
      id: 'rainfallTrend',
      label: 'Rainfall trend',
      value: metrics.rainfall_trend,
      unit: 'mm/3h',
      weight: weights.rainfallTrend,
      intensity: ramp(metrics.rainfall_trend, ramps.rainfallTrend),
      detail: 'rainfall is increasing compared with the previous hours',
    }),
  ];

  const hazard = assembleHazard({ id: 'flood', label: 'Flood Risk', drivers });
  return Object.freeze({
    ...hazard,
    summary: explainHazard({
      hazard: 'Flood',
      level: hazard.level,
      drivers: hazard.leadingDrivers,
      trend: metrics.trends?.rainfall?.direction,
    }),
  });
}
