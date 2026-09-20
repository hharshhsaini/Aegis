import { createSpeaker } from './speech.js';

/**
 * One mouth, one queue.
 *
 * The announcer decides WHETHER something is worth saying. This decides HOW it
 * gets said when several things are worth saying at once — which, on a console
 * watching three live feeds, happens the moment anything interesting starts.
 *
 * Before this existed each announcement called the synthesiser directly, and
 * the synthesiser's default behaviour is to CANCEL whatever is playing. Two
 * events arriving a second apart therefore produced one truncated sentence and
 * one complete one, and the truncated one was as likely to be the important
 * one. A queue is the fix, with two rules on top of it:
 *
 *  1. URGENT GOES FIRST. An official warning does not wait behind a routine
 *     update. It jumps to the head of the queue — but it still does not cut
 *     off the sentence already in progress, because half of two sentences is
 *     worse than the second half of one.
 *  2. MUTE IS ABOUT SOUND, NOT ABOUT WATCHING. Muting stops speech and drops
 *     the pending queue. It does not stop monitoring, scoring or the feed, and
 *     unmuting does not replay what was missed — old news announced late is
 *     worse than not announced at all.
 */

/** What the voice is doing. */
export const VOICE_STATES = Object.freeze({
  MONITORING: 'MONITORING',
  SPEAKING: 'SPEAKING',
  MUTED: 'MUTED',
});

/** Levels that jump the queue. */
const PRIORITY_LEVELS = Object.freeze(['URGENT']);

/**
 * Create the voice queue.
 *
 * @param {object} [input] Input.
 * @param {Function} [input.speaker] Speech port.
 * @param {boolean} [input.muted] Initial mute state.
 * @returns {object} Frozen controller.
 */
export function createVoiceQueue({
  speaker = createSpeaker(),
  muted = false,
} = {}) {
  const pending = [];
  const listeners = new Set();
  let speaking = null;
  let isMuted = Boolean(muted);
  let destroyed = false;

  const state = () => {
    if (isMuted) return VOICE_STATES.MUTED;
    return speaking ? VOICE_STATES.SPEAKING : VOICE_STATES.MONITORING;
  };

  function publish() {
    const snapshot = Object.freeze({
      state: state(),
      // The id of what is being spoken, so the feed can highlight exactly the
      // message the voice is reading rather than guessing at the latest one.
      speakingId: speaking?.id ?? null,
      pending: pending.length,
    });
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // One broken subscriber must not silence the voice.
      }
    }
  }

  /** Take the next item, if nothing is already being said. */
  function pump() {
    if (destroyed || isMuted || speaking) return;
    const next = pending.shift();
    if (!next) {
      publish();
      return;
    }
    speaking = next;
    publish();
    speaker(next.text, {
      // Queued at the synthesiser too, so it never cancels itself.
      queue: true,
      onEnd: () => {
        if (destroyed) return;
        speaking = null;
        publish();
        pump();
      },
    });
  }

  return Object.freeze({
    /** @returns {string} A {@link VOICE_STATES} value. */
    state,
    /** @returns {string|null} The id currently being spoken. */
    speakingId: () => speaking?.id ?? null,
    /** @returns {number} How many lines are waiting. */
    size: () => pending.length,

    /**
     * Offer a line to the voice.
     *
     * @param {object} input Input.
     * @param {string} input.text What to say.
     * @param {string} [input.id] The feed message this belongs to.
     * @param {string} [input.level] Alert level, for priority.
     * @returns {boolean} Whether it was accepted.
     */
    enqueue({ text, id = null, level = 'NOTICE' } = {}) {
      if (destroyed || isMuted || !text) return false;
      const item = { text, id, level };
      // An urgent line goes to the front of what is WAITING. It deliberately
      // does not interrupt what is already being said.
      if (PRIORITY_LEVELS.includes(level)) {
        const firstRoutine = pending.findIndex(
          (entry) => !PRIORITY_LEVELS.includes(entry.level),
        );
        if (firstRoutine === -1) pending.push(item);
        else pending.splice(firstRoutine, 0, item);
      } else {
        pending.push(item);
      }
      pump();
      return true;
    },

    /**
     * Mute or unmute.
     *
     * Muting drops the backlog on purpose: when the voice comes back, the
     * user wants to know what is happening NOW, not to sit through a recap of
     * what they muted.
     *
     * @param {boolean} value Whether to mute.
     */
    setMuted(value) {
      const next = Boolean(value);
      if (next === isMuted) return;
      isMuted = next;
      if (isMuted) {
        pending.length = 0;
        speaking = null;
        try {
          globalThis.speechSynthesis?.cancel?.();
        } catch {
          // Nothing playing.
        }
      }
      publish();
      if (!isMuted) pump();
    },

    /** @returns {boolean} Whether speech is muted. */
    muted: () => isMuted,

    /**
     * Subscribe to voice state. Called immediately.
     * @param {(state: object) => void} listener Listener.
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      listener(
        Object.freeze({
          state: state(),
          speakingId: speaking?.id ?? null,
          pending: pending.length,
        }),
      );
      return () => listeners.delete(listener);
    },

    destroy() {
      destroyed = true;
      pending.length = 0;
      speaking = null;
      listeners.clear();
      try {
        globalThis.speechSynthesis?.cancel?.();
      } catch {
        // Nothing playing.
      }
    },
  });
}
