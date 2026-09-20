import { FEATURE_NAMES } from './features.js';

/**
 * The Aegis seismic forecasting model: regularized logistic regression,
 * trained by gradient descent, implemented here rather than pulled in.
 *
 * WHY THIS MODEL. The brief asked for a simple, explainable baseline that emits
 * calibrated probabilities, and logistic regression is the textbook answer:
 * every weight is a readable statement about one feature, the output is a
 * probability by construction rather than a score squashed after the fact, and
 * it cannot memorize a small dataset the way a boosted ensemble can. It is also
 * honest about what it is — this problem has a weak signal, and a complicated
 * model would mostly hide that.
 *
 * WHY NO LIBRARY. This repository has no Python and no ML dependency, and
 * adding scikit-learn or XGBoost would mean a runtime the app cannot use. The
 * maths here is a few dozen lines and fully tested; the artifact is plain JSON.
 * The trade is real: no automatic hyper-parameter search, no tree ensembles.
 * The `predict` interface is deliberately narrow so a SageMaker endpoint can
 * replace it without touching a caller.
 *
 * Features are standardized from the TRAINING split only. Fitting the scaler on
 * everything would leak the validation distribution into training.
 */

/** Model identity, written into every artifact and every prediction. */
export const MODEL_NAME = 'Aegis Seismic Forecast';
export const MODEL_VERSION = 'v1';
export const MODEL_KIND = 'logistic-regression';

/** Numerically stable logistic function. */
export function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const exp = Math.exp(z);
  return exp / (1 + exp);
}

/**
 * Fit a standardizer over training rows.
 * @param {number[][]} matrix Feature rows.
 * @returns {{mean: number[], scale: number[]}} Standardizer.
 */
export function fitStandardizer(matrix) {
  const columns = matrix[0]?.length ?? 0;
  const mean = new Array(columns).fill(0);
  const scale = new Array(columns).fill(1);
  if (!matrix.length) return { mean, scale };
  for (let column = 0; column < columns; column += 1) {
    let sum = 0;
    for (const row of matrix) sum += row[column];
    mean[column] = sum / matrix.length;
    let variance = 0;
    for (const row of matrix) variance += (row[column] - mean[column]) ** 2;
    // A constant feature would divide by zero; it simply contributes nothing.
    scale[column] = Math.sqrt(variance / Math.max(1, matrix.length - 1)) || 1;
  }
  return { mean, scale };
}

/** Apply a standardizer to one row. */
export function standardize(row, { mean, scale }) {
  return row.map((value, index) => (value - mean[index]) / scale[index]);
}

/**
 * Train the model.
 *
 * Class weighting matters here: the target is usually imbalanced, and an
 * unweighted fit converges on predicting the majority class with a flat, useless
 * probability. Weighting the rarer class by the inverse of its frequency keeps
 * the decision surface meaningful without resampling the timeline.
 *
 * @param {object} input Training input.
 * @param {number[][]} input.features Training rows.
 * @param {number[]} input.labels Binary labels.
 * @param {object} [input.options] Hyper-parameters.
 * @returns {object} Frozen model artifact.
 */
export function trainLogisticRegression({ features, labels, options = {} }) {
  const {
    learningRate = 0.08,
    epochs = 600,
    l2 = 0.01,
    classWeighting = true,
  } = options;
  if (!features.length || features.length !== labels.length)
    throw new TypeError('Features and labels must be non-empty and aligned');

  const standardizer = fitStandardizer(features);
  const rows = features.map((row) => standardize(row, standardizer));
  const columns = rows[0].length;
  const weights = new Array(columns).fill(0);
  let bias = 0;

  const positives = labels.reduce((sum, label) => sum + label, 0);
  const negatives = labels.length - positives;
  const positiveWeight =
    classWeighting && positives ? labels.length / (2 * positives) : 1;
  const negativeWeight =
    classWeighting && negatives ? labels.length / (2 * negatives) : 1;

  const history = [];
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradients = new Array(columns).fill(0);
    let biasGradient = 0;
    let loss = 0;
    let weightSum = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      let z = bias;
      for (let column = 0; column < columns; column += 1)
        z += weights[column] * row[column];
      const prediction = sigmoid(z);
      const label = labels[i];
      const sampleWeight = label === 1 ? positiveWeight : negativeWeight;
      const error = (prediction - label) * sampleWeight;
      for (let column = 0; column < columns; column += 1)
        gradients[column] += error * row[column];
      biasGradient += error;
      // Clamped so a saturated prediction cannot produce a non-finite loss.
      const clamped = Math.min(1 - 1e-12, Math.max(1e-12, prediction));
      loss +=
        -sampleWeight *
        (label * Math.log(clamped) + (1 - label) * Math.log(1 - clamped));
      weightSum += sampleWeight;
    }

    for (let column = 0; column < columns; column += 1) {
      const gradient = gradients[column] / rows.length + l2 * weights[column];
      weights[column] -= learningRate * gradient;
    }
    bias -= learningRate * (biasGradient / rows.length);
    if (epoch % 50 === 0 || epoch === epochs - 1)
      history.push({
        epoch,
        loss: Number((loss / Math.max(1, weightSum)).toFixed(6)),
      });
  }

  return Object.freeze({
    name: MODEL_NAME,
    version: MODEL_VERSION,
    kind: MODEL_KIND,
    featureNames: Object.freeze([...FEATURE_NAMES]),
    weights: Object.freeze(weights),
    bias,
    standardizer: Object.freeze({
      mean: Object.freeze(standardizer.mean),
      scale: Object.freeze(standardizer.scale),
    }),
    hyperParameters: Object.freeze({
      learningRate,
      epochs,
      l2,
      classWeighting,
    }),
    trainingLoss: Object.freeze(history),
  });
}

/**
 * Predict the probability that the target is met.
 *
 * @param {object} model Model artifact.
 * @param {number[]} features Raw feature vector.
 * @returns {number} Probability in 0..1.
 */
export function predictProbability(model, features) {
  if (!Array.isArray(features) || features.length !== model.weights.length)
    throw new TypeError('Feature vector does not match the model');
  const row = standardize(features, model.standardizer);
  let z = model.bias;
  for (let column = 0; column < row.length; column += 1)
    z += model.weights[column] * row[column];
  return sigmoid(z);
}

/**
 * Rank the features that moved THIS prediction.
 *
 * Not global importance: the contribution is `weight × standardized value`, so
 * the explanation describes why this region at this moment scored as it did.
 * That is what an operator is actually asking when they ask why.
 *
 * @param {object} model Model artifact.
 * @param {number[]} features Raw feature vector.
 * @param {number} [limit] Maximum contributions returned.
 * @returns {object[]} Contributions, strongest absolute effect first.
 */
export function explainPrediction(model, features, limit = 6) {
  const row = standardize(features, model.standardizer);
  return model.weights
    .map((weight, index) => ({
      feature: model.featureNames[index],
      value: features[index],
      standardized: Number(row[index].toFixed(3)),
      contribution: Number((weight * row[index]).toFixed(4)),
      direction: weight * row[index] >= 0 ? 'INCREASES' : 'DECREASES',
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, limit);
}

/** Log-odds, clamped so a 0 or 1 probability cannot produce infinity. */
export function logit(probability) {
  const clamped = Math.min(1 - 1e-6, Math.max(1e-6, probability));
  return Math.log(clamped / (1 - clamped));
}

/**
 * Correct a probability for a different base rate than the model was trained on.
 *
 * This is the standard prior-shift correction, and it fixes the failure mode the
 * per-region evaluation exposed: one global model cannot be calibrated for a
 * region that sees the target 99% of the time AND one that sees it 0.4% of the
 * time. Discrimination — the ranking of busy hours above quiet ones — is a
 * property of the features and is unchanged; only the level moves.
 *
 * The region's own base rate is measured from its recent catalog at inference,
 * so this works for an arbitrary viewport rather than only the trained regions.
 *
 * @param {number} probability Model probability.
 * @param {number} trainedRate Base rate the model was trained at.
 * @param {number} localRate Base rate observed for this region.
 * @returns {number} Corrected probability.
 */
export function applyPriorCorrection(probability, trainedRate, localRate) {
  if (!Number.isFinite(localRate) || !Number.isFinite(trainedRate))
    return probability;
  return sigmoid(logit(probability) + logit(localRate) - logit(trainedRate));
}

/**
 * Validate a loaded artifact before it is trusted to make predictions.
 * @param {object} artifact Parsed artifact.
 * @returns {boolean} Whether the artifact is usable.
 */
export function isUsableModel(artifact) {
  return Boolean(
    artifact &&
    Array.isArray(artifact.weights) &&
    Array.isArray(artifact.featureNames) &&
    artifact.weights.length === artifact.featureNames.length &&
    // A model trained on a different feature set would silently misread every
    // column, so identity is checked, not assumed.
    artifact.featureNames.every(
      (name, index) => name === FEATURE_NAMES[index],
    ) &&
    artifact.standardizer?.mean?.length === artifact.weights.length &&
    Number.isFinite(artifact.bias),
  );
}
