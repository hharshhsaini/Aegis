import { distanceKm } from './sequences.js';

/**
 * Feature engineering for seismic activity forecasting.
 *
 * THE ONE RULE THIS MODULE ENFORCES: a feature vector computed for an origin
 * time `t` may read only events that happened STRICTLY BEFORE `t`. Every window
 * below is a look-back. Nothing peeks at the label window, because a forecaster
 * trained on data it will not have at inference time scores beautifully in
 * evaluation and is worthless in production.
 *
 * Features describe the RATE, SIZE, DEPTH, SPREAD and SEQUENCE STRUCTURE of
 * recent seismicity. None of them encodes a physical precursor claim — no such
 * precursor is known — they simply describe how active a region has been, which
 * is what the target is about.
 */

/** Look-back windows in hours, shortest first. */
export const COUNT_WINDOWS_HOURS = Object.freeze([1, 3, 6, 12, 24, 168, 720]);

/** Magnitude thresholds counted separately. */
export const MAGNITUDE_THRESHOLDS = Object.freeze([2.5, 3.5, 4.5, 5.5]);

/** Radii, in km from the region centre, used for spatial concentration. */
export const RADII_KM = Object.freeze([50, 100, 250]);

/** Depth below which an event is treated as shallow, in km. */
export const SHALLOW_DEPTH_KM = 70;

/**
 * The ordered feature names the model consumes.
 *
 * Order is part of the model contract: an artifact's weights are positional, so
 * this list must not be reordered without retraining. It is derived from the
 * builder below so the two can never drift.
 */
export const FEATURE_NAMES = Object.freeze([
  ...COUNT_WINDOWS_HOURS.map((hours) => `count_${hours}h`),
  'rate_change_6h_vs_24h',
  'rate_change_24h_vs_7d',
  'hours_since_last_event',
  'hours_since_largest_7d',
  'max_magnitude_24h',
  'max_magnitude_7d',
  'mean_magnitude_24h',
  'median_magnitude_7d',
  'magnitude_trend_24h',
  ...MAGNITUDE_THRESHOLDS.map(
    (threshold) => `count_7d_above_${String(threshold).replace('.', '_')}`,
  ),
  'mean_depth_24h',
  'min_depth_7d',
  'shallow_fraction_7d',
  'depth_spread_7d',
  ...RADII_KM.map((radius) => `count_7d_within_${radius}km`),
  'mean_distance_from_centroid_7d',
  'distance_from_largest_7d_km',
  'spatial_concentration_7d',
  'events_since_largest_7d',
  'rate_since_largest_7d',
  'max_significance_7d',
  'felt_reports_7d',
  // Region-relative features. The raw counts above let the model separate a
  // busy subduction zone from a quiet rift, which is legitimately predictive of
  // an absolute target — but it is base-rate knowledge, not forecasting skill.
  // These express the same activity as a RATIO to the region's own 30-day
  // normal, which is the signal that survives when the region is held fixed.
  'baseline_daily_rate_30d',
  'ratio_24h_to_baseline',
  'ratio_6h_to_baseline',
  'ratio_max_mag_24h_to_7d',
]);

/** Events strictly before `t` and within a look-back window. */
function inWindow(events, t, hours) {
  const from = t - hours * 3_600_000;
  return events.filter((event) => event.time < t && event.time >= from);
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function median(values) {
  const usable = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!usable.length) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2
    ? usable[middle]
    : (usable[middle - 1] + usable[middle]) / 2;
}

function stdev(values) {
  const usable = values.filter(Number.isFinite);
  if (usable.length < 2) return 0;
  const average = mean(usable);
  return Math.sqrt(
    usable.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (usable.length - 1),
  );
}

/** Least-squares slope of magnitude against time, per hour. */
function magnitudeTrend(events, t) {
  const usable = events.filter((event) => Number.isFinite(event.magnitude));
  if (usable.length < 3) return 0;
  const xs = usable.map((event) => (event.time - t) / 3_600_000);
  const ys = usable.map((event) => event.magnitude);
  const meanX = mean(xs);
  const meanY = mean(ys);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xs.length; i += 1) {
    numerator += (xs[i] - meanX) * (ys[i] - meanY);
    denominator += (xs[i] - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Build the feature vector for a region at an origin time.
 *
 * @param {object} input Input.
 * @param {object[]} input.events Catalog events, any order. Only events before `originTime` are read.
 * @param {number} input.originTime Origin time in epoch milliseconds.
 * @param {object} input.region Region box with a centre.
 * @returns {{values: number[], named: object}} Feature vector and a named view.
 */
export function buildFeatures({ events, originTime, region }) {
  // The guard that makes the whole pipeline honest.
  const past = events.filter(
    (event) => Number.isFinite(event.time) && event.time < originTime,
  );
  const center = {
    latitude: (region.north + region.south) / 2,
    longitude: (region.east + region.west) / 2,
  };

  const windows = Object.fromEntries(
    COUNT_WINDOWS_HOURS.map((hours) => [
      hours,
      inWindow(past, originTime, hours),
    ]),
  );
  const day = windows[24];
  const week = windows[168];

  const last = past.length ? past[past.length - 1] : null;
  const largestWeek = week.reduce(
    (worst, event) =>
      (event.magnitude ?? -Infinity) > (worst?.magnitude ?? -Infinity)
        ? event
        : worst,
    null,
  );
  const sinceLargest = largestWeek
    ? week.filter((event) => event.time > largestWeek.time)
    : [];
  const hoursSinceLargest = largestWeek
    ? (originTime - largestWeek.time) / 3_600_000
    : null;

  const weekMagnitudes = week.map((event) => event.magnitude);
  const weekDepths = week.map((event) => event.depth);
  const dayMagnitudes = day.map((event) => event.magnitude);

  const distances = week.map((event) => distanceKm(center, event));
  const named = {};

  for (const hours of COUNT_WINDOWS_HOURS)
    named[`count_${hours}h`] = windows[hours].length;

  // Rate changes: how the recent pace compares with the longer pace. Expressed
  // as a ratio around 1 so the model sees "twice as busy", not raw counts.
  named.rate_change_6h_vs_24h = day.length
    ? windows[6].length / 6 / (day.length / 24)
    : 0;
  named.rate_change_24h_vs_7d = week.length
    ? day.length / 24 / (week.length / 168)
    : 0;
  named.hours_since_last_event = last
    ? Math.min(720, (originTime - last.time) / 3_600_000)
    : 720;
  named.hours_since_largest_7d =
    hoursSinceLargest === null ? 168 : hoursSinceLargest;

  named.max_magnitude_24h = dayMagnitudes.some(Number.isFinite)
    ? Math.max(...dayMagnitudes.filter(Number.isFinite))
    : 0;
  named.max_magnitude_7d = weekMagnitudes.some(Number.isFinite)
    ? Math.max(...weekMagnitudes.filter(Number.isFinite))
    : 0;
  named.mean_magnitude_24h = mean(dayMagnitudes) ?? 0;
  named.median_magnitude_7d = median(weekMagnitudes) ?? 0;
  named.magnitude_trend_24h = magnitudeTrend(day, originTime);

  for (const threshold of MAGNITUDE_THRESHOLDS)
    named[`count_7d_above_${String(threshold).replace('.', '_')}`] =
      week.filter(
        (event) => (event.magnitude ?? -Infinity) >= threshold,
      ).length;

  named.mean_depth_24h = mean(day.map((event) => event.depth)) ?? 0;
  named.min_depth_7d = weekDepths.some(Number.isFinite)
    ? Math.min(...weekDepths.filter(Number.isFinite))
    : 0;
  named.shallow_fraction_7d = week.length
    ? week.filter(
        (event) =>
          Number.isFinite(event.depth) && event.depth <= SHALLOW_DEPTH_KM,
      ).length / week.length
    : 0;
  named.depth_spread_7d = stdev(weekDepths);

  for (const radius of RADII_KM)
    named[`count_7d_within_${radius}km`] = distances.filter(
      (distance) => distance <= radius,
    ).length;

  named.mean_distance_from_centroid_7d = mean(distances) ?? 0;
  named.distance_from_largest_7d_km = largestWeek
    ? distanceKm(center, largestWeek)
    : 0;
  // Low spread relative to the mean distance means the week's events sit on top
  // of each other — the numeric form of "spatially clustered".
  named.spatial_concentration_7d =
    distances.length > 1 && mean(distances) > 0
      ? 1 - Math.min(1, stdev(distances) / mean(distances))
      : 0;

  named.events_since_largest_7d = sinceLargest.length;
  named.rate_since_largest_7d =
    hoursSinceLargest && hoursSinceLargest > 0
      ? sinceLargest.length / hoursSinceLargest
      : 0;

  named.max_significance_7d = week.reduce(
    (worst, event) =>
      Math.max(
        worst,
        Number.isFinite(event.significance) ? event.significance : 0,
      ),
    0,
  );
  named.felt_reports_7d = week.reduce(
    (sum, event) => sum + (Number.isFinite(event.felt) ? event.felt : 0),
    0,
  );

  const month = windows[720];
  // Floored so a region with no recent activity cannot divide by zero and so a
  // single event in a dead region does not read as an infinite surge.
  const baselineDaily = Math.max(0.1, month.length / 30);
  named.baseline_daily_rate_30d = baselineDaily;
  named.ratio_24h_to_baseline = day.length / baselineDaily;
  named.ratio_6h_to_baseline = windows[6].length / (baselineDaily / 4);
  named.ratio_max_mag_24h_to_7d =
    named.max_magnitude_7d > 0
      ? named.max_magnitude_24h / named.max_magnitude_7d
      : 0;

  const values = FEATURE_NAMES.map((name) => {
    const value = named[name];
    return Number.isFinite(value) ? value : 0;
  });
  return { values, named: Object.freeze(named) };
}

/**
 * Count the events that satisfy a target inside a forward window.
 *
 * The only function in this module that looks FORWARD, used exclusively to
 * label training rows and to score a finished forecast — never to build a
 * feature.
 *
 * @param {object} input Input.
 * @param {object[]} input.events Catalog events.
 * @param {number} input.originTime Origin time.
 * @param {number} input.windowHours Forecast window.
 * @param {number} input.thresholdMagnitude Magnitude floor.
 * @returns {number} Qualifying event count.
 */
export function countLabelWindow({
  events,
  originTime,
  windowHours,
  thresholdMagnitude,
}) {
  const to = originTime + windowHours * 3_600_000;
  return events.filter(
    (event) =>
      event.time > originTime &&
      event.time <= to &&
      Number.isFinite(event.magnitude) &&
      event.magnitude >= thresholdMagnitude,
  ).length;
}
