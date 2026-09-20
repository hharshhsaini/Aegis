import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { coalesceProxyRequest } from '../common/http.js';
import { fetchRegionalJson } from '../regional/http.js';
import { validRegionalPoint } from '../regional/query.js';
import {
  forecastRequestUrl,
  normalizePoint,
  pointKey,
} from '../../../src/sources/openMeteo.js';
import { normalizeForecast } from '../../../src/weather/normalize.js';
import { analyzeSnapshot } from '../../../src/risk/riskEngine.js';

/**
 * Aegis weather intelligence endpoint.
 *
 * This route is the local stand-in for the first half of the target AWS
 * pipeline — Open-Meteo → Lambda → risk engine → store → change events — and it
 * is deliberately shaped like that Lambda. It owns the upstream call, the
 * caching, the previous-analysis store and the change events; the browser
 * receives only the finished analysis. Moving to AWS therefore means
 * re-hosting this file's body, not rewriting the engine or the UI.
 *
 * What it does NOT do is pretend to be AWS. `_analysisStore` is an in-process
 * Map standing in for DynamoDB, and the events it returns are plain records
 * that no EventBridge is consuming yet. Both are named for what they are.
 *
 * API budget is the reason for every cache here: Open-Meteo is public and
 * keyless, and it stays available to this project by not being hammered. One
 * upstream request serves every client looking at the same ~1 km cell for five
 * minutes, concurrent requests for a cold cell are coalesced into one, and a
 * stale answer is preferred over a retry storm when upstream is down.
 */

/** Fresh window. Open-Meteo updates hourly; five minutes is well inside that. */
const ANALYSIS_CACHE_MS = 5 * 60_000;

/** How long a cached analysis may still be served after an upstream failure. */
const ANALYSIS_STALE_MS = 45 * 60_000;

/** Cached cells. Each is small; the cap bounds memory on a long-running server. */
const ANALYSIS_MAX_CACHE = 240;

/** Retained previous analyses per cell — the DynamoDB stand-in for trends. */
const ANALYSIS_HISTORY_MAX = 240;

const _analysisCache = new Map();
const _analysisStore = new Map();
const _analysisInFlight = new Map();

const _analysisRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 30,
  globalMax: 90,
});

const WEATHER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function trimMap(map, limit) {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Fetch, normalize and analyze one location.
 *
 * The previous analysis for the same cell is passed into the engine so trends
 * and change events are measured against what this service last reported,
 * rather than being recomputed from scratch and always reading as "stable".
 *
 * @param {{latitude: number, longitude: number}} point Requested point.
 * @param {string} key Cache key for the cell.
 * @param {(url: string, options: object) => Promise<object>} fetchJson Upstream reader.
 * @returns {Promise<object>} Analysis payload.
 */
async function analyzePoint(point, key, fetchJson, clock = () => Date.now()) {
  const payload = await fetchJson(forecastRequestUrl(point), {
    maxBytes: WEATHER_MAX_RESPONSE_BYTES,
    // A fixed API endpoint has no legitimate reason to redirect, and following
    // one would let an upstream change steer this request elsewhere.
    redirect: 'error',
  });
  const snapshot = normalizeForecast(payload, {
    latitude: point.latitude,
    longitude: point.longitude,
    retrievedAt: new Date().toISOString(),
  });
  if (!snapshot) throw new Error('Weather observations unavailable');

  const previous = _analysisStore.get(key) || null;
  const analysis = analyzeSnapshot(snapshot, { previous });
  if (!analysis) throw new Error('Weather analysis unavailable');

  _analysisStore.set(key, analysis);
  trimMap(_analysisStore, ANALYSIS_HISTORY_MAX);
  _analysisCache.set(key, { analysis, cachedAt: clock() });
  trimMap(_analysisCache, ANALYSIS_MAX_CACHE);
  return analysis;
}

/**
 * Build the weather intelligence Vite plugin.
 *
 * The clock and cache window are parameters because cache behavior is the part
 * worth testing — freshness, staleness and how many upstream calls a window
 * costs — and a test that verifies it by sleeping for five minutes verifies
 * nothing anyone will run.
 *
 * @param {object} [options] Options.
 * @param {Function} [options.fetchJson] Upstream JSON reader.
 * @param {() => number} [options.now] Clock.
 * @param {number} [options.cacheMs] Fresh window.
 * @param {number} [options.staleMs] Window in which a failed refresh may serve the last analysis.
 * @returns {object} Vite plugin exposing `/api/weather/intelligence`.
 */
function weatherIntelligenceProxy({
  fetchJson = fetchRegionalJson,
  now: clock = () => Date.now(),
  cacheMs = ANALYSIS_CACHE_MS,
  staleMs = ANALYSIS_STALE_MS,
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/weather/intelligence', async (req, res) => {
      const send = (status, body, headers = {}) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          ...headers,
        });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET') {
        send(405, { error: 'Method Not Allowed' });
        return;
      }
      if (!_analysisRateLimiter(clientKey(req))) {
        send(429, { error: 'Rate limit exceeded' }, { 'Retry-After': '30' });
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const requested = validRegionalPoint(url.searchParams);
      if (!requested) {
        send(400, { error: 'Valid latitude and longitude are required' });
        return;
      }
      // Snap to the cache grid BEFORE calling upstream: two viewers a few
      // hundred metres apart must share one request, not open two.
      const point = normalizePoint(requested.latitude, requested.longitude);
      const key = pointKey(point);
      const now = clock();
      const cached = _analysisCache.get(key);

      if (cached && now - cached.cachedAt <= cacheMs) {
        send(
          200,
          { status: 'cached', analysis: cached.analysis },
          { 'Cache-Control': 'public, max-age=60', 'X-Aegis-Weather': 'HIT' },
        );
        return;
      }

      const request = coalesceProxyRequest(_analysisInFlight, key, () =>
        analyzePoint(point, key, fetchJson, clock),
      );
      try {
        const analysis = await request.promise;
        send(
          200,
          { status: 'ready', analysis },
          {
            'Cache-Control': 'public, max-age=60',
            'X-Aegis-Weather': request.shared ? 'INFLIGHT' : 'MISS',
          },
        );
      } catch {
        // A stale analysis is more useful than an error: risk does not become
        // unknown because one poll failed, and the age is reported so the panel
        // can say how old it is rather than implying it is current.
        if (cached && now - cached.cachedAt <= staleMs) {
          send(
            200,
            {
              status: 'stale',
              analysis: cached.analysis,
              ageMs: now - cached.cachedAt,
            },
            { 'Cache-Control': 'no-store', 'X-Aegis-Weather': 'STALE' },
          );
          return;
        }
        send(
          503,
          { error: 'Weather intelligence is temporarily unavailable' },
          { 'Cache-Control': 'no-store', 'X-Aegis-Weather': 'NONE' },
        );
      }
    });
  }

  return {
    name: 'aegis-weather-intelligence-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

/** Clear cached analyses and retained history. Used by tests and shutdown. */
function resetWeatherIntelligenceCaches() {
  _analysisCache.clear();
  _analysisStore.clear();
  _analysisInFlight.clear();
}

export {
  weatherIntelligenceProxy,
  resetWeatherIntelligenceCaches,
  ANALYSIS_CACHE_MS,
  ANALYSIS_STALE_MS,
};
