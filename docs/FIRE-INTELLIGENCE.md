# Fire Intelligence Engine

Aegis's second intelligence layer: NASA FIRMS satellite detections, clustered,
correlated with Open-Meteo weather, and reported with the reasoning attached.

```
NASA FIRMS (VIIRS NRT)          Open-Meteo
        │                           │
     detections ──► clusters ──► fire-spread conditions
                       │                │
                  activity trend   spread vector
                       └──────┬─────────┘
                        events · structured incident record
```

## What FIRMS actually publishes

A thermal anomaly: a pixel whose infrared signature crossed a threshold. Gas
flares, industrial heat and sun-warmed bare ground all appear in the feed. So:

- a single detection is a **satellite fire detection**, never "a fire";
- only a coherent group is an **active fire cluster**;
- every payload carries `groundTruth: false` and a qualifier string;
- an empty response means **no detections in that area and window** — a
  statement about the data, never about the ground.

This vocabulary is enforced by tests, not just convention.

## The key

`NASA_FIRMS_MAP_KEY` (falling back to the older `FIRMS_MAP_KEY`), read
server-side only. It has no `VITE_` prefix, so Vite never inlines it into the
browser bundle; the proxy redacts it from every response and every error message
before either leaves the process. Without a key the route answers `no_key` with
a message naming the variable, and the rest of Aegis runs untouched.

## Data

| Aspect | Choice | Why |
| --- | --- | --- |
| Endpoint | `area/csv/{KEY}/{SOURCE}/{w,s,e,n}/{days}` | Viewport-scoped, not world-wide |
| Source | `VIIRS_NOAA20_NRT` by default | Smallest set with reliable coverage; each extra source multiplies transactions |
| Day range | 2, clamped to trailing 24 h | `1` means "current UTC day so far" — nearly empty after 00:00Z |
| Available | `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`, `VIIRS_SNPP_NRT` | Independent satellites; detections are never cross-deduplicated |

## API budget

FIRMS allows 5,000 transactions per 10 minutes and publishes roughly every 15
minutes. Aegis therefore:

- snaps every viewport onto a shared 5° grid — panning inside a cell costs
  nothing, on the client *and* the server;
- caches each cell for 15 minutes, matching publication;
- coalesces concurrent requests for a cell into one upstream call;
- clamps a globe-wide view rather than requesting the planet;
- serves the last observation, labelled `stale` with its age, when FIRMS fails.

## Clustering

Single-link spatial clustering (DBSCAN's linking idea without the density rule):
detections within 3 km of any member join the cluster. Fire perimeters are
chains and fronts, so a centroid method would split a 20 km fire line in half; a
grid index keeps the linking near-linear.

Each cluster reports detection count, geographic centre, bounds, detection area
(VIIRS pixel footprint — **not** burned area), span, average confidence, average
and peak FRP with a band, newest and oldest detection, satellites and sources.

## Fire spread conditions

The same `assessFireConditions` model the weather panel uses, so the two
surfaces can never disagree. Weighted, normalized signals from
`src/risk/thresholds.js`:

| Driver | Weight | Ramp |
| --- | --- | --- |
| Relative humidity (descending) | 0.20 | 55% → 12% |
| Wind speed | 0.20 | 12 → 55 km/h |
| Vapour pressure deficit | 0.19 | 1.1 → 4.5 kPa |
| Temperature | 0.18 | 24 → 42 °C |
| Recent rainfall (descending) | 0.15 | 6 → 0 mm/24 h |
| Soil moisture (descending) | 0.08 | 0.25 → 0.06 m³/m³ |

Score 0–100 → NORMAL / LOW / MODERATE / ELEVATED / HIGH. Active rain damps the
whole score. It is an **environmental-condition assessment**, not a prediction
of fire behaviour, and no LLM participates in producing the number.

## Spread vector

Meteorological wind direction is the direction wind comes **from**, so the
spread bearing is wind + 180°. The two are named separately
(`windFromDegrees`, `spreadTowardDegrees`) because confusing them would point
every arrow at the wrong half of the map. Arrow length scales with wind speed
for legibility and is not a distance. Labelled *"Modeled potential spread
direction based on current wind"*, with terrain, fuel and fire behaviour
explicitly excluded.

## Activity trend

Compares this observation of a cell with the previous one: detection count and
percentage change, new and cleared detections, peak-FRP change. A ±15% deadband
avoids reading overpass noise as movement, and counts below 3 never produce a
percentage. With no previous observation the answer is
`INSUFFICIENT_DATA` — "Insufficient observations for trend analysis." A trend is
never invented.

## Events

`FIRE_DETECTED`, `FIRE_CLUSTER_FORMED`, `FIRE_ACTIVITY_INCREASED`,
`FIRE_ACTIVITY_DECREASED`, `FIRE_SPREAD_CONDITIONS_INCREASED` — each with
timestamp, location, source, severity, previous and current state, and drivers.
Emitted on **change**, not while a condition merely holds, so a steady fire
produces none. A first observation announces only the three largest clusters.
Shaped for EventBridge; nothing calls AWS yet.

## Bedrock preparation

`fireIncidentRecord(cluster, { activity })` returns the structured incident:
counts, confidence, FRP, trend, weather, spread conditions with drivers, and the
potential direction — each number produced deterministically, with
`groundTruth: false` and the qualifier travelling alongside so a generated
summary cannot promote a thermal anomaly into a confirmed wildfire.

## UI

**Globe:** amber-to-red by FRP, visually distinct from the weather overlay and
the application's cyan chrome. Zoomed out, cluster rings sized by detection
count, labelled for the six largest only; below 900 km, individual detections
appear as points. One selected cluster draws its spread vector.

**Panel (right):** `FIRE INTELLIGENCE`, collapsed until a cluster is selected —
heading, detection statistics, fire activity, environmental conditions, fire
spread conditions with drivers, potential direction, raw FIRMS fields behind a
"Technical detail" disclosure, and the standing NASA FIRMS attribution.

## Attribution

> We acknowledge the use of data and/or imagery from NASA's Fire Information for
> Resource Management System (FIRMS), part of NASA's Earth Observing System Data
> and Information System (EOSDIS).

Also registered in the app's Data attribution popover and stated in the fire
panel. Aegis does not generate satellite observations; it analyzes NASA's.
