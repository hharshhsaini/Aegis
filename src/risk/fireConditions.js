import { FIRE } from './thresholds.js';
import { ramp, driver, assembleHazard } from './scoring.js';
import { explainHazard } from './narrative.js';

/**
 * Fire-spread conditions — how readily fire would move through an area if one
 * started there.
 *
 * This is NOT a wildfire detection. Weather cannot tell you a fire exists; it
 * can only tell you whether the atmosphere would help one spread. The label and
 * every sentence this module produces say "conditions", and the score is built
 * to be combined later with an actual detection feed (FIRMS) rather than to
 * stand in for one.
 *
 * Vapour pressure deficit carries real weight here because it measures the
 * drying power of the air directly — the quantity temperature and humidity are
 * each only a proxy for. Active rain damps the whole score: fuels that are
 * being rained on do not carry fire, whatever the other signals read.
 */

/**
 * Score fire-spread conditions from derived metrics.
 * @param {object} metrics Derived metrics from `weather/derived.js`.
 * @returns {object} Frozen conditions assessment with an explanation.
 */
export function assessFireConditions(metrics) {
  const { weights, ramps, wetSuppression } = FIRE;
  const raining = (metrics.rain_1h ?? 0) >= wetSuppression.mmPerHour;

  const drivers = [
    driver({
      id: 'temperature',
      label: 'Temperature',
      value: metrics.temperature_2m,
      unit: '°C',
      weight: weights.temperature,
      intensity: ramp(metrics.temperature_2m, ramps.temperature),
      detail: `temperature is ${metrics.temperature_2m ?? 0}°C`,
    }),
    driver({
      id: 'humidity',
      label: 'Relative humidity',
      value: metrics.relative_humidity_2m,
      unit: '%',
      weight: weights.humidity,
      intensity: ramp(metrics.relative_humidity_2m, ramps.humidity),
      detail: `relative humidity is low at ${metrics.relative_humidity_2m ?? 0}%`,
    }),
    driver({
      id: 'wind',
      label: 'Wind speed',
      value: metrics.wind_speed_10m,
      unit: 'km/h',
      weight: weights.wind,
      intensity: ramp(metrics.wind_speed_10m, ramps.wind),
      detail: `wind is ${metrics.wind_speed_10m ?? 0} km/h, which would drive spread`,
    }),
    driver({
      id: 'vapourPressureDeficit',
      label: 'Vapour pressure deficit',
      value: metrics.vapour_pressure_deficit,
      unit: 'kPa',
      weight: weights.vapourPressureDeficit,
      intensity: ramp(
        metrics.vapour_pressure_deficit,
        ramps.vapourPressureDeficit,
      ),
      detail:
        'vapour pressure deficit is high, so the air is actively drying fuels',
    }),
    driver({
      id: 'dryness',
      label: 'Recent rainfall',
      value: metrics.rain_24h,
      unit: 'mm',
      weight: weights.dryness,
      intensity: ramp(metrics.rain_24h, ramps.dryness),
      detail: `only ${metrics.rain_24h ?? 0} mm of rain has fallen in 24 hours`,
    }),
    driver({
      id: 'soilDryness',
      label: 'Soil moisture',
      value: metrics.soil_moisture_index,
      unit: 'm³/m³',
      weight: weights.soilDryness,
      intensity: ramp(metrics.soil_moisture_index, ramps.soilDryness),
      detail: 'soil moisture is low',
    }),
  ];

  const hazard = assembleHazard({
    id: 'fireConditions',
    label: 'Fire Spread Conditions',
    drivers,
    damping: raining ? wetSuppression.damping : 1,
    dampingReason: 'precipitation is currently falling',
  });

  return Object.freeze({
    ...hazard,
    summary: explainHazard({
      hazard: 'Fire-spread',
      level: hazard.level,
      drivers: hazard.leadingDrivers,
      trend: metrics.trends?.temperature?.direction,
      qualifier: raining
        ? 'Active precipitation is suppressing spread potential for now'
        : '',
    }),
    // Stated on every result so no consumer can present this as a detection.
    disclaimer:
      'Describes weather conditions for fire spread. It is not a fire detection.',
  });
}
