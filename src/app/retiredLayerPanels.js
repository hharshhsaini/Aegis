/**
 * Rail panels whose entire content belongs to one retired layer.
 *
 * A retired layer is constructed but never registered, so the manager can never
 * enable it and the panel can never fill. Left in the rail, each one offers the
 * operator a control that cannot do anything — the CCTV panel, for instance,
 * opens on an empty viewport reading "Enable CCTV", with no way to enable it.
 *
 * The markup stays in the templates: this is presentation, keyed on what the
 * catalog actually registered, so re-registering a layer restores its panel
 * without a markup change. Panels that merely MENTION a retired layer alongside
 * live content are not listed here — hiding those would take working controls
 * with them.
 */
const RETIRED_LAYER_PANELS = Object.freeze({
  'cctv-panel': 'cctv',
  'radio-panel': 'radio',
});

/**
 * Hide every rail panel whose backing layer is absent from the catalog.
 *
 * @param {object} input
 * @param {(layerId: string) => boolean} input.isRegistered Catalog membership test.
 * @param {Document} [input.document] Document to search; defaults to the page.
 * @returns {string[]} Panel ids hidden by this call.
 */
export function hideRetiredLayerPanels({
  isRegistered,
  document: doc = globalThis.document,
} = {}) {
  const hidden = [];
  for (const [panelId, layerId] of Object.entries(RETIRED_LAYER_PANELS)) {
    if (isRegistered?.(layerId)) continue;
    const panel = doc?.getElementById?.(panelId);
    if (!panel) continue;
    panel.hidden = true;
    hidden.push(panelId);
  }
  return hidden;
}
