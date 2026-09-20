import { buildFeatures, FEATURE_NAMES } from './features.js';
import {
  predictProbability,
  explainPrediction,
  applyPriorCorrection,
  isUsableModel,
} from './forecastModel.js';
import { detectActivityAnomaly, observedBaseRate } from './anomaly.js';
import { describeTarget, DEFAULT_TARGET } from './dataset.js';

/**
 * Runtime seismic forecasting.
 *
 * Joins the pieces into the one object the rest of Aegis consumes: features
 * from the region's recent catalog, the model's probability corrected to that
 * region's own base rate, an independent anomaly reading, and an explanation
 * built from the same feature contributions that produced the number.
 *
 * THE TARGET TRAVELS WITH THE PROBABILITY. Every record carries its target
 * definition, forecast window, model version and validation metrics, because a
 * bare "71%" is the exact failure the brief warns about. Nothing here forecasts
 * a specific earthquake — the target is a count of events over a window, and
 * the record says so in words a UI can print unmodified.
 */

/** Feature names that get a plain-language phrase in the explanation. */
const FEATURE_PHRASES = Object.freeze({
  count_1h: 'events in the last hour',
  count_3h: 'events in the last 3 hours',
  count_6h: 'events in the last 6 hours',
  count_12h: 'events in the last 12 hours',
  count_24h: 'events in the last 24 hours',
  count_168h: 'events in the last 7 days',
  count_720h: 'events in the last 30 days',
  rate_change_6h_vs_24h: 'recent event rate against the daily rate',
  rate_change_24h_vs_7d: 'daily event rate against the weekly rate',
  hours_since_last_event: 'time since the last recorded event',
  hours_since_largest_7d: 'time since the largest recent event',
  max_magnitude_24h: 'largest magnitude in the last 24 hours',
  max_magnitude_7d: 'largest magnitude in the last 7 days',
  mean_magnitude_24h: 'average magnitude in the last 24 hours',
  median_magnitude_7d: 'median magnitude over 7 days',
  magnitude_trend_24h: 'magnitude trend over 24 hours',
  shallow_fraction_7d: 'share of shallow events',
  spatial_concentration_7d: 'spatial clustering of recent events',
  events_since_largest_7d: 'events recorded since the largest recent event',
  rate_since_largest_7d: 'event rate since the largest recent event',
  max_significance_7d: 'USGS significance of recent events',
  felt_reports_7d: 'felt reports over 7 days',
  baseline_daily_rate_30d: 'the region’s 30-day average daily rate',
  ratio_24h_to_baseline: 'today’s activity against the region’s normal',
  ratio_6h_to_baseline: 'the last 6 hours against the region’s normal',
  ratio_max_mag_24h_to_7d: 'today’s largest event against the week’s largest',
  count_7d_above_2_5: 'M2.5+ events in the last 7 days',
  count_7d_above_3_5: 'M3.5+ events in the last 7 days',
  count_7d_above_4_5: 'M4.5+ events in the last 7 days',
  count_7d_above_5_5: 'M5.5+ events in the last 7 days',
  mean_depth_24h: 'average depth over 24 hours',
  min_depth_7d: 'the shallowest event of the last 7 days',
  depth_spread_7d: 'the spread of event depths',
  count_7d_within_50km: 'events within 50 km of the region centre',
  count_7d_within_100km: 'events within 100 km of the region centre',
  count_7d_within_250km: 'events within 250 km of the region centre',
  mean_distance_from_centroid_7d: 'how spread out recent events are',
  distance_from_largest_7d_km: 'the distance to the largest recent event',
});

/** Turn one feature contribution into a sentence an operator can read. */
function phraseFor(contribution) {
  const subject = FEATURE_PHRASES[contribution.feature] || contribution.feature;
  const direction =
    contribution.direction === 'INCREASES' ? 'raises' : 'lowers';
  const level =
    contribution.standardized >= 1
      ? 'well above'
      : contribution.standardized >= 0.25
        ? 'above'
        : contribution.standardized <= -1
          ? 'well below'
          : contribution.standardized <= -0.25
            ? 'below'
            : 'near';
  return `${subject} is ${level} its training average, which ${direction} the forecast`;
}

/** Name the direction of the forecast against the region's own baseline. */
function trendFrom(probability, baseline) {
  if (!Number.isFinite(baseline)) return 'UNKNOWN';
  const delta = probability - baseline;
  if (delta >= 0.12) return 'INCREASING';
  if (delta <= -0.12) return 'DECREASING';
  return 'STEADY';
}

/**
 * Produce a forecast for one region.
 *
 * @param {object} input Input.
 * @param {object} input.model Model artifact.
 * @param {object[]} input.events Catalog events for the region (30+ days).
 * @param {object} input.region Region descriptor with a bounding box.
 * @param {number} [input.now] Origin time.
 * @param {object} [input.target] Target definition; defaults to the model's.
 * @returns {object} Frozen forecast record.
 */
export function forecastRegion({
  model,
  events,
  region,
  now = Date.now(),
  target,
}) {
  const definition = target || model?.target || DEFAULT_TARGET;

  // Baseline and anomaly are computed from the catalog alone, so they remain
  // available — and honest — even when no model artifact is loaded.
  const base = observedBaseRate({ events, now, target: definition });
  const anomaly = detectActivityAnomaly({
    events,
    now,
    windowHours: definition.forecastWindowHours,
    thresholdMagnitude: definition.thresholdMagnitude,
  });

  if (!isUsableModel(model))
    return Object.freeze({
      status: 'MODEL_UNAVAILABLE',
      target: definition,
      targetDescription: describeTarget(definition),
      forecastWindowHours: definition.forecastWindowHours,
      probability: null,
      baselineProbability: base.rate,
      anomaly,
      trend: 'UNKNOWN',
      drivers: Object.freeze([]),
      note: 'No usable forecasting model artifact is loaded; observed activity and the anomaly comparison are still reported.',
    });

  const { values, named } = buildFeatures({ events, originTime: now, region });
  const rawProbability = predictProbability(model, values);
  // Anchor the level to this region's own measured base rate. Without it a
  // global model reports a global-average likelihood everywhere, which the
  // per-region evaluation showed to be badly wrong in quiet and very busy areas.
  const corrected =
    Number.isFinite(base.rate) && base.samples >= 20
      ? applyPriorCorrection(
          rawProbability,
          model.baselineProbability,
          base.rate,
        )
      : rawProbability;

  const contributions = explainPrediction(model, values, 6);
  const drivers = contributions
    .filter((entry) => Math.abs(entry.contribution) >= 0.05)
    .slice(0, 4)
    .map((entry) =>
      Object.freeze({
        feature: entry.feature,
        value: entry.value,
        contribution: entry.contribution,
        direction: entry.direction,
        text: phraseFor(entry),
      }),
    );

  return Object.freeze({
    status: 'READY',
    // What is being forecast — never separated from the number.
    target: Object.freeze({ ...definition }),
    targetDescription: describeTarget(definition),
    forecastWindowHours: definition.forecastWindowHours,
    probability: Number(corrected.toFixed(4)),
    rawModelProbability: Number(rawProbability.toFixed(4)),
    baselineProbability:
      base.rate === null ? null : Number(base.rate.toFixed(4)),
    baselineSamples: base.samples,
    priorCorrectionApplied: corrected !== rawProbability,
    trend: trendFrom(corrected, base.rate),
    anomaly,
    drivers: Object.freeze(drivers),
    features: named,
    featureNames: FEATURE_NAMES,
    model: Object.freeze({
      name: model.name,
      version: model.version,
      kind: model.kind,
      trainedAt: model.trainedAt ?? null,
      trainingWindow: model.trainingData
        ? `${model.trainingData.from?.slice(0, 10)} → ${model.trainingData.to?.slice(0, 10)}`
        : null,
      trainingRegions: model.trainingData?.regions?.length ?? null,
      trainedBaseRate: model.baselineProbability ?? null,
    }),
    // Validation numbers ride along so a UI can never show a probability
    // without the evidence for how well that probability has performed.
    validation: model.evaluation
      ? Object.freeze({
          brierScore: model.evaluation.brierScore,
          baselineBrierScore: model.evaluation.baselineBrierScore,
          brierSkillScore: model.evaluation.brierSkillScore,
          rocAuc: model.evaluation.rocAuc,
          samples: model.evaluation.samples,
          verdict: model.evaluation.verdict,
        })
      : null,
    generatedAt: new Date(now).toISOString(),
    disclaimer:
      'Forecast of a defined seismic-activity outcome from recent observations. It is not a prediction of a specific earthquake’s time, location or magnitude, and earthquake occurrence cannot be predicted.',
  });
}

/**
 * Whether a new forecast differs enough from the last one to be worth
 * re-explaining downstream.
 *
 * This is the gate that keeps an LLM from being invoked on every poll: the
 * numbers update continuously and cheaply, while narration happens only when
 * something an operator would notice has actually changed.
 *
 * @param {object|null} previous Previous forecast.
 * @param {object} current Current forecast.
 * @param {object} [options] Options.
 * @param {number} [options.probabilityDelta] Movement that counts as material.
 * @returns {{changed: boolean, reasons: string[]}} Decision and why.
 */
export function forecastMateriallyChanged(
  previous,
  current,
  { probabilityDelta = 0.1 } = {},
) {
  const reasons = [];
  if (!previous)
    return { changed: true, reasons: ['first forecast for this region'] };
  if (
    Number.isFinite(previous.probability) &&
    Number.isFinite(current.probability) &&
    Math.abs(current.probability - previous.probability) >= probabilityDelta
  )
    reasons.push(
      `probability moved from ${(previous.probability * 100).toFixed(0)}% to ${(current.probability * 100).toFixed(0)}%`,
    );
  if (previous.trend !== current.trend)
    reasons.push(`trend changed from ${previous.trend} to ${current.trend}`);
  if (previous.anomaly?.level !== current.anomaly?.level)
    reasons.push(
      `activity anomaly changed from ${previous.anomaly?.level} to ${current.anomaly?.level}`,
    );
  return { changed: reasons.length > 0, reasons };
}
