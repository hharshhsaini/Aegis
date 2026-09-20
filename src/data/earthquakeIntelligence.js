import { DEFAULT_FEED } from '../layers/earthquakes/thresholds.js';

/**
 * Browser-side access to the Aegis earthquake intelligence endpoint.
 *
 * USGS serves one feed for the whole planet, so the client caches by FEED, not
 * by viewport: a pan re-scopes the events it already holds instead of asking
 * again. Only a feed change or an expired window costs a request.
 *
 * Deduplication is by event id, which is the original USGS id, so an event that
 * appears in consecutive refreshes is the same event rather than a new one.
 */

/** Client cache lifetime. USGS regenerates about every minute. */
export const CLIENT_CACHE_MS = 5 * 60_000;

/**
 * Create the earthquake intelligence service.
 *
 * @param {object} input Input.
 * @param {(query: object, options?: object) => Promise<object>} input.fetchIntelligence Transport.
 * @param {() => number} [input.now] Clock.
 * @param {number} [input.ttlMs] Cache lifetime.
 * @returns {object} Frozen service.
 */
export function createEarthquakeIntelligenceService({
  fetchIntelligence,
  now = () => Date.now(),
  ttlMs = CLIENT_CACHE_MS,
}) {
  if (typeof fetchIntelligence !== 'function')
    throw new TypeError('An earthquake intelligence transport is required');

  const cache = new Map();
  const inFlight = new Map();
  const listeners = new Set();
  const seenEventIds = new Set();
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
   * Observe recent earthquakes for a viewport.
   *
   * @param {object} [input] Query.
   * @param {object|null} [input.bbox] Viewport box, or null for the whole feed.
   * @param {string} [input.feed] USGS feed id.
   * @param {object} [options] Options.
   * @param {boolean} [options.force] Bypass the client cache.
   * @param {AbortSignal} [options.signal] Caller cancellation.
   * @returns {Promise<object|null>} Result record.
   */
  async function observe(
    { bbox = null, feed = DEFAULT_FEED } = {},
    options = {},
  ) {
    const { force = false, signal } = options;
    // The viewport is part of the request but NOT of the cache key: the server
    // scopes a planet-wide feed, and re-scoping is cheaper than re-fetching.
    const key = `${feed}:${
      bbox
        ? Object.values(bbox)
            .map((n) => n.toFixed(1))
            .join(',')
        : 'world'
    }`;
    const cached = cache.get(key);
    if (!force && cached && now() - cached.at < ttlMs) {
      const record = { ...cached.record, source: 'cache' };
      publish(record);
      return record;
    }
    if (inFlight.has(key)) return inFlight.get(key);

    const pending = (async () => {
      try {
        const response = await fetchIntelligence({ bbox, feed }, { signal });
        const intelligence = response?.intelligence || null;
        if (!intelligence) throw new Error('USGS earthquake data unavailable');
        const newEventIds = intelligence.events
          .map((event) => event.id)
          .filter((id) => !seenEventIds.has(id));
        for (const id of newEventIds) seenEventIds.add(id);
        const record = Object.freeze({
          key,
          feed,
          bbox,
          intelligence,
          responseWeather: response.responseWeather ?? null,
          newEventIds: Object.freeze(newEventIds),
          status: response.status || 'ready',
          receivedAt: now(),
          source: 'network',
          error: null,
        });
        cache.set(key, { at: now(), record });
        while (cache.size > 8) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        publish(record);
        return record;
      } catch (error) {
        if (signal?.aborted) throw error;
        // A failed refresh keeps the previous observation on screen. It must
        // never read as "no earthquakes" — that is a claim about the world.
        const record = Object.freeze({
          key,
          feed,
          bbox,
          intelligence: cached?.record?.intelligence || null,
          responseWeather: cached?.record?.responseWeather ?? null,
          newEventIds: Object.freeze([]),
          status: cached?.record ? 'stale' : 'error',
          receivedAt: now(),
          source: 'error',
          error:
            error?.message || 'USGS earthquake data temporarily unavailable.',
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
    hasSeen: (id) => seenEventIds.has(id),
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      if (latest) listener(latest);
      return () => listeners.delete(listener);
    },
    clear() {
      cache.clear();
      inFlight.clear();
      seenEventIds.clear();
      latest = null;
    },
  });
}
