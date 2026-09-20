/**
 * A timeline scrubber that cannot leak its input to anything else.
 *
 * The Nepal reconstruction clock is a native `<input type="range">` living
 * inside a panel that is itself interactive. That is the whole bug: a range
 * input handles its own drag correctly, but it does not stop the pointer
 * events from bubbling, so every ancestor sees them too. Dragging the playhead
 * therefore also reached
 *
 *   - the panel's hover disclosure, whose `pointerleave` schedules a close —
 *     and a drag almost always leaves the panel bounds, so the modal shut
 *     itself mid-scrub;
 *   - the panel's own `click` handler, which toggles collapse;
 *   - any backdrop or container click handler above it;
 *   - and, once the pointer left the panel, the Cesium canvas underneath.
 *
 * So this module wraps the input in an isolation layer. Every pointer, click
 * and key event it handles is stopped at the input, an explicit pointer
 * capture keeps the drag bound to the control even when the cursor travels far
 * outside it, and a `data-scrubbing` flag is published on the element while a
 * drag is live so hover-driven behaviour elsewhere can stand down.
 *
 * The native input is kept rather than replaced: it already gives correct
 * keyboard stepping, an accessible role, a value, and screen-reader support
 * that a div with a background gradient would have to reimplement badly.
 */

/** Keys the scrubber handles itself, and must not let an ancestor see. */
const HANDLED_KEYS = Object.freeze([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/**
 * Read the input's value as a 0..1 fraction.
 * @param {HTMLInputElement} input Range input.
 * @returns {number} Fraction.
 */
export function fractionOf(input, range = readRange(input)) {
  const { min, max } = range;
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return 0;
  const value = Number(input.value);
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, (value - min) / span));
}

/**
 * Map a client X coordinate onto the input's track as a 0..1 fraction.
 *
 * Used while dragging so the value follows the pointer even after capture has
 * taken the cursor outside the element, which is exactly when a native range
 * would otherwise stop updating.
 *
 * @param {HTMLInputElement} input Range input.
 * @param {number} clientX Pointer X.
 * @returns {number} Fraction.
 */
export function fractionAt(input, clientX, range = readRange(input)) {
  const rect = input.getBoundingClientRect?.();
  if (!rect?.width) return fractionOf(input, range);
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

/**
 * The input's value range.
 *
 * Read from the property, then the attribute, then a 0..100 default. A host
 * that models the element without DOM property accessors — a test double, a
 * non-browser renderer — still reports the authored range through
 * `getAttribute`, and silently falling back to 0..100 against a 0..1000
 * control would put every seek at the end of the timeline.
 *
 * @param {HTMLInputElement} input Range input.
 * @returns {{min: number, max: number}} The range.
 */
export function readRange(input) {
  const read = (name, fallback) => {
    const property = Number(input?.[name]);
    if (Number.isFinite(property) && input?.[name] !== '') return property;
    const attribute = Number(input?.getAttribute?.(name));
    return Number.isFinite(attribute) ? attribute : fallback;
  };
  return { min: read('min', 0), max: read('max', 100) };
}

/**
 * Attach the scrubber to an existing range input.
 *
 * @param {object} input Input.
 * @param {HTMLInputElement} input.element The range input.
 * @param {(fraction: number) => void} [input.onPreview] Called during a drag.
 * @param {(fraction: number) => void} [input.onCommit] Called when a drag ends.
 * @returns {object|null} Controller, or null without an element.
 */
export function attachTimelineScrubber({
  element,
  onPreview,
  onCommit,
  range,
} = {}) {
  if (!element) return null;

  // Resolved once: the authored range does not change, and re-reading it per
  // pointermove would ask the DOM for the same two numbers hundreds of times
  // during a single drag.
  const bounds = range || readRange(element);

  let dragging = false;
  let pointerId = null;

  /**
   * Stop an event reaching anything above this control.
   *
   * `stopPropagation` handles ancestors in the bubble phase;
   * `stopImmediatePropagation` also handles other listeners on the input
   * itself that were attached earlier and would otherwise double-handle the
   * same gesture.
   *
   * @param {Event} event Event.
   */
  const isolate = (event) => {
    // Optional calls: a synthetic event dispatched by a host or a test is a
    // plain object, and a scrubber that threw on one would take the whole
    // panel down with it.
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
  };

  /** Publish drag state so hover-driven behaviour elsewhere can stand down. */
  const setDragging = (value) => {
    dragging = value;
    if (!element.dataset) return;
    if (value) element.dataset.scrubbing = 'true';
    else delete element.dataset.scrubbing;
  };

  const applyFraction = (fraction, { commit = false } = {}) => {
    const { min, max } = bounds;
    const value = min + fraction * (max - min);
    element.value = String(Math.round(value));
    if (commit) onCommit?.(fraction);
    else onPreview?.(fraction);
  };

  const onPointerDown = (event) => {
    isolate(event);
    // Only the primary button starts a scrub; a right-click on the timeline
    // is not a seek and should not move the clock.
    if (event.button !== undefined && event.button !== 0) return;
    setDragging(true);
    pointerId = event.pointerId;
    // Explicit capture: the drag stays bound to this control even when the
    // cursor travels over the globe, another panel, or outside the window.
    try {
      element.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is an enhancement; a browser that refuses it still scrubs.
    }
    applyFraction(fractionAt(element, event.clientX, bounds));
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    isolate(event);
    applyFraction(fractionAt(element, event.clientX, bounds));
  };

  const endDrag = (event) => {
    if (!dragging) return;
    isolate(event);
    setDragging(false);
    if (pointerId !== null) {
      try {
        element.releasePointerCapture?.(pointerId);
      } catch {
        // Already released, or never captured.
      }
      pointerId = null;
    }
    applyFraction(fractionOf(element, bounds), { commit: true });
  };

  const onKeyDown = (event) => {
    if (!HANDLED_KEYS.includes(event.key)) return;
    // The input steps itself; isolating stops the same arrow also reaching a
    // beat-navigation or tab-navigation handler further up.
    isolate(event);
  };

  const onKeyUp = (event) => {
    if (!HANDLED_KEYS.includes(event.key)) return;
    isolate(event);
    onCommit?.(fractionOf(element, bounds));
  };

  // `input` and `change` are kept because the native control still fires them
  // for keyboard stepping and for any browser path that bypasses our pointer
  // handling; isolating them stops an ancestor form/panel handler seeing them.
  const onInput = (event) => {
    isolate(event);
    if (!dragging) onPreview?.(fractionOf(element, bounds));
  };

  const onChange = (event) => {
    isolate(event);
    if (!dragging) onCommit?.(fractionOf(element, bounds));
  };

  // A click is synthesised after a drag; letting it through would reach the
  // panel's collapse handler and the backdrop.
  const onClick = isolate;

  const listeners = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', endDrag],
    ['pointercancel', endDrag],
    ['lostpointercapture', endDrag],
    ['keydown', onKeyDown],
    ['keyup', onKeyUp],
    ['input', onInput],
    ['change', onChange],
    ['click', onClick],
    ['dblclick', isolate],
    ['contextmenu', isolate],
    // The wheel is the globe's zoom gesture. Over the timeline it must do
    // nothing rather than zooming the map behind the panel.
    ['wheel', isolate],
  ];
  for (const [type, handler] of listeners)
    element.addEventListener(type, handler);

  return Object.freeze({
    /** @returns {boolean} Whether a drag is in progress. */
    isDragging: () => dragging,
    /** @returns {number} The current fraction. */
    fraction: () => fractionOf(element, bounds),
    /**
     * Move the playhead without notifying, for playback-driven updates.
     * @param {number} fraction Fraction in 0..1.
     */
    setFraction(fraction) {
      // A live drag owns the playhead; playback must not fight the operator
      // for it, which is what made the scrubber jump back mid-gesture.
      if (dragging) return;
      const { min, max } = bounds;
      const clamped = Math.min(1, Math.max(0, fraction));
      element.value = String(Math.round(min + clamped * (max - min)));
    },
    destroy() {
      for (const [type, handler] of listeners)
        element.removeEventListener(type, handler);
      setDragging(false);
    },
  });
}
