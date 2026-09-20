import { NEARBY_RADIUS_KM } from './relevance.js';

/**
 * What Aegis says when you look at something.
 *
 * Clicking an event is a question — "what is this?" — and this builds the
 * answer. Deterministically, from fields a provider actually published. No
 * model is involved and none is needed: every clause below is a value or is
 * omitted, and a briefing that omits a field is correct where one that
 * invented it would be dangerous.
 *
 * Two rules do most of the work here:
 *
 *  1. EVERY CLAUSE IS OPTIONAL. Depth, felt reports, review status and the
 *     tsunami flag are all fields USGS may or may not publish for a given
 *     event. Each is spoken only when present, and nothing is ever defaulted —
 *     "depth unavailable" is a fact; "depth 10 km" when USGS said nothing is a
 *     fabrication.
 *  2. VIEWED IS NOT NEAR. Somebody in Bengaluru inspecting an Alaskan
 *     earthquake must hear "you are viewing", not "near you". The framing is
 *     chosen from the measured distance to the DEVICE, so the console cannot
 *     accidentally describe a distant event as a personal one.
 *
 * Nothing here tells anyone they are in danger or what to do about it. No
 * input to this function could justify it.
 */

/** How stale an observation can be before it is described as such. */
const RECENT_MS = 60 * 60 * 1000;

/**
 * Say how long ago something happened, in words.
 * @param {number|null} observedAt Epoch ms.
 * @param {number} now Clock.
 * @returns {string} A phrase, or an empty string when the time is unknown.
 */
export function timePhrase(observedAt, now) {
  if (!Number.isFinite(observedAt)) return '';
  const ms = now - observedAt;
  if (ms < 0) return '';
  // Floored, not rounded: rounding turns thirty seconds into "one minute ago",
  // which claims more elapsed time than has actually passed. For a feed where
  // recency is the point, erring downward is the honest direction.
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes === 1) return 'one minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return 'about an hour ago';
  if (hours < 24) return `about ${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'about a day ago' : `about ${days} days ago`;
}

/**
 * How this event relates to the listener, in one clause.
 *
 * The distinction §8 exists to protect: an event is described as near the user
 * only when it measurably is. Otherwise it is described as something they are
 * LOOKING at, named by the place the camera is over.
 *
 * @param {object} context Focus context.
 * @returns {string} A clause, or an empty string.
 */
export function proximityPhrase({
  deviceDistanceKm = null,
  viewedPlaceName = null,
} = {}) {
  if (Number.isFinite(deviceDistanceKm) && deviceDistanceKm <= NEARBY_RADIUS_KM)
    return ` approximately ${Math.round(deviceDistanceKm)} kilometres from your location`;
  if (viewedPlaceName)
    return ` in the area you are viewing, near ${viewedPlaceName}`;
  return '';
}

/**
 * Join sentence fragments, dropping the empty ones.
 *
 * Fragments are trimmed before joining: several are written with a leading
 * space so they read correctly when appended inline, and joining those with a
 * separator as well produced doubled spaces that a synthesiser renders as an
 * unnatural pause.
 */
const sentences = (parts) =>
  parts
    .filter(Boolean)
    .map((part) => String(part).trim())
    .filter(Boolean)
    .join(' ');

/**
 * Build the briefing for one earthquake.
 * @param {object} event Normalized USGS event.
 * @param {object} context Focus context.
 * @returns {string} Spoken text.
 */
function earthquakeBriefing(event, context) {
  const { now = Date.now() } = context;
  const magnitude = Number.isFinite(event.magnitude)
    ? `Magnitude ${event.magnitude.toFixed(1)}`
    : 'Magnitude unavailable';
  const depth = Number.isFinite(event.depth)
    ? `, at a depth of ${Math.round(event.depth)} kilometres`
    : '';
  const when = timePhrase(event.time ?? event.observedAt, now);
  const where = event.place ? ` near ${event.place}` : proximityPhrase(context);

  // USGS's own review status, quoted rather than interpreted. "Automatic"
  // means a machine solution nobody has checked yet, which is worth saying.
  const status =
    event.status === 'automatic'
      ? ' This is an automatic solution that has not yet been reviewed.'
      : event.status === 'reviewed'
        ? ' The solution has been reviewed by USGS.'
        : '';

  // A flag USGS sets. Its ABSENCE is reported as an absence of a flag, never
  // as an assurance that no tsunami is possible.
  const tsunami = event.tsunami
    ? ' USGS has set a tsunami flag for this event.'
    : ' USGS has not set a tsunami flag for this event.';

  const felt =
    Number.isFinite(event.felt) && event.felt > 0
      ? ` ${event.felt} felt ${event.felt === 1 ? 'report has' : 'reports have'} been submitted to USGS.`
      : '';

  return sentences([
    `Earthquake detected${where}.`,
    `${magnitude}${depth}.`,
    when ? `Recorded ${when}.` : '',
    proximityPhrase(context) && event.place
      ? `The event is${proximityPhrase(context)}.`
      : '',
    status,
    tsunami,
    felt,
    'Aegis is monitoring the region for additional seismic activity.',
  ]);
}

/**
 * Build the briefing for one fire cluster.
 * @param {object} cluster Normalized FIRMS cluster.
 * @param {object} context Focus context.
 * @returns {string} Spoken text.
 */
function fireBriefing(cluster, context) {
  const detections = Number.isFinite(cluster.detectionCount ?? cluster.count)
    ? (cluster.detectionCount ?? cluster.count)
    : null;
  const where = proximityPhrase(context);

  const size = detections
    ? `${detections} satellite thermal ${detections === 1 ? 'detection forms' : 'detections form'} this cluster.`
    : '';
  const power = Number.isFinite(cluster.maxFrp)
    ? `Peak fire radiative power in the cluster is ${Math.round(cluster.maxFrp)} megawatts.`
    : '';
  const confidence = Number.isFinite(cluster.meanConfidence)
    ? `Mean detection confidence is ${Math.round(cluster.meanConfidence)} percent.`
    : '';

  return sentences([
    `Active fire detections${where}.`,
    size,
    power,
    confidence,
    // The FIRMS vocabulary, kept exactly as the fire engine states it.
    'These are satellite thermal anomaly detections, not a confirmed wildfire.',
    'Aegis is monitoring the cluster for changes in activity.',
  ]);
}

/**
 * Build the briefing for a weather or flood hazard.
 * @param {object} event Incident record.
 * @param {object} context Focus context.
 * @returns {string} Spoken text.
 */
function hazardBriefing(event, context) {
  const where = proximityPhrase(context);
  const score = Number.isFinite(event.severity)
    ? `The current model score is ${event.severity} out of 100.`
    : '';
  return sentences([
    `${event.title || 'Hazard signal'} detected${where}.`,
    score,
    // A model score is not an observation, and the sentence says so every time.
    'This is a model estimate from forecast conditions, not an observation of what is happening on the ground.',
    'Aegis is monitoring rainfall, conditions and official warnings for further changes.',
  ]);
}

/**
 * Build a spoken briefing for a focused event.
 *
 * @param {object} event The focused event or incident.
 * @param {object} [context] Focus context.
 * @param {number|null} [context.deviceDistanceKm] Distance to the device location.
 * @param {string|null} [context.viewedPlaceName] Where the camera is.
 * @param {number} [context.now] Clock.
 * @returns {string} Spoken text, or an empty string when there is nothing to say.
 */
export function buildEventBriefing(event, context = {}) {
  if (!event) return '';
  const kind = String(event.kind || event.type || '').toUpperCase();

  // An earthquake is recognised by carrying a magnitude, because the focus
  // pipeline receives both raw USGS events and incident records.
  if (kind === 'EARTHQUAKE' || Number.isFinite(event.magnitude))
    return earthquakeBriefing(event, context);
  if (kind === 'FIRE' || event.detectionCount !== undefined)
    return fireBriefing(event, context);
  if (kind === 'WEATHER' || kind === 'FLOOD')
    return hazardBriefing(event, context);

  const where = proximityPhrase(context);
  const when = timePhrase(
    event.observedAt ?? event.time,
    context.now ?? Date.now(),
  );
  return sentences([
    `${event.title || 'Event'} detected${where}.`,
    when ? `Recorded ${when}.` : '',
    event.source ? `Source: ${event.source}.` : '',
    'Aegis is monitoring the area for further developments.',
  ]);
}

/** Whether an observation is recent enough to describe without qualification. */
export function isRecent(observedAt, now = Date.now()) {
  return Number.isFinite(observedAt) && now - observedAt <= RECENT_MS;
}
