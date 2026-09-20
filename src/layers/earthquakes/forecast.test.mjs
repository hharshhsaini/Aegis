import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFeatures, countLabelWindow, FEATURE_NAMES } from './features.js';
import { buildRegionRows, timeSplit, describeTarget, DEFAULT_TARGET } from './dataset.js';
import {
  trainLogisticRegression,
  predictProbability,
  explainPrediction,
  applyPriorCorrection,
  isUsableModel,
  sigmoid,
  logit,
} from './forecastModel.js';
import {
  brierScore,
  rocAuc,
  classificationMetrics,
  calibrationCurve,
  evaluateForecasts,
} from './evaluate.js';
import { detectActivityAnomaly, observedBaseRate, poissonExceedance } from './anomaly.js';
import { forecastRegion, forecastMateriallyChanged } from './forecast.js';
import { catalogQueryUrl, timeChunks, consolidateCatalog } from './catalog.js';
import { buildForecastPrompt, templateSummary, SYSTEM_PROMPT } from './narrative.js';

/**
 * The forecasting pipeline's tests are mostly about what it must NOT do: leak
 * the future into a feature, claim skill it has not measured, or let a
 * probability escape without the target it belongs to.
 */

const NOW = Date.parse('2026-09-18T12:00:00Z');
const REGION = { id: 'test', label: 'Test', west: 130, south: 30, east: 145, north: 45 };

/** Synthetic catalog: `count` events spread evenly over `hours` before `end`. */
function events({ count, hours, end = NOW, magnitude = 3.2, lat = 37, lon = 137 }) {
  return Array.from({ length: count }, (_, index) => ({
    id: `e${end}-${index}-${Math.random().toString(36).slice(2, 7)}`,
    time: end - (index * hours * 3_600_000) / Math.max(1, count),
    magnitude,
    depth: 30,
    latitude: lat + index * 0.01,
    longitude: lon + index * 0.01,
    significance: 100,
    felt: null,
  }));
}

test('features read only the past — the leakage guard', () => {
  const past = events({ count: 10, hours: 24, end: NOW - 60_000 });
  const future = events({ count: 500, hours: 24, end: NOW + 24 * 3_600_000, lat: 38 }).map(
    (event) => ({ ...event, time: NOW + 3_600_000 }),
  );
  const withoutFuture = buildFeatures({ events: past, originTime: NOW, region: REGION });
  const withFuture = buildFeatures({
    events: [...past, ...future],
    originTime: NOW,
    region: REGION,
  });
  // 500 events after the origin must not move a single feature.
  assert.deepEqual(withFuture.values, withoutFuture.values);
});

test('the label window reads only the future', () => {
  const before = events({ count: 20, hours: 24, end: NOW - 60_000 });
  const after = [
    { id: 'a', time: NOW + 3_600_000, magnitude: 3, depth: 10, latitude: 37, longitude: 137 },
    { id: 'b', time: NOW + 7_200_000, magnitude: 2.6, depth: 10, latitude: 37, longitude: 137 },
    { id: 'c', time: NOW + 90 * 3_600_000, magnitude: 5, depth: 10, latitude: 37, longitude: 137 },
  ];
  const count = countLabelWindow({
    events: [...before, ...after],
    originTime: NOW,
    windowHours: 24,
    thresholdMagnitude: 2.5,
  });
  assert.equal(count, 2, 'only the two events inside the 24h window count');
});

test('feature names and vector stay aligned', () => {
  const { values, named } = buildFeatures({
    events: events({ count: 12, hours: 48, end: NOW - 60_000 }),
    originTime: NOW,
    region: REGION,
  });
  assert.equal(values.length, FEATURE_NAMES.length);
  assert.ok(values.every(Number.isFinite), 'no NaN may reach the model');
  assert.equal(named.count_24h, values[FEATURE_NAMES.indexOf('count_24h')]);
  assert.ok(named.count_168h >= named.count_24h, 'wider windows contain narrower ones');
});

test('rows are dropped when their label window runs past the catalog', () => {
  const catalog = events({ count: 200, hours: 24 * 60, end: NOW });
  const rows = buildRegionRows({ region: REGION, events: catalog, strideHours: 12 });
  const last = Math.max(...catalog.map((event) => event.time));
  for (const row of rows)
    assert.ok(
      row.originTime + DEFAULT_TARGET.forecastWindowHours * 3_600_000 <= last,
      'a row must never be labelled from missing data',
    );
});

test('the split is by time, and the halves do not overlap', () => {
  const rows = buildRegionRows({
    region: REGION,
    events: events({ count: 400, hours: 24 * 90, end: NOW }),
    strideHours: 12,
  });
  const { train, validation, cutTime } = timeSplit(rows, 0.25);
  assert.ok(train.length && validation.length);
  assert.ok(Math.max(...train.map((row) => row.originTime)) <= cutTime);
  assert.ok(Math.min(...validation.map((row) => row.originTime)) > cutTime);
  // Validation is the FUTURE of training, which is the only honest split here.
  assert.ok(
    Math.min(...validation.map((row) => row.originTime)) >
      Math.max(...train.map((row) => row.originTime)),
  );
});

test('the target definition is stated in words', () => {
  assert.equal(describeTarget(DEFAULT_TARGET), '≥3 events M≥2.5 within 24h');
  assert.equal(
    describeTarget({ minimumEvents: 1, thresholdMagnitude: 4.5, forecastWindowHours: 6 }),
    '≥1 events M≥4.5 within 6h',
  );
});

test('the model learns a separable signal and emits probabilities', () => {
  // Busy rows are positive, quiet rows are negative; a working learner must
  // rank them apart.
  const features = [];
  const labels = [];
  for (let i = 0; i < 200; i += 1) {
    const busy = i % 2 === 0;
    const row = new Array(FEATURE_NAMES.length).fill(0);
    row[0] = busy ? 8 + Math.random() : 1 + Math.random();
    row[4] = busy ? 30 + Math.random() * 5 : 3 + Math.random() * 2;
    features.push(row);
    labels.push(busy ? 1 : 0);
  }
  const model = trainLogisticRegression({ features, labels });
  const busyProbability = predictProbability(model, features[0]);
  const quietProbability = predictProbability(model, features[1]);
  assert.ok(busyProbability > 0.5, `busy scored ${busyProbability}`);
  assert.ok(quietProbability < 0.5, `quiet scored ${quietProbability}`);
  assert.ok(busyProbability > quietProbability);
  for (const probability of [busyProbability, quietProbability])
    assert.ok(probability >= 0 && probability <= 1);
});

test('predictions explain themselves through feature contributions', () => {
  const features = Array.from({ length: 60 }, (_, i) => {
    const row = new Array(FEATURE_NAMES.length).fill(0);
    row[4] = i % 2 === 0 ? 40 : 2;
    return row;
  });
  const labels = features.map((row) => (row[4] > 20 ? 1 : 0));
  const model = trainLogisticRegression({ features, labels });
  const contributions = explainPrediction(model, features[0], 5);
  assert.ok(contributions.length > 0);
  assert.equal(contributions[0].feature, FEATURE_NAMES[4]);
  assert.equal(contributions[0].direction, 'INCREASES');
  // Ranked by absolute effect on THIS prediction.
  const magnitudes = contributions.map((entry) => Math.abs(entry.contribution));
  assert.deepEqual(magnitudes, [...magnitudes].sort((a, b) => b - a));
});

test('the prior correction moves the level but never the ranking', () => {
  const high = applyPriorCorrection(0.8, 0.5, 0.1);
  const low = applyPriorCorrection(0.3, 0.5, 0.1);
  assert.ok(high < 0.8, 'a rarer local base rate lowers the probability');
  assert.ok(high > low, 'ordering is preserved');
  // Same rates in and out is the identity.
  assert.ok(Math.abs(applyPriorCorrection(0.42, 0.5, 0.5) - 0.42) < 1e-9);
  assert.equal(applyPriorCorrection(0.42, 0.5, null), 0.42);
  assert.ok(Math.abs(sigmoid(logit(0.73)) - 0.73) < 1e-9);
});

test('an artifact trained on other features is refused', () => {
  const model = trainLogisticRegression({
    features: [new Array(FEATURE_NAMES.length).fill(1), new Array(FEATURE_NAMES.length).fill(0)],
    labels: [1, 0],
  });
  assert.equal(isUsableModel(model), true);
  assert.equal(isUsableModel({ ...model, featureNames: ['something_else'] }), false);
  assert.equal(isUsableModel({ ...model, weights: [1, 2] }), false);
  assert.equal(isUsableModel(null), false);
});

test('evaluation metrics behave on known inputs', () => {
  assert.equal(brierScore([1, 0], [1, 0]), 0);
  assert.equal(brierScore([0.5, 0.5], [1, 0]), 0.25);
  // A perfect ranker scores 1; a reversed one scores 0.
  assert.equal(rocAuc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]), 1);
  assert.equal(rocAuc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0]), 0);
  // One class present means AUC is undefined, not 0.5.
  assert.equal(rocAuc([0.4, 0.6], [1, 1]), null);
  const metrics = classificationMetrics([0.9, 0.8, 0.2, 0.1], [1, 0, 1, 0], 0.5);
  assert.equal(metrics.confusionMatrix.truePositives, 1);
  assert.equal(metrics.confusionMatrix.falsePositives, 1);
  assert.equal(metrics.confusionMatrix.falseNegatives, 1);
  assert.equal(metrics.confusionMatrix.trueNegatives, 1);
  assert.equal(metrics.precision, 0.5);
  assert.equal(metrics.recall, 0.5);
  const bins = calibrationCurve([0.05, 0.95], [0, 1], 10);
  assert.equal(bins[0].count, 1);
  assert.equal(bins[9].count, 1);
});

test('evaluation says plainly when a model beats nothing', () => {
  const labels = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 1 : 0));
  // A model that always predicts the base rate has no skill, by construction.
  const useless = evaluateForecasts({
    probabilities: labels.map(() => 0.5),
    labels,
    baselineProbability: 0.5,
  });
  assert.equal(useless.brierSkillScore, 0);
  assert.match(useless.verdict, /does NOT outperform/i);

  const good = evaluateForecasts({
    probabilities: labels.map((label) => (label ? 0.9 : 0.1)),
    labels,
    baselineProbability: 0.5,
  });
  assert.ok(good.brierSkillScore > 0.5);
  assert.equal(good.rocAuc, 1);
  assert.match(good.verdict, /Outperforms/);
});

test('the anomaly detector is independent and reports its own baseline', () => {
  // Quiet for a month, busy today.
  const history = events({ count: 30, hours: 24 * 30, end: NOW - 25 * 3_600_000 });
  const today = events({ count: 12, hours: 20, end: NOW });
  const anomaly = detectActivityAnomaly({ events: [...history, ...today], now: NOW });
  assert.equal(anomaly.currentCount, 12);
  assert.ok(anomaly.ratio > 2, `ratio was ${anomaly.ratio}`);
  assert.ok(['UNUSUAL', 'HIGHLY_UNUSUAL', 'ELEVATED'].includes(anomaly.level));
  assert.ok(anomaly.exceedanceProbability < 0.05, 'a real surge is improbable by chance');
  assert.match(anomaly.method, /Poisson/);

  // Too little history is reported as such, not as "normal".
  const sparse = detectActivityAnomaly({ events: events({ count: 2, hours: 100 }), now: NOW });
  assert.equal(sparse.level, 'INSUFFICIENT_BASELINE');
  assert.equal(sparse.ratio, null);
});

test('Poisson exceedance behaves at the edges', () => {
  assert.equal(poissonExceedance(0, 5), 1);
  assert.ok(poissonExceedance(20, 2) < 1e-6);
  assert.ok(poissonExceedance(2, 2) > 0.3 && poissonExceedance(2, 2) < 0.8);
});

test('the observed base rate is measured from complete windows only', () => {
  const catalog = events({ count: 120, hours: 24 * 30, end: NOW });
  const base = observedBaseRate({ events: catalog, now: NOW, target: DEFAULT_TARGET });
  assert.ok(base.samples > 0);
  assert.ok(base.rate >= 0 && base.rate <= 1);
  assert.equal(base.met <= base.samples, true);
});

test('a forecast never appears without its target and disclaimer', () => {
  const artifact = JSON.parse(
    readFileSync(new URL('./seismicModel.json', import.meta.url), 'utf8'),
  );
  const catalog = events({ count: 150, hours: 24 * 40, end: NOW - 60_000 });
  const forecast = forecastRegion({ model: artifact, events: catalog, region: REGION, now: NOW });

  assert.equal(forecast.status, 'READY');
  assert.ok(forecast.probability >= 0 && forecast.probability <= 1);
  assert.equal(forecast.targetDescription, describeTarget(artifact.target));
  assert.equal(forecast.forecastWindowHours, artifact.target.forecastWindowHours);
  assert.ok(forecast.baselineProbability !== undefined);
  assert.ok(forecast.model.version);
  assert.ok(forecast.validation.brierScore >= 0);
  assert.match(forecast.disclaimer, /not a prediction of a specific earthquake/i);
  // The forbidden claims must not be constructible from this record.
  const text = JSON.stringify(forecast);
  assert.doesNotMatch(text, /will occur|will happen|guaranteed|certain to/i);
});

test('without a model artifact the forecast degrades honestly', () => {
  const forecast = forecastRegion({
    model: null,
    events: events({ count: 60, hours: 24 * 30, end: NOW }),
    region: REGION,
    now: NOW,
  });
  assert.equal(forecast.status, 'MODEL_UNAVAILABLE');
  assert.equal(forecast.probability, null);
  // Observation-derived facts survive a missing model.
  assert.ok(forecast.anomaly);
  assert.ok(forecast.baselineProbability !== undefined);
  assert.match(forecast.note, /No usable forecasting model/);
});

test('narration is gated on material change', () => {
  const base = {
    probability: 0.4,
    trend: 'STEADY',
    anomaly: { level: 'NORMAL' },
  };
  assert.equal(forecastMateriallyChanged(null, base).changed, true);
  assert.equal(forecastMateriallyChanged(base, { ...base }).changed, false);
  assert.equal(
    forecastMateriallyChanged(base, { ...base, probability: 0.43 }).changed,
    false,
    'small drift must not trigger a language model',
  );
  const moved = forecastMateriallyChanged(base, { ...base, probability: 0.62 });
  assert.equal(moved.changed, true);
  assert.match(moved.reasons[0], /probability moved/);
  assert.equal(
    forecastMateriallyChanged(base, { ...base, anomaly: { level: 'UNUSUAL' } }).changed,
    true,
  );
});

test('the prompt supplies every number and forbids inventing more', () => {
  const artifact = JSON.parse(
    readFileSync(new URL('./seismicModel.json', import.meta.url), 'utf8'),
  );
  const forecast = forecastRegion({
    model: artifact,
    events: events({ count: 150, hours: 24 * 40, end: NOW - 60_000 }),
    region: REGION,
    now: NOW,
  });
  const prompt = buildForecastPrompt({ forecast, region: REGION });
  assert.match(prompt, /Target: ≥3 events/);
  assert.match(prompt, /Model probability for that target/);
  assert.match(prompt, /base rate/);
  assert.match(prompt, /Activity anomaly/);
  assert.match(prompt, /Model validation on held-out data/);
  assert.match(SYSTEM_PROMPT, /Use ONLY the numbers supplied/);
  assert.match(SYSTEM_PROMPT, /Never predict a specific earthquake/);
  assert.match(SYSTEM_PROMPT, /Never claim damage/);

  const question = buildForecastPrompt({ forecast, region: REGION, question: 'Should I worry?' });
  assert.match(question, /The operator asks: "Should I worry\?"/);
});

test('the template summary states the target and the limitation', () => {
  const artifact = JSON.parse(
    readFileSync(new URL('./seismicModel.json', import.meta.url), 'utf8'),
  );
  const forecast = forecastRegion({
    model: artifact,
    events: events({ count: 150, hours: 24 * 40, end: NOW - 60_000 }),
    region: REGION,
    now: NOW,
  });
  const summary = templateSummary({ forecast });
  assert.match(summary, /probability of ≥3 events M≥2\.5 within 24h/);
  assert.match(summary, /not a prediction of a specific earthquake/i);
  assert.match(summary, /USGS/);
});

test('catalog queries target the official FDSN service', () => {
  const url = catalogQueryUrl({
    region: REGION,
    start: '2026-01-01T00:00:00Z',
    end: '2026-02-01T00:00:00Z',
    minMagnitude: 2.5,
  });
  assert.match(url, /^https:\/\/earthquake\.usgs\.gov\/fdsnws\/event\/1\/query\?/);
  assert.match(url, /format=geojson/);
  assert.match(url, /minmagnitude=2\.5/);
  assert.match(url, /minlatitude=30/);
  assert.throws(
    () => catalogQueryUrl({ region: REGION, start: '2026-02-01', end: '2026-01-01' }),
    /start before/,
  );

  const chunks = timeChunks('2026-01-01', '2026-04-01', 30);
  assert.equal(chunks.length, 3);
  assert.ok(new Date(chunks[0].end) <= new Date(chunks[1].start));

  const deduped = consolidateCatalog([
    { id: 'a', time: 3 },
    { id: 'b', time: 1 },
    { id: 'a', time: 3 },
  ]);
  assert.deepEqual(
    deduped.map((event) => event.id),
    ['b', 'a'],
  );
});

test('the shipped artifact is usable and carries its evidence', () => {
  const artifact = JSON.parse(
    readFileSync(new URL('./seismicModel.json', import.meta.url), 'utf8'),
  );
  assert.equal(isUsableModel(artifact), true);
  assert.ok(artifact.target && artifact.targetDescription);
  assert.ok(artifact.trainingData.from && artifact.trainingData.to);
  assert.ok(artifact.trainingData.rows > 100, 'trained on a real catalog');
  assert.ok(artifact.evaluation.samples > 0);
  assert.ok(artifact.evaluation.verdict);
  assert.ok(Array.isArray(artifact.perRegionEvaluation));
  // Training and validation must come from different periods.
  assert.ok(artifact.trainingData.validationCut);
});
