import {
  snapBoundingBox,
  areaKey,
  DEFAULT_SOURCES,
} from '../sources/firmsArea.js';

/**
 * Browser-side access to the Aegis fire intelligence endpoint.
 *
 * The client's job is to ask rarely. A Cesium camera generates a new viewport
 * on every frame of a flight, and FIRMS publishes roughly every 15 minutes, so
 * requests are snapped to the same grid the server caches on, deduplicated
 * while in flight, and reused from memory until the data could plausibly have
 * changed.
 *
 * Because the grid is shared with the server, panning inside one cell costs
 * nothing at all: the client recognises the cell it already holds and never
 * opens a request.
 */

/** Client cache lifetime, matched to the FIRMS publication cadence. */
export const CLIENT_CACHE_MS = 15 * 60_000;

/** Cells retained in memory. */
const MAX_CACHED_CELLS = 12;

/**
 * Create the fire intelligence service.
 *
 * @param {object} input Service input.
 * @param {(bbox: object, options?: object) => Promise<object>} input.fetchIntelligence Transport.
 * @param {() => number} [input.now] Clock.
 * @param {number} [input.ttlMs] Cache lifetime.
 * @returns {object} Frozen service.
 */
export function createFireIntelligenceService({
  fetchIntelligence,
  now = () => Date.now(),
  ttlMs = CLIENT_CACHE_MS,
}) {
  if (typeof fetchIntelligence !== 'function')
    throw new TypeError('A fire intelligence transport is required');

  const cache = new Map();
  const inFlight = new Map();
  const listeners = new Set();
  let latest = null;

  const publish = (record) => {
    latest = record;
    for (const listener of listeners) {
      try {
        listener(record);
      } catch {
        // One broken subscriber must not stop the others.
      }
    }
  };

  /**
   * Observe an area.
   *
   * @param {{west: number, south: number, east: number, north: number}} viewBox Viewport box.
   * @param {object} [options] Options.
   * @param {boolean} [options.force] Bypass the client cache.
   * @param {AbortSignal} [options.signal] Caller cancellation.
   * @returns {Promise<object|null>} Result record, or null for an unusable box.
   */
  async function observe(viewBox, { force = false, signal } = {}) {
    const snapped = snapBoundingBox(viewBox);
    if (!snapped) return null;
    const key = areaKey(snapped, DEFAULT_SOURCES.join('+'), 2);

    const cached = cache.get(key);
    if (!force && cached && now() - cached.at < ttlMs) {
      const record = { ...cached.record, source: 'cache' };
      publish(record);
      return record;
    }
    if (inFlight.has(key)) return inFlight.get(key);

    const pending = (async () => {
      try {
        const response = await fetchIntelligence(snapped, { signal });
        const intelligence = response?.intelligence || null;
        if (!intelligence) throw new Error('Satellite fire data unavailable');
        const record = Object.freeze({
          key,
          bbox: snapped,
          intelligence,
          detections: Object.freeze(response.detections || []),
          status: response.status || 'ready',
          areaClamped: Boolean(response.areaClamped),
          receivedAt: now(),
          source: 'network',
          error: null,
        });
        cache.set(key, { at: now(), record });
        while (cache.size > MAX_CACHED_CELLS) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        publish(record);
        return record;
      } catch (error) {
        if (signal?.aborted) throw error;
        // FIRMS being unreachable must not blank what is already on screen, and
        // must never be reported as "no fires" — that is a claim about the
        // ground, not about the feed.
        const record = Object.freeze({
          key,
          bbox: snapped,
          intelligence: cached?.record?.intelligence || null,
          detections: cached?.record?.detections || Object.freeze([]),
          status: cached?.record ? 'stale' : 'error',
          receivedAt: now(),
          source: 'error',
          error:
            error?.message || 'Satellite fire data temporarily unavailable.',
        });
        publish(record);
        return record;
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, pending);
    return pending;
  }

  return Object.freeze({
    observe,
    getLatest: () => latest,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      if (latest) listener(latest);
      return () => listeners.delete(listener);
    },
    clear() {
      cache.clear();
      inFlight.clear();
      latest = null;
    },
  });
}
