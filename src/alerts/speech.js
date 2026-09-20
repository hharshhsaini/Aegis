/**
 * The one voice Aegis speaks with.
 *
 * Every spoken line in the product comes through here: the alert layer's
 * announcements, the briefings, and the startup introduction. That is the
 * point of the module — there is exactly one speech port, so the console
 * cannot end up with two voices that differ in rate, language or interrupt
 * behaviour depending on which subsystem happened to be talking.
 *
 * It is the BROWSER synthesiser rather than the Realtime assistant, and that is
 * deliberate: it needs no API key, it works offline, and everything it says is
 * deterministic template text that no model needs to generate. The
 * conversational Realtime voice in `src/voice/` is a separate thing and is left
 * exactly as it was.
 *
 * Two behaviours are worth knowing about:
 *
 *  - INTERRUPTION. By default a new line cancels whatever is playing, because
 *    an alert that matters more than the sentence in progress should not queue
 *    behind it. A narration that is meant to run as a sequence passes
 *    `queue: true` instead, so its own lines do not cut each other off.
 *  - FAILURE IS SILENT, NOT FATAL. A platform with no synthesiser, or one that
 *    refuses to speak, returns a no-op. The caller still shows its card; the
 *    console never breaks because audio was unavailable.
 */

/**
 * Create the speech port.
 *
 * @param {object} [speechSynthesis] The synthesiser.
 * @returns {(text: string, options?: object) => void} Speak function.
 */
export function createSpeaker(speechSynthesis = globalThis.speechSynthesis) {
  if (!speechSynthesis?.speak) return () => {};
  return (text, { queue = false, rate = 1.02, onEnd } = {}) => {
    try {
      if (!queue) speechSynthesis.cancel();
      const utterance = new globalThis.SpeechSynthesisUtterance(text);
      utterance.rate = rate;
      utterance.lang = 'en-US';
      if (onEnd) {
        utterance.onend = onEnd;
        // A refusal mid-sentence must not strand a sequence waiting for an end
        // event that is never going to arrive.
        utterance.onerror = onEnd;
      }
      speechSynthesis.speak(utterance);
    } catch {
      // A browser that refuses to speak still shows the card.
      onEnd?.();
    }
  };
}

/**
 * Whether this platform can speak at all.
 *
 * Distinct from whether it is ALLOWED to right now — autoplay policy is a
 * separate question the caller handles — and used to decide whether offering an
 * audio prompt would be honest.
 *
 * @param {object} [speechSynthesis] The synthesiser.
 * @returns {boolean} Whether speech synthesis exists.
 */
export function speechAvailable(speechSynthesis = globalThis.speechSynthesis) {
  return Boolean(speechSynthesis?.speak);
}
