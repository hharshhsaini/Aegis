/**
 * Statistical activity-anomaly detection.
 *
 * Deliberately INDEPENDENT of the forecasting model. The model answers "what is
 * likely next"; this answers "is now unusual compared with normal here", using
 * nothing but counting and a Poisson assumption. Keeping them separate means a
 * model failure cannot silently take the anomaly signal with it, and the two can
 * be compared — when they disagree, that itself is information.
 *
 * Earthquake counts in a fixed window are the textbook case for a Poisson
 * baseline: independent-ish occurrences at a rate that is roughly stable over
 * weeks. Aftershock sequences violate that independence, which is exactly why a
 * sequence shows up here as a strong anomaly rather than being smoothed away.
 */

/** Days of history used to establish "normal" for a region. */
export const BASELINE_DAYS = 30;

/** Ratio thresholds for naming an anomaly. */
export const ANOMALY_LEVELS = Object.freeze([
  { id: 'NORMAL', minRatio: 0, label: 'Normal activity' },
  { id: 'ELEVATED', minRatio: 1.75, label: 'Elevated activity' },
  { id: 'UNUSUAL', minRatio: 3, label: 'Unusual activity' },
  { id: 'HIGHLY_UNUSUAL', minRatio: 6, label: 'Highly unusual activity' },
]);

/** Events the baseline needs before a ratio is worth quoting. */
export const MIN_BASELINE_EVENTS = 5;

/**
 * Poisson upper-tail probability: P(X >= observed) given an expected rate.
 *
 * Computed iteratively in log space so a busy region with a large expectation
 * cannot overflow a factorial.
 *
 * @param {number} observed Observed count.
 * @param {number} expected Expected count.
 * @returns {number} Exceedance probability in 0..1.
 */
export function poissonExceedance(observed, expected) {
  if (!Number.isFinite(observed) || !Number.isFinite(expected) || expected <= 0)
    return observed > 0 ? 0 : 1;
  if (observed <= 0) return 1;
  // Sum the lower tail P(X <= observed-1), then complement.
  let logTerm = -expected;
  let cumulative = Math.exp(logTerm);
  for (let k = 1; k < observed; k += 1) {
    logTerm += Math.log(expected) - Math.log(k);
    cumulative += Math.exp(logTerm);
  }
  return Math.min(1, Math.max(0, 1 - cumulative));
}

/** Name an anomaly ratio. */
export function anomalyLevel(ratio) {
  if (!Number.isFinite(ratio)) return ANOMALY_LEVELS[0];
  let level = ANOMALY_LEVELS[0];
  for (const band of ANOMALY_LEVELS) if (ratio >= band.minRatio) level = band;
  return level;
}

/**
 * Compare current activity with the region's own recent history.
 *
 * @param {object} input Input.
 * @param {object[]} input.events Catalog events for the region.
 * @param {number} [input.now] Clock.
 * @param {number} [input.windowHours] Current window.
 * @param {number} [input.baselineDays] History used for the baseline.
 * @param {number} [input.thresholdMagnitude] Magnitude floor for counting.
 * @returns {object} Frozen anomaly record.
 */
export function detectActivityAnomaly({
  events,
  now = Date.now(),
  windowHours = 24,
  baselineDays = BASELINE_DAYS,
  thresholdMagnitude = 2.5,
}) {
  const qualifying = (events || []).filter(
    (event) =>
      Number.isFinite(event.time) &&
      Number.isFinite(event.magnitude) &&
      event.magnitude >= thresholdMagnitude,
  );
  const windowMs = windowHours * 3_600_000;
  const baselineMs = baselineDays * 86_400_000;

  const current = qualifying.filter(
    (event) => event.time > now - windowMs,
  ).length;
  // The baseline EXCLUDES the current window: comparing a period with itself
  // would drag the "normal" toward whatever is happening right now.
  const baselineEvents = qualifying.filter(
    (event) =>
      event.time <= now - windowMs && event.time > now - windowMs - baselineMs,
  );
  const baselineWindows = baselineMs / windowMs;
  const expected = baselineEvents.length / baselineWindows;

  const comparable = baselineEvents.length >= MIN_BASELINE_EVENTS;
  const ratio = comparable && expected > 0 ? current / expected : null;
  const exceedance = comparable ? poissonExceedance(current, expected) : null;
  const level = comparable ? anomalyLevel(ratio) : ANOMALY_LEVELS[0];

  return Object.freeze({
    windowHours,
    baselineDays,
    thresholdMagnitude,
    currentCount: current,
    expectedCount: comparable ? Number(expected.toFixed(2)) : null,
    ratio: ratio === null ? null : Number(ratio.toFixed(2)),
    changePercent:
      ratio === null ? null : Number(((ratio - 1) * 100).toFixed(1)),
    // The probability of seeing at least this many events if nothing had
    // changed. Small means the increase is hard to explain as chance alone.
    exceedanceProbability:
      exceedance === null ? null : Number(exceedance.toFixed(4)),
    level: comparable ? level.id : 'INSUFFICIENT_BASELINE',
    label: comparable ? level.label : 'Insufficient history for a baseline',
    baselineEventCount: baselineEvents.length,
    method: 'Poisson comparison against the region’s own trailing baseline',
    note: comparable
      ? `${current} events in ${windowHours}h against ${expected.toFixed(1)} expected from the last ${baselineDays} days.`
      : `Only ${baselineEvents.length} events in the last ${baselineDays} days — too few to establish a baseline.`,
  });
}

/**
 * The region's own base rate for the forecast target.
 *
 * This is both the honest BASELINE shown beside the model's probability and the
 * rate the prior correction anchors to. It is measured, not assumed: sample
 * origin times across the history and count how often the target was actually
 * met.
 *
 * @param {object} input Input.
 * @param {object[]} input.events Catalog events.
 * @param {number} input.now Clock.
 * @param {object} input.target Target definition.
 * @param {number} [input.historyDays] History sampled.
 * @param {number} [input.strideHours] Sampling stride.
 * @returns {{rate: number|null, samples: number, met: number}} Observed base rate.
 */
export function observedBaseRate({
  events,
  now,
  target,
  historyDays = BASELINE_DAYS,
  strideHours = 6,
}) {
  const qualifying = (events || []).filter(
    (event) =>
      Number.isFinite(event.time) &&
      Number.isFinite(event.magnitude) &&
      event.magnitude >= target.thresholdMagnitude,
  );
  const windowMs = target.forecastWindowHours * 3_600_000;
  const from = now - historyDays * 86_400_000;
  let samples = 0;
  let met = 0;
  // Every sampled window must be complete, so sampling stops one window short
  // of now — a half-observed window would look artificially quiet.
  for (
    let origin = from;
    origin <= now - windowMs;
    origin += strideHours * 3_600_000
  ) {
    const count = qualifying.filter(
      (event) => event.time > origin && event.time <= origin + windowMs,
    ).length;
    samples += 1;
    if (count >= target.minimumEvents) met += 1;
  }
  return {
    rate: samples ? met / samples : null,
    samples,
    met,
  };
}
