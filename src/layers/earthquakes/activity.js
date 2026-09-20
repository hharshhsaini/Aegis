import { ACTIVITY } from './thresholds.js';

/**
 * Earthquake activity rates and trend.
 *
 * The rates come from the feed's own timestamps rather than from anything this
 * process remembered earlier, so a first observation is as complete as the
 * hundredth: a 24-hour feed already contains the last six hours and the six
 * before that, and comparing those two windows is a real measurement.
 *
 * What the feed cannot support, this module refuses to state. A one-hour feed
 * has no previous window, so it reports INSUFFICIENT_DATA rather than inventing
 * a direction. A trend is never extrapolated forward — that would be predicting
 * earthquakes, which this layer does not do.
 */

export const ACTIVITY_STATES = Object.freeze({
  INCREASING: 'INCREASING',
  DECREASING: 'DECREASING',
  STEADY: 'STEADY',
  INSUFFICIENT: 'INSUFFICIENT_DATA',
});

/**
 * Count events in a window ending now.
 * @param {object[]} events Events with epoch `time`.
 * @param {number} hours Window length.
 * @param {number} now Clock.
 * @returns {number} Event count.
 */
export function countWithin(events, hours, now) {
  const from = now - hours * 3_600_000;
  return events.filter(
    (event) => Number.isFinite(event.time) && event.time > from,
  ).length;
}

/**
 * Count events in the window before the most recent one.
 * @param {object[]} events Events.
 * @param {number} hours Window length.
 * @param {number} now Clock.
 * @returns {number} Event count.
 */
export function countPrevious(events, hours, now) {
  const to = now - hours * 3_600_000;
  const from = to - hours * 3_600_000;
  return events.filter(
    (event) =>
      Number.isFinite(event.time) && event.time > from && event.time <= to,
  ).length;
}

/**
 * Compute activity rates and the observed trend.
 *
 * @param {object} input Input.
 * @param {object[]} input.events Events, already scoped to the area of interest.
 * @param {number} [input.now] Clock.
 * @param {number} [input.feedWindowHours] Hours the feed covers.
 * @returns {object} Frozen activity record.
 */
export function earthquakeActivity({
  events,
  now = Date.now(),
  feedWindowHours = 24,
}) {
  const list = Array.isArray(events) ? events : [];
  const rates = {};
  for (const hours of ACTIVITY.windows)
    rates[`last${hours}h`] = countWithin(list, hours, now);

  const window = ACTIVITY.comparisonHours;
  const current = countWithin(list, window, now);
  const previous = countPrevious(list, window, now);
  const largest = list.reduce(
    (worst, event) =>
      (event.magnitude ?? -Infinity) > (worst?.magnitude ?? -Infinity)
        ? event
        : worst,
    null,
  );

  // The comparison needs the feed to actually cover both windows.
  const comparable = feedWindowHours >= window * 2;
  if (
    !comparable ||
    (current < ACTIVITY.minComparable && previous < ACTIVITY.minComparable)
  )
    return Object.freeze({
      status: ACTIVITY_STATES.INSUFFICIENT,
      rates: Object.freeze(rates),
      comparisonHours: window,
      currentWindowEvents: current,
      previousWindowEvents: comparable ? previous : null,
      changePercent: null,
      largestRecent: largest
        ? Object.freeze({
            id: largest.id,
            magnitude: largest.magnitude,
            place: largest.place,
            timeIso: largest.timeIso,
          })
        : null,
      note: 'Insufficient observations for trend analysis.',
    });

  const changePercent = previous
    ? Number((((current - previous) / previous) * 100).toFixed(1))
    : current
      ? 100
      : 0;
  const status =
    changePercent >= ACTIVITY.deadbandPercent
      ? ACTIVITY_STATES.INCREASING
      : changePercent <= -ACTIVITY.deadbandPercent
        ? ACTIVITY_STATES.DECREASING
        : ACTIVITY_STATES.STEADY;

  return Object.freeze({
    status,
    rates: Object.freeze(rates),
    comparisonHours: window,
    currentWindowEvents: current,
    previousWindowEvents: previous,
    changePercent,
    largestRecent: largest
      ? Object.freeze({
          id: largest.id,
          magnitude: largest.magnitude,
          place: largest.place,
          timeIso: largest.timeIso,
        })
      : null,
    note: `${current} events in the last ${window}h against ${previous} in the ${window}h before.`,
  });
}
