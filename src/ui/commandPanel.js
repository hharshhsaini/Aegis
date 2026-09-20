/**
 * The header every intelligence panel shares: title, status chip, collapse.
 *
 * The fire and earthquake panels had grown their own header wiring, which is
 * how their collapse buttons ended up behaving differently from each other and
 * from the rest of the console. This is the one implementation.
 *
 * It does NOT own the collapse itself. `bindPanelDisclosure` already binds
 * every `.panel-collapse-btn[data-collapse-target]` and routes it through
 * `setPanelCollapsed`, which is what persists the state and tells the rail to
 * relayout. Adding a second click handler here does not add a feature — it
 * takes one away: the first attempt stopped the event immediately, which
 * silenced the real handler and left a button that highlighted on hover and
 * did nothing at all.
 *
 * So this module observes rather than competes. It keeps the glyph, the aria
 * state, the status chip and the collapsed summary in step with whatever the
 * disclosure system decides, and it isolates POINTER events on the button —
 * which the disclosure does not need and the Cesium canvas underneath must
 * never see, because a pointerdown that reaches the globe starts a camera drag
 * before any click is dispatched.
 *
 * Collapsed, a panel is its header and an optional one-line summary — never an
 * empty container holding space for content that is not being shown.
 */

/**
 * Bind a panel's header.
 *
 * @param {object} input Input.
 * @param {HTMLElement} input.panel The panel root.
 * @param {Document} [input.document] Document.
 * @param {boolean} [input.collapsed] Initial state.
 * @param {(collapsed: boolean) => void} [input.onToggle] Called after a toggle.
 * @returns {object|null} Controller, or null without a panel.
 */
export function bindCommandPanel({
  panel,
  document: doc = globalThis.document,
  collapsed = null,
} = {}) {
  if (!panel) return null;

  const button = panel.querySelector('.panel-collapse-btn');
  const chip = panel.querySelector('.aegis-feed-chip');
  const summary = panel.querySelector('[data-role="collapsed-summary"]');

  /**
   * Stop an event reaching anything above this control.
   *
   * Propagation only: the disclosure's own handler on this element must still
   * run, so this deliberately does NOT use `stopImmediatePropagation`.
   *
   * @param {Event} event Event.
   */
  const isolate = (event) => {
    event?.stopPropagation?.();
  };

  const isCollapsed = () => panel.classList.contains('collapsed');

  /** Paint the button to match the state it will move away from. */
  function present() {
    const collapsedNow = isCollapsed();
    if (button) {
      // An en dash collapses, a plus expands: the glyph names the ACTION, not
      // the state, which is what an operator reaching for it expects.
      button.textContent = collapsedNow ? '+' : '–';
      button.setAttribute('aria-expanded', collapsedNow ? 'false' : 'true');
      button.setAttribute(
        'aria-label',
        collapsedNow ? 'Expand panel' : 'Collapse panel',
      );
      button.title = collapsedNow ? 'Expand panel' : 'Collapse panel';
    }
    if (summary) summary.hidden = !collapsedNow;
  }

  // Pointer events only. The click belongs to `bindPanelDisclosure`; a
  // pointerdown belongs to nobody above this button, and letting one through
  // to the canvas starts a camera drag before the click is ever dispatched.
  const listeners = [
    ['pointerdown', isolate],
    ['pointerup', isolate],
    ['dblclick', isolate],
  ];
  for (const [type, handler] of listeners)
    button?.addEventListener(type, handler);

  // The disclosure system owns the class; this keeps the glyph and the summary
  // in step with it however it changes — a button click, a keyboard escape, a
  // rail relayout, or a restored share link.
  const observer = globalThis.MutationObserver
    ? new globalThis.MutationObserver(() => present())
    : null;
  observer?.observe(panel, {
    attributes: true,
    attributeFilter: ['class'],
  });

  if (typeof collapsed === 'boolean')
    panel.classList.toggle('collapsed', collapsed);
  present();

  return Object.freeze({
    present,
    /** @returns {boolean} Whether the panel is collapsed. */
    isCollapsed,
    /**
     * Set the header status chip.
     * @param {object} description A {@link describeFeedState} result.
     */
    setStatus(description) {
      if (!chip || !description) return;
      chip.textContent = description.label;
      chip.dataset.tone = description.tone;
      chip.title = description.message || description.label;
    },
    /**
     * Set the one-line summary shown while collapsed.
     *
     * Collapsed does not mean silent: a panel worth collapsing is usually one
     * an operator still wants a number from.
     *
     * @param {string} text Summary text.
     */
    setSummary(text) {
      if (summary) summary.textContent = text || '';
    },
    destroy() {
      observer?.disconnect();
      for (const [type, handler] of listeners)
        button?.removeEventListener(type, handler);
    },
  });
}
