import { SOURCE_TYPES } from '../incidents/model.js';

/**
 * How relevant is an event TO THIS USER?
 *
 * A magnitude 5.1 earthquake 8,000 km away and a magnitude 5.1 earthquake 40 km
 * away are the same event to a map and completely different events to a person.
 * This module is the difference: it turns an incident plus a location into a
 * priority, and that priority decides whether the console merely shows
 * something or interrupts somebody about it.
 *
 * The rules it enforces are safety rules, not preferences:
 *
 *  1. DISTANCE DOMINATES. Severity alone never earns an interruption. A distant
 *     event has to be genuinely major before it is allowed to speak, and most
 *     never are.
 *  2. PROVENANCE OUTRANKS MODELLING. An official warning from an authority
 *     outranks an observation, which outranks a forecast, which outranks a
 *     model score. A model can raise the UI's attention; only an authority can
 *     raise it to URGENT.
 *  3. NOTHING HERE INVENTS URGENCY. Every input is a number some other part of
 *     the system already measured or a flag a source already set.
 */

/**
 * What kind of statement an event is. Ordered: later outranks earlier.
 *
 * Aliased from the incident model rather than redeclared. This vocabulary
 * decides both how an event is DRAWN and whether it may speak with authority,
 * so a second copy that drifted by one value would put a model score behind an
 * official warning's wording.
 */
export const PROVENANCE = SOURCE_TYPES;

/** Provenance rank, for comparisons. */
const PROVENANCE_RANK = Object.freeze({
  MODEL: 0,
  FORECAST: 1,
  OBSERVED: 2,
  OFFICIAL: 3,
});

/** Distance bands, nearest first. */
export const PROXIMITY = Object.freeze({
  LOCAL: 'LOCAL',
  NEARBY: 'NEARBY',
  REGIONAL: 'REGIONAL',
  GLOBAL: 'GLOBAL',
});

/**
 * Band edges in kilometres, measured from the MONITORED location.
 *
 * These are classification boundaries, not a filter that hides anything: an
 * event beyond the last edge is GLOBAL, not discarded. They are named
 * individually so a deployment can move them without hunting through the
 * scoring code, and every band is used — `proximityOf` is the only place a
 * distance becomes a scope, and everything downstream reads that scope.
 */
export const LOCAL_RADIUS_KM = 50;
export const NEARBY_RADIUS_KM = 250;
export const REGIONAL_RADIUS_KM = 1000;

/** Band edges in kilometres. `LOCAL` is the user's own surroundings. */
export const PROXIMITY_KM = Object.freeze({
  LOCAL: LOCAL_RADIUS_KM,
  NEARBY: NEARBY_RADIUS_KM,
  REGIONAL: REGIONAL_RADIUS_KM,
});

/** Alert levels, in escalating order. */
export const ALERT_LEVELS = Object.freeze([
  'INFO',
  'NOTICE',
  'WARNING',
  'URGENT',
]);

/** Which levels a given user setting will allow through to voice. */
export const ALERT_THRESHOLDS = Object.freeze({
  ALL: 'INFO',
  IMPORTANT: 'NOTICE',
  'WARNING+': 'WARNING',
  'URGENT ONLY': 'URGENT',
});

/** Earth's mean radius, in kilometres. */
const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance between two points, in kilometres.
 *
 * @param {{latitude: number, longitude: number}} a First point.
 * @param {{latitude: number, longitude: number}} b Second point.
 * @returns {number|null} Distance, or null when either point is unusable.
 */
export function distanceKm(a, b) {
  if (
    !Number.isFinite(a?.latitude) ||
    !Number.isFinite(a?.longitude) ||
    !Number.isFinite(b?.latitude) ||
    !Number.isFinite(b?.longitude)
  )
    return null;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Name a distance band.
 * @param {number|null} km Distance in kilometres.
 * @returns {string} A {@link PROXIMITY} value.
 */
export function proximityOf(km) {
  // An unknown distance is treated as GLOBAL: without knowing where something
  // is relative to the user, it has not earned the right to interrupt them.
  if (!Number.isFinite(km)) return PROXIMITY.GLOBAL;
  if (km <= PROXIMITY_KM.LOCAL) return PROXIMITY.LOCAL;
  if (km <= PROXIMITY_KM.NEARBY) return PROXIMITY.NEARBY;
  if (km <= PROXIMITY_KM.REGIONAL) return PROXIMITY.REGIONAL;
  return PROXIMITY.GLOBAL;
}

/**
 * The severity floor an event must clear to speak at each distance.
 *
 * This table is the whole "do not interrupt me about the other side of the
 * planet" rule, written down. A local event speaks at moderate severity; a
 * global one has to be severe before it is heard at all.
 */
const SPEAK_FLOOR = Object.freeze({
  [PROXIMITY.LOCAL]: 40,
  [PROXIMITY.NEARBY]: 55,
  [PROXIMITY.REGIONAL]: 70,
  [PROXIMITY.GLOBAL]: 88,
});

/**
 * Classify an incident for one user location.
 *
 * @param {object} input Input.
 * @param {object} input.incident Incident record.
 * @param {object|null} input.userLocation The location being monitored.
 * @param {string} [input.provenance] A {@link PROVENANCE} value.
 * @param {number} [input.now] Clock.
 * @returns {object} Frozen relevance record.
 */
export function classifyRelevance({
  incident,
  userLocation,
  provenance = PROVENANCE.OBSERVED,
  now = Date.now(),
}) {
  const km = distanceKm(userLocation, incident?.location);
  const proximity = proximityOf(km);
  const severity = Number.isFinite(incident?.severity) ? incident.severity : 0;

  // Start from what the distance band and severity justify on their own.
  let level = 'INFO';
  if (severity >= SPEAK_FLOOR[proximity]) level = 'NOTICE';
  if (
    (proximity === PROXIMITY.LOCAL && severity >= 60) ||
    (proximity === PROXIMITY.NEARBY && severity >= 72)
  )
    level = 'WARNING';

  // Provenance can raise the ceiling but never manufactures nearness. Only an
  // authority's own warning reaches URGENT, and only when it is close enough
  // to be about this user — a national warning for somewhere else is news.
  if (provenance === PROVENANCE.OFFICIAL) {
    level =
      proximity === PROXIMITY.LOCAL || proximity === PROXIMITY.NEARBY
        ? 'URGENT'
        : 'WARNING';
  } else if (
    // A model or forecast is capped below WARNING however high it scores: a
    // risk index moving is not an event happening.
    provenance === PROVENANCE.MODEL ||
    provenance === PROVENANCE.FORECAST
  ) {
    if (ALERT_LEVELS.indexOf(level) > ALERT_LEVELS.indexOf('NOTICE'))
      level = 'NOTICE';
  }

  const ageMs = Number.isFinite(incident?.observedAt)
    ? now - incident.observedAt
    : null;

  return Object.freeze({
    incidentId: incident?.id ?? null,
    distanceKm: km === null ? null : Number(km.toFixed(1)),
    proximity,
    severity,
    provenance,
    level,
    ageMs,
    // Whether this is allowed to reach the voice layer at all, before the
    // user's own threshold and the cooldown get a say.
    speakable:
      severity >= SPEAK_FLOOR[proximity] || provenance === PROVENANCE.OFFICIAL,
  });
}

/**
 * Does this relevance clear the user's chosen threshold?
 *
 * @param {object} relevance A {@link classifyRelevance} result.
 * @param {string} [setting] An {@link ALERT_THRESHOLDS} key.
 * @returns {boolean} Whether voice may consider it.
 */
export function passesThreshold(relevance, setting = 'IMPORTANT') {
  if (!relevance?.speakable) return false;
  const floor = ALERT_THRESHOLDS[setting] ?? 'NOTICE';
  return ALERT_LEVELS.indexOf(relevance.level) >= ALERT_LEVELS.indexOf(floor);
}

/**
 * Order incidents by how much they matter to this user.
 *
 * Proximity first, then level, then severity, then recency — the order an
 * operator would read them in.
 *
 * @param {object} a Relevance record.
 * @param {object} b Relevance record.
 * @returns {number} Comparator result.
 */
export function compareRelevance(a, b) {
  const bands = [
    PROXIMITY.LOCAL,
    PROXIMITY.NEARBY,
    PROXIMITY.REGIONAL,
    PROXIMITY.GLOBAL,
  ];
  const byBand = bands.indexOf(a.proximity) - bands.indexOf(b.proximity);
  if (byBand !== 0) return byBand;
  const byLevel = ALERT_LEVELS.indexOf(b.level) - ALERT_LEVELS.indexOf(a.level);
  if (byLevel !== 0) return byLevel;
  if (b.severity !== a.severity) return b.severity - a.severity;
  return (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity);
}

/**
 * Render a distance for display.
 * @param {number|null} km Distance.
 * @returns {string} Display text.
 */
export function formatDistance(km) {
  if (!Number.isFinite(km)) return '';
  if (km < 1) return 'under 1 km away';
  if (km < 10) return `${km.toFixed(1)} km away`;
  return `${Math.round(km)} km away`;
}

/**
 * Split a set of incidents by how near they are to a location.
 *
 * This exists because of a specific, visible failure. Aegis's area feeds —
 * FIRMS, USGS, Open-Meteo — are scoped to the CAMERA's viewport, which is the
 * right question for drawing the globe and the wrong one for deciding what is
 * near a person. With the camera over Africa and the user in Bengaluru, every
 * fire the console knew about was 15,000 km away, and the local panel listed
 * them as the nearest incidents because they were the only incidents there
 * were. "Nearest" was true and useless.
 *
 * Partitioning fixes the presentation half of that: a surface that wants local
 * events asks for `local` and gets an empty list when there are none, rather
 * than the closest of a set that was never about this location. An empty list
 * is a statement about the data — no incidents recorded near here — and it is
 * the honest one.
 *
 * The acquisition half is fixed separately, by asking the providers about the
 * monitored location as well as about the viewport.
 *
 * @param {object[]} scored `{ incident, relevance }` records.
 * @returns {{local: object[], nearby: object[], regional: object[], global: object[]}} Sets by scope.
 */
export function partitionByScope(scored = []) {
  const sets = { local: [], nearby: [], regional: [], global: [] };
  for (const entry of scored) {
    switch (entry?.relevance?.proximity) {
      case PROXIMITY.LOCAL:
        sets.local.push(entry);
        break;
      case PROXIMITY.NEARBY:
        sets.nearby.push(entry);
        break;
      case PROXIMITY.REGIONAL:
        sets.regional.push(entry);
        break;
      default:
        sets.global.push(entry);
    }
  }
  return sets;
}

/**
 * The incidents a LOCAL surface may show.
 *
 * Local and nearby only. A regional or global event is still counted, still
 * drawn on the globe and still able to speak if it is significant enough — it
 * simply may not be presented as something near the user, because it is not.
 *
 * @param {object[]} scored `{ incident, relevance }` records.
 * @returns {object[]} Local and nearby entries, nearest first.
 */
export function localSet(scored = []) {
  const sets = partitionByScope(scored);
  return [...sets.local, ...sets.nearby].sort(
    (a, b) =>
      (a.relevance.distanceKm ?? Infinity) -
      (b.relevance.distanceKm ?? Infinity),
  );
}

/**
 * Whether a distant event is significant enough to be worth surfacing globally.
 *
 * Severity has to carry the whole argument once distance has stopped helping,
 * so the floor is high: this is the "major earthquake on the other side of the
 * planet" case, not the "something happened somewhere" case.
 *
 * @param {object} entry A `{ incident, relevance }` record.
 * @returns {boolean} Whether it belongs in a global summary.
 */
export function isGloballySignificant(entry) {
  const severity = entry?.relevance?.severity ?? 0;
  return severity >= SPEAK_FLOOR[PROXIMITY.GLOBAL];
}
