import { createIncident, INCIDENT_KINDS, SOURCE_TYPES } from './model.js';
import { magnitudeScore } from '../layers/earthquakes/seismicModule.js';

/**
 * Turning each feed's existing analysis into incidents.
 *
 * Every function here is a TRANSLATION, not an assessment. The severity each
 * one produces is derived from a number the relevant engine already computed —
 * a USGS magnitude, a FIRMS cluster's own spread score, a risk-engine hazard
 * score — because a second opinion computed here could disagree with the panel
 * an operator opens next, and then neither number would be trustworthy.
 *
 * Each source also decides what is worth SURFACING. A busy viewport holds 150
 * fire clusters and dozens of small earthquakes; listing them all would bury
 * the few that matter under a scrolling wall of noise. So each source applies a
 * floor and a cap, and both are stated here rather than hidden in the UI.
 */

/** Below this severity an observation is not worth an operator's attention. */
export const SURFACE_THRESHOLD = 25;

/** Most incidents any one feed may contribute. */
export const PER_SOURCE_LIMIT = 6;

/**
 * Earthquakes worth listing.
 *
 * Magnitude drives severity through the same anchors the seismic module uses,
 * so an M5 reads the same here as it does there. USGS's own alert grading lifts
 * an event that the feed itself flagged.
 *
 * @param {object|null} intelligence Earthquake intelligence record.
 * @param {number} [now] Clock.
 * @returns {object[]} Incidents.
 */
export function earthquakeIncidents(intelligence, now = Date.now()) {
  const events = intelligence?.events || [];
  return events
    .map((event) => {
      const base = magnitudeScore(event.magnitude);
      // The feed's own grading, not a judgement added here.
      const lift =
        event.alert?.level === 'SIGNIFICANT'
          ? 20
          : event.alert?.level === 'WATCH'
            ? 10
            : 0;
      const observedAt = Date.parse(event.timeIso);
      return createIncident({
        id: `eq:${event.id}`,
        kind: INCIDENT_KINDS.EARTHQUAKE,
        sourceType: SOURCE_TYPES.OBSERVED,
        title: `M${event.magnitude?.toFixed?.(1) ?? event.magnitude} earthquake`,
        place: event.place || null,
        severity: base + lift,
        observedAt: Number.isFinite(observedAt) ? observedAt : null,
        location: Number.isFinite(event.latitude)
          ? { latitude: event.latitude, longitude: event.longitude }
          : null,
        source: 'USGS',
        summary: `USGS recorded M${event.magnitude} ${event.place ? `at ${event.place}` : 'in this area'}.`,
        live: true,
        detail: { eventId: event.id, alertLevel: event.alert?.level ?? null },
      });
    })
    .filter((incident) => incident.severity >= SURFACE_THRESHOLD)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, PER_SOURCE_LIMIT);
}

/**
 * Fire clusters worth listing.
 *
 * Only coherent CLUSTERS, never lone pixels: a single thermal anomaly is a
 * measurement, not an incident. Severity combines how much is burning-hot
 * (the cluster's own detection count and radiative power band) with the
 * environmental spread score the fire engine already produced.
 *
 * The wording stays FIRMS' wording — thermal anomaly detections — because
 * "wildfire" is a claim about the ground that a satellite pixel cannot make.
 *
 * @param {object|null} intelligence Fire intelligence record.
 * @param {number} [now] Clock.
 * @returns {object[]} Incidents.
 */
export function fireIncidents(intelligence, now = Date.now()) {
  const clusters = (intelligence?.clusters || []).filter(
    (cluster) => cluster.kind === 'CLUSTER',
  );
  const FRP_LIFT = { LOW: 0, MODERATE: 12, HIGH: 24, EXTREME: 36 };
  return clusters
    .map((cluster) => {
      // Detections scale logarithmically: 60 pixels is not six times the
      // incident that 10 pixels is.
      const fromSize = Math.min(
        50,
        (Math.log10(Math.max(1, cluster.detectionCount)) / 2) * 50,
      );
      const fromPower = FRP_LIFT[cluster.peakFrpBand] ?? 0;
      // The spread score is environmental, so it only ever adds a fraction.
      const fromConditions = (cluster.spreadConditions?.score ?? 0) * 0.25;
      const observedAt = Number.isFinite(cluster.newestAgeMs)
        ? now - cluster.newestAgeMs
        : null;
      return createIncident({
        id: `fire:${cluster.id}`,
        kind: INCIDENT_KINDS.FIRE,
        sourceType: SOURCE_TYPES.OBSERVED,
        title: `Active fire cluster · ${cluster.detectionCount} detections`,
        place: cluster.spanKm ? `${cluster.spanKm} km span` : null,
        severity: fromSize + fromPower + fromConditions,
        observedAt,
        location: cluster.center
          ? {
              latitude: cluster.center.latitude,
              longitude: cluster.center.longitude,
            }
          : null,
        source: 'NASA FIRMS',
        summary: `${cluster.detectionCount} satellite thermal anomaly detections across ${cluster.spanKm} km. Not confirmed ground truth.`,
        live: true,
        detail: {
          clusterId: cluster.id,
          spreadLevel: cluster.spreadConditions?.level ?? null,
        },
      });
    })
    .filter((incident) => incident.severity >= SURFACE_THRESHOLD)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, PER_SOURCE_LIMIT);
}

/**
 * Weather hazards worth listing.
 *
 * The risk engine has already scored every hazard for the analyzed point; this
 * promotes the active ones. A NORMAL or LOW hazard is not an incident — it is
 * the absence of one — so the surfacing floor does real work here.
 *
 * @param {object|null} analysis Risk analysis.
 * @param {object|null} [point] The analyzed point.
 * @param {string|null} [placeLabel] A human name for the point, when known.
 * @returns {object[]} Incidents.
 */
export function weatherIncidents(analysis, point = null, placeLabel = null) {
  const risks = Object.values(analysis?.risks || {});
  const location = point ||
    analysis?.location || { latitude: null, longitude: null };
  const observedAt = analysis?.generatedAt
    ? Date.parse(analysis.generatedAt)
    : null;
  return risks
    .map((hazard) =>
      createIncident({
        id: `wx:${hazard.id}:${location.latitude?.toFixed?.(2)},${location.longitude?.toFixed?.(2)}`,
        kind: INCIDENT_KINDS.WEATHER,
        sourceType: SOURCE_TYPES.MODEL,
        title: hazard.label,
        place: placeLabel,
        severity: hazard.score,
        observedAt: Number.isFinite(observedAt) ? observedAt : null,
        location: Number.isFinite(location.latitude) ? location : null,
        source: 'Open-Meteo',
        summary: hazard.summary || '',
        live: true,
        detail: { hazardId: hazard.id, level: hazard.level },
      }),
    )
    .filter((incident) => incident.severity >= SURFACE_THRESHOLD)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, PER_SOURCE_LIMIT);
}

/**
 * Authored incident scenarios.
 *
 * These are demonstrations. They carry `live: false`, sort below every real
 * detection, and name their own nature in the source field, so an operator
 * reading the list can never mistake one for something that is happening.
 *
 * @param {object[]} scenes Scene descriptors from the director.
 * @returns {object[]} Incidents.
 */
export function scenarioIncidents(scenes = []) {
  return scenes.map((scene) =>
    createIncident({
      id: `scenario:${scene.id}`,
      kind: INCIDENT_KINDS.SCENARIO,
      title: scene.title,
      place: scene.place || null,
      // A fixed mid-band severity: an authored sequence has no measured
      // severity, and inventing one would put a script above an earthquake.
      severity: 50,
      observedAt: null,
      location: scene.location || null,
      source: 'Authored scenario',
      summary:
        scene.summary ||
        `${scene.shots} shot sequence. Authored demonstration, not live data.`,
      live: false,
      scenarioId: scene.id,
      detail: { shots: scene.shots ?? null },
    }),
  );
}
