/**
 * AEGIS LIVE — the transcript of what the console has told you this session.
 *
 * This replaced two buttons, WHAT'S HAPPENING? and WHAT JUST HAPPENED?, and
 * the replacement is the point. Those buttons put the user in the position of
 * having to ASK a monitoring system whether it had noticed anything, which is
 * the one question a monitoring system should never make somebody ask. The
 * feed inverts it: Aegis watches, decides, and says so, and the transcript is
 * the record of it having done that.
 *
 * Three decisions worth stating:
 *
 *  1. SESSION ONLY, ON PURPOSE. Messages live in memory and die with the tab.
 *     There is no storage here and there should not be. The question this
 *     surface answers is "what has Aegis told me while I have been watching",
 *     and a transcript that survived a refresh would answer a different and
 *     less useful one.
 *  2. OUTPUT ONLY. There is no input box and no reply affordance. Adding one
 *     would turn a monitoring system back into a chatbot, and the entire
 *     product argument is that the user should be the observer rather than the
 *     operator.
 *  3. IT NEVER INVENTS A HEARTBEAT. Nothing here emits "scanning…" on a timer.
 *     Every message corresponds to a real state change upstream. When nothing
 *     is happening the feed is quiet, and the quiet is the information.
 */

/** Message kinds. Each carries its own label and styling. */
export const MESSAGE_KINDS = Object.freeze({
  MONITORING: 'MONITORING',
  UPDATE: 'UPDATE',
  MODEL: 'MODEL',
  WARNING: 'WARNING',
  SCENARIO: 'SCENARIO',
});

/** How each kind announces itself in the transcript. */
export const KIND_LABELS = Object.freeze({
  [MESSAGE_KINDS.MONITORING]: 'AEGIS',
  [MESSAGE_KINDS.UPDATE]: 'AEGIS UPDATE',
  [MESSAGE_KINDS.MODEL]: 'AEGIS MODEL',
  [MESSAGE_KINDS.WARNING]: 'AEGIS WARNING',
  [MESSAGE_KINDS.SCENARIO]: 'SCENARIO',
});

/** Messages retained. Old enough to scroll back through, bounded enough to hold. */
export const MAX_MESSAGES = 60;

/** How close to the bottom still counts as "following the feed", in pixels. */
const FOLLOW_THRESHOLD_PX = 48;

/**
 * Which kind of message an announcement should become.
 *
 * Derived from the announcement's own provenance and level rather than chosen
 * at the call site, so the transcript cannot disagree with what the voice said
 * about the same event.
 *
 * @param {object} announcement An announcer record.
 * @returns {string} A {@link MESSAGE_KINDS} value.
 */
export function kindForAnnouncement(announcement) {
  if (announcement?.provenance === 'OFFICIAL') return MESSAGE_KINDS.WARNING;
  if (
    announcement?.provenance === 'MODEL' ||
    announcement?.provenance === 'FORECAST'
  )
    return MESSAGE_KINDS.MODEL;
  return MESSAGE_KINDS.UPDATE;
}

/** Format a clock time for a transcript line. */
export function formatClock(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Bind the live feed.
 *
 * @param {object} input Input.
 * @param {Document} [input.document] Document.
 * @param {(incidentId: string) => void} [input.onSelect] Open an incident.
 * @param {() => number} [input.now] Clock.
 * @returns {object|null} Controller, or null when the markup is absent.
 */
export function createLiveFeed({
  document: doc = globalThis.document,
  onSelect,
  now = () => Date.now(),
} = {}) {
  const list = doc?.getElementById?.('aegis-live-list');
  if (!list) return null;

  const scroller = doc.getElementById('aegis-live-scroll') || list;
  const jumpButton = doc.getElementById('aegis-live-jump');
  const stateChip = doc.getElementById('aegis-live-state');

  /** The session transcript. In memory, and nowhere else. */
  const messages = [];
  let following = true;
  let speakingId = null;
  let destroyed = false;
  let sequence = 0;

  /** Is the scroller parked at the bottom? */
  function atBottom() {
    const gap =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    return !Number.isFinite(gap) || gap <= FOLLOW_THRESHOLD_PX;
  }

  /** Show or hide the "new intelligence" pill. */
  function presentJump() {
    if (!jumpButton) return;
    jumpButton.hidden = following;
  }

  /** Render one message. */
  function renderMessage(message) {
    const item = doc.createElement('li');
    item.className = 'aegis-live-message';
    item.dataset.messageId = message.id;
    item.dataset.kind = message.kind;
    if (message.id === speakingId) item.dataset.speaking = 'true';

    const head = doc.createElement('div');
    head.className = 'aegis-live-head';
    const who = doc.createElement('span');
    who.className = 'aegis-live-who';
    who.textContent = KIND_LABELS[message.kind] || KIND_LABELS.MONITORING;
    const time = doc.createElement('time');
    time.className = 'aegis-live-time';
    time.textContent = formatClock(message.timestamp);
    head.append(who, time);

    const body = doc.createElement('p');
    body.className = 'aegis-live-text';
    body.textContent = message.message;

    item.append(head, body);

    // A message about a real incident is a way into it. One that is not — the
    // opening monitoring line, a quiet-period note — is simply a statement,
    // and is deliberately not made to look clickable.
    if (message.incidentId && onSelect) {
      const action = doc.createElement('button');
      action.type = 'button';
      action.className = 'aegis-live-action';
      action.textContent = message.actionLabel || 'VIEW INCIDENT';
      action.addEventListener('click', () => onSelect(message.incidentId));
      item.append(action);
    }

    return item;
  }

  /** Repaint the whole transcript. */
  function present() {
    if (destroyed) return;
    list.replaceChildren(...messages.map(renderMessage));
    if (following) scroller.scrollTop = scroller.scrollHeight;
    presentJump();
  }

  const onScroll = () => {
    following = atBottom();
    presentJump();
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  const onJump = () => {
    following = true;
    scroller.scrollTop = scroller.scrollHeight;
    presentJump();
  };
  jumpButton?.addEventListener('click', onJump);

  return Object.freeze({
    /** @returns {object[]} The session transcript. */
    messages: () => [...messages],

    /**
     * Add a message.
     *
     * @param {object} input Message fields.
     * @returns {object} The stored message.
     */
    push({
      kind = MESSAGE_KINDS.MONITORING,
      message,
      incidentId = null,
      actionLabel = null,
      level = null,
      id = null,
      timestamp = now(),
    }) {
      const record = Object.freeze({
        id: id || `msg:${++sequence}`,
        kind,
        message,
        incidentId,
        actionLabel,
        level,
        timestamp,
      });
      messages.push(record);
      while (messages.length > MAX_MESSAGES) messages.shift();

      // Following is decided BEFORE the new item changes the scroll height:
      // somebody reading history must not be yanked to the bottom by an
      // arrival they have not looked at yet.
      following = following || atBottom();
      present();
      return record;
    },

    /**
     * Mark which message the voice is currently reading.
     * @param {string|null} id Message id, or null.
     */
    setSpeaking(id) {
      if (speakingId === id) return;
      speakingId = id;
      for (const node of list.children)
        if (node.dataset.messageId === id) node.dataset.speaking = 'true';
        else delete node.dataset.speaking;
    },

    /**
     * Set the header state chip.
     * @param {string} state A voice state.
     */
    setState(state) {
      if (!stateChip) return;
      stateChip.textContent = `AEGIS ${state}`;
      stateChip.dataset.state = state;
    },

    /** Highlight the message for an incident, if the transcript has one. */
    highlightIncident(incidentId) {
      const match = messages.findLast?.(
        (entry) => entry.incidentId === incidentId,
      );
      if (!match) return false;
      for (const node of list.children)
        if (node.dataset.messageId === match.id) {
          node.dataset.highlighted = 'true';
          node.scrollIntoView?.({ block: 'nearest' });
        } else delete node.dataset.highlighted;
      return true;
    },

    destroy() {
      destroyed = true;
      scroller.removeEventListener('scroll', onScroll);
      jumpButton?.removeEventListener('click', onJump);
      messages.length = 0;
    },
  });
}
