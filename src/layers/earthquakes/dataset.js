import { buildFeatures, countLabelWindow, FEATURE_NAMES } from './features.js';

/**
 * Training-set construction.
 *
 * A row is one REGION at one ORIGIN TIME: features from the past, label from
 * the window after. Sliding the origin time across a real catalog turns a
 * stream of earthquakes into a supervised problem without inventing anything.
 *
 * Two properties are non-negotiable and both are enforced here rather than
 * trusted:
 *
 *  1. NO LEAKAGE. Features read `t-`, labels read `t+`. `buildFeatures` filters
 *     to the past itself, and the label window starts strictly after `t`.
 *  2. NO TRUNCATED LABELS. A row whose label window extends past the end of the
 *     catalog would be labelled from missing data and look like a quiet period.
 *     Those rows are dropped, not zero-filled.
 */

/**
 * The forecast target.
 *
 * Every parameter is configurable because the target IS the product claim: a
 * probability means nothing until this object is stated alongside it.
 */
export const DEFAULT_TARGET = Object.freeze({
  thresholdMagnitude: 2.5,
  forecastWindowHours: 24,
  minimumEvents: 3,
});

/** Spacing between consecutive origin times, in hours. */
export const DEFAULT_STRIDE_HOURS = 6;

/** History a row needs behind it before its features mean anything. */
export const DEFAULT_WARMUP_HOURS = 720;

/**
 * Describe a target in the words the UI and the model output must both use.
 * @param {object} target Target definition.
 * @returns {string} Human-readable target.
 */
export function describeTarget(target = DEFAULT_TARGET) {
  const { minimumEvents, thresholdMagnitude, forecastWindowHours } = target;
  return `≥${minimumEvents} events M≥${thresholdMagnitude} within ${forecastWindowHours}h`;
}

/**
 * Build labelled rows for one region.
 *
 * @param {object} input Input.
 * @param {object} input.region Region descriptor.
 * @param {object[]} input.events Catalog events for the region, any order.
 * @param {object} [input.target] Target definition.
 * @param {number} [input.strideHours] Origin-time spacing.
 * @param {number} [input.warmupHours] History required before the first row.
 * @returns {object[]} Rows: `{ regionId, originTime, features, named, label, labelCount }`.
 */
export function buildRegionRows({
  region,
  events,
  target = DEFAULT_TARGET,
  strideHours = DEFAULT_STRIDE_HOURS,
  warmupHours = DEFAULT_WARMUP_HOURS,
}) {
  const catalog = events
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time);
  if (catalog.length < 2) return [];

  const first = catalog[0].time;
  const last = catalog[catalog.length - 1].time;
  const windowMs = target.forecastWindowHours * 3_600_000;
  const start = first + warmupHours * 3_600_000;
  // The last usable origin: its whole label window must fit inside the catalog.
  const end = last - windowMs;
  const stride = strideHours * 3_600_000;
  const rows = [];

  for (let originTime = start; originTime <= end; originTime += stride) {
    const { values, named } = buildFeatures({
      events: catalog,
      originTime,
      region,
    });
    const labelCount = countLabelWindow({
      events: catalog,
      originTime,
      windowHours: target.forecastWindowHours,
      thresholdMagnitude: target.thresholdMagnitude,
    });
    rows.push({
      regionId: region.id,
      originTime,
      features: values,
      named,
      labelCount,
      label: labelCount >= target.minimumEvents ? 1 : 0,
    });
  }
  return rows;
}

/**
 * Split rows by TIME, never at random.
 *
 * Random splitting on a temporal problem leaks: neighbouring origin times share
 * most of their look-back window, so a random validation row is nearly a copy of
 * a training row and the score is meaningless. Splitting on a cut date instead
 * asks the honest question — trained on the past, does it work on a future it
 * has never seen?
 *
 * @param {object[]} rows Labelled rows.
 * @param {number} [validationFraction] Share of the timeline held out.
 * @returns {{train: object[], validation: object[], cutTime: number}} Split.
 */
export function timeSplit(rows, validationFraction = 0.25) {
  const ordered = [...rows].sort((a, b) => a.originTime - b.originTime);
  if (!ordered.length) return { train: [], validation: [], cutTime: 0 };
  const first = ordered[0].originTime;
  const last = ordered[ordered.length - 1].originTime;
  const cutTime = first + (last - first) * (1 - validationFraction);
  return {
    train: ordered.filter((row) => row.originTime <= cutTime),
    validation: ordered.filter((row) => row.originTime > cutTime),
    cutTime,
  };
}

/**
 * Summarize a dataset, including the class balance.
 *
 * The positive rate is the number to look at first: a target that is positive
 * 95% of the time makes an impressive-looking model that has learned to say
 * "yes", which the evaluation's baseline comparison exists to expose.
 *
 * @param {object[]} rows Labelled rows.
 * @returns {object} Frozen summary.
 */
export function summarizeDataset(rows) {
  const positives = rows.filter((row) => row.label === 1).length;
  const times = rows.map((row) => row.originTime);
  return Object.freeze({
    rows: rows.length,
    positives,
    negatives: rows.length - positives,
    positiveRate: rows.length
      ? Number((positives / rows.length).toFixed(4))
      : 0,
    featureCount: FEATURE_NAMES.length,
    from: times.length ? new Date(Math.min(...times)).toISOString() : null,
    to: times.length ? new Date(Math.max(...times)).toISOString() : null,
    regions: Object.freeze([...new Set(rows.map((row) => row.regionId))]),
  });
}
