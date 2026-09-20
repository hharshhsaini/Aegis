/**
 * Forecast evaluation.
 *
 * A probability model is judged on two different things, and reporting only one
 * of them is how bad models look good:
 *
 *  - DISCRIMINATION (ROC-AUC, precision, recall, F1): can it tell active
 *    periods from quiet ones?
 *  - CALIBRATION (Brier score, reliability bins): when it says 70%, does that
 *    happen about 70% of the time?
 *
 * Both are compared against the CLIMATOLOGICAL BASELINE — always predicting the
 * training base rate. A forecaster that cannot beat that number has learned
 * nothing, and this module is built to say so plainly rather than to flatter.
 */

/**
 * Brier score: mean squared error of probabilities. Lower is better.
 * @param {number[]} probabilities Predicted probabilities.
 * @param {number[]} labels Binary outcomes.
 * @returns {number} Brier score.
 */
export function brierScore(probabilities, labels) {
  if (!probabilities.length) return 0;
  const total = probabilities.reduce(
    (sum, probability, index) => sum + (probability - labels[index]) ** 2,
    0,
  );
  return total / probabilities.length;
}

/**
 * ROC-AUC via the rank-sum identity, which also handles ties correctly.
 * @param {number[]} probabilities Predicted probabilities.
 * @param {number[]} labels Binary outcomes.
 * @returns {number|null} AUC, or null when one class is absent.
 */
export function rocAuc(probabilities, labels) {
  const positives = labels.filter((label) => label === 1).length;
  const negatives = labels.length - positives;
  // With only one class present, AUC is undefined — reported as null, not 0.5.
  if (!positives || !negatives) return null;

  const indexed = probabilities
    .map((probability, index) => ({ probability, label: labels[index] }))
    .sort((a, b) => a.probability - b.probability);

  // Average ranks within tied groups so ties contribute 0.5 as they should.
  const ranks = new Array(indexed.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (
      j + 1 < indexed.length &&
      indexed[j + 1].probability === indexed[i].probability
    )
      j += 1;
    const averageRank = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) ranks[k] = averageRank;
    i = j + 1;
  }
  const positiveRankSum = indexed.reduce(
    (sum, entry, index) => sum + (entry.label === 1 ? ranks[index] : 0),
    0,
  );
  return (
    (positiveRankSum - (positives * (positives + 1)) / 2) /
    (positives * negatives)
  );
}

/**
 * Confusion matrix and the rates derived from it at one threshold.
 * @param {number[]} probabilities Predicted probabilities.
 * @param {number[]} labels Binary outcomes.
 * @param {number} [threshold] Decision threshold.
 * @returns {object} Frozen metrics.
 */
export function classificationMetrics(probabilities, labels, threshold = 0.5) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  probabilities.forEach((probability, index) => {
    const predicted = probability >= threshold ? 1 : 0;
    const actual = labels[index];
    if (predicted === 1 && actual === 1) tp += 1;
    else if (predicted === 1 && actual === 0) fp += 1;
    else if (predicted === 0 && actual === 0) tn += 1;
    else fn += 1;
  });
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return Object.freeze({
    threshold,
    confusionMatrix: Object.freeze({
      truePositives: tp,
      falsePositives: fp,
      trueNegatives: tn,
      falseNegatives: fn,
    }),
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4)),
    accuracy: Number(
      ((tp + tn) / Math.max(1, probabilities.length)).toFixed(4),
    ),
  });
}

/**
 * Reliability bins: predicted probability against observed frequency.
 * @param {number[]} probabilities Predicted probabilities.
 * @param {number[]} labels Binary outcomes.
 * @param {number} [bins] Bin count.
 * @returns {object[]} Frozen calibration bins.
 */
export function calibrationCurve(probabilities, labels, bins = 10) {
  const buckets = Array.from({ length: bins }, (_, index) => ({
    from: Number((index / bins).toFixed(2)),
    to: Number(((index + 1) / bins).toFixed(2)),
    count: 0,
    predictedSum: 0,
    observedSum: 0,
  }));
  probabilities.forEach((probability, index) => {
    const bucket = buckets[Math.min(bins - 1, Math.floor(probability * bins))];
    bucket.count += 1;
    bucket.predictedSum += probability;
    bucket.observedSum += labels[index];
  });
  return Object.freeze(
    buckets.map((bucket) =>
      Object.freeze({
        from: bucket.from,
        to: bucket.to,
        count: bucket.count,
        meanPredicted: bucket.count
          ? Number((bucket.predictedSum / bucket.count).toFixed(4))
          : null,
        observedFrequency: bucket.count
          ? Number((bucket.observedSum / bucket.count).toFixed(4))
          : null,
      }),
    ),
  );
}

/**
 * Full evaluation of a set of predictions against a baseline.
 *
 * @param {object} input Input.
 * @param {number[]} input.probabilities Model probabilities.
 * @param {number[]} input.labels Outcomes.
 * @param {number} input.baselineProbability Climatological base rate from TRAINING.
 * @param {number} [input.threshold] Decision threshold.
 * @returns {object} Frozen evaluation report.
 */
export function evaluateForecasts({
  probabilities,
  labels,
  baselineProbability,
  threshold = 0.5,
}) {
  const modelBrier = brierScore(probabilities, labels);
  const baselineBrier = brierScore(
    labels.map(() => baselineProbability),
    labels,
  );
  const auc = rocAuc(probabilities, labels);
  const metrics = classificationMetrics(probabilities, labels, threshold);
  const baselineMetrics = classificationMetrics(
    labels.map(() => baselineProbability),
    labels,
    threshold,
  );

  // The Brier skill score answers the only question that matters: is this
  // better than always predicting the base rate? Zero or below means no.
  const skill = baselineBrier > 0 ? 1 - modelBrier / baselineBrier : 0;

  return Object.freeze({
    samples: probabilities.length,
    positives: labels.filter((label) => label === 1).length,
    baselineProbability: Number(baselineProbability.toFixed(4)),
    brierScore: Number(modelBrier.toFixed(4)),
    baselineBrierScore: Number(baselineBrier.toFixed(4)),
    brierSkillScore: Number(skill.toFixed(4)),
    rocAuc: auc === null ? null : Number(auc.toFixed(4)),
    ...metrics,
    baselineComparison: Object.freeze({
      precision: baselineMetrics.precision,
      recall: baselineMetrics.recall,
      f1: baselineMetrics.f1,
      accuracy: baselineMetrics.accuracy,
    }),
    calibration: calibrationCurve(probabilities, labels),
    // A single honest verdict, so a reader cannot skim past a failure.
    verdict:
      skill > 0.02 && (auc ?? 0) > 0.55
        ? 'Outperforms the climatological baseline on this validation split.'
        : skill > 0
          ? 'Marginally better than the climatological baseline; treat as weak.'
          : 'Does NOT outperform the climatological baseline on this validation split.',
  });
}
