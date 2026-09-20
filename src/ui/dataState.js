/**
 * One vocabulary for "how good is this data right now", shared by every panel.
 *
 * An operator needs to know whether what they are reading is current, old, or
 * absent — and those are three different things that a raw HTTP status cannot
 * tell them apart. "Fire intelligence unavailable (503)" says nothing about the
 * ground and nothing useful about the feed; it is a transport detail that
 * belongs in a diagnostics disclosure, not in the headline of a command
 * console.
 *
 * So panels describe a FEED STATE instead:
 *
 *   LIVE        fresh data, with records in view
 *   NO_EVENTS   the feed answered successfully, and there is nothing here
 *   RECENT      slightly behind the publication cadence, still usable
 *   STALE       last good observation is old; shown, but marked
 *   LOADING     a request is in flight and nothing is on screen yet
 *   NO_DATA     nothing has ever been observed for this area
 *   UNAVAILABLE the feed could not be reached
 *   ERROR       the feed answered, but the answer could not be processed
 *
 * The distinction that matters most is NO_EVENTS versus the other three empty
 * states. A successful USGS query over a quiet ocean returns zero earthquakes:
 * that is an OBSERVATION, and the most informative one the feed can give. It is
 * not an absence of data, not an outage, and not something to offer a RETRY
 * for — retrying a correct answer just asks the same question again.
 *
 * Conflating them is the bug this vocabulary exists to prevent, and it is not
 * hypothetical: the earthquake panel showed the chip NO DATA and a RETRY button
 * directly above the sentence "USGS reported no recorded earthquakes in this
 * area" and a last-observation time of "just now". Three surfaces describing one
 * healthy response three different ways.
 *
 * NO_DATA and UNAVAILABLE stay separate for the same reason: "no fires here" is
 * a claim about the ground, "feed unreachable" is a claim about the pipe, and
 * letting a network failure read as an all-clear is the single most dangerous
 * thing a disaster console can do.
 */

/** Feed states in escalating order of concern. */
export const FEED_STATES = Object.freeze({
  LIVE: 'LIVE',
  NO_EVENTS: 'NO_EVENTS',
  RECENT: 'RECENT',
  STALE: 'STALE',
  LOADING: 'LOADING',
  NO_DATA: 'NO_DATA',
  UNAVAILABLE: 'UNAVAILABLE',
  ERROR: 'ERROR',
});

/** Short chip labels, in the console's own casing. */
export const FEED_STATE_LABELS = Object.freeze({
  LIVE: 'LIVE',
  NO_EVENTS: 'NO EVENTS',
  RECENT: 'RECENT',
  STALE: 'STALE',
  LOADING: 'SYNCING',
  NO_DATA: 'NO DATA',
  UNAVAILABLE: 'UNAVAILABLE',
  ERROR: 'ERROR',
});

/**
 * Tone drives colour only. Kept separate from the state id so the palette can
 * change without a panel learning new state names.
 */
export const FEED_STATE_TONES = Object.freeze({
  LIVE: 'ok',
  // A successful empty answer is a healthy feed, so it reads neutral rather
  // than as a warning. Nothing is wrong; there is simply nothing here.
  NO_EVENTS: 'ok',
  RECENT: 'ok',
  STALE: 'warn',
  LOADING: 'idle',
  NO_DATA: 'idle',
  UNAVAILABLE: 'alert',
  ERROR: 'alert',
});

/**
 * Default freshness bands, in milliseconds.
 *
 * A feed is LIVE while it is within its own publication cadence, RECENT for one
 * further cadence, and STALE after that. Callers pass the cadence of the source
 * they are describing — FIRMS publishes roughly every 15 minutes, Open-Meteo
 * hourly — so "live" always means live *for that feed* rather than an arbitrary
 * number applied to everything.
 */
export const DEFAULT_FRESHNESS = Object.freeze({
  liveMs: 15 * 60_000,
  recentMs: 45 * 60_000,
});

/**
 * Classify one feed observation.
 *
 * @param {object} input Input.
 * @param {boolean} input.hasData Whether any observation is held for display.
 * @param {boolean} [input.failed] Whether the most recent attempt failed.
 * @param {boolean} [input.loading] Whether a request is in flight.
 * @param {boolean} [input.empty] Whether the feed answered with nothing here.
 * @param {number|null} [input.observedAt] Epoch ms of the last good observation.
 * @param {number} [input.now] Clock.
 * @param {object} [input.freshness] Cadence bands for this feed.
 * @returns {string} A {@link FEED_STATES} id.
 */
export function classifyFeedState({
  hasData,
  failed = false,
  loading = false,
  empty = false,
  errored = false,
  observedAt = null,
  now = Date.now(),
  freshness = DEFAULT_FRESHNESS,
}) {
  // A processing failure is distinct from a transport one: the feed answered,
  // and what came back could not be used. Reported as itself rather than
  // disguised as an outage.
  if (errored) return FEED_STATES.ERROR;

  // `hasData` means an observation was received. It does NOT mean that
  // observation contained records — a successful query over a quiet area
  // legitimately returns none, and that is the `empty` flag's whole job.
  if (!hasData) {
    if (loading) return FEED_STATES.LOADING;
    if (failed) return FEED_STATES.UNAVAILABLE;
    // Never observed, and nothing in flight: an absence, not an answer.
    return observedAt === null ? FEED_STATES.LOADING : FEED_STATES.NO_DATA;
  }

  // An observation is held. A failed refresh over it is STALE, never
  // UNAVAILABLE — what is on screen is still a real observation.
  if (failed) return FEED_STATES.STALE;

  const age = Number.isFinite(observedAt) ? now - observedAt : null;
  const fresh = age === null || age <= freshness.liveMs;
  // Freshness is judged before content: a recent successful answer that found
  // nothing is NO_EVENTS, while an old one is STALE whether it found anything
  // or not, because its age is the more important fact about it.
  if (fresh) return empty ? FEED_STATES.NO_EVENTS : FEED_STATES.LIVE;
  if (age <= freshness.recentMs)
    return empty ? FEED_STATES.NO_EVENTS : FEED_STATES.RECENT;
  return FEED_STATES.STALE;
}

/**
 * Render an age the way every Aegis panel renders it.
 * @param {number} ms Age in milliseconds.
 * @returns {string} Human phrase.
 */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/**
 * Turn a transport failure into something an operator can read.
 *
 * The raw message is preserved and returned separately as `detail`, for the
 * diagnostics disclosure. It is never the headline.
 *
 * @param {object} input Input.
 * @param {string} input.state A {@link FEED_STATES} id.
 * @param {string} input.sourceLabel Attribution, e.g. "NASA FIRMS".
 * @param {string} [input.subjectPlural] What the feed reports, e.g. "fire detections".
 * @param {number|null} [input.observedAt] Epoch ms of the last good observation.
 * @param {number} [input.now] Clock.
 * @param {string|null} [input.detail] Raw technical text, for diagnostics only.
 * @returns {object} Frozen presentation record.
 */
export function describeFeedState({
  state,
  sourceLabel,
  subjectPlural = 'observations',
  observedAt = null,
  now = Date.now(),
  detail = null,
}) {
  const lastObserved = Number.isFinite(observedAt)
    ? formatAge(now - observedAt)
    : null;

  const presentation = {
    [FEED_STATES.LIVE]: {
      headline: null,
      message: null,
    },
    [FEED_STATES.RECENT]: {
      headline: null,
      message: null,
    },
    [FEED_STATES.STALE]: {
      headline: 'STALE DATA',
      message: `Showing the last successful observation. ${sourceLabel} has not answered since.`,
    },
    [FEED_STATES.LOADING]: {
      headline: 'SYNCING',
      message: `Awaiting ${sourceLabel} observation…`,
    },
    [FEED_STATES.NO_EVENTS]: {
      headline: `NO RECENT ${subjectPlural.toUpperCase()}`,
      message: `${sourceLabel} reports no ${subjectPlural} within the current view during the observation window. This is an observation, not an all-clear.`,
    },
    [FEED_STATES.NO_DATA]: {
      headline: 'NO DATA',
      message: `No ${sourceLabel} observation has been received for this area yet.`,
    },
    [FEED_STATES.UNAVAILABLE]: {
      headline: 'DATA UNAVAILABLE',
      message: `${sourceLabel} feed temporarily unavailable. No observation is being shown for this area.`,
    },
    [FEED_STATES.ERROR]: {
      headline: 'PROCESSING ERROR',
      message: `${sourceLabel} answered, but the response could not be read.`,
    },
  }[state] || { headline: null, message: null };

  return Object.freeze({
    state,
    label: FEED_STATE_LABELS[state] || state,
    tone: FEED_STATE_TONES[state] || 'idle',
    headline: presentation.headline,
    message: presentation.message,
    source: sourceLabel,
    lastObserved,
    observedAt: Number.isFinite(observedAt) ? observedAt : null,
    // Preserved verbatim so a developer can still see the 503, but only from
    // inside the diagnostics disclosure.
    detail: detail || null,
    // Whether the panel should keep rendering whatever content it holds.
    showsContent:
      state === FEED_STATES.LIVE ||
      state === FEED_STATES.RECENT ||
      state === FEED_STATES.STALE ||
      state === FEED_STATES.NO_EVENTS,
    // Whether a retry control makes sense.
    //
    // Deliberately NOT for NO_EVENTS: that is a correct answer, and offering to
    // retry it invites an operator to keep asking the same question until the
    // reply changes. Retry is for a feed that failed to answer, or answered
    // with something unusable, or whose answer has gone old.
    retryable:
      state === FEED_STATES.UNAVAILABLE ||
      state === FEED_STATES.STALE ||
      state === FEED_STATES.ERROR ||
      state === FEED_STATES.NO_DATA,
  });
}

/**
 * Build the standard state block into a container.
 *
 * Every panel renders the same shape, so an operator learns it once: headline,
 * one sentence, the age of the last good observation, the attribution, a retry,
 * and the technical detail folded away.
 *
 * @param {object} input Input.
 * @param {Document} input.document Document.
 * @param {HTMLElement} input.container Container to fill.
 * @param {object} input.description Result of {@link describeFeedState}.
 * @param {(() => void)|null} [input.onRetry] Retry handler.
 * @returns {HTMLElement} The container.
 */
export function renderFeedState({
  document: doc,
  container,
  description,
  onRetry = null,
}) {
  if (!container) return container;
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  container.dataset.tone = description.tone;
  container.dataset.state = description.state;
  const children = [];

  if (description.headline)
    children.push(
      make('p', 'aegis-feed-state-headline', description.headline),
      make('p', 'aegis-feed-state-message', description.message || ''),
    );

  const meta = make('dl', 'aegis-feed-state-meta');
  if (description.lastObserved) {
    meta.append(
      make('dt', null, 'Last observation'),
      make('dd', null, description.lastObserved),
    );
  }
  meta.append(make('dt', null, 'Source'), make('dd', null, description.source));
  children.push(meta);

  if (onRetry && description.retryable) {
    const retry = make('button', 'aegis-feed-state-retry', 'RETRY');
    retry.type = 'button';
    retry.addEventListener('click', onRetry);
    children.push(retry);
  }

  if (description.detail) {
    const details = doc.createElement('details');
    details.className = 'aegis-feed-state-detail';
    details.append(
      make('summary', null, 'Technical detail'),
      make('p', null, description.detail),
    );
    children.push(details);
  }

  container.replaceChildren(...children);
  return container;
}
