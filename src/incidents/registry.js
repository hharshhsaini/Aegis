import { compareIncidents } from './model.js';

/**
 * The incident board.
 *
 * Feeds push their contributions in whenever they refresh; the registry keeps
 * one merged, ordered list and tells its subscribers when that list actually
 * changed. "Actually changed" is the important part: the fire feed republishes
 * every fifteen minutes and the earthquake feed every five, and re-rendering a
 * list that is identical would make selected rows jump under the operator's
 * cursor for no reason.
 *
 * Contributions are keyed by CONTRIBUTOR, not appended, so a feed that has
 * gone quiet removes its own incidents by publishing an empty list. Nothing
 * lingers on the board because the source that reported it stopped answering —
 * a stale incident is worse than no incident.
 */

/** Most incidents the board will hold. */
export const MAX_INCIDENTS = 12;

/**
 * Create the registry.
 *
 * @param {object} [input] Input.
 * @param {number} [input.limit] Maximum incidents retained.
 * @returns {object} Frozen registry.
 */
export function createIncidentRegistry({ limit = MAX_INCIDENTS } = {}) {
  const contributions = new Map();
  const listeners = new Set();
  let merged = Object.freeze([]);
  let signature = '';

  /** Rebuild the merged list, and publish only if it differs. */
  function rebuild() {
    // Deduplicated by incident id, because the same real-world event can now
    // reach the board from two contributors: the viewport feed that draws the
    // globe, and the location-scoped query that Local Intelligence asks about
    // the monitored point. They overlap whenever the camera is looking at the
    // user, and one earthquake must never be listed — or announced — twice
    // because two questions found it.
    const seen = new Map();
    for (const list of contributions.values())
      for (const incident of list)
        if (!seen.has(incident.id)) seen.set(incident.id, incident);
    const all = [...seen.values()];
    const next = Object.freeze(all.sort(compareIncidents).slice(0, limit));
    // Identity plus severity: a row that merely aged does not need a repaint,
    // but one that changed band does.
    const nextSignature = next
      .map((incident) => `${incident.id}@${incident.severity}`)
      .join('|');
    if (nextSignature === signature) return false;
    signature = nextSignature;
    merged = next;
    for (const listener of listeners) {
      try {
        listener(merged);
      } catch {
        // One broken subscriber must not stop the others.
      }
    }
    return true;
  }

  return Object.freeze({
    /**
     * Replace one contributor's incidents.
     *
     * @param {string} contributor Stable contributor id.
     * @param {object[]} incidents That contributor's current incidents.
     * @returns {boolean} Whether the board changed.
     */
    publish(contributor, incidents) {
      contributions.set(contributor, Object.freeze([...(incidents || [])]));
      return rebuild();
    },
    /** @returns {object[]} The current board. */
    list() {
      return merged;
    },
    /**
     * Find one incident by id.
     * @param {string} id Incident id.
     * @returns {object|null} The incident.
     */
    find(id) {
      return merged.find((incident) => incident.id === id) || null;
    },
    /**
     * Subscribe to board changes. The listener is called immediately.
     * @param {(incidents: object[]) => void} listener Listener.
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      listener(merged);
      return () => listeners.delete(listener);
    },
    clear() {
      contributions.clear();
      merged = Object.freeze([]);
      signature = '';
    },
  });
}
