import { VISIBILITY } from './thresholds.js';
import { ramp, driver, assembleHazard } from './scoring.js';
import { explainHazard } from './narrative.js';

/**
 * Visibility hazard.
 *
 * Reported visibility leads, with the three mechanisms that degrade it scored
 * alongside so the explanation can say WHY sight distance is short: falling
 * precipitation, snow, or fog. The fog term is a closing spread between
 * temperature and dew point under low cloud — the standard formation signal —
 * which lets the model flag fog conditions that are developing before the
 * visibility figure itself collapses.
 *
 * Visibility drives air, sea and road response decisions, so it is reported as
 * its own hazard rather than folded into storm risk.
 */

/**
 * Score visibility hazard from derived metrics.
 * @param {object} metrics Derived metrics from `weather/derived.js`.
 * @returns {object} Frozen hazard assessment with an explanation.
 */
export function assessVisibilityRisk(metrics) {
  const { weights, ramps } = VISIBILITY;
  const lowCloud = (metrics.cloud_cover_low ?? 0) >= 50;

  const drivers = [
    driver({
      id: 'visibility',
      label: 'Visibility',
      value: metrics.visibility,
      unit: 'm',
      weight: weights.visibility,
      intensity: ramp(metrics.visibility, ramps.visibility),
      detail: `visibility is ${Math.round(metrics.visibility ?? 0)} m`,
    }),
    driver({
      id: 'precipitation',
      label: 'Precipitation',
      value: metrics.rain_1h,
      unit: 'mm/h',
      weight: weights.precipitation,
      intensity: ramp(metrics.rain_1h, ramps.precipitation),
      detail: 'falling precipitation is reducing sight distance',
    }),
    driver({
      id: 'snowfall',
      label: 'Snowfall',
      value: metrics.snowfall_6h,
      unit: 'cm',
      weight: weights.snowfall,
      intensity: ramp(metrics.snowfall_6h, ramps.snowfall),
      detail: 'snowfall is further reducing visibility',
    }),
    driver({
      id: 'fogPotential',
      label: 'Fog potential',
      value: metrics.dew_point_spread,
      unit: '°C',
      weight: weights.fogPotential,
      // Only meaningful under low cloud; a tight spread with clear skies aloft
      // does not produce fog on its own.
      intensity: lowCloud
        ? ramp(metrics.dew_point_spread, ramps.fogPotential)
        : 0,
      detail:
        'temperature and dew point are close under low cloud, favoring fog',
    }),
  ];

  const hazard = assembleHazard({
    id: 'visibility',
    label: 'Visibility Hazard',
    drivers,
  });
  return Object.freeze({
    ...hazard,
    summary: explainHazard({
      hazard: 'Visibility',
      level: hazard.level,
      drivers: hazard.leadingDrivers,
    }),
  });
}
