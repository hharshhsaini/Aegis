# Seismic Forecasting Pipeline

Aegis forecasts **seismic activity level**, not earthquakes. The distinction is
the whole design: earthquake occurrence cannot be predicted, and every layer
below is built so that no output can be mistaken for a claim that it can.

```
USGS FDSN catalog → features (past only) → time split → logistic regression
                                                           ↓
     anomaly detector (independent) ←── forecast + prior correction
                                                           ↓
                              structured record → Bedrock (gated) → panel
```

## The target

**≥3 events M≥2.5 within 24h**, for a selected region. Configurable in
`dataset.js` (`thresholdMagnitude`, `forecastWindowHours`, `minimumEvents`).

A probability is always displayed with this definition attached. "71%" alone is
meaningless and the UI never shows it that way.

## Data

| | |
| --- | --- |
| Live observations | USGS summary feeds (`all_day.geojson` etc.) |
| Training / history | USGS **FDSN event web service** — official, keyless, queryable by time, magnitude and box |
| Training set | 7 seismic regions × 12 months, M2.5+, chunked monthly and cached |

## No leakage

`buildFeatures` filters to events **strictly before** the origin time; the label
window starts strictly after it. Rows whose label window would run past the end
of the catalog are dropped rather than zero-filled. A test asserts that adding
500 future events changes no feature.

Validation is a **time split**, never random — neighbouring origin times share
look-back windows, so a shuffled split leaks and flatters.

## Model

Regularized **logistic regression**, trained by gradient descent, implemented in
this repository (no Python, no ML dependency). Chosen for explainability and
calibrated output. Features are standardized from the training split only;
classes are weighted inversely to frequency.

Per-prediction explanations are `weight × standardized value`, so the panel
explains *this* forecast rather than quoting global importances.

## Prior correction

A single global model cannot be calibrated for a region seeing the target 99% of
the time and one seeing it 0.4%. Each forecast is shifted in log-odds by the
region's **own measured base rate**, sampled from its recent catalog. Ranking is
untouched; only the level moves.

Measured effect (Brier skill, validation): Iceland −44.7 → **+0.999**, Alaska
−1.92 → **+0.9997**, Greece −0.31 → **+0.50**, Japan 0.191 → 0.190.

## Anomaly detection

Independent of the model: a Poisson comparison of the current window against the
region's trailing 30-day baseline (excluding the current window). Reports the
ratio, the exceedance probability, and `INSUFFICIENT_BASELINE` when there is too
little history — never a fabricated "normal".

## Bedrock

A real `bedrock-runtime` InvokeModel client with SigV4 signing
(`server/providers/bedrock.js`). It narrates; it never computes. The prompt
supplies every number and forbids inventing more.

**Invocation is gated** — only on a material forecast change (≥10 points, trend
change, or anomaly-level change) or an operator question. Unconfigured, the
route returns a deterministic template summary labelled as such.

Configure with `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
optionally `BEDROCK_MODEL_ID`.

## Reproducing

```bash
node scripts/train-seismic-model.mjs --months 12 --stride 6
```

Writes `src/layers/earthquakes/seismicModel.json` and
`docs/SEISMIC-MODEL-EVALUATION.md`. Catalog chunks cache to `.gev-cache/seismic/`,
so re-runs cost no upstream requests.

## Results

See [SEISMIC-MODEL-EVALUATION.md](SEISMIC-MODEL-EVALUATION.md), written by the
training run. Headline: validation Brier **0.117** vs baseline 0.251, ROC-AUC
**0.917** — but the per-region table is the honest read, and it shows real
temporal skill only in the busiest regions.

## AWS mapping

| Pipeline stage | Today | Target |
| --- | --- | --- |
| Ingest | route fetches USGS | EventBridge schedule → Lambda |
| Store | in-process caches | S3 (catalog) + DynamoDB (forecasts) |
| Train | `scripts/train-seismic-model.mjs` | SageMaker training job |
| Artifact | JSON in repo | S3 / SageMaker Model Registry |
| Inference | `/api/quakes/forecast` | Lambda or SageMaker endpoint |
| Narration | Bedrock client, gated | unchanged |

The training/serving split already matches this: training is offline and
produces a portable artifact; serving only loads and predicts.
