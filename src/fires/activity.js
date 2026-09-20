/**
 * Fire activity trend between observation windows.
 *
 * Satellite fire data is not a stream, it is a series of overpasses. Two
 * consecutive FIRMS responses can differ because the fire grew, because a
 * different satellite passed over, or because cloud hid the ground. So the
 * honest unit of comparison is "what this service last observed for this area"
 * versus "what it observes now", and anything the data cannot support is
 * reported as INSUFFICIENT_DATA rather than guessed.
 *
 * A trend is never invented from a single observation.
 */

/** Relative change, in percent, that counts as real movement. */
export const ACTIVITY_DEADBAND_PERCENT = 15;

/** Minimum detections in either window before a percentage is meaningful. */
export const MIN_COMPARABLE_DETECTIONS = 3;

/** Trend states. */
export const ACTIVITY_STATES = Object.freeze({
  INCREASING: 'INCREASING',
  DECREASING: 'DECREASING',
  STEADY: 'STEADY',
  INSUFFICIENT: 'INSUFFICIENT_DATA',
});

/**
 * Compare the current observation of an area with the previous one.
 *
 * @param {object} input Comparison input.
 * @param {object[]} input.detections Current detections.
 * @param {object[]} [input.previousDetections] Detections from the last observation.
 * @param {number|null} [input.previousObservedMs] When that observation was made.
 * @param {number} [input.now] Clock.
 * @returns {object} Frozen activity record.
 */
export function compareActivity({
  detections,
  previousDetections,
  previousObservedMs = null,
  now = Date.now(),
}) {
  const current = Array.isArray(detections) ? detections : [];
  const previous = Array.isArray(previousDetections)
    ? previousDetections
    : null;

  if (!previous) {
    return Object.freeze({
      status: ACTIVITY_STATES.INSUFFICIENT,
      detectionCount: current.length,
      previousDetectionCount: null,
      changePercent: null,
      newDetections: null,
      clearedDetections: null,
      peakFrpChange: null,
      note: 'Insufficient observations for trend analysis.',
      comparedWindowMs: null,
    });
  }

  const currentIds = new Set(current.map((detection) => detection.id));
  const previousIds = new Set(previous.map((detection) => detection.id));
  const newDetections = current.filter(
    (detection) => !previousIds.has(detection.id),
  ).length;
  const clearedDetections = previous.filter(
    (detection) => !currentIds.has(detection.id),
  ).length;

  const peak = (list) => {
    const values = list
      .map((detection) => detection.fireRadiativePower)
      .filter((value) => Number.isFinite(value));
    return values.length ? Math.max(...values) : null;
  };
  const currentPeak = peak(current);
  const previousPeak = peak(previous);

  // Percentages on tiny counts are noise dressed as insight: three detections
  // becoming five is not "up 67%" in any way an operator should act on.
  if (
    current.length < MIN_COMPARABLE_DETECTIONS &&
    previous.length < MIN_COMPARABLE_DETECTIONS
  ) {
    return Object.freeze({
      status: ACTIVITY_STATES.INSUFFICIENT,
      detectionCount: current.length,
      previousDetectionCount: previous.length,
      changePercent: null,
      newDetections,
      clearedDetections,
      peakFrpChange:
        Number.isFinite(currentPeak) && Number.isFinite(previousPeak)
          ? Number((currentPeak - previousPeak).toFixed(2))
          : null,
      note: 'Insufficient observations for trend analysis.',
      comparedWindowMs: previousObservedMs ? now - previousObservedMs : null,
    });
  }

  const changePercent = previous.length
    ? Number(
        (((current.length - previous.length) / previous.length) * 100).toFixed(
          1,
        ),
      )
    : null;
  const status = !Number.isFinite(changePercent)
    ? ACTIVITY_STATES.INSUFFICIENT
    : changePercent >= ACTIVITY_DEADBAND_PERCENT
      ? ACTIVITY_STATES.INCREASING
      : changePercent <= -ACTIVITY_DEADBAND_PERCENT
        ? ACTIVITY_STATES.DECREASING
        : ACTIVITY_STATES.STEADY;

  return Object.freeze({
    status,
    detectionCount: current.length,
    previousDetectionCount: previous.length,
    changePercent,
    newDetections,
    clearedDetections,
    peakFrpChange:
      Number.isFinite(currentPeak) && Number.isFinite(previousPeak)
        ? Number((currentPeak - previousPeak).toFixed(2))
        : null,
    note:
      status === ACTIVITY_STATES.INCREASING
        ? `${current.length} detections, up ${Math.abs(changePercent)}% on the previous observation.`
        : status === ACTIVITY_STATES.DECREASING
          ? `${current.length} detections, down ${Math.abs(changePercent)}% on the previous observation.`
          : `${current.length} detections, broadly unchanged since the previous observation.`,
    comparedWindowMs: previousObservedMs ? now - previousObservedMs : null,
  });
}
