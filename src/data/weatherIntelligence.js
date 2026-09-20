import { normalizePoint, pointKey } from '../sources/openMeteo.js';

/**
 * Browser-side access to the Aegis weather intelligence endpoint.
 *
 * The analysis itself is produced server-side; this service exists to make sure
 * the app asks for it as rarely as possible. A camera drifting across a city
 * would otherwise fire a request per frame, so requests are snapped to the same
 * ~1 km grid the server caches on, held briefly in memory, and deduplicated
 * while one is in flight.
 *
 * The provider is injected rather than imported, which is what lets the panel
 * keep working unchanged when the endpoint moves from a Vite middleware to an
 * API Gateway route in front of Lambda.
 */

/** How long a fetched analysis is reused before asking again. */
export const CLIENT_CACHE_MS = 4 * 60_000;

/** Cells retained in memory; bounded so a long session cannot grow unboundedly. */
const MAX_CACHED_CELLS = 24;

/**
 * Create the intelligence service.
 *
 * @param {object} input Service input.
 * @param {(latitude: number, longitude: number, options?: object) => Promise<object>} input.fetchAnalysis
 *   Transport that returns `{ status, analysis }` for a point.
 * @param {() => number} [input.now] Clock, injectable for tests.
 * @param {number} [input.ttlMs] Client cache lifetime.
 * @returns {object} Frozen service.
 */
export function createWeatherIntelligenceService({
  fetchAnalysis,
  now = () => Date.now(),
  ttlMs = CLIENT_CACHE_MS,
}) {
  if (typeof fetchAnalysis !== 'function')
    throw new TypeError('A weather analysis transport is required');

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
        // One broken subscriber must not stop the others from updating.
      }
    }
  };

  /**
   * Analyze a location, reusing recent work where possible.
   *
   * @param {number} latitude Degrees north.
   * @param {number} longitude Degrees east.
   * @param {object} [options] Options.
   * @param {boolean} [options.force] Bypass the client cache.
   * @param {AbortSignal} [options.signal] Caller cancellation.
   * @returns {Promise<object|null>} Result record, or null for invalid input.
   */
  async function analyze(latitude, longitude, { force = false, signal } = {}) {
    const point = normalizePoint(latitude, longitude);
    if (!point) return null;
    const key = pointKey(point);

    const cached = cache.get(key);
    // Strictly inside the window: a ttl of 0 must mean "never reuse", which an
    // inclusive comparison would turn into "reuse for the rest of this
    // millisecond" — the difference only shows up under a stopped clock, which
    // is exactly where tests and replays live.
    if (!force && cached && now() - cached.at < ttlMs) {
      const record = { ...cached.record, source: 'cache' };
      publish(record);
      return record;
    }

    // A second caller for the same cell joins the request already running
    // rather than starting another.
    if (inFlight.has(key)) return inFlight.get(key);

    const pending = (async () => {
      try {
        const response = await fetchAnalysis(point.latitude, point.longitude, {
          signal,
        });
        const analysis = response?.analysis || null;
        if (!analysis) throw new Error('Weather intelligence unavailable');
        const record = Object.freeze({
          point,
          key,
          analysis,
          status: response.status || 'ready',
          ageMs: response.ageMs ?? 0,
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
        // A failed poll leaves the previous analysis standing, flagged, rather
        // than blanking a panel an operator may be reading.
        const record = Object.freeze({
          point,
          key,
          analysis: cached?.record?.analysis || null,
          status: cached?.record ? 'stale' : 'error',
          ageMs: cached ? now() - cached.at : 0,
          receivedAt: now(),
          source: 'error',
          error: error?.message || 'Weather intelligence unavailable',
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
    analyze,
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
