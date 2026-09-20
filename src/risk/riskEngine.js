import { deriveMetrics } from '../weather/derived.js';
import { assessFloodRisk } from './floodRisk.js';
import { assessFlashFloodRisk } from './flashFloodRisk.js';
import { assessWindRisk } from './windRisk.js';
import { assessFireConditions } from './fireConditions.js';
import { assessHeatRisk } from './heatRisk.js';
import { assessVisibilityRisk } from './visibilityRisk.js';
import { detectSignificantChanges } from './changeDetection.js';
import {
  FORECAST_HORIZONS,
  OVERALL,
  TREND_DEADBANDS,
  riskLevel,
} from './thresholds.js';
import { classifyTrend } from '../weather/derived.js';
import { explainProjection } from './narrative.js';

/**
 * The Aegis risk engine.
 *
 * Deterministic by design. Every number below comes from arithmetic over
 * observed and forecast values against thresholds in `thresholds.js`, and the
 * same inputs always produce the same output. No language model is involved in
 * producing a score — an LLM consumes this structure afterwards to explain and
 * answer questions, and the numbers it talks about remain this module's.
 *
 * The engine is pure and provider-agnostic: give it a normalized snapshot and
 * it returns a complete analysis. That is what lets it run inside a Vite
 * middleware today and an AWS Lambda later without a rewrite.
 *
 * SCHEMA_VERSION is part of the output because stored analyses outlive the code
 * that wrote them; a consumer reading from DynamoDB later needs to know which
 * scoring generation produced a record.
 */

export const SCHEMA_VERSION = '1.0.0';

/** Hazard models in presentation order. */
const HAZARD_MODELS = Object.freeze([
  ['flood', assessFloodRisk],
  ['flashFlood', assessFlashFloodRisk],
  ['wind', assessWindRisk],
  ['fireConditions', assessFireConditions],
  ['heat', assessHeatRisk],
  ['visibility', assessVisibilityRisk],
]);

/**
 * Run every hazard model against one set of derived metrics.
 * @param {object} metrics Derived metrics.
 * @returns {object} Frozen map of hazard id to assessment.
 */
export function assessHazards(metrics) {
  const risks = {};
  for (const [id, assess] of HAZARD_MODELS) risks[id] = assess(metrics);
  return Object.freeze(risks);
}

/**
 * Combine hazard scores into one environmental figure.
 *
 * Dominated by the worst active hazard: an area with one HIGH risk is not
 * "moderate overall" because its other hazards are quiet. Breadth contributes
 * the remainder, so several concurrent moderate hazards still read worse than
 * one alone.
 *
 * @param {object} risks Hazard assessments keyed by id.
 * @returns {{score: number, level: string, peak: string|null}} Overall figure.
 */
export function overallRisk(risks) {
  const entries = Object.values(risks || {}).filter((hazard) =>
    Number.isFinite(hazard?.score),
  );
  if (!entries.length) return { score: 0, level: riskLevel(0), peak: null };
  const peak = entries.reduce((worst, hazard) =>
    hazard.score > worst.score ? hazard : worst,
  );
  const mean =
    entries.reduce((sum, hazard) => sum + hazard.score, 0) / entries.length;
  const score = Math.round(
    peak.score * OVERALL.peakWeight + mean * OVERALL.breadthWeight,
  );
  return { score, level: riskLevel(score), peak: peak.id };
}

/**
 * Project each hazard across the configured forecast horizons.
 *
 * A horizon is scored by re-deriving metrics anchored at that future hour and
 * running the same models — not by extrapolating the current score. The
 * projected hour therefore has its own real accumulation windows, soil state
 * and wind profile, and a projected score means exactly what a current score
 * means.
 *
 * @param {object} snapshot Normalized snapshot.
 * @param {object} currentRisks Current hazard assessments, for the projection text.
 * @returns {object[]} Frozen horizon records.
 */
export function projectForecast(snapshot, currentRisks) {
  const horizons = [];
  const series = snapshot?.series || {};
  const lastIndex = (series.time?.length || 1) - 1;
  for (const hours of FORECAST_HORIZONS) {
    const index = (snapshot?.currentIndex ?? 0) + hours;
    if (index > lastIndex) continue;
    const metrics = deriveMetrics(snapshot, index);
    const risks = assessHazards(metrics);
    const scores = {};
    for (const [id, hazard] of Object.entries(risks)) scores[id] = hazard.score;
    const overall = overallRisk(risks);
    horizons.push(
      Object.freeze({
        hours,
        at: metrics.anchorTime,
        scores: Object.freeze(scores),
        levels: Object.freeze(
          Object.fromEntries(
            Object.entries(risks).map(([id, hazard]) => [id, hazard.level]),
          ),
        ),
        overall: overall.score,
        overallLevel: overall.level,
        notes: Object.freeze(
          Object.entries(risks)
            .map(([id, hazard]) =>
              explainProjection(
                hazard.label.replace(/ Risk$/, ''),
                currentRisks?.[id]?.score ?? 0,
                hazard.score,
                hours,
              ),
            )
            .filter(Boolean),
        ),
      }),
    );
  }
  return Object.freeze(horizons);
}

/**
 * Attach a trend to one hazard.
 *
 * Observed movement — this score against the previous analysis of the same
 * location — is the truth when it exists. On a first look there is no previous
 * analysis, and rather than showing every hazard as flat, the engine falls back
 * to the direction its own 3-hour projection implies, labelled `projected` so a
 * consumer never presents a model's expectation as an observation.
 *
 * @param {object} hazard Hazard assessment.
 * @param {number|null} previousScore Score from the previous analysis.
 * @param {number|null} projectedScore Score projected 3 hours out.
 * @returns {object} Frozen trend record.
 */
function hazardTrend(hazard, previousScore, projectedScore) {
  if (Number.isFinite(previousScore)) {
    const change = hazard.score - previousScore;
    return Object.freeze({
      direction: classifyTrend(change, TREND_DEADBANDS.risk),
      change,
      previous: previousScore,
      source: 'observed',
    });
  }
  if (Number.isFinite(projectedScore)) {
    const change = projectedScore - hazard.score;
    return Object.freeze({
      direction: classifyTrend(change, TREND_DEADBANDS.risk),
      change,
      previous: null,
      source: 'projected',
    });
  }
  return Object.freeze({
    direction: 'UNKNOWN',
    change: null,
    previous: null,
    source: 'none',
  });
}

/** Readable current conditions for the panel header. */
function currentConditions(snapshot, metrics) {
  const current = snapshot?.current || {};
  const pick = (key, fallback) =>
    Number.isFinite(current[key]) ? current[key] : (fallback ?? null);
  return Object.freeze({
    temperature: pick('temperature_2m', metrics.temperature_2m),
    apparentTemperature: pick(
      'apparent_temperature',
      metrics.apparent_temperature,
    ),
    humidity: pick('relative_humidity_2m', metrics.relative_humidity_2m),
    precipitation: pick('precipitation', metrics.rain_1h),
    rain24h: metrics.rain_24h,
    windSpeed: pick('wind_speed_10m', metrics.wind_speed_10m),
    windGusts: pick('wind_gusts_10m', metrics.wind_gusts_10m),
    windDirection: pick('wind_direction_10m', metrics.wind_direction_10m),
    pressure: pick('pressure_msl', metrics.pressure_msl),
    cloudCover: pick('cloud_cover', metrics.cloud_cover),
    visibility: metrics.visibility,
    weatherCode: pick('weather_code', metrics.weather_code),
    soilMoisture: metrics.soil_moisture_index,
  });
}

/**
 * Produce the complete analysis for one location.
 *
 * This object is the engine's contract — with the UI today and with Amazon
 * Bedrock later. It carries the scores, the drivers that produced them, the
 * trends, the projections and the detected changes, so a downstream consumer
 * never needs the raw weather response to explain a situation.
 *
 * @param {object} snapshot Normalized snapshot from `weather/normalize.js`.
 * @param {object} [options] Analysis options.
 * @param {object|null} [options.previous] Previous analysis for the same location.
 * @param {string} [options.generatedAt] ISO instant for the analysis; defaults to now.
 * @returns {object|null} Frozen analysis, or null without a usable snapshot.
 */
export function analyzeSnapshot(
  snapshot,
  { previous = null, generatedAt } = {},
) {
  if (!snapshot?.series?.time?.length) return null;
  const metrics = deriveMetrics(snapshot, snapshot.currentIndex);
  const assessed = assessHazards(metrics);
  const forecast = projectForecast(snapshot, assessed);
  const projected3h = forecast.find((horizon) => horizon.hours === 3);

  const risks = {};
  for (const [id, hazard] of Object.entries(assessed)) {
    risks[id] = Object.freeze({
      ...hazard,
      trend: hazardTrend(
        hazard,
        previous?.risks?.[id]?.score ?? null,
        projected3h?.scores?.[id] ?? null,
      ),
    });
  }

  const overall = overallRisk(risks);
  const previousOverall = previous?.overall?.score ?? null;
  const timestamp = generatedAt || new Date().toISOString();
  const location = snapshot.location;

  const significantChanges = detectSignificantChanges({
    metrics,
    previousMetrics: previous?.metrics,
    risks,
    previousRisks: previous?.risks,
    location,
    timestamp,
  });

  const ranked = Object.values(risks).sort((a, b) => b.score - a.score);
  const headline = ranked[0];

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    location,
    observedAt: snapshot.observedAt,
    retrievedAt: snapshot.retrievedAt,
    generatedAt: timestamp,
    conditions: currentConditions(snapshot, metrics),
    risks: Object.freeze(risks),
    overall: Object.freeze({
      ...overall,
      trend: Object.freeze({
        direction: classifyTrend(
          Number.isFinite(previousOverall)
            ? overall.score - previousOverall
            : null,
          TREND_DEADBANDS.risk,
        ),
        change: Number.isFinite(previousOverall)
          ? overall.score - previousOverall
          : null,
        previous: previousOverall,
        source: Number.isFinite(previousOverall) ? 'observed' : 'none',
      }),
    }),
    forecast: Object.freeze({
      horizons: forecast,
      // Projection sentences for the hazard currently leading, which is what an
      // operator asks about first.
      notes: Object.freeze(
        forecast.flatMap((horizon) =>
          horizon.notes.filter((note) =>
            note.startsWith(headline?.label?.replace(/ Risk$/, '') || ''),
          ),
        ),
      ),
    }),
    trends: metrics.trends,
    significantChanges,
    metrics,
    headline: Object.freeze({
      hazard: headline?.id ?? null,
      label: headline?.label ?? null,
      score: headline?.score ?? 0,
      level: headline?.level ?? riskLevel(0),
      summary: headline?.summary ?? '',
    }),
  });
}
