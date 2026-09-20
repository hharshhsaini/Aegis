/**
 * The compact metric grid the intelligence panels share.
 *
 * The panels were mostly empty: a single sentence where an operator wanted
 * numbers. This renders the dense block that replaced it — a label and a value,
 * repeated, in one consistent shape so the fire panel and the earthquake panel
 * read the same way.
 *
 * The one rule worth stating: a null value prints an em dash, never a zero.
 * "0 clusters" and "we do not know how many clusters" are different statements,
 * and a panel that renders the second as the first is lying quietly. Callers
 * pass null for the gap and a number for the count.
 */

/**
 * Render a metric grid into a container.
 *
 * @param {Document} doc Document.
 * @param {HTMLElement} container Target, usually a `<dl>`.
 * @param {Array<[string, (string|number|null|undefined), (string|undefined)]>} metrics
 *   Label, value and an optional colour for the value.
 * @returns {void}
 */
export function renderMetrics(doc, container, metrics) {
  if (!container) return;
  container.replaceChildren(
    ...metrics.map(([label, value, color]) => {
      const cell = doc.createElement('div');
      cell.className = 'aegis-metric';
      const term = doc.createElement('dt');
      term.textContent = label;
      const detail = doc.createElement('dd');
      const missing = value === null || value === undefined;
      detail.textContent = missing ? '—' : String(value);
      if (missing) detail.dataset.empty = 'true';
      else if (color) detail.style.color = color;
      cell.append(term, detail);
      return cell;
    }),
  );
}
