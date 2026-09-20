/**
 * Earthquake intelligence configuration.
 *
 * Every threshold the earthquake layer judges by lives here: magnitude and
 * depth categories, clustering windows, activity deadbands and alert rules.
 *
 * None of this predicts earthquakes. Categories describe an observation that
 * has already happened, and the wording throughout is chosen so a category can
 * never be read as a damage estimate.
 */

/** USGS GeoJSON summary feeds. Values are the feed ids USGS publishes. */
export const USGS_FEEDS = Object.freeze({
  all_hour: {
    id: 'all_hour',
    windowHours: 1,
    label: 'All earthquakes, past hour',
  },
  all_day: {
    id: 'all_day',
    windowHours: 24,
    label: 'All earthquakes, past day',
  },
  '2.5_day': { id: '2.5_day', windowHours: 24, label: 'M2.5+, past day' },
  '4.5_day': { id: '4.5_day', windowHours: 24, label: 'M4.5+, past day' },
  significant_week: {
    id: 'significant_week',
    windowHours: 168,
    label: 'Significant earthquakes, past week',
  },
  all_week: {
    id: 'all_week',
    windowHours: 168,
    label: 'All earthquakes, past week',
  },
});

/**
 * Default feed.
 *
 * `all_day` is the practical recent feed: one request covers every magnitude
 * for the last 24 hours, which is the window the activity and sequence models
 * need. Larger archives are deliberately not downloaded.
 */
export const DEFAULT_FEED = 'all_day';

/**
 * Magnitude categories.
 *
 * These name the SIZE OF THE RECORDED EVENT and nothing else. A M6 at 600 km
 * under the ocean and a M6 at 8 km under a city share this label, so the
 * category is never presented as a consequence.
 */
export const MAGNITUDE_CATEGORIES = Object.freeze([
  { id: 'MINOR', min: -Infinity, max: 2.5, label: 'Minor' },
  { id: 'LIGHT', min: 2.5, max: 4.5, label: 'Light' },
  { id: 'MODERATE', min: 4.5, max: 6.0, label: 'Moderate' },
  { id: 'STRONG', min: 6.0, max: 7.0, label: 'Strong' },
  { id: 'MAJOR', min: 7.0, max: 8.0, label: 'Major' },
  { id: 'GREAT', min: 8.0, max: Infinity, label: 'Great' },
]);

/**
 * Depth categories, in kilometres, following the usual seismological bands.
 * Depth is context — it says how far the energy travelled before reaching the
 * surface, not what it did on arrival.
 */
export const DEPTH_CATEGORIES = Object.freeze([
  { id: 'SHALLOW', max: 70, label: 'Shallow' },
  { id: 'INTERMEDIATE', max: 300, label: 'Intermediate' },
  { id: 'DEEP', max: Infinity, label: 'Deep' },
]);

/** Spatial and temporal windows that group events into one sequence. */
export const SEQUENCE = Object.freeze({
  radiusKm: 100,
  windowHours: 72,
  minEvents: 3,
});

/** Activity comparison windows and the movement that counts as a change. */
export const ACTIVITY = Object.freeze({
  windows: Object.freeze([1, 6, 24]),
  comparisonHours: 6,
  /** Relative change, in percent, before a rate is called increasing or decreasing. */
  deadbandPercent: 25,
  /** Events needed in either window before a percentage means anything. */
  minComparable: 3,
});

/** Radii offered for geographic analysis around an epicentre, in kilometres. */
export const ANALYSIS_RADII_KM = Object.freeze([5, 10, 25, 50, 100]);

/** Default analysis radius. */
export const DEFAULT_ANALYSIS_RADIUS_KM = 25;

/**
 * Alert rules.
 *
 * Deliberately conservative: most earthquakes are INFORMATION. An alert level
 * is raised only by something the source data actually states — a large
 * magnitude, USGS's own significance score, a USGS tsunami flag, widespread
 * felt reports, or a burst of local activity.
 */
export const ALERT_RULES = Object.freeze({
  significant: Object.freeze({
    magnitude: 6.0,
    usgsSignificance: 600,
    tsunamiFlag: true,
    feltReports: 1000,
  }),
  watch: Object.freeze({
    magnitude: 4.5,
    usgsSignificance: 300,
    feltReports: 100,
    sequenceEvents: 8,
    /**
     * An event must be at least this large to inherit its sequence's watch.
     * Without it, a swarm of M1s would mark a hundred events WATCH and bury the
     * ones that matter — the sequence itself is still reported separately.
     */
    sequenceMinMagnitude: 3.0,
  }),
});

/** Alert levels, lowest first. */
export const ALERT_LEVELS = Object.freeze([
  'INFORMATION',
  'WATCH',
  'SIGNIFICANT',
]);

/** Felt-report count above which public reporting is called substantial. */
export const SUBSTANTIAL_FELT_REPORTS = 500;

/**
 * Name the magnitude band of a recorded event.
 * @param {number|null} magnitude Reported magnitude.
 * @returns {{id: string, label: string}|null} Category, or null without a magnitude.
 */
export function magnitudeCategory(magnitude) {
  if (!Number.isFinite(magnitude)) return null;
  const band = MAGNITUDE_CATEGORIES.find(
    (entry) => magnitude >= entry.min && magnitude < entry.max,
  );
  return band ? Object.freeze({ id: band.id, label: band.label }) : null;
}

/**
 * Name the depth band of a recorded event.
 * @param {number|null} depthKm Depth in kilometres.
 * @returns {{id: string, label: string}|null} Category, or null without a depth.
 */
export function depthCategory(depthKm) {
  if (!Number.isFinite(depthKm)) return null;
  const band = DEPTH_CATEGORIES.find((entry) => depthKm < entry.max);
  return band ? Object.freeze({ id: band.id, label: band.label }) : null;
}
