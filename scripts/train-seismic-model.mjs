#!/usr/bin/env node
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEISMIC_REGIONS,
  catalogQueryUrl,
  timeChunks,
  consolidateCatalog,
} from '../src/layers/earthquakes/catalog.js';
import { normalizeUsgsFeed } from '../src/layers/earthquakes/usgsEvents.js';
import {
  buildRegionRows,
  timeSplit,
  summarizeDataset,
  describeTarget,
  DEFAULT_TARGET,
} from '../src/layers/earthquakes/dataset.js';
import {
  trainLogisticRegression,
  predictProbability,
  applyPriorCorrection,
} from '../src/layers/earthquakes/forecastModel.js';
import { evaluateForecasts } from '../src/layers/earthquakes/evaluate.js';

/**
 * Reproducible training for the Aegis seismic forecasting model.
 *
 *   USGS FDSN catalog → cache → features → time split → train → evaluate →
 *   artifact + evaluation report
 *
 * Run: `node scripts/train-seismic-model.mjs [--months 24] [--stride 6]`
 *
 * Catalog chunks are cached under `.gev-cache/seismic/` so a re-run costs no
 * upstream requests, and so a training run is reproducible from the same data
 * rather than from whatever the service returns today.
 *
 * The artifact and the evaluation report are written together, on purpose: a
 * model whose measured performance is not on disk beside it invites someone to
 * quote the probability without the evidence.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const CACHE_DIR = path.join(root, '.gev-cache', 'seismic');
const ARTIFACT_PATH = path.join(root, 'src/layers/earthquakes/seismicModel.json');
const REPORT_PATH = path.join(root, 'docs/SEISMIC-MODEL-EVALUATION.md');

const args = new Map(
  process.argv.slice(2).reduce((pairs, token, index, list) => {
    if (token.startsWith('--')) pairs.push([token.slice(2), list[index + 1]]);
    return pairs;
  }, []),
);
const MONTHS = Number(args.get('months') ?? 24);
const STRIDE_HOURS = Number(args.get('stride') ?? 6);
const MIN_MAGNITUDE = Number(args.get('minmag') ?? 2.5);

/** Polite, cached fetch of one catalog chunk. */
async function fetchChunk(region, chunk) {
  const key = `${region.id}_${chunk.start.slice(0, 10)}_${chunk.end.slice(0, 10)}.json`;
  const cachePath = path.join(CACHE_DIR, key);
  try {
    return JSON.parse(await readFile(cachePath, 'utf8'));
  } catch {
    /* not cached yet */
  }
  const url = catalogQueryUrl({
    region,
    start: chunk.start,
    end: chunk.end,
    minMagnitude: MIN_MAGNITUDE,
  });
  const response = await fetch(url, {
    headers: { 'User-Agent': 'aegis-seismic-training (research use)' },
  });
  if (!response.ok) throw new Error(`USGS ${response.status} for ${region.id} ${chunk.start}`);
  const payload = await response.json();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath, JSON.stringify(payload));
  // One request per chunk, spaced out: this is a public service.
  await new Promise((resolve) => setTimeout(resolve, 350));
  return payload;
}

async function loadRegionCatalog(region, start, end) {
  const chunks = timeChunks(start, end, 30);
  const events = [];
  for (const chunk of chunks) {
    const payload = await fetchChunk(region, chunk);
    const snapshot = normalizeUsgsFeed(payload, { feed: 'fdsnws' });
    if (snapshot) events.push(...snapshot.events);
  }
  return consolidateCatalog(events);
}

async function main() {
  const end = new Date();
  const start = new Date(end.getTime() - MONTHS * 30 * 86_400_000);
  const target = DEFAULT_TARGET;

  console.log(`Aegis seismic model training`);
  console.log(`  target      : ${describeTarget(target)}`);
  console.log(`  window      : ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`);
  console.log(`  regions     : ${SEISMIC_REGIONS.length}`);
  console.log(`  stride      : ${STRIDE_HOURS}h\n`);

  const allRows = [];
  const regionSummaries = [];
  for (const region of SEISMIC_REGIONS) {
    process.stdout.write(`  ${region.label.padEnd(26)}`);
    const catalog = await loadRegionCatalog(region, start, end);
    const rows = buildRegionRows({ region, events: catalog, target, strideHours: STRIDE_HOURS });
    const positives = rows.filter((row) => row.label === 1).length;
    console.log(
      `${String(catalog.length).padStart(6)} events → ${String(rows.length).padStart(5)} rows, ${((positives / Math.max(1, rows.length)) * 100).toFixed(1)}% positive`,
    );
    regionSummaries.push({
      region: region.label,
      events: catalog.length,
      rows: rows.length,
      positiveRate: rows.length ? positives / rows.length : 0,
    });
    allRows.push(...rows);
  }

  const summary = summarizeDataset(allRows);
  const { train, validation, cutTime } = timeSplit(allRows, 0.25);
  console.log(`\n  dataset     : ${summary.rows} rows, ${(summary.positiveRate * 100).toFixed(1)}% positive`);
  console.log(`  split       : ${train.length} train / ${validation.length} validation`);
  console.log(`  cut date    : ${new Date(cutTime).toISOString()}\n`);

  if (!train.length || !validation.length)
    throw new Error('Not enough data to train and validate');

  const model = trainLogisticRegression({
    features: train.map((row) => row.features),
    labels: train.map((row) => row.label),
  });

  // The baseline is the TRAINING base rate: what you would predict knowing only
  // how often the target happens, and nothing about the moment.
  const baselineProbability =
    train.reduce((sum, row) => sum + row.label, 0) / train.length;

  const validationProbabilities = validation.map((row) =>
    predictProbability(model, row.features),
  );
  const evaluation = evaluateForecasts({
    probabilities: validationProbabilities,
    labels: validation.map((row) => row.label),
    baselineProbability,
  });
  const trainEvaluation = evaluateForecasts({
    probabilities: train.map((row) => predictProbability(model, row.features)),
    labels: train.map((row) => row.label),
    baselineProbability,
  });

  // Aggregate skill can be an illusion: regions differ enormously in base rate
  // (Alaska is almost always positive, Iceland almost never), so a model that
  // only learned "which region is this" would score well without forecasting
  // anything. Scoring each region separately, against its OWN base rate, is the
  // test of real temporal skill.
  const perRegion = SEISMIC_REGIONS.map((region) => {
    const rows = validation.filter((row) => row.regionId === region.id);
    if (rows.length < 30) return { region: region.label, rows: rows.length, evaluation: null };
    const trainRows = train.filter((row) => row.regionId === region.id);
    const regionBaseline = trainRows.length
      ? trainRows.reduce((sum, row) => sum + row.label, 0) / trainRows.length
      : baselineProbability;
    const raw = rows.map((row) => predictProbability(model, row.features));
    // With the prior correction the region's own base rate is supplied, which is
    // what the running system does from that region's recent catalog.
    const corrected = raw.map((probability) =>
      applyPriorCorrection(probability, baselineProbability, regionBaseline),
    );
    const labels = rows.map((row) => row.label);
    return {
      region: region.label,
      rows: rows.length,
      baseline: Number(regionBaseline.toFixed(4)),
      evaluation: evaluateForecasts({
        probabilities: raw,
        labels,
        baselineProbability: regionBaseline,
      }),
      calibratedEvaluation: evaluateForecasts({
        probabilities: corrected,
        labels,
        baselineProbability: regionBaseline,
      }),
    };
  });

  console.log(`  VALIDATION (held-out future)`);
  console.log(`    Brier          ${evaluation.brierScore}  (baseline ${evaluation.baselineBrierScore})`);
  console.log(`    Brier skill    ${evaluation.brierSkillScore}`);
  console.log(`    ROC-AUC        ${evaluation.rocAuc}`);
  console.log(`    precision      ${evaluation.precision}`);
  console.log(`    recall         ${evaluation.recall}`);
  console.log(`    F1             ${evaluation.f1}`);
  console.log(`\n  ${evaluation.verdict}\n`);
  console.log(`  PER REGION (against each region's own base rate)`);
  for (const entry of perRegion)
    console.log(
      `    ${entry.region.padEnd(26)} ${entry.evaluation ? `AUC ${String(entry.evaluation.rocAuc).padEnd(7)} skill ${String(entry.evaluation.brierSkillScore).padEnd(8)} → calibrated ${String(entry.calibratedEvaluation.brierSkillScore).padEnd(8)} base ${entry.baseline}` : `${entry.rows} rows — too few to score`}`,
    );
  console.log('');

  const artifact = {
    ...model,
    target,
    targetDescription: describeTarget(target),
    baselineProbability: Number(baselineProbability.toFixed(4)),
    trainedAt: new Date().toISOString(),
    trainingData: {
      source: 'USGS FDSN event web service',
      minMagnitude: MIN_MAGNITUDE,
      from: start.toISOString(),
      to: end.toISOString(),
      strideHours: STRIDE_HOURS,
      regions: regionSummaries,
      ...summary,
      trainRows: train.length,
      validationRows: validation.length,
      validationCut: new Date(cutTime).toISOString(),
    },
    evaluation,
    trainEvaluation,
    perRegionEvaluation: perRegion,
  };
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(REPORT_PATH, renderReport(artifact));
  console.log(`  artifact → ${path.relative(root, ARTIFACT_PATH)}`);
  console.log(`  report   → ${path.relative(root, REPORT_PATH)}`);
}

/** Render the evaluation report that ships beside the artifact. */
function renderReport(artifact) {
  const { evaluation: validation, trainEvaluation: training, trainingData } = artifact;
  const bins = validation.calibration
    .filter((bin) => bin.count > 0)
    .map(
      (bin) =>
        `| ${bin.from.toFixed(1)}–${bin.to.toFixed(1)} | ${bin.count} | ${bin.meanPredicted} | ${bin.observedFrequency} |`,
    )
    .join('\n');

  return `# Seismic Model Evaluation

Generated by \`scripts/train-seismic-model.mjs\` on ${artifact.trainedAt}.
This file is written by the training run, not by hand.

## What the model forecasts

**Target:** ${artifact.targetDescription}

A probability here is the model's estimate that THIS target is met in the
region over the forecast window. It is **not** the probability of a damaging
earthquake, and it says nothing about where, when or how large an individual
event will be. Earthquake occurrence cannot be predicted; seismic activity
level can be forecast from recent activity, and that is what this is.

## Training data

| | |
| --- | --- |
| Source | ${trainingData.source} (official, keyless) |
| Window | ${trainingData.from.slice(0, 10)} → ${trainingData.to.slice(0, 10)} |
| Minimum magnitude | M${trainingData.minMagnitude} |
| Regions | ${trainingData.regions.length} |
| Rows | ${trainingData.rows} (${(trainingData.positiveRate * 100).toFixed(1)}% positive) |
| Origin-time stride | ${trainingData.strideHours} h |
| Train / validation | ${trainingData.trainRows} / ${trainingData.validationRows} |
| Validation cut | ${trainingData.validationCut} (time-based, no shuffling) |

### Per region

| Region | Events | Rows | Positive rate |
| --- | ---: | ---: | ---: |
${trainingData.regions
  .map(
    (region) =>
      `| ${region.region} | ${region.events} | ${region.rows} | ${(region.positiveRate * 100).toFixed(1)}% |`,
  )
  .join('\n')}

## Results

Validation is the held-out FUTURE of the same catalog — trained on the past,
scored on what came after. The baseline is the climatological one: always
predict the training base rate (${validation.baselineProbability}).

| Metric | Validation | Training | Baseline |
| --- | ---: | ---: | ---: |
| Brier score (lower better) | **${validation.brierScore}** | ${training.brierScore} | ${validation.baselineBrierScore} |
| Brier skill score | **${validation.brierSkillScore}** | ${training.brierSkillScore} | 0 |
| ROC-AUC | **${validation.rocAuc}** | ${training.rocAuc} | 0.5 |
| Precision @0.5 | ${validation.precision} | ${training.precision} | ${validation.baselineComparison.precision} |
| Recall @0.5 | ${validation.recall} | ${training.recall} | ${validation.baselineComparison.recall} |
| F1 @0.5 | ${validation.f1} | ${training.f1} | ${validation.baselineComparison.f1} |
| Accuracy @0.5 | ${validation.accuracy} | ${training.accuracy} | ${validation.baselineComparison.accuracy} |

**Confusion matrix (validation, threshold 0.5)**

| | Predicted positive | Predicted negative |
| --- | ---: | ---: |
| **Actual positive** | ${validation.confusionMatrix.truePositives} | ${validation.confusionMatrix.falseNegatives} |
| **Actual negative** | ${validation.confusionMatrix.falsePositives} | ${validation.confusionMatrix.trueNegatives} |

**Calibration (validation)** — does 70% mean 70%?

| Bin | Count | Mean predicted | Observed frequency |
| --- | ---: | ---: | ---: |
${bins}

## Per-region skill — the honest check

Aggregate metrics flatter this problem. Base rates differ enormously between
regions, so a model that merely learned *which region it is looking at* would
post a strong global AUC without forecasting anything. Each region below is
scored against **its own** base rate, which removes that shortcut.

| Region | Validation rows | Base rate | ROC-AUC | Brier skill (raw) | Brier skill (prior-corrected) |
| --- | ---: | ---: | ---: | ---: | ---: |
${artifact.perRegionEvaluation
  .map((entry) =>
    entry.evaluation
      ? `| ${entry.region} | ${entry.rows} | ${entry.baseline} | ${entry.evaluation.rocAuc ?? 'n/a'} | ${entry.evaluation.brierSkillScore} | ${entry.calibratedEvaluation.brierSkillScore} |`
      : `| ${entry.region} | ${entry.rows} | — | insufficient rows | — | — |`,
  )
  .join('\n')}

ROC-AUC is unchanged by the prior correction — it reorders nothing. The Brier
skill columns show what the correction is for: anchoring the probability LEVEL
to the region actually being looked at.

**Read the `n/a` rows with care.** A region whose validation window contains only
one outcome class (always positive, or never) has no ROC-AUC, and its Brier
skill is easy to make look excellent by predicting the constant. Those rows say
the model is not miscalibrated there; they do not demonstrate forecasting skill.

Where a region's ROC-AUC sits near 0.5, the model has no useful temporal skill
*there*, whatever the global number says.

## Verdict

> ${validation.verdict}

The gap between the training and validation columns is the overfitting check.
A large gap means the model has learned this catalog rather than the problem.

## Limitations

- Trained on ${trainingData.regions.length} regions over ${trainingData.from.slice(0, 4)}–${trainingData.to.slice(0, 4)}; other tectonic settings are out of distribution.
- Rows every ${trainingData.strideHours} h share look-back windows, so effective sample size is below the row count.
- The catalog's completeness varies by region and time; M${trainingData.minMagnitude} is not detected equally everywhere.
- Logistic regression fits a linear decision surface in standardized feature space. It cannot represent interactions that a tree ensemble would.
- Performance is measured on this catalog only. It is not a statement about future real-world accuracy.
`;
}

main().catch((error) => {
  console.error(`Training failed: ${error.message}`);
  process.exitCode = 1;
});
