import { clusterEarthquakes, describeSequence } from './sequences.js';
import { earthquakeActivity } from './activity.js';
import {
  assessAlert,
  feltReportNote,
  deriveEarthquakeEvents,
} from './alerts.js';
import { geographicExposure, ANALYSIS_RADIUS_LABEL } from './exposure.js';
import {
  DEFAULT_ANALYSIS_RADIUS_KM,
  USGS_FEEDS,
  DEFAULT_FEED,
} from './thresholds.js';

/**
 * Earthquake intelligence: USGS observations, organized.
 *
 * The hard line in this layer is that earthquakes cannot be predicted, so there
 * is no score that pretends otherwise. What Aegis adds to USGS is ORGANIZATION:
 * which events belong to the same sequence, how the recorded rate compares with
 * the previous window, which events clear an alert threshold, and what the
 * geography around an epicentre is — each traceable to a measurement.
 *
 * Every figure below is either copied from USGS or counted from USGS records.
 * Nothing here estimates damage, casualties or infrastructure loss.
 */

export const SCHEMA_VERSION = '1.0.0';

/**
 * Assemble intelligence for a set of observations.
 *
 * @param {object} input Input.
 * @param {object} input.snapshot Normalized USGS snapshot.
 * @param {object[]} [input.events] Events to analyze; defaults to the snapshot's.
 * @param {object} [input.previous] Previous observation for this area.
 * @param {object} [input.area] Area descriptor.
 * @param {number} [input.now] Clock.
 * @returns {object} Frozen intelligence record.
 */
export function assembleEarthquakeIntelligence({
  snapshot,
  events,
  previous = null,
  area = null,
  now = Date.now(),
}) {
  const observed = Array.isArray(events) ? events : (snapshot?.events ?? []);
  const feed = snapshot?.feed ?? DEFAULT_FEED;
  const feedWindowHours = USGS_FEEDS[feed]?.windowHours ?? 24;

  const clusters = clusterEarthquakes(observed, { now });
  const activity = earthquakeActivity({
    events: observed,
    now,
    feedWindowHours,
  });

  const clusterById = new Map();
  for (const cluster of clusters)
    for (const event of cluster.events) clusterById.set(event.id, cluster);

  // Alert grading is per event, because an alert is about a measurement.
  const graded = observed.map((event) => {
    const alert = assessAlert(event, {
      cluster: clusterById.get(event.id) ?? null,
    });
    return Object.freeze({ ...event, alert, feltNote: feltReportNote(event) });
  });

  const internalEvents = deriveEarthquakeEvents({
    clusters,
    previousClusters: previous?.clusters ?? null,
    activity,
    previousActivity: previous?.activity ?? null,
    knownEventIds: previous?.eventIds ? new Set(previous.eventIds) : null,
  });

  const significant = graded.filter(
    (event) => event.alert.level === 'SIGNIFICANT',
  );
  const watch = graded.filter((event) => event.alert.level === 'WATCH');
  const sequences = clusters.filter((cluster) => cluster.kind === 'SEQUENCE');
  const largest = graded.reduce(
    (worst, event) =>
      (event.magnitude ?? -Infinity) > (worst?.magnitude ?? -Infinity)
        ? event
        : worst,
    null,
  );

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    source: 'USGS',
    attribution: 'USGS Earthquake Hazards Program',
    feed,
    feedWindowHours,
    observedAt: new Date(now).toISOString(),
    feedGeneratedAt: snapshot?.generatedAt
      ? new Date(snapshot.generatedAt).toISOString()
      : null,
    area: area ? Object.freeze({ ...area }) : null,
    eventCount: graded.length,
    events: Object.freeze(graded),
    clusters,
    sequenceCount: sequences.length,
    activity,
    alerts: Object.freeze({
      significant: Object.freeze(significant.map((event) => event.id)),
      watch: Object.freeze(watch.map((event) => event.id)),
    }),
    internalEvents,
    largestEvent: largest
      ? Object.freeze({
          id: largest.id,
          magnitude: largest.magnitude,
          place: largest.place,
          timeIso: largest.timeIso,
          alertLevel: largest.alert.level,
        })
      : null,
    // An empty feed window is a statement about what was RECORDED.
    summary: graded.length
      ? `${graded.length} earthquake${graded.length === 1 ? '' : 's'} recorded by USGS in this view over the last ${feedWindowHours}h` +
        (sequences.length
          ? `, including ${sequences.length} earthquake sequence${sequences.length > 1 ? 's' : ''}.`
          : '.')
      : `No earthquakes recorded by USGS in this view over the last ${feedWindowHours}h.`,
    sequenceNotes: Object.freeze(sequences.slice(0, 3).map(describeSequence)),
  });
}

/**
 * Weather context for post-event response, never for causation.
 *
 * Weather does not cause earthquakes and cannot predict them. What it can do is
 * tell a responder what conditions they would be working in, so this function
 * only ever produces a response-planning sentence, and only when the weather is
 * actually notable.
 *
 * @param {object} input Input.
 * @param {object} input.event Earthquake event.
 * @param {object|null} input.metrics Derived weather metrics for the epicentre.
 * @returns {object|null} Frozen response-context record, or null.
 */
export function responseWeatherContext({ event, metrics }) {
  if (!metrics) return null;
  const notes = [];
  if ((metrics.rain_6h ?? 0) >= 5 || (metrics.forecast_rain_12h ?? 0) >= 10)
    notes.push(
      'Heavy rainfall is present or forecast in the surrounding region and may be relevant to post-event response planning.',
    );
  if ((metrics.wind_speed_10m ?? 0) >= 40)
    notes.push(
      'Strong wind is present in the surrounding region and may affect air support and debris handling.',
    );
  if (Number.isFinite(metrics.temperature_2m) && metrics.temperature_2m <= 2)
    notes.push(
      'Near-freezing temperatures are present in the surrounding region and may be relevant to shelter planning.',
    );
  if (Number.isFinite(metrics.visibility) && metrics.visibility <= 2000)
    notes.push(
      'Reduced visibility is present in the surrounding region and may affect movement and air support.',
    );
  if (!notes.length) return null;

  return Object.freeze({
    eventId: event?.id ?? null,
    // The disclaimer travels with the data so no consumer can reframe it.
    relationship: 'RESPONSE_CONTEXT_ONLY',
    disclaimer:
      'Weather is reported as response context. It has no causal relationship with earthquake occurrence and is not used to predict earthquakes.',
    conditions: Object.freeze({
      temperature: metrics.temperature_2m ?? null,
      rain6h: metrics.rain_6h ?? null,
      forecastRain12h: metrics.forecast_rain_12h ?? null,
      windSpeed: metrics.wind_speed_10m ?? null,
      visibility: metrics.visibility ?? null,
    }),
    notes: Object.freeze(notes),
  });
}

/**
 * Structured incident record for Amazon Bedrock.
 *
 * Bedrock explains; it does not measure. Magnitude, depth, felt reports and the
 * tsunami flag are USGS values carried through unchanged, and the record states
 * its source so a generated answer can attribute them correctly.
 *
 * @param {object} event Graded earthquake event.
 * @param {object} [context] Context.
 * @param {object|null} [context.cluster] The event's cluster.
 * @param {object|null} [context.activity] Area activity.
 * @param {object|null} [context.exposure] Geographic exposure context.
 * @param {object|null} [context.weather] Response weather context.
 * @returns {object} Frozen incident record.
 */
export function earthquakeIncidentRecord(
  event,
  { cluster = null, activity = null, exposure = null, weather = null } = {},
) {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    incidentType: 'EARTHQUAKE',
    source: 'USGS',
    sourceName: 'USGS Earthquake Hazards Program',
    observation: 'RECORDED_EVENT',
    eventId: event.id,
    magnitude: event.magnitude,
    magnitudeType: event.magnitudeType,
    magnitudeCategory: event.magnitudeCategory?.label ?? null,
    depthKm: event.depth,
    depthCategory: event.depthCategory?.label ?? null,
    location: Object.freeze({
      latitude: event.latitude,
      longitude: event.longitude,
      place: event.place,
    }),
    eventTime: event.timeIso,
    lastUpdated: event.updatedIso,
    feltReports: event.felt,
    tsunamiFlag: event.tsunami,
    // USGS's own PAGER alert colour, distinct from the Aegis alert level below.
    usgsAlertLevel: event.raw?.alert ?? null,
    usgsSignificance: event.significance,
    usgsStatus: event.status,
    usgsEventPage: event.url,
    aegisAlertLevel: event.alert?.level ?? null,
    aegisAlertDrivers: event.alert?.drivers ?? Object.freeze([]),
    sequence: cluster
      ? Object.freeze({
          detected: cluster.kind === 'SEQUENCE',
          eventCount: cluster.eventCount,
          maxMagnitude: cluster.maxMagnitude,
          radiusKm: cluster.radiusKm,
          spanHours: cluster.spanHours,
          activityTrend: activity?.status ?? null,
        })
      : null,
    activity: activity
      ? Object.freeze({
          status: activity.status,
          rates: activity.rates,
          note: activity.note,
        })
      : null,
    geographicContext: exposure
      ? Object.freeze({
          analysisRadiusKm: exposure.analysisRadiusKm,
          radiusLabel: exposure.radiusLabel,
          status: exposure.status,
          basis: exposure.basis,
        })
      : Object.freeze({
          analysisRadiusKm: DEFAULT_ANALYSIS_RADIUS_KM,
          radiusLabel: ANALYSIS_RADIUS_LABEL,
          status: 'UNAVAILABLE',
          basis:
            'Geographic analysis radius only. Not a damage radius and not an affected-area estimate.',
        }),
    responseWeather: weather,
    constraints: Object.freeze([
      'Earthquake occurrence cannot be predicted from this data.',
      'No damage, casualty or infrastructure-loss estimate is included.',
      'Magnitude, depth, felt reports, significance and the tsunami flag are USGS values.',
    ]),
  });
}

export { geographicExposure };
