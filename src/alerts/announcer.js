import {
  ALERT_LEVELS,
  ALERT_THRESHOLDS,
  PROVENANCE,
  formatDistance,
} from './relevance.js';

/**
 * The alert layer: what gets said, how it is worded, and how often.
 *
 * This is the part of Aegis that can wake somebody up, so it is written around
 * the ways that could go wrong rather than around the happy path.
 *
 * WORDING. Every sentence names its source and says what KIND of statement it
 * is. A USGS record becomes "USGS reports"; a risk index becomes "the model
 * estimates"; only an authority's own message becomes "an official warning has
 * been issued". The templates below are the only place alert text is produced,
 * and none of them can turn a probability into a prediction or a model score
 * into an instruction — there is no template that says anyone is in danger,
 * because no input here justifies one.
 *
 * REPETITION. A feed republishes the same earthquake every few minutes with a
 * revised magnitude. Announcing that five times is worse than not announcing it
 * at all: it trains the listener to ignore the voice. So an incident is
 * announced once, and again only if it MATERIALLY changed — a level increase,
 * or a severity jump large enough to mean something.
 *
 * CADENCE. A minimum gap between announcements, longer for quieter levels, so
 * a busy feed cannot monopolise the room. An URGENT official warning is the one
 * thing allowed to bypass it.
 */

/** Minimum gap between spoken announcements, by level, in milliseconds. */
export const COOLDOWN_MS = Object.freeze({
  INFO: 300_000,
  NOTICE: 120_000,
  WARNING: 60_000,
  URGENT: 0,
});

/** A severity jump this large re-announces an incident already spoken. */
export const MATERIAL_SEVERITY_DELTA = 15;

/** Announcements retained for the "what just happened" briefing. */
const MAX_HISTORY = 40;

/**
 * How Aegis opens when it speaks unprompted.
 *
 * The opener exists because these announcements arrive UNINVITED. Somebody
 * looking at the globe, or at another tab entirely, hears a sentence start; the
 * first two words have to say who is talking and how much it matters, before
 * any detail. "Aegis warning" and "Aegis update" are the only two, so the
 * distinction stays audible rather than becoming a scale nobody can hold.
 *
 * @param {string} level An alert level.
 * @returns {string} The opening words.
 */
export function announcementOpener(level) {
  return level === 'URGENT' || level === 'WARNING'
    ? 'Aegis warning.'
    : 'Aegis update.';
}

/**
 * The closing clause for an event that is not near the user.
 *
 * Says what has been ESTABLISHED, never that somebody is safe. "No local impact
 * has been identified" is a statement about Aegis's own findings; "you are
 * fine" would be a claim about the world that no feed here can support.
 *
 * @param {object} relevance Relevance record.
 * @returns {string} A closing clause, or an empty string.
 */
function closingFor(relevance) {
  if (relevance?.proximity === 'LOCAL' || relevance?.proximity === 'NEARBY')
    return ' I am monitoring the area.';
  if (relevance?.proximity === 'REGIONAL' || relevance?.proximity === 'GLOBAL')
    return ' No local impact has been identified for your location.';
  return '';
}

/**
 * Compose the sentence for one incident.
 *
 * Deterministic, template-based, and provenance-aware. No language model is
 * involved and none is needed: every clause is filled from a field.
 *
 * @param {object} input Input.
 * @param {object} input.incident Incident record.
 * @param {object} input.relevance Relevance record.
 * @returns {string} Spoken text.
 */
export function composeAnnouncement({ incident, relevance }) {
  const where = Number.isFinite(relevance?.distanceKm)
    ? ` approximately ${Math.round(relevance.distanceKm)} kilometres from your location`
    : '';
  const open = `${announcementOpener(relevance?.level)} `;
  const close = closingFor(relevance);

  if (relevance?.provenance === PROVENANCE.OFFICIAL) {
    // The only phrasing that asserts authority, and it is reachable only when a
    // provider marked the record official.
    return `${open}An official warning has been issued${where ? ` for an area${where}` : ' for your area'}: ${incident.title}. Source: ${incident.source}.`;
  }

  if (relevance?.provenance === PROVENANCE.MODEL) {
    // A score moving is not an event happening, and the wording says so.
    return `${open}${incident.source} risk model indicates elevated ${incident.title.toLowerCase()} for this area, now ${incident.severity} out of 100. This is a model estimate, not an observation.`;
  }

  if (relevance?.provenance === PROVENANCE.FORECAST) {
    return `${open}${incident.source} forecasts elevated ${incident.title.toLowerCase()} for this area. This is a forecast, not an observed event.`;
  }

  switch (incident.kind) {
    case 'EARTHQUAKE':
      return `${open}${incident.source} reports ${incident.title}${where}${incident.place ? `, near ${incident.place}` : ''}.${close}`;
    case 'FIRE':
      // FIRMS sees thermal anomalies, so that is what is said.
      return `${open}An active fire cluster has been detected${where} by ${incident.source} satellite observation. This is a thermal anomaly detection, not a confirmed wildfire.${close}`;
    default:
      return `${open}${incident.source} reports ${incident.title}${where}.${close}`;
  }
}

/**
 * How many same-kind events in one refresh become a sequence.
 *
 * Three is the point at which a listener stops hearing individual events and
 * starts hearing a pattern, and the pattern is the more useful statement.
 */
export const GROUP_THRESHOLD = 3;

/**
 * Compose one sentence for a burst of same-kind events.
 *
 * An aftershock sequence arrives as twenty separate records. Announced one by
 * one they would either monopolise the room or, throttled by the cooldown,
 * dribble out over half an hour as stale news. Neither describes what is
 * actually happening, which is that activity in a region has increased — so
 * that is what gets said, with the count and the strongest event as evidence.
 *
 * @param {object} input Input.
 * @param {string} input.kind Incident kind shared by the group.
 * @param {object[]} input.entries `{ incident, relevance }` records.
 * @returns {string} Spoken text.
 */
export function composeGroupAnnouncement({ kind, entries }) {
  const level = entries
    .map((entry) => entry.relevance.level)
    .sort((a, b) => ALERT_LEVELS.indexOf(b) - ALERT_LEVELS.indexOf(a))[0];
  const open = `${announcementOpener(level)} `;
  const count = entries.length;

  // The nearest of the group is the one that decides how much this matters to
  // this listener, so it is the distance worth saying.
  const distances = entries
    .map((entry) => entry.relevance.distanceKm)
    .filter((km) => Number.isFinite(km));
  const nearest = distances.length ? Math.min(...distances) : null;
  const where =
    nearest === null
      ? ''
      : `, the nearest approximately ${Math.round(nearest)} kilometres away`;

  const strongest = entries.reduce((best, entry) =>
    entry.incident.severity > best.incident.severity ? entry : best,
  ).incident;

  switch (kind) {
    case 'EARTHQUAKE':
      return `${open}Seismic activity has increased in the monitored region. ${count} events have been detected${where}. The strongest is ${strongest.title}.`;
    case 'FIRE':
      return `${open}Fire activity has increased in the monitored region. ${count} active fire clusters have been detected${where}. These are satellite thermal anomaly detections, not confirmed wildfires.`;
    default:
      return `${open}${count} developments have been detected in the monitored region${where}. The most significant is ${strongest.title}.`;
  }
}

/**
 * Create the announcer.
 *
 * @param {object} input Input.
 * @param {(text: string, meta: object) => void} [input.speak] Speech output port.
 * @param {(announcement: object) => void} [input.onAnnounce] UI notification port.
 * @param {() => number} [input.now] Clock.
 * @param {() => string} [input.readThreshold] The user's alert-level setting.
 * @param {() => boolean} [input.readEnabled] Whether voice alerts are on.
 * @returns {object} Frozen announcer.
 */
export function createAnnouncer({
  speak,
  onAnnounce,
  now = () => Date.now(),
  readThreshold = () => 'IMPORTANT',
  readEnabled = () => true,
} = {}) {
  /** What has already been said about each incident. */
  const spoken = new Map();
  const history = [];
  let lastSpokeAt = 0;
  let lastBriefingAt = now();

  /**
   * Has this incident materially changed since it was last announced?
   *
   * @param {object} relevance Relevance record.
   * @returns {boolean} Whether it is worth saying again.
   */
  function materiallyChanged(relevance) {
    const previous = spoken.get(relevance.incidentId);
    if (!previous) return true;
    // A level increase always matters: NOTICE becoming WARNING is the system
    // changing its mind about how much this concerns you.
    if (
      ALERT_LEVELS.indexOf(relevance.level) >
      ALERT_LEVELS.indexOf(previous.level)
    )
      return true;
    // A large severity move matters. A small one is the feed refining a number
    // and is exactly the update that must stay silent.
    return relevance.severity - previous.severity >= MATERIAL_SEVERITY_DELTA;
  }

  /**
   * Why this incident may not be announced, or null when it may.
   *
   * Everything except the shared cooldown, which is a property of the ROOM
   * rather than of the incident — grouping needs to know what is worth saying
   * before deciding whether there is time to say it.
   *
   * @param {object} relevance Relevance record.
   * @returns {string|null} A refusal reason, or null.
   */
  function blockedReason(relevance) {
    if (!relevance?.speakable) return 'not-speakable';
    const floor = ALERT_THRESHOLDS[readThreshold()] ?? 'NOTICE';
    if (ALERT_LEVELS.indexOf(relevance.level) < ALERT_LEVELS.indexOf(floor))
      return 'below-threshold';
    if (!materiallyChanged(relevance)) return 'already-announced';
    return null;
  }

  /**
   * Record an announcement and send it to the speech and UI ports.
   *
   * @param {object} input Input.
   * @returns {object} The announcement record.
   */
  function emit({ incidentId, title, text, relevance, source, members }) {
    for (const id of members)
      spoken.set(id, {
        level: relevance.level,
        severity: relevance.severity,
        at: now(),
      });
    lastSpokeAt = now();

    const announcement = Object.freeze({
      incidentId,
      title,
      text,
      level: relevance.level,
      distanceKm: relevance.distanceKm,
      distanceLabel: formatDistance(relevance.distanceKm),
      source,
      provenance: relevance.provenance,
      groupSize: members.length,
      at: now(),
    });
    history.push(announcement);
    while (history.length > MAX_HISTORY) history.shift();

    onAnnounce?.(announcement);
    // The UI card is shown whatever the audio setting: a muted user should
    // still SEE that something happened.
    if (readEnabled()) speak?.(text, announcement);
    return announcement;
  }

  return Object.freeze({
    /**
     * Consider one incident for announcement.
     *
     * @param {object} input Input.
     * @param {object} input.incident Incident record.
     * @param {object} input.relevance Relevance record.
     * @returns {object} What was decided and why.
     */
    consider({ incident, relevance }) {
      const decision = (spokenNow, reason) => {
        const record = Object.freeze({
          incidentId: relevance.incidentId,
          level: relevance.level,
          spoken: spokenNow,
          reason,
          at: now(),
        });
        return record;
      };

      const blocked = blockedReason(relevance);
      if (blocked) return decision(false, blocked);

      const cooldown = COOLDOWN_MS[relevance.level] ?? COOLDOWN_MS.NOTICE;
      const sinceLast = now() - lastSpokeAt;
      // URGENT has a zero cooldown by table, so an official warning is never
      // held behind an earlier routine announcement.
      if (sinceLast < cooldown) return decision(false, 'cooling-down');

      emit({
        incidentId: incident.id,
        title: incident.title,
        text: composeAnnouncement({ incident, relevance }),
        relevance,
        source: incident.source,
        members: [relevance.incidentId],
      });

      return decision(true, 'announced');
    },

    /**
     * Consider a whole refresh at once, collapsing bursts.
     *
     * Offering incidents one at a time cannot see a sequence, because each call
     * only knows about its own event. This does: when several events of the
     * same kind become announceable in the same pass, they are said once, as
     * the pattern they are, and all of them are marked spoken so the tail of
     * the sequence does not leak out individually afterwards.
     *
     * @param {object[]} entries `{ incident, relevance }` records.
     * @returns {object[]} One decision per entry considered.
     */
    considerAll(entries = []) {
      const eligible = [];
      const decisions = [];
      for (const entry of entries) {
        const blocked = blockedReason(entry.relevance);
        if (blocked)
          decisions.push(
            Object.freeze({
              incidentId: entry.relevance.incidentId,
              level: entry.relevance.level,
              spoken: false,
              reason: blocked,
              at: now(),
            }),
          );
        else eligible.push(entry);
      }

      const byKind = new Map();
      for (const entry of eligible) {
        const list = byKind.get(entry.incident.kind) || [];
        list.push(entry);
        byKind.set(entry.incident.kind, list);
      }

      for (const [kind, group] of byKind) {
        if (group.length < GROUP_THRESHOLD) {
          for (const entry of group) decisions.push(this.consider(entry));
          continue;
        }

        // The group speaks at its highest level, and is held by that level's
        // cooldown — a burst is not a licence to talk over everything else.
        const lead = group.reduce((best, entry) =>
          ALERT_LEVELS.indexOf(entry.relevance.level) >
          ALERT_LEVELS.indexOf(best.relevance.level)
            ? entry
            : best,
        );
        const cooldown =
          COOLDOWN_MS[lead.relevance.level] ?? COOLDOWN_MS.NOTICE;
        if (now() - lastSpokeAt < cooldown) {
          for (const entry of group)
            decisions.push(
              Object.freeze({
                incidentId: entry.relevance.incidentId,
                level: entry.relevance.level,
                spoken: false,
                reason: 'cooling-down',
                at: now(),
              }),
            );
          continue;
        }

        emit({
          incidentId: lead.incident.id,
          title: `${group.length} ${kind.toLowerCase()} events`,
          text: composeGroupAnnouncement({ kind, entries: group }),
          relevance: lead.relevance,
          source: lead.incident.source,
          members: group.map((entry) => entry.relevance.incidentId),
        });
        for (const entry of group)
          decisions.push(
            Object.freeze({
              incidentId: entry.relevance.incidentId,
              level: entry.relevance.level,
              spoken: true,
              reason: 'announced-as-group',
              at: now(),
            }),
          );
      }

      return decisions;
    },

    /** @returns {object[]} Announcements since the last briefing. */
    since(timestamp = lastBriefingAt) {
      return history.filter((entry) => entry.at > timestamp);
    },
    /** @returns {number} When the last briefing was taken. */
    lastBriefingAt: () => lastBriefingAt,
    /** Mark a briefing as delivered, starting a new "since" window. */
    markBriefed() {
      lastBriefingAt = now();
    },
    /** @returns {object[]} Everything announced this session. */
    history: () => [...history],
    /** Forget what has been said — used when the monitored location changes. */
    reset() {
      spoken.clear();
      history.length = 0;
      lastSpokeAt = 0;
      lastBriefingAt = now();
    },
  });
}
