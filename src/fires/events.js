import { ACTIVITY_STATES } from './activity.js';

/**
 * Fire intelligence events.
 *
 * Same contract as the weather engine's change events: a record is emitted when
 * something CHANGED, not while something is merely true. A cluster that has
 * been burning steadily for a day produces no events, which is what makes these
 * safe to wire to downstream work — an EventBridge rule, a notification, a
 * Bedrock summary — without re-triggering on every poll.
 *
 * Nothing here calls AWS. These are plain records a caller may route.
 */

export const FIRE_EVENTS = Object.freeze({
  FIRE_DETECTED: 'FIRE_DETECTED',
  FIRE_CLUSTER_FORMED: 'FIRE_CLUSTER_FORMED',
  FIRE_ACTIVITY_INCREASED: 'FIRE_ACTIVITY_INCREASED',
  FIRE_ACTIVITY_DECREASED: 'FIRE_ACTIVITY_DECREASED',
  FIRE_SPREAD_CONDITIONS_INCREASED: 'FIRE_SPREAD_CONDITIONS_INCREASED',
});

/** Spread-score movement that is worth an event. */
export const SPREAD_CONDITIONS_DELTA = 12;

/** Detections in a brand-new area before it is worth announcing. */
export const NEW_AREA_MIN_DETECTIONS = 3;

/** Clusters announced on a first observation of an area. */
export const FIRST_OBSERVATION_EVENT_LIMIT = 3;

function event({
  type,
  location,
  severity,
  previousState,
  currentState,
  drivers,
  source,
}) {
  return Object.freeze({
    type,
    timestamp: new Date().toISOString(),
    location,
    source: source || 'NASA FIRMS',
    severity,
    previousState,
    currentState,
    drivers: Object.freeze([...(drivers || [])]),
  });
}

/**
 * Severity from the size and heat of what was found.
 * @param {object} cluster Cluster record.
 * @returns {string} Severity id.
 */
function clusterSeverity(cluster) {
  if (cluster.detectionCount >= 40 || cluster.peakFrpBand === 'EXTREME')
    return 'HIGH';
  if (cluster.detectionCount >= 12 || cluster.peakFrpBand === 'HIGH')
    return 'ELEVATED';
  return 'MODERATE';
}

/**
 * Derive events by comparing this observation with the previous one.
 *
 * @param {object} input Comparison input.
 * @param {object[]} input.clusters Current clusters.
 * @param {object[]} [input.previousClusters] Clusters from the previous observation.
 * @param {object} input.activity Activity record from `compareActivity`.
 * @param {object} [input.previousActivity] Previous activity record.
 * @param {object} [input.area] Area descriptor for the event payload.
 * @returns {object[]} Frozen events, most severe first.
 */
export function deriveFireEvents({
  clusters,
  previousClusters,
  activity,
  previousActivity,
  area,
}) {
  const events = [];
  const current = Array.isArray(clusters) ? clusters : [];
  const previous = Array.isArray(previousClusters) ? previousClusters : null;

  // A first look at an area reports what exists; it cannot report change.
  // Only the most significant clusters are announced: a first view of a fire
  // season would otherwise emit dozens of identical events, and a downstream
  // consumer that fires a notification per event would be unusable on day one.
  if (!previous) {
    for (const cluster of current
      .filter(
        (entry) =>
          entry.kind === 'CLUSTER' &&
          entry.detectionCount >= NEW_AREA_MIN_DETECTIONS,
      )
      .slice(0, FIRST_OBSERVATION_EVENT_LIMIT))
      events.push(
        event({
          type: FIRE_EVENTS.FIRE_DETECTED,
          location: cluster.center,
          severity: clusterSeverity(cluster),
          previousState: null,
          currentState: {
            detections: cluster.detectionCount,
            peakFrp: cluster.peakFrp,
            peakFrpBand: cluster.peakFrpBand,
          },
          drivers: [`${cluster.detectionCount} satellite fire detections`],
        }),
      );
    return Object.freeze(events);
  }

  // A cluster with no predecessor nearby is newly formed.
  const near = (a, b) =>
    Math.abs(a.latitude - b.latitude) < 0.15 &&
    Math.abs(a.longitude - b.longitude) < 0.15;
  for (const cluster of current) {
    if (cluster.kind !== 'CLUSTER') continue;
    const predecessor = previous.find((entry) =>
      near(entry.center, cluster.center),
    );
    if (!predecessor)
      events.push(
        event({
          type: FIRE_EVENTS.FIRE_CLUSTER_FORMED,
          location: cluster.center,
          severity: clusterSeverity(cluster),
          previousState: null,
          currentState: {
            detections: cluster.detectionCount,
            peakFrpBand: cluster.peakFrpBand,
          },
          drivers: ['a new group of detections formed in this area'],
        }),
      );
    else if (
      Number.isFinite(cluster.spreadConditions?.score) &&
      Number.isFinite(predecessor.spreadConditions?.score) &&
      cluster.spreadConditions.score - predecessor.spreadConditions.score >=
        SPREAD_CONDITIONS_DELTA
    )
      events.push(
        event({
          type: FIRE_EVENTS.FIRE_SPREAD_CONDITIONS_INCREASED,
          location: cluster.center,
          severity:
            cluster.spreadConditions.level === 'HIGH' ? 'HIGH' : 'ELEVATED',
          previousState: {
            score: predecessor.spreadConditions.score,
            level: predecessor.spreadConditions.level,
          },
          currentState: {
            score: cluster.spreadConditions.score,
            level: cluster.spreadConditions.level,
          },
          drivers: (cluster.spreadConditions.leadingDrivers || []).map(
            (driver) => driver.label,
          ),
        }),
      );
  }

  // Area-wide activity movement.
  if (
    activity?.status === ACTIVITY_STATES.INCREASING ||
    activity?.status === ACTIVITY_STATES.DECREASING
  )
    events.push(
      event({
        type:
          activity.status === ACTIVITY_STATES.INCREASING
            ? FIRE_EVENTS.FIRE_ACTIVITY_INCREASED
            : FIRE_EVENTS.FIRE_ACTIVITY_DECREASED,
        location: area?.center || current[0]?.center || null,
        severity:
          Math.abs(activity.changePercent) >= 50
            ? 'HIGH'
            : Math.abs(activity.changePercent) >= 25
              ? 'ELEVATED'
              : 'MODERATE',
        previousState: {
          detections: activity.previousDetectionCount,
          status: previousActivity?.status ?? null,
        },
        currentState: {
          detections: activity.detectionCount,
          status: activity.status,
        },
        drivers: [activity.note],
      }),
    );

  const order = { HIGH: 3, ELEVATED: 2, MODERATE: 1 };
  return Object.freeze(
    events.sort((a, b) => (order[b.severity] || 0) - (order[a.severity] || 0)),
  );
}
