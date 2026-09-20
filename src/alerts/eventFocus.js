/**
 * One place that knows what the operator is looking at.
 *
 * Before this, clicking an earthquake marker did nothing at all. The handler
 * picked the event, checked whether the pick had MISSED, and dropped the hit
 * on the floor:
 *
 *     const event = overlay.eventFromPick(picked);
 *     if (!event && overlay.getSelected()) { ...clear selection... }
 *
 * The camera moved, the marker was under the cursor, and no part of the
 * intelligence system was ever told. The fire handler had the same shape. So
 * the fix is not a voice feature — it is a missing signal, and this module is
 * that signal.
 *
 * Everything that can mean "the user is inspecting this" routes through
 * `focus(event, source)`: a marker click, a panel row, a feed message, a
 * camera settling on something significant. Subscribers — the overlay
 * highlight, the transcript, the voice — react to one focus rather than each
 * growing its own click handling.
 *
 * The rules that keep it from becoming noise:
 *
 *  - AN EXPLICIT CLICK ALWAYS SPEAKS. A click is a question, and a question
 *    deserves an answer even for a magnitude 2.6 that would never have been
 *    announced on its own.
 *  - THE CAMERA IS NOT A CLICK. Drifting over a region must not narrate it, so
 *    camera-driven focus has a significance floor and the same cooldown.
 *  - THE SAME EVENT IS NOT REPEATED. Nudging the camera around one earthquake
 *    is one focus, not twenty.
 */

/** How long before the same event may be spoken about again. */
export const EVENT_SPEECH_COOLDOWN_MS = 60_000;

/** Magnitude at which a merely-viewed earthquake is worth a briefing. */
export const CAMERA_FOCUS_MIN_MAGNITUDE = 4.5;

/** Where a focus came from. An explicit source is a user intent. */
export const FOCUS_SOURCES = Object.freeze({
  MARKER_CLICK: 'marker-click',
  PANEL_CLICK: 'panel-click',
  FEED_CLICK: 'feed-click',
  CAMERA: 'camera-proximity',
});

/** Sources that represent a deliberate user action. */
const EXPLICIT = new Set([
  FOCUS_SOURCES.MARKER_CLICK,
  FOCUS_SOURCES.PANEL_CLICK,
  FOCUS_SOURCES.FEED_CLICK,
]);

/**
 * Is this event significant enough to narrate without being asked?
 *
 * Only consulted for camera-driven focus. A click bypasses it entirely.
 *
 * @param {object} event The event.
 * @returns {boolean} Whether a passive look is worth a briefing.
 */
export function worthUnpromptedFocus(event) {
  if (!event) return false;
  if (Number.isFinite(event.magnitude))
    return event.magnitude >= CAMERA_FOCUS_MIN_MAGNITUDE;
  // Non-seismic events reaching the camera path are not narrated on sight:
  // there is no equivalent single number to threshold on, and guessing one
  // would turn exploration into a running commentary.
  return false;
}

/**
 * Create the focus bus.
 *
 * @param {object} [input] Input.
 * @param {() => number} [input.now] Clock.
 * @param {number} [input.cooldownMs] Repeat suppression window.
 * @returns {object} Frozen controller.
 */
export function createEventFocus({
  now = () => Date.now(),
  cooldownMs = EVENT_SPEECH_COOLDOWN_MS,
} = {}) {
  const listeners = new Set();
  let focused = null;
  let lastSpokenId = null;
  let lastSpokenAt = 0;
  let destroyed = false;

  /**
   * Should this focus produce speech?
   *
   * @param {object} event The event.
   * @param {string} source A {@link FOCUS_SOURCES} value.
   * @returns {{speak: boolean, reason: string}} The decision and why.
   */
  function decide(event, source) {
    if (!event?.id) return { speak: false, reason: 'no-event' };
    const explicit = EXPLICIT.has(source);

    if (!explicit && !worthUnpromptedFocus(event))
      return { speak: false, reason: 'below-camera-threshold' };

    const sameEvent = event.id === lastSpokenId;
    const withinCooldown = now() - lastSpokenAt < cooldownMs;

    // A repeat click on the event already being discussed is not a new
    // question. A click on a DIFFERENT event always is, whatever the cooldown
    // — the operator just asked about something else.
    if (sameEvent && withinCooldown)
      return { speak: false, reason: 'already-briefed' };

    return { speak: true, reason: explicit ? 'explicit' : 'camera' };
  }

  return Object.freeze({
    /** @returns {object|null} The focused event. */
    current: () => focused,
    /** @returns {string|null} The id last spoken about. */
    lastSpokenId: () => lastSpokenId,

    /**
     * Focus an event.
     *
     * @param {object} event The event or incident.
     * @param {string} [source] A {@link FOCUS_SOURCES} value.
     * @returns {object} What was decided.
     */
    focus(event, source = FOCUS_SOURCES.MARKER_CLICK) {
      if (destroyed || !event) return { speak: false, reason: 'inactive' };
      const decision = decide(event, source);
      focused = event;
      if (decision.speak) {
        lastSpokenId = event.id;
        lastSpokenAt = now();
      }
      const payload = Object.freeze({
        type: 'EVENT_FOCUSED',
        eventId: event.id,
        event,
        source,
        speak: decision.speak,
        reason: decision.reason,
        timestamp: now(),
      });
      for (const listener of listeners) {
        try {
          listener(payload);
        } catch {
          // One broken subscriber must not stop the rest from reacting.
        }
      }
      return payload;
    },

    /** Clear the focus without announcing anything. */
    clear() {
      focused = null;
    },

    /**
     * Subscribe to focus events.
     * @param {(focus: object) => void} listener Listener.
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      destroyed = true;
      listeners.clear();
      focused = null;
    },
  });
}
