/**
 * One shape for "something is happening here".
 *
 * Aegis watches three live feeds and ships one authored demonstration, and
 * until now each of those was only visible inside its own panel. An operator
 * asking the obvious question — what is going on right now? — had to read three
 * panels and a scene dropdown and combine them in their head.
 *
 * An INCIDENT is that combination: a place, a severity, a time, and the source
 * that reported it. Everything in the list is derived from a feed that has
 * already been observed and scored elsewhere; nothing here invents an event,
 * re-scores one, or promotes an observation into a claim about the ground.
 *
 * The distinction that must survive contact with the UI is LIVE versus
 * AUTHORED. The Nepal flood sequence is a scripted demonstration and sits in
 * the same list as real USGS and FIRMS detections, so every incident carries
 * its `live` flag and its `source`, and the renderer is required to show them.
 */

/** Where an incident came from. */
export const INCIDENT_KINDS = Object.freeze({
  SCENARIO: 'SCENARIO',
  EARTHQUAKE: 'EARTHQUAKE',
  FIRE: 'FIRE',
  WEATHER: 'WEATHER',
});

/**
 * WHAT KIND OF STATEMENT an incident is.
 *
 * This is the distinction a user must never have to infer. "An M5.1 was
 * recorded", "a model scores this region 72/100" and "an authority has issued a
 * warning" are three different claims about the world, and collapsing them into
 * one "risk" reading is how a console starts lying. It is a separate axis from
 * `kind` — an earthquake can be observed *or* forecast — and from `live`, which
 * only says whether the record is real or authored.
 *
 * Ordered weakest to strongest; later outranks earlier. `relevance.js` consumes
 * this as `PROVENANCE` rather than keeping a second copy, because two
 * vocabularies for one idea is exactly how they drift apart.
 */
export const SOURCE_TYPES = Object.freeze({
  MODEL: 'MODEL',
  FORECAST: 'FORECAST',
  OBSERVED: 'OBSERVED',
  OFFICIAL: 'OFFICIAL',
});

/**
 * How each source type is written and drawn.
 *
 * The glyph carries the distinction at a glance in a dense feed, where there is
 * no room for the word. It is deliberately NOT colour alone: severity already
 * owns colour, and a user who cannot separate hues would otherwise lose the
 * difference between "this happened" and "a model thinks this might".
 */
export const SOURCE_TYPE_PRESENTATION = Object.freeze({
  [SOURCE_TYPES.OBSERVED]: Object.freeze({
    glyph: '●',
    label: 'OBSERVED',
    description: 'Recorded by an instrument or satellite.',
  }),
  [SOURCE_TYPES.FORECAST]: Object.freeze({
    glyph: '◇',
    label: 'FORECAST',
    description: 'A prediction, not an observation.',
  }),
  [SOURCE_TYPES.MODEL]: Object.freeze({
    glyph: '◇',
    label: 'MODEL SIGNAL',
    description: 'A model score, not an observation.',
  }),
  [SOURCE_TYPES.OFFICIAL]: Object.freeze({
    glyph: '▲',
    label: 'OFFICIAL WARNING',
    description: 'Issued by an authority.',
  }),
});

/** Presentation for an authored reconstruction, which is not a live claim. */
export const SCENARIO_PRESENTATION = Object.freeze({
  glyph: '◼',
  label: 'SCENARIO',
  description: 'An authored reconstruction, not a live event.',
});

/**
 * How an incident should be labelled and drawn.
 *
 * A scenario is reported as a scenario whatever its source type: an authored
 * reconstruction must never present itself as an observation, and that rule
 * outranks everything else on the record.
 *
 * @param {object} incident Incident record.
 * @returns {{glyph: string, label: string, description: string}} Presentation.
 */
export function describeSourceType(incident) {
  if (incident && incident.live === false) return SCENARIO_PRESENTATION;
  return (
    SOURCE_TYPE_PRESENTATION[incident?.sourceType] ||
    SOURCE_TYPE_PRESENTATION[SOURCE_TYPES.OBSERVED]
  );
}

/** Severity bands, matching the risk engine's vocabulary exactly. */
export const INCIDENT_LEVELS = Object.freeze([
  Object.freeze({ id: 'NORMAL', min: 0 }),
  Object.freeze({ id: 'LOW', min: 21 }),
  Object.freeze({ id: 'MODERATE', min: 41 }),
  Object.freeze({ id: 'ELEVATED', min: 61 }),
  Object.freeze({ id: 'HIGH', min: 81 }),
]);

/**
 * Name a severity.
 * @param {number} severity 0..100.
 * @returns {string} Level id.
 */
export function incidentLevel(severity) {
  if (!Number.isFinite(severity)) return 'NORMAL';
  let level = INCIDENT_LEVELS[0].id;
  for (const band of INCIDENT_LEVELS) if (severity >= band.min) level = band.id;
  return level;
}

/**
 * Build an incident record.
 *
 * Every field an incident needs to be shown honestly is required: what it is,
 * where it is, when it was observed, who reported it, and whether it is real.
 *
 * @param {object} input Input.
 * @returns {object} Frozen incident.
 */
export function createIncident({
  id,
  kind,
  title,
  place = null,
  severity = 0,
  observedAt = null,
  location = null,
  source,
  summary = '',
  live = true,
  scenarioId = null,
  detail = null,
  sourceType = null,
}) {
  const score = Math.max(0, Math.min(100, Math.round(severity)));
  return Object.freeze({
    id,
    kind,
    title,
    place,
    severity: score,
    level: incidentLevel(score),
    // Declared by the feed that built the record. Weather is the only kind
    // whose default is not an observation: its severity is a risk-engine score,
    // and calling that "observed" would be the exact confusion this field
    // exists to prevent.
    sourceType:
      SOURCE_TYPES[sourceType] ??
      (kind === INCIDENT_KINDS.WEATHER
        ? SOURCE_TYPES.MODEL
        : SOURCE_TYPES.OBSERVED),
    observedAt: Number.isFinite(observedAt) ? observedAt : null,
    location: location
      ? Object.freeze({
          latitude: location.latitude,
          longitude: location.longitude,
        })
      : null,
    source,
    summary,
    // An authored demonstration is never allowed to look like an observation.
    live: Boolean(live),
    scenarioId,
    detail: detail ? Object.freeze(detail) : null,
  });
}

/**
 * Order incidents for an operator.
 *
 * Authored scenarios sort last regardless of severity: they are always
 * available and never news, so letting one sit above a live detection would
 * bury the thing that actually just happened. Within each group it is severity
 * first, then recency.
 *
 * @param {object} a Incident.
 * @param {object} b Incident.
 * @returns {number} Comparator result.
 */
export function compareIncidents(a, b) {
  if (a.live !== b.live) return a.live ? -1 : 1;
  if (b.severity !== a.severity) return b.severity - a.severity;
  return (b.observedAt ?? 0) - (a.observedAt ?? 0);
}
