import { clusterDetections, MIN_CLUSTER_DETECTIONS } from './clustering.js';
import { compareActivity } from './activity.js';
import { deriveFireEvents } from './events.js';
import { spreadVector } from './spreadVector.js';
import { assessFireConditions } from '../risk/fireConditions.js';

/**
 * Fire intelligence: satellite detections correlated with weather.
 *
 * This is the correlation step of the Aegis pipeline. FIRMS says WHERE hot
 * pixels are; Open-Meteo says what the atmosphere is doing there; the fire
 * spread model — the same `assessFireConditions` the weather panel uses, so the
 * two can never disagree — says how readily fire would move in those
 * conditions. Nothing here predicts fire behaviour.
 *
 * Language is deliberate throughout. FIRMS publishes thermal anomalies, so a
 * lone detection is a "satellite fire detection" and only a coherent group is
 * an "active fire cluster". Neither is ground truth, and the payload carries
 * that qualification with it so a downstream consumer — including an LLM —
 * cannot lose it.
 */

export const SCHEMA_VERSION = '1.0.0';

/** How many clusters are enriched with weather per observation. */
export const MAX_ENRICHED_CLUSTERS = 5;

/** Wording used wherever a detection or cluster is described. */
export const DETECTION_TERMS = Object.freeze({
  single: 'Satellite fire detection',
  cluster: 'Active fire cluster',
  qualifier:
    'Satellite thermal anomaly detected by NASA FIRMS. Not confirmed ground truth.',
});

/**
 * Decide which clusters are worth a weather request.
 *
 * Weather enrichment costs an Open-Meteo call per cluster, so it goes to the
 * clusters an operator would actually open: real clusters first, largest first.
 *
 * @param {object[]} clusters Ranked clusters.
 * @param {number} [limit] Maximum enriched.
 * @returns {object[]} Clusters to enrich.
 */
export function significantClusters(clusters, limit = MAX_ENRICHED_CLUSTERS) {
  return clusters
    .filter((cluster) => cluster.detectionCount >= MIN_CLUSTER_DETECTIONS)
    .slice(0, limit);
}

/**
 * Attach weather-derived fire-spread conditions to one cluster.
 *
 * @param {object} cluster Cluster record.
 * @param {object|null} metrics Derived weather metrics for its centre.
 * @returns {object} Frozen cluster with `spreadConditions`, `weather` and `spreadVector`.
 */
export function enrichCluster(cluster, metrics) {
  if (!metrics)
    return Object.freeze({
      ...cluster,
      spreadConditions: null,
      weather: null,
      spreadVector: null,
      weatherStatus: 'UNAVAILABLE',
    });

  const conditions = assessFireConditions(metrics);
  return Object.freeze({
    ...cluster,
    spreadConditions: Object.freeze({
      score: conditions.score,
      level: conditions.level,
      summary: conditions.summary,
      disclaimer: conditions.disclaimer,
      drivers: conditions.drivers,
      leadingDrivers: conditions.leadingDrivers,
      damped: conditions.damped,
    }),
    weather: Object.freeze({
      temperature: metrics.temperature_2m,
      humidity: metrics.relative_humidity_2m,
      windSpeed: metrics.wind_speed_10m,
      windGusts: metrics.wind_gusts_10m,
      windDirection: metrics.wind_direction_10m,
      vapourPressureDeficit: metrics.vapour_pressure_deficit,
      soilMoisture: metrics.soil_moisture_index,
      precipitation: metrics.rain_1h,
      recentRain24h: metrics.rain_24h,
      forecastRain12h: metrics.forecast_rain_12h,
      precipitationProbability: metrics.precipitation_probability_6h,
    }),
    spreadVector: spreadVector(metrics),
    weatherStatus: 'READY',
  });
}

/**
 * Assemble the fire intelligence for one observed area.
 *
 * @param {object} input Assembly input.
 * @param {object[]} input.detections Detections in the area.
 * @param {(cluster: object) => object|null} [input.weatherFor] Supplies derived metrics per cluster.
 * @param {object} [input.previous] Previous observation for this area.
 * @param {object} [input.area] Area descriptor.
 * @param {string[]} [input.sources] FIRMS sources queried.
 * @param {number} [input.now] Clock.
 * @returns {object} Frozen fire intelligence record.
 */
export function assembleFireIntelligence({
  detections,
  weatherFor = () => null,
  previous = null,
  area = null,
  sources = [],
  now = Date.now(),
}) {
  const observed = Array.isArray(detections) ? detections : [];
  const clustered = clusterDetections(observed, { now });
  const enrichTargets = new Set(
    significantClusters(clustered).map((entry) => entry.id),
  );
  const clusters = clustered.map((cluster) =>
    enrichTargets.has(cluster.id)
      ? enrichCluster(cluster, weatherFor(cluster))
      : cluster,
  );

  const activity = compareActivity({
    detections: observed,
    previousDetections: previous?.detections ?? null,
    previousObservedMs: previous?.observedMs ?? null,
    now,
  });

  const events = deriveFireEvents({
    clusters,
    previousClusters: previous?.clusters ?? null,
    activity,
    previousActivity: previous?.activity ?? null,
    area,
  });

  const clusterCount = clusters.filter(
    (entry) => entry.kind === 'CLUSTER',
  ).length;
  const worstSpread = clusters
    .filter((entry) => Number.isFinite(entry.spreadConditions?.score))
    .sort((a, b) => b.spreadConditions.score - a.spreadConditions.score)[0];

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    provider: 'NASA FIRMS',
    observedAt: new Date(now).toISOString(),
    area: area ? Object.freeze({ ...area }) : null,
    sources: Object.freeze([...sources]),
    detectionCount: observed.length,
    clusterCount,
    clusters: Object.freeze(clusters),
    activity,
    events,
    // An empty area is a statement about the DATA, never about the ground.
    summary: observed.length
      ? `${observed.length} satellite fire detections in view${
          clusterCount
            ? `, forming ${clusterCount} active fire cluster${clusterCount > 1 ? 's' : ''}`
            : ''
        }.`
      : 'No active satellite fire detections in the selected area and time window.',
    qualifier: DETECTION_TERMS.qualifier,
    leadingSpreadConditions: worstSpread
      ? Object.freeze({
          clusterId: worstSpread.id,
          score: worstSpread.spreadConditions.score,
          level: worstSpread.spreadConditions.level,
        })
      : null,
  });
}

/**
 * Project one cluster into the structured incident record for Amazon Bedrock.
 *
 * Bedrock explains; it does not score. Every number here was produced by the
 * deterministic models, and the qualification travels with the payload so a
 * generated summary cannot quietly promote a thermal anomaly into a confirmed
 * wildfire.
 *
 * @param {object} cluster Enriched cluster.
 * @param {object} [context] Surrounding context.
 * @param {object} [context.activity] Area activity record.
 * @returns {object} Frozen incident record.
 */
export function fireIncidentRecord(cluster, { activity = null } = {}) {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    incidentType:
      cluster.kind === 'CLUSTER'
        ? 'ACTIVE_FIRE_CLUSTER'
        : 'SATELLITE_FIRE_DETECTIONS',
    dataSource: 'NASA FIRMS (VIIRS near-real-time)',
    observationType: 'SATELLITE_THERMAL_ANOMALY',
    groundTruth: false,
    location: cluster.center,
    detections: cluster.detectionCount,
    detectionAreaKm2: cluster.detectionAreaKm2,
    spanKm: cluster.spanKm,
    confidence: cluster.averageConfidence,
    peakFRP: cluster.peakFrp,
    peakFRPBand: cluster.peakFrpBand,
    averageFRP: cluster.averageFrp,
    firstDetectedAt: cluster.oldestDetectionAt,
    latestDetectionAt: cluster.newestDetectionAt,
    satellites: cluster.satellites,
    activityTrend: activity?.status ?? null,
    activityNote: activity?.note ?? null,
    weather: cluster.weather ?? null,
    fireSpreadConditions: cluster.spreadConditions
      ? Object.freeze({
          score: cluster.spreadConditions.score,
          level: cluster.spreadConditions.level,
          drivers: Object.freeze(
            (cluster.spreadConditions.leadingDrivers || []).map(
              (driver) => driver.detail,
            ),
          ),
          basis: 'weather conditions only; not a prediction of fire behaviour',
        })
      : null,
    potentialSpreadDirection: cluster.spreadVector
      ? Object.freeze({
          cardinal: cluster.spreadVector.spreadTowardCardinal,
          degrees: cluster.spreadVector.spreadTowardDegrees,
          windSpeedKmh: cluster.spreadVector.windSpeedKmh,
          basis: cluster.spreadVector.basis,
        })
      : null,
    qualifier: DETECTION_TERMS.qualifier,
  });
}
