import { CHANGE_DETECTION } from './thresholds.js';

/**
 * Change detection — what is DIFFERENT, not what is high.
 *
 * A steady 40 km/h wind produces no event here; 12 km/h becoming 40 does. That
 * distinction is what makes these events safe to wire to downstream work: a
 * standing hazard would otherwise re-trigger an AI summary, a notification or a
 * workflow on every poll.
 *
 * Each event is shaped as the payload an AWS EventBridge rule would match on,
 * with the metric, both values, the delta and a severity. Nothing here calls
 * AWS — the engine emits records and a caller decides what to do with them.
 */

/** Event type emitted for every detected change. */
export const WEATHER_CHANGE_DETECTED = 'WEATHER_CHANGE_DETECTED';

/**
 * Grade a change against a metric's severity bands.
 * @param {number} magnitude Absolute change.
 * @param {object} bands Severity bands from configuration.
 * @returns {string|null} Severity id, or null when below the lowest band.
 */
function severityFor(magnitude, bands) {
  let severity = null;
  for (const [id, threshold] of Object.entries(bands))
    if (magnitude >= threshold) severity = id;
  return severity;
}

/**
 * Build one change event.
 * @param {object} input Event input.
 * @returns {object} Frozen event record.
 */
function changeEvent({
  location,
  timestamp,
  metric,
  label,
  unit,
  previous,
  current,
  severity,
}) {
  return Object.freeze({
    type: WEATHER_CHANGE_DETECTED,
    location,
    timestamp,
    metric,
    label,
    unit,
    previous_value: previous,
    current_value: current,
    change: Number((current - previous).toFixed(3)),
    direction: current >= previous ? 'INCREASE' : 'DECREASE',
    severity,
  });
}

/**
 * Detect significant movement in the watched metrics and risk scores.
 *
 * Two comparisons run, and both matter. Against the PREVIOUS ANALYSIS, this
 * catches what changed between polls — the operational "something just
 * happened" signal. Against RECENT OBSERVATIONS in the same series, it catches
 * a sharp change that happened before this process first looked, so a fresh
 * start is not blind to a squall that arrived an hour ago.
 *
 * @param {object} input Detection input.
 * @param {object} input.metrics Current derived metrics.
 * @param {object} input.previousMetrics Metrics from the previous analysis, if any.
 * @param {object} input.risks Current hazard assessments keyed by id.
 * @param {object} [input.previousRisks] Previous hazard assessments keyed by id.
 * @param {object} input.location Location record for the event payload.
 * @param {string} input.timestamp ISO instant for the event payload.
 * @returns {object[]} Frozen change events, most severe first.
 */
export function detectSignificantChanges({
  metrics,
  previousMetrics,
  risks,
  previousRisks,
  location,
  timestamp,
}) {
  const events = [];

  for (const [metric, config] of Object.entries(CHANGE_DETECTION.metrics)) {
    const current = metrics?.[metric];
    if (!Number.isFinite(current)) continue;

    // Prefer the previous analysis; fall back to the series' own recent past so
    // a first run still reports a change that already happened.
    const candidates = [];
    if (Number.isFinite(previousMetrics?.[metric]))
      candidates.push(previousMetrics[metric]);
    const recent = recentComparisonValue(metrics, metric);
    if (Number.isFinite(recent)) candidates.push(recent);

    for (const previous of candidates) {
      const magnitude = Math.abs(current - previous);
      if (magnitude < config.minimum) continue;
      const severity = severityFor(magnitude, config.severity);
      if (!severity) continue;
      events.push(
        changeEvent({
          location,
          timestamp,
          metric,
          label: config.label,
          unit: config.unit,
          previous,
          current,
          severity,
        }),
      );
      break; // One event per metric: the strongest available comparison wins.
    }
  }

  for (const [id, hazard] of Object.entries(risks || {})) {
    const previous = previousRisks?.[id]?.score;
    if (!Number.isFinite(previous) || !Number.isFinite(hazard?.score)) continue;
    const magnitude = Math.abs(hazard.score - previous);
    if (magnitude < CHANGE_DETECTION.riskScore.minimum) continue;
    const severity = severityFor(
      magnitude,
      CHANGE_DETECTION.riskScore.severity,
    );
    if (!severity) continue;
    events.push(
      changeEvent({
        location,
        timestamp,
        metric: `risk.${id}`,
        label: `${hazard.label} score`,
        unit: 'points',
        previous,
        current: hazard.score,
        severity,
      }),
    );
  }

  const order = { HIGH: 3, ELEVATED: 2, MODERATE: 1 };
  return Object.freeze(
    events.sort((a, b) => (order[b.severity] || 0) - (order[a.severity] || 0)),
  );
}

/**
 * The value a metric held a few hours ago, for the series-based comparison.
 *
 * Derived metrics already carry their own three-hour deltas, so the earlier
 * value is recovered from those rather than re-reading the series — one
 * definition of "three hours ago", used everywhere.
 *
 * @param {object} metrics Derived metrics.
 * @param {string} metric Metric id.
 * @returns {number|null} Earlier value, or null when not recoverable.
 */
function recentComparisonValue(metrics, metric) {
  const fromDelta = (value, delta) =>
    Number.isFinite(value) && Number.isFinite(delta) ? value - delta : null;
  switch (metric) {
    case 'rain_1h':
      return fromDelta(metrics.rain_1h, metrics.rain_acceleration);
    case 'wind_speed_10m':
      return fromDelta(metrics.wind_speed_10m, metrics.wind_change_3h);
    case 'pressure_msl':
      return fromDelta(metrics.pressure_msl, metrics.pressure_change_3h);
    case 'temperature_2m':
      return metrics.trends?.temperature?.previous ?? null;
    case 'soil_moisture_index':
      return metrics.trends?.soilMoisture?.previous ?? null;
    default:
      return null;
  }
}
