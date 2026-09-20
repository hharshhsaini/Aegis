import { ALERT_RULES, SUBSTANTIAL_FELT_REPORTS } from './thresholds.js';
import { ACTIVITY_STATES } from './activity.js';

/**
 * Earthquake alert levels and internal events.
 *
 * Two rules govern this module. First, most earthquakes are INFORMATION: the
 * world records thousands a week, and a layer that shouts about each one is
 * noise an operator learns to mute. Second, a level is raised only by something
 * the SOURCE states — magnitude, USGS significance, the USGS tsunami flag,
 * felt-report volume, or a burst of local activity — never by inference about
 * damage, casualties or infrastructure.
 *
 * The vocabulary stops at SIGNIFICANT. No emergency terminology is used, because
 * this layer has no data that could justify it.
 */

export const EARTHQUAKE_EVENTS = Object.freeze({
  EARTHQUAKE_DETECTED: 'EARTHQUAKE_DETECTED',
  SIGNIFICANT_EARTHQUAKE_DETECTED: 'SIGNIFICANT_EARTHQUAKE_DETECTED',
  EARTHQUAKE_CLUSTER_FORMED: 'EARTHQUAKE_CLUSTER_FORMED',
  EARTHQUAKE_SEQUENCE_DETECTED: 'EARTHQUAKE_SEQUENCE_DETECTED',
  EARTHQUAKE_ACTIVITY_INCREASED: 'EARTHQUAKE_ACTIVITY_INCREASED',
});

/**
 * Grade one event, with the reasons that produced the grade.
 *
 * @param {object} event Normalized earthquake event.
 * @param {object} [context] Surrounding context.
 * @param {object|null} [context.cluster] The cluster the event belongs to.
 * @returns {{level: string, drivers: string[]}} Alert assessment.
 */
export function assessAlert(event, { cluster = null } = {}) {
  const drivers = [];
  const { significant, watch } = ALERT_RULES;

  if (
    Number.isFinite(event.magnitude) &&
    event.magnitude >= significant.magnitude
  )
    drivers.push({
      level: 'SIGNIFICANT',
      text: `USGS reports magnitude ${event.magnitude.toFixed(1)}`,
    });
  if (event.tsunami)
    drivers.push({
      level: 'SIGNIFICANT',
      text: 'USGS has set the tsunami flag',
    });
  if (
    Number.isFinite(event.significance) &&
    event.significance >= significant.usgsSignificance
  )
    drivers.push({
      level: 'SIGNIFICANT',
      text: `USGS significance ${event.significance}`,
    });
  if (Number.isFinite(event.felt) && event.felt >= significant.feltReports)
    drivers.push({
      level: 'SIGNIFICANT',
      text: `${event.felt.toLocaleString('en-US')} felt reports`,
    });

  if (Number.isFinite(event.magnitude) && event.magnitude >= watch.magnitude)
    drivers.push({
      level: 'WATCH',
      text: `USGS reports magnitude ${event.magnitude.toFixed(1)}`,
    });
  if (
    Number.isFinite(event.significance) &&
    event.significance >= watch.usgsSignificance
  )
    drivers.push({
      level: 'WATCH',
      text: `USGS significance ${event.significance}`,
    });
  if (Number.isFinite(event.felt) && event.felt >= watch.feltReports)
    drivers.push({
      level: 'WATCH',
      text: `${event.felt.toLocaleString('en-US')} felt reports`,
    });
  if (
    cluster?.kind === 'SEQUENCE' &&
    cluster.eventCount >= watch.sequenceEvents &&
    Number.isFinite(event.magnitude) &&
    event.magnitude >= watch.sequenceMinMagnitude
  )
    drivers.push({
      level: 'WATCH',
      text: `${cluster.eventCount} events recorded in this sequence`,
    });

  const level = drivers.some((driver) => driver.level === 'SIGNIFICANT')
    ? 'SIGNIFICANT'
    : drivers.some((driver) => driver.level === 'WATCH')
      ? 'WATCH'
      : 'INFORMATION';

  return Object.freeze({
    level,
    drivers: Object.freeze(
      drivers
        .filter((driver) => driver.level === level)
        .map((driver) => driver.text),
    ),
  });
}

/**
 * Whether public reporting on an event is substantial enough to point out.
 * Felt reports measure how many people reported shaking — not damage.
 *
 * @param {object} event Normalized event.
 * @returns {string|null} Sentence, or null when there is nothing notable.
 */
export function feltReportNote(event) {
  if (!Number.isFinite(event.felt) || event.felt < SUBSTANTIAL_FELT_REPORTS)
    return null;
  return `Substantial public reporting associated with this event (${event.felt.toLocaleString('en-US')} felt reports to USGS).`;
}

function record({ type, event, location, severity, drivers, context }) {
  return Object.freeze({
    type,
    timestamp: new Date().toISOString(),
    eventId: event?.id ?? null,
    location,
    source: 'USGS',
    severity,
    drivers: Object.freeze([...(drivers || [])]),
    context: context ? Object.freeze({ ...context }) : null,
  });
}

/**
 * Derive internal events for a set of observations.
 *
 * Previous state is compared where it exists, so a standing sequence does not
 * re-announce itself on every refresh.
 *
 * @param {object} input Input.
 * @param {object[]} input.clusters Current clusters.
 * @param {object[]} [input.previousClusters] Clusters from the previous observation.
 * @param {object} input.activity Activity record.
 * @param {object} [input.previousActivity] Previous activity record.
 * @param {Set<string>|null} [input.knownEventIds] Event ids already reported.
 * @returns {object[]} Frozen internal events.
 */
export function deriveEarthquakeEvents({
  clusters,
  previousClusters = null,
  activity,
  previousActivity = null,
  knownEventIds = null,
}) {
  const events = [];
  const current = Array.isArray(clusters) ? clusters : [];

  for (const cluster of current) {
    for (const event of cluster.events) {
      // A refresh must not re-announce an event already reported.
      if (knownEventIds?.has(event.id)) continue;
      const alert = assessAlert(event, { cluster });
      if (alert.level === 'INFORMATION') continue;
      events.push(
        record({
          type:
            alert.level === 'SIGNIFICANT'
              ? EARTHQUAKE_EVENTS.SIGNIFICANT_EARTHQUAKE_DETECTED
              : EARTHQUAKE_EVENTS.EARTHQUAKE_DETECTED,
          event,
          location: { latitude: event.latitude, longitude: event.longitude },
          severity: alert.level,
          drivers: alert.drivers,
          context: {
            magnitude: event.magnitude,
            depthKm: event.depth,
            place: event.place,
            tsunamiFlag: event.tsunami,
            usgsStatus: event.status,
          },
        }),
      );
    }
  }

  const near = (a, b) =>
    Math.abs(a.latitude - b.latitude) < 1 &&
    Math.abs(a.longitude - b.longitude) < 1;
  for (const cluster of current) {
    if (cluster.kind !== 'SEQUENCE') continue;
    const predecessor = previousClusters?.find((entry) =>
      near(entry.center, cluster.center),
    );
    // Crossing INTO sequence status is the news, whether or not a smaller group
    // was already being tracked at this location. Only a group that was already
    // a sequence and merely grew reports growth instead.
    if (!predecessor || predecessor.kind !== 'SEQUENCE')
      events.push(
        record({
          type: EARTHQUAKE_EVENTS.EARTHQUAKE_SEQUENCE_DETECTED,
          event: { id: cluster.largestEventId },
          location: cluster.center,
          severity: 'WATCH',
          drivers: [
            `${cluster.eventCount} events within ${cluster.radiusKm} km, largest M${cluster.maxMagnitude ?? '—'}`,
          ],
          context: {
            eventCount: cluster.eventCount,
            maxMagnitude: cluster.maxMagnitude,
            spanHours: cluster.spanHours,
          },
        }),
      );
    else if (cluster.eventCount > predecessor.eventCount)
      events.push(
        record({
          type: EARTHQUAKE_EVENTS.EARTHQUAKE_CLUSTER_FORMED,
          event: { id: cluster.largestEventId },
          location: cluster.center,
          severity: 'INFORMATION',
          drivers: [
            `sequence grew from ${predecessor.eventCount} to ${cluster.eventCount} events`,
          ],
          context: { eventCount: cluster.eventCount },
        }),
      );
  }

  if (
    activity?.status === ACTIVITY_STATES.INCREASING &&
    previousActivity?.status !== ACTIVITY_STATES.INCREASING
  )
    events.push(
      record({
        type: EARTHQUAKE_EVENTS.EARTHQUAKE_ACTIVITY_INCREASED,
        event: null,
        location: current[0]?.center ?? null,
        severity: 'INFORMATION',
        drivers: [activity.note],
        context: {
          currentWindowEvents: activity.currentWindowEvents,
          previousWindowEvents: activity.previousWindowEvents,
          changePercent: activity.changePercent,
        },
      }),
    );

  const order = { SIGNIFICANT: 3, WATCH: 2, INFORMATION: 1 };
  return Object.freeze(
    events.sort((a, b) => (order[b.severity] || 0) - (order[a.severity] || 0)),
  );
}
