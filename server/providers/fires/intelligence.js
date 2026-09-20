import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { coalesceProxyRequest } from '../common/http.js';
import { fetchRegionalText, fetchRegionalJson } from '../regional/http.js';
import {
  areaRequestUrl,
  areaKey,
  snapBoundingBox,
  clampBoundingBox,
  redactMapKey,
  DEFAULT_SOURCES,
  DEFAULT_DAY_RANGE,
  DETECTION_MAX_AGE_MS,
} from '../../../src/sources/firmsArea.js';
import { parseDetections } from '../../../src/fires/detections.js';
import { assembleFireIntelligence } from '../../../src/fires/intelligence.js';
import { significantClusters } from '../../../src/fires/intelligence.js';
import { forecastRequestUrl } from '../../../src/sources/openMeteo.js';
import { normalizeForecast } from '../../../src/weather/normalize.js';
import { deriveMetrics } from '../../../src/weather/derived.js';

/**
 * Aegis fire intelligence endpoint.
 *
 * Correlates NASA FIRMS detections with Open-Meteo weather and returns finished
 * intelligence: clusters, activity trend, fire-spread conditions and events.
 * Like the weather route, it is shaped as the Lambda it will become — it owns
 * the upstream calls, the caches and the retained previous observation.
 *
 * THE MAP_KEY NEVER LEAVES THIS PROCESS. It is read from server-side
 * configuration, used to build the upstream URL, and redacted from anything
 * that could be returned or logged. No response carries it, and no browser
 * bundle can see it: the variable has no VITE_ prefix, so Vite never inlines it.
 *
 * API budget. FIRMS allows 5,000 transactions per 10 minutes and refreshes
 * roughly every 15 minutes, so: bounding boxes snap to a shared 5° grid, each
 * cell is cached for 15 minutes, concurrent requests for a cell are coalesced
 * into one, a failed refresh serves the last observation labelled stale, and
 * only one VIIRS source is queried by default. A viewport pan costs nothing
 * until it crosses into a cell that has not been fetched recently.
 */

/** FIRMS publishes roughly every 15 minutes; matching that is the fresh window. */
const FIRE_CACHE_MS = 15 * 60_000;

/** How long a cached observation may still be served after a failure. */
const FIRE_STALE_MS = 60 * 60_000;

/** Cached cells and retained previous observations. */
const FIRE_MAX_CACHE = 64;

/** Weather enrichment reuses this cache; clusters move slowly. */
const WEATHER_CACHE_MS = 10 * 60_000;

const _fireCache = new Map();
const _fireStore = new Map();
const _fireInFlight = new Map();
const _weatherCache = new Map();

const _fireRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 20,
  globalMax: 60,
});

const FIRMS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const WEATHER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Read the key from server-side configuration only. */
function mapKey() {
  return String(
    process.env.NASA_FIRMS_MAP_KEY || process.env.FIRMS_MAP_KEY || '',
  ).trim();
}

function trimMap(map, limit) {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Fetch detections for one snapped cell from every requested source.
 *
 * Sources are fetched in parallel because they are independent satellites and a
 * slow one should not hold up the rest; a source that fails is skipped rather
 * than failing the whole observation, so partial coverage still produces
 * intelligence.
 */
async function fetchDetections({
  bbox,
  sources,
  dayRange,
  fetchText,
  key,
  now,
}) {
  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const csv = await fetchText(
        areaRequestUrl({ mapKey: key, source, bbox, dayRange }),
        { maxBytes: FIRMS_MAX_RESPONSE_BYTES, redirect: 'error' },
      );
      // The request covers two UTC days; the window Aegis reports is the
      // trailing 24 hours from now.
      return parseDetections(csv, {
        source,
        now,
        maxAgeMs: DETECTION_MAX_AGE_MS,
      });
    }),
  );
  const detections = [];
  const okSources = [];
  const failed = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      detections.push(...result.value);
      okSources.push(sources[index]);
    } else failed.push(sources[index]);
  });
  if (!okSources.length)
    throw new Error(
      redactMapKey(results[0]?.reason?.message || 'FIRMS unavailable', key),
    );
  return { detections, okSources, failed };
}

/**
 * Derived weather metrics for a cluster centre, cached per rounded location.
 *
 * Returns null rather than throwing: fire detections are still worth reporting
 * when the weather service is unreachable, and the cluster simply carries no
 * spread conditions.
 */
async function weatherMetricsFor(center, fetchJson, now) {
  const key = `${center.latitude.toFixed(2)},${center.longitude.toFixed(2)}`;
  const cached = _weatherCache.get(key);
  if (cached && now - cached.at <= WEATHER_CACHE_MS) return cached.metrics;
  try {
    const payload = await fetchJson(
      forecastRequestUrl({
        latitude: center.latitude,
        longitude: center.longitude,
      }),
      { maxBytes: WEATHER_MAX_RESPONSE_BYTES, redirect: 'error' },
    );
    const snapshot = normalizeForecast(payload, {
      latitude: center.latitude,
      longitude: center.longitude,
    });
    if (!snapshot) return null;
    const metrics = deriveMetrics(snapshot, snapshot.currentIndex);
    _weatherCache.set(key, { at: now, metrics });
    trimMap(_weatherCache, FIRE_MAX_CACHE);
    return metrics;
  } catch {
    return null;
  }
}

/** Observe one cell: fetch, cluster, correlate with weather, compare, store. */
async function observeCell({
  cellKey,
  bbox,
  sources,
  dayRange,
  fetchText,
  fetchJson,
  clock,
}) {
  const key = mapKey();
  const now = clock();
  const { detections, okSources, failed } = await fetchDetections({
    bbox,
    sources,
    dayRange,
    fetchText,
    key,
    now,
  });

  // Weather is fetched only for the clusters that will carry it, and only after
  // clustering has decided which those are.
  const preview = assembleFireIntelligence({
    detections,
    sources: okSources,
    now,
  });
  const targets = significantClusters(preview.clusters);
  const metricsById = new Map();
  await Promise.all(
    targets.map(async (cluster) => {
      metricsById.set(
        cluster.id,
        await weatherMetricsFor(cluster.center, fetchJson, now),
      );
    }),
  );

  const previous = _fireStore.get(cellKey) || null;
  const intelligence = assembleFireIntelligence({
    detections,
    weatherFor: (cluster) => metricsById.get(cluster.id) ?? null,
    previous,
    area: {
      ...bbox,
      center: {
        latitude: (bbox.north + bbox.south) / 2,
        longitude: (bbox.east + bbox.west) / 2,
      },
    },
    sources: okSources,
    now,
  });

  _fireStore.set(cellKey, {
    observedMs: now,
    detections,
    clusters: intelligence.clusters,
    activity: intelligence.activity,
  });
  trimMap(_fireStore, FIRE_MAX_CACHE);
  _fireCache.set(cellKey, {
    at: now,
    intelligence,
    detections,
    partialSources: failed,
  });
  trimMap(_fireCache, FIRE_MAX_CACHE);
  return { intelligence, detections, partialSources: failed };
}

/**
 * Build the fire intelligence Vite plugin.
 *
 * @param {object} [options] Options.
 * @param {Function} [options.fetchText] Upstream CSV reader.
 * @param {Function} [options.fetchJson] Upstream JSON reader for weather.
 * @param {() => number} [options.now] Clock.
 * @param {number} [options.cacheMs] Fresh window.
 * @param {number} [options.staleMs] Stale-serving window.
 * @param {(key: string) => boolean} [options.rateLimiter] Per-client admission test.
 *   The default is shared by every instance in the process, which is what a
 *   real deployment wants and what a test suite must be able to replace.
 * @returns {object} Vite plugin exposing `/api/fires/intelligence`.
 */
function fireIntelligenceProxy({
  fetchText = fetchRegionalText,
  fetchJson = fetchRegionalJson,
  now: clock = () => Date.now(),
  cacheMs = FIRE_CACHE_MS,
  staleMs = FIRE_STALE_MS,
  rateLimiter = _fireRateLimiter,
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/fires/intelligence', async (req, res) => {
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
      if (!mapKey()) {
        // Honest and specific: the feature is unconfigured, not broken, and the
        // rest of Aegis keeps running.
        send(
          503,
          {
            error: 'no_key',
            message:
              'Satellite fire data unavailable: set NASA_FIRMS_MAP_KEY to enable NASA FIRMS.',
          },
          { 'X-Aegis-Fires': 'NOKEY' },
        );
        return;
      }

      const url = new URL(req.url || '', 'http://localhost');
      const numbers = ['west', 'south', 'east', 'north'].map((name) =>
        Number(url.searchParams.get(name)),
      );
      const requested = snapBoundingBox({
        west: numbers[0],
        south: numbers[1],
        east: numbers[2],
        north: numbers[3],
      });
      if (!requested) {
        send(400, {
          error: 'A valid west/south/east/north bounding box is required',
        });
        return;
      }
      const { bbox, clamped } = clampBoundingBox(requested);
      const dayRange = Math.min(
        7,
        Math.max(1, Number(url.searchParams.get('days')) || DEFAULT_DAY_RANGE),
      );
      const sources = DEFAULT_SOURCES;
      const cellKey = areaKey(bbox, sources.join('+'), dayRange);
      const now = clock();
      const cached = _fireCache.get(cellKey);

      // The response describes the CELL that was observed, not the exact
      // viewport. Trimming detections to the screen edge would leave the panel
      // ("11 detections, 1 cluster") disagreeing with the map (1 dot), and
      // would re-trim on every pan within one cached answer. The cell is stated
      // in `intelligence.area` so the client can say what area it is reporting.
      const answer = (payload, headers) =>
        send(200, { ...payload, area: bbox, areaClamped: clamped }, headers);

      if (cached && now - cached.at <= cacheMs) {
        answer(
          {
            status: 'cached',
            intelligence: cached.intelligence,
            detections: cached.detections,
            partialSources: cached.partialSources,
          },
          { 'Cache-Control': 'public, max-age=120', 'X-Aegis-Fires': 'HIT' },
        );
        return;
      }

      const request = coalesceProxyRequest(_fireInFlight, cellKey, () =>
        observeCell({
          cellKey,
          bbox,
          sources,
          dayRange,
          fetchText,
          fetchJson,
          clock,
        }),
      );
      try {
        const result = await request.promise;
        answer(
          {
            status: 'ready',
            intelligence: result.intelligence,
            detections: result.detections,
            partialSources: result.partialSources,
          },
          {
            'Cache-Control': 'public, max-age=120',
            'X-Aegis-Fires': request.shared ? 'INFLIGHT' : 'MISS',
          },
        );
      } catch (error) {
        if (cached && now - cached.at <= staleMs) {
          answer(
            {
              status: 'stale',
              intelligence: cached.intelligence,
              detections: cached.detections,
              ageMs: now - cached.at,
            },
            { 'Cache-Control': 'no-store', 'X-Aegis-Fires': 'STALE' },
          );
          return;
        }
        send(
          503,
          {
            error: 'unavailable',
            message: 'Satellite fire data temporarily unavailable.',
            // Redacted twice over: the key is stripped here as well as at the
            // throw site, because an error message is the easiest way to leak one.
            detail: redactMapKey(error?.message || '', mapKey()).slice(0, 200),
          },
          { 'Cache-Control': 'no-store', 'X-Aegis-Fires': 'NONE' },
        );
      }
    });
  }

  return {
    name: 'aegis-fire-intelligence-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

/** Clear cached observations and retained history. Used by tests and shutdown. */
function resetFireIntelligenceCaches() {
  _fireCache.clear();
  _fireStore.clear();
  _fireInFlight.clear();
  _weatherCache.clear();
}

export {
  fireIntelligenceProxy,
  resetFireIntelligenceCaches,
  FIRE_CACHE_MS,
  FIRE_STALE_MS,
};
