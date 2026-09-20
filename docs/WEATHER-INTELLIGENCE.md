# Weather Intelligence Engine

Aegis does not display weather. It analyzes weather and reports disaster risk
with the reasoning attached.

```
Open-Meteo  →  normalize  →  derived metrics  →  risk models  →  explanation
                                                      ↓
                                        forecast windows · trends · change events
```

Every number is produced by arithmetic against thresholds in
[`src/risk/thresholds.js`](../src/risk/thresholds.js). No language model is
involved in scoring. An LLM (Amazon Bedrock, later) consumes the finished
analysis to explain and answer questions; the scores stay deterministic.

## Data

One batched request per location per cache window, built by
[`src/sources/openMeteo.js`](../src/sources/openMeteo.js):

- 42 hourly variables — precipitation, soil moisture (5 layers), the wind and
  temperature profile (10/80/120/180 m), pressure, visibility, cloud, VPD and
  evapotranspiration.
- Current conditions for the panel header.
- `past_hours=24` and `forecast_hours=48`, so accumulation windows and trends
  are measured against real observed hours rather than whatever this process
  happened to see earlier.
- Units pinned to °C / km/h / mm, because every threshold is written in them.

Open-Meteo's forecast endpoint is public and keyless. The request is still made
server-side so one call serves every client looking at the same cell.

## Hazard models

| Model | File | Reads |
| --- | --- | --- |
| Flood | `risk/floodRisk.js` | 6/24 h accumulation, 6/12 h forecast, probability, soil moisture, rainfall trend |
| Flash flood | `risk/flashFloodRisk.js` | 1 h rate, peak 3 h forecast rate, acceleration, near-surface saturation |
| Wind + storm | `risk/windRisk.js` | sustained, gusts, gust factor, 3 h pressure change, 10→180 m shear, weather code |
| Fire spread | `risk/fireConditions.js` | temperature, humidity, wind, VPD, 24 h dryness, soil dryness |
| Heat | `risk/heatRisk.js` | apparent temperature, air temperature, dew point, hours above threshold |
| Visibility | `risk/visibilityRisk.js` | visibility, precipitation, snowfall, dew-point spread under low cloud |

Each returns `score` (0–100), `level`, ranked `drivers` with their contribution,
and a `summary` sentence built from those drivers.

**Levels:** NORMAL 0–20 · LOW 21–40 · MODERATE 41–60 · ELEVATED 61–80 · HIGH 81–100.

### Two rules the models hold to

**Flash flood is not "flood, but higher."** It is a separate model reading rate
and acceleration, because 60 mm over a day and 30 mm in an hour give an operator
completely different amounts of time.

**Fire-spread conditions are not a fire.** Weather can only say whether fire
would spread, never that one exists. The model carries a `disclaimer` field
saying so, and combines with a real detection feed (FIRMS) later.

## Forecast, trends and change events

- **Forecast windows** (+3/6/12/24 h) re-derive metrics anchored at that future
  hour and run the same models. A projected score means what a current score
  means. Projection text says "projected", never "will".
- **Trends** compare against the previous analysis of the same cell. With no
  previous analysis the arrow comes from the 3-hour projection, labelled
  `source: 'projected'` so an expectation is never shown as an observation.
- **Change detection** emits `WEATHER_CHANGE_DETECTED` records (metric, both
  values, delta, severity) for genuine movement — not for standing conditions.
  Shaped as the payload an EventBridge rule would match on.

## Delivery

`GET /api/weather/intelligence?latitude=&longitude=` →
[`server/providers/weather/intelligence.js`](../server/providers/weather/intelligence.js)

The route is the local stand-in for the target Lambda: it owns the upstream
call, the 5-minute cache, request coalescing, the retained previous analysis
(DynamoDB stand-in) and the change events. The browser receives only the
finished analysis — never 42 hourly arrays.

API budget protections: requests snap to a ~1 km grid, concurrent cold requests
for a cell are coalesced into one, a failed refresh serves the last analysis
labelled `stale` with its age, and the client caches for 4 minutes on top.

## Moving to AWS

The engine (`src/risk/*`, `src/weather/*`, `src/sources/openMeteo.js`) is pure
and free of browser, Node and Cesium dependencies. Re-hosting means calling
`analyzeSnapshot` from a Lambda and persisting the result; the models, the UI
and the analysis contract are unchanged. `schemaVersion` is carried on every
analysis because stored records outlive the code that wrote them.

## UI

`AEGIS INTELLIGENCE` (left rail) shows the headline hazard, current conditions
as supporting evidence, every hazard ranked, WHY, the forecast row, and any
significant changes. The globe draws one region for the analyzed location, and
only at MODERATE or above — a quiet location draws nothing.

Clicking bare globe analyzes that point; clicking an entity belongs to that
entity's layer. The camera re-analyzes only after it settles and has actually
moved to a different area.
