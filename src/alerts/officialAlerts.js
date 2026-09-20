import { PROVENANCE } from './relevance.js';
import { createIncident, INCIDENT_KINDS } from '../incidents/model.js';

/**
 * Official disaster warnings from an authority.
 *
 * These are the only records in Aegis that may speak with authority: an
 * official warning outranks every observation and every model score, and it is
 * the only thing that can reach URGENT. That makes the integrity of this
 * boundary more important than the convenience of having data behind it.
 *
 * So there is NO built-in provider. India's NDMA operates SACHET, and its
 * public alerting is CAP-based, but Aegis has no credentialed, documented,
 * stable public endpoint wired up here — and inventing one, or scraping a page
 * and calling the result official, would attach an authority's name to data
 * that authority never served. A wrong "official warning" is worse than no
 * warning at all.
 *
 * What exists instead is the seam. A real provider implements `fetchAlerts()`,
 * returns CAP-shaped records, and registers here; everything downstream —
 * priority, wording, URGENT eligibility — already works. Until one is
 * registered the service reports itself NOT CONFIGURED, and the briefing says
 * so out loud rather than letting an operator assume official warnings are
 * being watched.
 */

/** CAP severity values, mapped onto the 0..100 scale Aegis scores in. */
const CAP_SEVERITY = Object.freeze({
  Extreme: 95,
  Severe: 80,
  Moderate: 60,
  Minor: 40,
  Unknown: 50,
});

/** CAP urgency values that justify treating an alert as immediate. */
const IMMEDIATE_URGENCY = Object.freeze(['Immediate', 'Expected']);

/**
 * Normalize one CAP-shaped alert into an Aegis incident.
 *
 * Kept separate from any provider so a future NDMA/SACHET, NOAA or Meteoalarm
 * adapter only has to produce CAP fields.
 *
 * @param {object} alert CAP-shaped alert.
 * @param {string} sourceLabel The issuing authority.
 * @returns {object|null} Incident, or null when unusable.
 */
export function normalizeCapAlert(alert, sourceLabel) {
  const latitude = Number(alert?.latitude);
  const longitude = Number(alert?.longitude);
  if (!alert?.identifier || !alert?.event) return null;

  const severity = CAP_SEVERITY[alert.severity] ?? CAP_SEVERITY.Unknown;
  const sent = alert.sent ? Date.parse(alert.sent) : Number.NaN;

  return createIncident({
    id: `official:${alert.identifier}`,
    // Official warnings cover hazards Aegis has no feed for, so the kind falls
    // back to a generic weather/other rather than being forced into one.
    kind: alert.kind || INCIDENT_KINDS.WEATHER,
    // The one source type that may speak with authority, and the reason a
    // record can reach URGENT at all.
    sourceType: PROVENANCE.OFFICIAL,
    title: alert.headline || alert.event,
    place: alert.areaDesc || null,
    severity,
    observedAt: Number.isFinite(sent) ? sent : null,
    location: Number.isFinite(latitude) ? { latitude, longitude } : null,
    source: sourceLabel,
    summary: alert.description || alert.headline || alert.event,
    live: true,
    detail: Object.freeze({
      capIdentifier: alert.identifier,
      capSeverity: alert.severity ?? null,
      capUrgency: alert.urgency ?? null,
      capCertainty: alert.certainty ?? null,
      immediate: IMMEDIATE_URGENCY.includes(alert.urgency),
      // Carried through verbatim. An authority's own instruction is the one
      // kind of advice Aegis may relay, and only by quoting it.
      instruction: alert.instruction || null,
      provenance: PROVENANCE.OFFICIAL,
    }),
  });
}

/**
 * Create the official alerts service.
 *
 * @param {object} [input] Input.
 * @param {object[]} [input.providers] Registered providers.
 * @param {() => number} [input.now] Clock.
 * @returns {object} Frozen service.
 */
export function createOfficialAlerts({
  providers = [],
  now = () => Date.now(),
} = {}) {
  let lastSuccess = null;
  let lastError = null;

  return Object.freeze({
    /**
     * Provider health, in the shape the rest of the console reports feeds.
     * @returns {object} Frozen status.
     */
    status() {
      return Object.freeze({
        provider: 'OFFICIAL_ALERTS',
        configured: providers.length > 0,
        available: providers.length > 0 && lastError === null,
        lastSuccess,
        lastError,
        // What the UI shows when nothing is registered. Not an error state:
        // nothing is broken, there is simply no authority feed connected.
        label: providers.length ? 'LIVE' : 'NOT CONFIGURED',
        sources: Object.freeze(providers.map((provider) => provider.label)),
      });
    },

    /**
     * Fetch current official alerts near a point.
     *
     * With no provider registered this returns an empty list and says so
     * through `status()`. It never fabricates an alert to fill the gap.
     *
     * @param {object} location Point of interest.
     * @returns {Promise<object[]>} Incidents.
     */
    async fetch(location) {
      if (!providers.length) return [];
      const collected = [];
      for (const provider of providers) {
        try {
          const alerts = await provider.fetchAlerts(location);
          for (const alert of alerts || []) {
            const incident = normalizeCapAlert(alert, provider.label);
            if (incident) collected.push(incident);
          }
          lastSuccess = now();
          lastError = null;
        } catch (error) {
          // A failing authority feed must not be silently treated as "no
          // warnings in force" — that is the most dangerous false negative
          // this system could produce, so it is recorded and surfaced.
          lastError = String(error?.message || error);
        }
      }
      return collected;
    },
  });
}
