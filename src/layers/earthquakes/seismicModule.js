/**
 * The seismic module shown in the Aegis Intelligence column.
 *
 * The left column answers "what is the state of this region", and seismicity is
 * part of that answer — but it comes from USGS rather than from the weather
 * engine, so it needs translating into the same hazard shape the other modules
 * use. That is all this module does.
 *
 * Two things it deliberately does NOT do:
 *
 *  1. It does not forecast. The score describes RECORDED ACTIVITY over the feed
 *     window — how large, how many, whether a sequence is present — and nothing
 *     about what comes next. The forecasting model has its own panel section,
 *     its own probability, and its own validation figures.
 *  2. It does not invent a hazard where there is no observation. An empty feed
 *     window scores zero and says "no earthquakes recorded", which is a
 *     statement about the USGS catalog, not about the ground.
 *
 * The score is a plain weighted maximum, not a model: magnitude dominates,
 * because one M6 matters more than forty M2s, and count and sequence presence
 * lift it from there.
 */

/**
 * Magnitude to a 0..100 contribution.
 *
 * Anchored on the bands USGS itself uses: below M3 is rarely felt, M4.5 is the
 * global reporting threshold, M6+ is damaging near the epicentre. Linear
 * between the anchors, flat outside them.
 */
const MAGNITUDE_ANCHORS = Object.freeze([
  [2.5, 8],
  [3.5, 24],
  [4.5, 45],
  [5.5, 68],
  [6.5, 88],
  [7.5, 100],
]);

/** Interpolate a magnitude against {@link MAGNITUDE_ANCHORS}. */
export function magnitudeScore(magnitude) {
  if (!Number.isFinite(magnitude)) return 0;
  const first = MAGNITUDE_ANCHORS[0];
  const last = MAGNITUDE_ANCHORS[MAGNITUDE_ANCHORS.length - 1];
  if (magnitude <= first[0])
    return Math.max(0, (magnitude / first[0]) * first[1]);
  if (magnitude >= last[0]) return last[1];
  for (let i = 1; i < MAGNITUDE_ANCHORS.length; i += 1) {
    const [highMag, highScore] = MAGNITUDE_ANCHORS[i];
    if (magnitude > highMag) continue;
    const [lowMag, lowScore] = MAGNITUDE_ANCHORS[i - 1];
    const ratio = (magnitude - lowMag) / (highMag - lowMag);
    return lowScore + ratio * (highScore - lowScore);
  }
  return last[1];
}

/** Event count to a smaller 0..100 contribution: many small events still matter. */
export function countScore(count) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  // Logarithmic: 1 event ≈ 0, 10 ≈ 33, 100 ≈ 66, 1000 ≈ 100.
  return Math.min(100, (Math.log10(count) / 3) * 100);
}

/** Level bands, matching the weather engine's vocabulary exactly. */
function levelFor(score) {
  if (score >= 81) return 'HIGH';
  if (score >= 61) return 'ELEVATED';
  if (score >= 41) return 'MODERATE';
  if (score >= 21) return 'LOW';
  return 'NORMAL';
}

/** Activity status to the trend vocabulary the risk modules already speak. */
const TREND_BY_STATUS = Object.freeze({
  INCREASING: 'INCREASING',
  DECREASING: 'DECREASING',
  STEADY: 'STABLE',
  INSUFFICIENT_DATA: 'UNKNOWN',
});

/**
 * Build the seismic risk module from one earthquake intelligence record.
 *
 * @param {object|null} intelligence Earthquake intelligence record.
 * @returns {object|null} Hazard-shaped module, or null without a record.
 */
export function seismicRiskModule(intelligence) {
  if (!intelligence) return null;

  const magnitude = intelligence.largestEvent?.magnitude ?? null;
  const count = intelligence.eventCount ?? 0;
  const sequences = intelligence.sequenceCount ?? 0;
  const significant = intelligence.alerts?.significant?.length ?? 0;

  const fromMagnitude = magnitudeScore(magnitude);
  const fromCount = countScore(count);
  // The largest event carries the picture; the rest lifts it. A sequence is a
  // structural fact about the activity, so it is worth a fixed step rather than
  // a proportion of a count it has already influenced.
  const base = Math.max(fromMagnitude, fromCount * 0.6);
  const sequenceLift = sequences > 0 ? 10 : 0;
  const significantLift = significant > 0 ? 12 : 0;
  const score = Math.round(
    Math.max(0, Math.min(100, base + sequenceLift + significantLift)),
  );

  const level = count === 0 ? 'NORMAL' : levelFor(score);
  const direction = TREND_BY_STATUS[intelligence.activity?.status] || 'UNKNOWN';

  // Drivers mirror the weather engine's records so ANALYSIS and ACTION can read
  // them without a special case.
  const drivers = [];
  if (Number.isFinite(magnitude))
    drivers.push({
      id: 'largestMagnitude',
      label: 'Largest recorded event',
      state: level,
      contribution: Math.round(fromMagnitude),
      detail: `USGS recorded M${magnitude}${intelligence.largestEvent?.place ? ` at ${intelligence.largestEvent.place}` : ''}`,
    });
  if (count > 0)
    drivers.push({
      id: 'eventCount',
      label: 'Recorded events',
      state: level,
      contribution: Math.round(fromCount * 0.6),
      detail: `${count} earthquakes recorded in the last ${intelligence.feedWindowHours}h`,
    });
  if (sequences > 0)
    drivers.push({
      id: 'sequences',
      label: 'Earthquake sequences',
      state: level,
      contribution: sequenceLift,
      detail: `${sequences} earthquake sequence${sequences > 1 ? 's' : ''} in this view`,
    });

  return Object.freeze({
    id: 'seismic',
    label: 'Seismic Activity',
    score,
    level,
    // Ordered by contribution so the panel's "leading driver" really is one.
    leadingDrivers: Object.freeze(
      [...drivers].sort((a, b) => b.contribution - a.contribution),
    ),
    drivers: Object.freeze(drivers),
    trend: Object.freeze({
      direction,
      // "observed" because this is a comparison of two recorded windows, not a
      // projection of a third.
      source: direction === 'UNKNOWN' ? 'unknown' : 'observed',
      change: intelligence.activity?.changePercent ?? null,
    }),
    summary: count
      ? `${intelligence.summary} ${intelligence.activity?.note || ''}`.trim()
      : intelligence.summary,
    // Stated on the record so no consumer can mistake it for a forecast.
    basis: 'Recorded USGS activity over the feed window. Not a forecast.',
    source: 'USGS',
  });
}
