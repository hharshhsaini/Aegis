import { PROXIMITY, compareRelevance, formatDistance } from './relevance.js';

/**
 * "What's happening?" and "What just happened?", assembled from templates.
 *
 * Deterministic on purpose. No language model is involved: every sentence is a
 * template filled from a counted or measured field, so the same state always
 * produces the same briefing and nothing in it can be an invention.
 *
 * The wording carries the same distinctions the alert layer does. An absence of
 * incidents is reported as an absence of RECORDS — "no incidents have been
 * recorded within 50 kilometres" — never as a statement that the area is safe,
 * because the first is something Aegis knows and the second is not.
 */

/** Render a place for the opening line. */
function placePhrase(location) {
  if (!location?.locationName) return 'your current view';
  const region = location.region || location.country;
  return region ? `${location.locationName}, ${region}` : location.locationName;
}

/** Group scored incidents by distance band. */
function byProximity(scored) {
  const groups = {
    [PROXIMITY.LOCAL]: [],
    [PROXIMITY.NEARBY]: [],
    [PROXIMITY.REGIONAL]: [],
    [PROXIMITY.GLOBAL]: [],
  };
  for (const entry of scored) groups[entry.relevance.proximity].push(entry);
  return groups;
}

/** One incident, as a clause. */
function describe({ incident, relevance }) {
  const where = Number.isFinite(relevance.distanceKm)
    ? ` ${formatDistance(relevance.distanceKm)}`
    : '';
  return `${incident.title}${where}`;
}

/**
 * The full situation briefing.
 *
 * @param {object} input Input.
 * @param {object|null} input.location The monitored location.
 * @param {object[]} input.scored `{incident, relevance}` pairs.
 * @param {object} [input.officialAlerts] Official-alert provider status.
 * @returns {object} Frozen briefing with `text` and its parts.
 */
export function composeSituationBriefing({
  location,
  scored = [],
  officialAlerts = null,
}) {
  const ordered = [...scored].sort((a, b) =>
    compareRelevance(a.relevance, b.relevance),
  );
  const groups = byProximity(ordered);
  const sentences = [];

  sentences.push(`You are currently in ${placePhrase(location)}.`);

  const local = groups[PROXIMITY.LOCAL];
  if (local.length) {
    sentences.push(
      local.length === 1
        ? `One incident has been recorded within 50 kilometres: ${describe(local[0])}.`
        : `${local.length} incidents have been recorded within 50 kilometres. The closest is ${describe(local[0])}.`,
    );
  } else {
    // An absence of records, stated as exactly that.
    sentences.push(
      'No incidents have been recorded within 50 kilometres of you.',
    );
  }

  const nearby = groups[PROXIMITY.NEARBY];
  if (nearby.length)
    sentences.push(
      `${nearby.length === 1 ? 'One further incident is' : `${nearby.length} further incidents are`} recorded nearby, the nearest being ${describe(nearby[0])}.`,
    );

  const regional = groups[PROXIMITY.REGIONAL];
  if (regional.length)
    sentences.push(
      `${regional.length} regional ${regional.length === 1 ? 'incident is' : 'incidents are'} being tracked.`,
    );

  const global = groups[PROXIMITY.GLOBAL];
  if (global.length)
    sentences.push(
      global.length === 1
        ? 'Globally, one significant event has been recorded, which is not currently assessed as locally relevant.'
        : `Globally, ${global.length} significant events have been recorded, none of which are currently assessed as locally relevant.`,
    );

  if (officialAlerts && officialAlerts.configured === false)
    sentences.push(
      'Official warning feeds are not configured, so this briefing covers observed and modelled data only.',
    );

  return Object.freeze({
    kind: 'SITUATION',
    text: sentences.join(' '),
    sentences: Object.freeze(sentences),
    counts: Object.freeze({
      local: local.length,
      nearby: nearby.length,
      regional: regional.length,
      global: global.length,
    }),
  });
}

/**
 * The "since last briefing" briefing.
 *
 * @param {object} input Input.
 * @param {object[]} input.announcements Announcements since the last briefing.
 * @param {object[]} [input.scored] Current `{incident, relevance}` pairs.
 * @returns {object} Frozen briefing.
 */
export function composeChangeBriefing({ announcements = [], scored = [] }) {
  if (!announcements.length) {
    // Nothing new is an answer, and a useful one.
    const local = scored.filter(
      (entry) => entry.relevance.proximity === PROXIMITY.LOCAL,
    ).length;
    return Object.freeze({
      kind: 'CHANGE',
      text: `Nothing new has been recorded since your last briefing. ${
        local
          ? `${local} local ${local === 1 ? 'incident remains' : 'incidents remain'} active.`
          : 'No local incidents are active.'
      }`,
      sentences: Object.freeze([]),
      counts: Object.freeze({ announced: 0 }),
    });
  }

  const sentences = [
    announcements.length === 1
      ? 'Since your last briefing, one significant event was detected.'
      : `Since your last briefing, ${announcements.length} significant events were detected.`,
  ];
  // Newest first: the most recent development is the one being asked about.
  for (const entry of [...announcements].reverse().slice(0, 4))
    sentences.push(entry.text);

  return Object.freeze({
    kind: 'CHANGE',
    text: sentences.join(' '),
    sentences: Object.freeze(sentences),
    counts: Object.freeze({ announced: announcements.length }),
  });
}

/**
 * The world-mode briefing: significant global events, summarised.
 *
 * Deliberately a summary. Reading every global event aloud is how a monitoring
 * tool becomes background noise.
 *
 * @param {object} input Input.
 * @param {object[]} input.scored `{incident, relevance}` pairs.
 * @returns {object} Frozen briefing.
 */
export function composeWorldBriefing({ scored = [] }) {
  const significant = [...scored]
    .filter((entry) => entry.relevance.severity >= 60)
    .sort((a, b) => compareRelevance(a.relevance, b.relevance))
    .slice(0, 3);

  if (!significant.length)
    return Object.freeze({
      kind: 'WORLD',
      text: 'No globally significant events have been recorded in the current feeds.',
      sentences: Object.freeze([]),
      counts: Object.freeze({ significant: 0 }),
    });

  const sentences = [
    `${significant.length} significant ${significant.length === 1 ? 'event has' : 'events have'} been recorded globally.`,
    ...significant.map(
      (entry) =>
        `${entry.incident.title}${entry.incident.place ? ` near ${entry.incident.place}` : ''}, reported by ${entry.incident.source}.`,
    ),
  ];

  return Object.freeze({
    kind: 'WORLD',
    text: sentences.join(' '),
    sentences: Object.freeze(sentences),
    counts: Object.freeze({ significant: significant.length }),
  });
}
