import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { coalesceProxyRequest } from './common/http.js';
import { fetchRegionalJson } from './regional/http.js';
import {
  normalizeUsgsFeed,
  feedUrl,
  withinBoundingBox,
  withinRadius,
} from '../../src/layers/earthquakes/usgsEvents.js';
import {
  assembleEarthquakeIntelligence,
  responseWeatherContext,
} from '../../src/layers/earthquakes/intelligence.js';
import {
  USGS_FEEDS,
  DEFAULT_FEED,
} from '../../src/layers/earthquakes/thresholds.js';
import { forecastRequestUrl } from '../../src/sources/openMeteo.js';
import { normalizeForecast } from '../../src/weather/normalize.js';
import { deriveMetrics } from '../../src/weather/derived.js';

/**
 * Aegis earthquake intelligence endpoint.
 *
 * USGS publishes one static GeoJSON summary per feed, regenerated about every
 * minute and served from a CDN. That shape dictates the design: ONE request per
 * feed serves every viewport, so this route caches the whole feed and answers
 * viewport questions from memory. Panning never costs an upstream request, and
 * the same feed is never downloaded twice inside the refresh window.
 *
 * No API key exists for these feeds, so there is no credential to protect here.
 * The route still lives server-side so the cache is shared across clients and
 * so the Lambda it becomes has the same shape.
 *
 * Weather is fetched only for a SIGNIFICANT event, and only as post-event
 * response context. It is never used to explain or predict an earthquake.
 */

/** Refresh window. USGS regenerates roughly every minute; five is polite and ample. */
const FEED_CACHE_MS = 5 * 60_000;

/** How long a cached feed may still be served after an upstream failure. */
const FEED_STALE_MS = 60 * 60_000;

/** Weather enrichment reuse window for a significant event's epicentre. */
const WEATHER_CACHE_MS = 10 * 60_000;

const _feedCache = new Map();
const _areaStore = new Map();
const _feedInFlight = new Map();
const _weatherCache = new Map();

const _quakeRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 40,
  globalMax: 120,
});

const USGS_MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const WEATHER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function trimMap(map, limit) {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Fetch and normalize one USGS feed. */
async function loadFeed(feed, fetchJson, clock) {
  const payload = await fetchJson(feedUrl(feed), {
    maxBytes: USGS_MAX_RESPONSE_BYTES,
    // A fixed, documented feed URL has no reason to redirect.
    redirect: 'error',
  });
  const snapshot = normalizeUsgsFeed(payload, { feed });
  if (!snapshot) throw new Error('Malformed USGS feed');
  _feedCache.set(feed, { at: clock(), snapshot });
  trimMap(_feedCache, 8);
  return snapshot;
}

/** Derived weather metrics for an epicentre, cached per rounded location. */
async function responseWeatherFor(event, fetchJson, now) {
  const key = `${event.latitude.toFixed(2)},${event.longitude.toFixed(2)}`;
  const cached = _weatherCache.get(key);
  if (cached && now - cached.at <= WEATHER_CACHE_MS) return cached.metrics;
  try {
    const payload = await fetchJson(
      forecastRequestUrl({
        latitude: event.latitude,
        longitude: event.longitude,
      }),
      { maxBytes: WEATHER_MAX_RESPONSE_BYTES, redirect: 'error' },
    );
    const snapshot = normalizeForecast(payload, {
      latitude: event.latitude,
      longitude: event.longitude,
    });
    if (!snapshot) return null;
    const metrics = deriveMetrics(snapshot, snapshot.currentIndex);
    _weatherCache.set(key, { at: now, metrics });
    trimMap(_weatherCache, 32);
    return metrics;
  } catch {
    // Earthquake facts stand on their own; response weather is additive.
    return null;
  }
}

/**
 * Build the earthquake intelligence Vite plugin.
 *
 * @param {object} [options] Options.
 * @param {Function} [options.fetchJson] Upstream JSON reader.
 * @param {() => number} [options.now] Clock.
 * @param {number} [options.cacheMs] Refresh window.
 * @param {number} [options.staleMs] Stale-serving window.
 * @param {(key: string) => boolean} [options.rateLimiter] Per-client admission test.
 * @returns {object} Vite plugin exposing `/api/quakes/intelligence`.
 */
function earthquakeIntelligenceProxy({
  fetchJson = fetchRegionalJson,
  now: clock = () => Date.now(),
  cacheMs = FEED_CACHE_MS,
  staleMs = FEED_STALE_MS,
  rateLimiter = _quakeRateLimiter,
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/quakes/intelligence', async (req, res) => {
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
      if (!rateLimiter(clientKey(req))) {
        send(429, { error: 'Rate limit exceeded' }, { 'Retry-After': '30' });
        return;
      }

      const url = new URL(req.url || '', 'http://localhost');
      const requestedFeed = url.searchParams.get('feed') || DEFAULT_FEED;
      if (!USGS_FEEDS[requestedFeed]) {
        send(400, { error: `Unknown USGS feed: ${requestedFeed}` });
        return;
      }
      // A MISSING box means "the whole feed". Parsing an absent parameter with
      // Number() would turn it into 0, producing a zero-size box at null island
      // that silently filters every event out — so presence is checked first.
      const names = ['west', 'south', 'east', 'north'];
      const provided = names.every((name) => url.searchParams.has(name));
      const numbers = names.map((name) => Number(url.searchParams.get(name)));
      const bbox =
        provided && numbers.every(Number.isFinite)
          ? {
              west: numbers[0],
              south: numbers[1],
              east: numbers[2],
              north: numbers[3],
            }
          : null;
      if (provided && !bbox) {
        send(400, {
          error: 'A valid west/south/east/north bounding box is required',
        });
        return;
      }

      // A RADIUS query asks a different question from a bounding box: not
      // "what is on screen" but "what is near this point". Local Intelligence
      // needs the second one, because scoring viewport events against a user's
      // location is how a fire on another continent ends up listed as their
      // nearest incident. Both read the same cached feed, so asking about a
      // location costs no extra upstream request.
      const radiusNames = ['latitude', 'longitude', 'maxradiuskm'];
      const hasRadius = radiusNames.every((name) => url.searchParams.has(name));
      const radiusNumbers = radiusNames.map((name) =>
        Number(url.searchParams.get(name)),
      );
      const around =
        hasRadius && radiusNumbers.every(Number.isFinite)
          ? {
              latitude: radiusNumbers[0],
              longitude: radiusNumbers[1],
              radiusKm: Math.min(Math.max(radiusNumbers[2], 1), 20_000),
            }
          : null;
      if (hasRadius && !around) {
        send(400, {
          error: 'A valid latitude/longitude/maxradiuskm query is required',
        });
        return;
      }

      const now = clock();
      const cached = _feedCache.get(requestedFeed);
      const fresh = cached && now - cached.at <= cacheMs;

      /** Answer from a snapshot, scoping it to the requested viewport. */
      const answer = async (snapshot, status, headers) => {
        // A radius query wins when both are present: it is the more specific
        // question, and the caller asked it deliberately.
        const events = around
          ? withinRadius(snapshot.events, around, around.radiusKm)
          : withinBoundingBox(snapshot.events, bbox);
        const previous = _areaStore.get(requestedFeed) || null;
        const intelligence = assembleEarthquakeIntelligence({
          snapshot,
          events,
          previous,
          area: bbox,
          now,
        });
        // Response weather for the single most significant event only: it is
        // context for one incident, not a second weather product.
        const focus = intelligence.events.find(
          (event) => event.alert.level === 'SIGNIFICANT',
        );
        const weather = focus
          ? responseWeatherContext({
              event: focus,
              metrics: await responseWeatherFor(focus, fetchJson, now),
            })
          : null;

        _areaStore.set(requestedFeed, {
          observedMs: now,
          clusters: intelligence.clusters,
          activity: intelligence.activity,
          eventIds: intelligence.events.map((event) => event.id),
        });
        trimMap(_areaStore, 8);
        send(200, { status, intelligence, responseWeather: weather }, headers);
      };

      if (fresh) {
        await answer(cached.snapshot, 'cached', {
          'Cache-Control': 'public, max-age=60',
          'X-Aegis-Quakes': 'HIT',
        });
        return;
      }

      const request = coalesceProxyRequest(_feedInFlight, requestedFeed, () =>
        loadFeed(requestedFeed, fetchJson, clock),
      );
      try {
        const snapshot = await request.promise;
        await answer(snapshot, 'ready', {
          'Cache-Control': 'public, max-age=60',
          'X-Aegis-Quakes': request.shared ? 'INFLIGHT' : 'MISS',
        });
      } catch {
        if (cached && now - cached.at <= staleMs) {
          await answer(cached.snapshot, 'stale', {
            'Cache-Control': 'no-store',
            'X-Aegis-Quakes': 'STALE',
          });
          return;
        }
        send(
          503,
          {
            error: 'unavailable',
            message: 'USGS earthquake data temporarily unavailable.',
          },
          { 'Cache-Control': 'no-store', 'X-Aegis-Quakes': 'NONE' },
        );
      }
    });
  }

  return {
    name: 'aegis-earthquake-intelligence-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

/** Clear cached feeds and retained observations. Used by tests and shutdown. */
function resetEarthquakeIntelligenceCaches() {
  _feedCache.clear();
  _areaStore.clear();
  _feedInFlight.clear();
  _weatherCache.clear();
}

export {
  earthquakeIntelligenceProxy,
  resetEarthquakeIntelligenceCaches,
  FEED_CACHE_MS,
  FEED_STALE_MS,
};
