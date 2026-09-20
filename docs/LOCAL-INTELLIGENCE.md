# Local Intelligence

The layer that turns Aegis from a globe showing every disaster into a console
showing **yours**. It answers one question the map alone cannot — *does this
matter to the person sitting here?* — and only then decides whether to speak.

```
device location (coarse)        live feeds: USGS · FIRMS · Open-Meteo · official
        │                                        │
        │                                  normalization
        │                                        │
        └──────────────► relevance ◄─── deduplication
                             │
            distance · severity · provenance · recency
                             │
                  INFO · NOTICE · WARNING · URGENT
                             │
                 ┌───────────┴───────────┐
              announcer                  UI
        (queue · cooldown · dedup)   (panels · incident cards)
```

## Two locations, never one

The single most important distinction in this layer:

| | Meaning | Drives |
| --- | --- | --- |
| **Device location** | Where the user *is* | Alert relevance, voice, Local Intelligence |
| **Viewed location** | Where the camera *is looking* | Regional panel, status-strip REGION |

Panning to Kathmandu must never redirect somebody's earthquake alerts away from
the city they are sitting in. The two are separate modules with separate state
(`src/app/deviceLocation.js`, `src/app/locationContext.js`) and the separation
is pinned by test, because nothing on screen would reveal a regression.

Monitoring follows the device by default. The user can point it at the viewed
location with an explicit **MONITOR THIS AREA**, and never by accident.

## Permission

Asked **once**, from an explicit user action, through the browser's own dialog.
Aegis never tries to pre-empt or work around that dialog.

- Granted, denied and unavailable are three different outcomes. A device that
  cannot answer (timeout, position-unavailable) is *not* recorded as a refusal.
- The decision is remembered in `aegis.location.consent.v1`. A refusal means
  the card never returns; re-enabling stays available in the panel.
- Denial is not a failure state. Aegis runs globally — search, exploration and
  every feed keep working, and the panel says `LOCATION NOT ENABLED`.
- Blocked storage (private browsing) degrades to asking again, never to
  throwing.

## Precision is a privacy boundary

A browser hands over metre-level coordinates. Almost nothing here needs them.

- The exact fix **never leaves** `deviceLocation.js`. It is coarsened to two
  decimals (~1.1 km) at the moment of receipt, and the coarse position is the
  only one published to other modules.
- The geocoder is asked about a **bucket**, never about the exact point.
- Coordinates are never written to storage, a share link, a log or analytics.
  Consent storage holds one token and no position.
- Camera framing comes from the reported accuracy, and **the closest band is
  still city scale** (90 km altitude). The console has no reason to show
  somebody their own street, and doing so would leak where they live into any
  screenshot or screen-share.

| Accuracy | Framing | Altitude |
| --- | --- | --- |
| > 50 km | `REGIONAL` | 900 km |
| > 5 km | `METRO` | 220 km |
| otherwise | `CITY` | 90 km |

## Relevance

Severity alone never earns an interruption. `src/alerts/relevance.js` combines
distance, severity, provenance and recency into one level.

Distance bands, from the monitored location: `LOCAL` ≤ 50 km, `NEARBY` ≤ 150 km,
`REGIONAL` ≤ 600 km, `GLOBAL` beyond. **An unknown distance is treated as
GLOBAL** — not knowing where something is must never earn an interruption.

Each band carries a severity floor, so a distant event has to be genuinely
major before it is allowed to speak. An M5.1 at 6,600 km is `INFO` and silent;
an M6.2 at 58 km is `WARNING` and speaks.

## Provenance outranks modelling

Four kinds of statement, and the distinction is a safety rule:

| Provenance | Ceiling | Phrasing |
| --- | --- | --- |
| `MODEL` | below `WARNING` | "…risk model indicates elevated …, now N out of 100. This is a model estimate, not an observation." |
| `FORECAST` | below `WARNING` | "…forecasts elevated …. This is a forecast, not an observed event." |
| `OBSERVED` | `WARNING` | "USGS reports M6.2 earthquake approximately 58 kilometres from your location." |
| `OFFICIAL` | `URGENT` | "An official warning has been issued for an area …" |

Only an authority's own warning reaches `URGENT`, and only when it is close
enough to be about this user — a national warning for somewhere else is news.
A risk index moving is not an event happening, and the wording says so.

Aegis never turns a flood score into "your area will flood", a fire-spread
model into "a wildfire is heading toward you", or a seismic probability into
"an earthquake is going to happen". Fire detections keep the FIRMS vocabulary:
"a thermal anomaly detection, not a confirmed wildfire".

## Announcing

`src/alerts/announcer.js` is a queue, not a firehose. Between a feed and the
voice sit:

- **Deduplication** — an incident is announced once, not on every refresh.
- **Materiality** — a refined number is silent; a significant magnitude or
  status change can re-announce.
- **Cooldown** — a minimum interval between routine announcements, scaled by
  level: `INFO` 5 min, `NOTICE` 2 min, `WARNING` 1 min, `URGENT` none. `URGENT`
  has a zero cooldown *by table*, which is how an official warning bypasses the
  queue without a special case.
- **Priority** — an official warning is never held behind a routine
  announcement, and may bypass the normal cooldown.
- **Threshold** — the user's `ALERT LEVEL` (`ALL` · `IMPORTANT` · `WARNING+` ·
  `URGENT ONLY`, default `IMPORTANT`) gates what reaches the voice at all.

This extends the existing voice system rather than adding a second one; the
existing controls keep working. Speech is accompanied by a compact voice-alert
card, never a full-screen popup.

## Briefings

Deterministic templates over structured data — **no LLM in this layer**.

- **WHAT'S HAPPENING?** — the current picture: where the user is, what is
  nearby, what is regional, what is globally significant, and which official
  feeds are active.
- **WHAT JUST HAPPENED?** — only what changed since `lastBriefingAt`.

A quiet location produces a statement about the **records**, not about safety:
"No incidents have been recorded within 50 kilometres of you." And when no
authority feed is wired up, the briefing says so out loud rather than letting
an operator assume warnings are being watched.

## Official alerts

`src/alerts/officialAlerts.js` is a seam, deliberately without a built-in
provider. India's NDMA operates SACHET and its public alerting is CAP-based,
but Aegis has no credentialed, documented, stable public endpoint wired up —
and inventing one, or scraping a page and calling the result official, would
attach an authority's name to data that authority never served. **A wrong
"official warning" is worse than no warning at all.**

A real provider implements `fetchAlerts()`, returns CAP-shaped records and
registers here; priority, wording and `URGENT` eligibility already work. Until
one is registered the service reports `NOT CONFIGURED`, and a failing feed is
recorded and surfaced rather than being read as "no warnings in force" — the
most dangerous false negative this system could produce.

The normalizer is provider-agnostic CAP, so NDMA/SACHET, NOAA or Meteoalarm
adapters only have to produce CAP fields.

## Panels

Every intelligence panel shares one header (`src/ui/commandPanel.js`): title,
status chip, and a collapse control whose glyph names the **action** — `–` to
collapse, `+` to expand. Collapsed, a panel is its header plus a one-line
summary, never an empty container holding space for hidden content.

The header module deliberately does *not* own the collapse. `bindPanelDisclosure`
already routes every `.panel-collapse-btn[data-collapse-target]` through
`setPanelCollapsed`; a second click handler there would silence the real one.
What it does own is **pointer isolation** — a `pointerdown` that reaches the
Cesium canvas starts a camera drag before any click is dispatched, which is why
a collapse button must never move the globe or select an entity.

## Monitoring limits

While the tab is open, monitoring is live. When it is hidden, monitoring
continues only as far as browser and platform behaviour allow. Aegis does not
claim to alert anyone while it is closed, because without a real background
notification system it cannot.

## Sources

| Layer | Source | Nature |
| --- | --- | --- |
| Earthquakes | USGS GeoJSON feeds | Observed |
| Fires | NASA FIRMS (VIIRS NRT) | Observed (thermal anomaly) |
| Weather / flood | Open-Meteo | Forecast + model |
| Official warnings | *not configured* | Authority |
