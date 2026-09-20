import { readFile } from 'node:fs/promises';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { coalesceProxyRequest } from './common/http.js';
import { fetchRegionalJson } from './regional/http.js';
import {
  catalogQueryUrl,
  timeChunks,
  consolidateCatalog,
} from '../../src/layers/earthquakes/catalog.js';
import { normalizeUsgsFeed } from '../../src/layers/earthquakes/usgsEvents.js';
import {
  forecastRegion,
  forecastMateriallyChanged,
} from '../../src/layers/earthquakes/forecast.js';
import {
  buildForecastPrompt,
  templateSummary,
  SYSTEM_PROMPT,
} from '../../src/layers/earthquakes/narrative.js';
import { invokeBedrock, isBedrockConfigured } from './bedrock.js';

/**
 * Aegis seismic forecast endpoint.
 *
 * Runs the inference half of the pipeline:
 *
 *   USGS catalog (cached) → features → model → prior correction → anomaly →
 *   forecast record → narration (gated)
 *
 * Training happens offline in `scripts/train-seismic-model.mjs`; this route only
 * loads the artifact and predicts, which is the split that lets training move to
 * SageMaker without the serving path changing.
 *
 * NARRATION IS GATED. Bedrock is invoked only when the forecast has materially
 * changed for that region, or when an operator asks a question — never on a
 * poll that produced the same numbers. The gate is the reason the panel can
 * refresh continuously without a model invocation behind every refresh.
 */

/** Catalog refresh for a region, in ms. History moves slowly. */
const CATALOG_CACHE_MS = 10 * 60_000;

/** Days of history pulled for features, baseline and anomaly. */
const HISTORY_DAYS = 45;

const _catalogCache = new Map();
const _catalogInFlight = new Map();
const _forecastStore = new Map();
const _narrationCache = new Map();
let _modelPromise = null;

const _forecastRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 30,
  globalMax: 90,
});

/** Load the trained artifact once per process. */
function loadModel(modelPath) {
  _modelPromise ||= readFile(modelPath, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null);
  return _modelPromise;
}

function regionKey(region) {
  return [region.west, region.south, region.east, region.north]
    .map((value) => value.toFixed(1))
    .join(',');
}

/** Fetch the region's recent catalog, cached and coalesced. */
async function loadCatalog(region, fetchJson, now) {
  const key = regionKey(region);
  const cached = _catalogCache.get(key);
  if (cached && now - cached.at <= CATALOG_CACHE_MS) return cached.events;

  const request = coalesceProxyRequest(_catalogInFlight, key, async () => {
    const start = new Date(now - HISTORY_DAYS * 86_400_000);
    const end = new Date(now);
    const events = [];
    // Chunked so a long history stays inside the service's per-response cap.
    for (const chunk of timeChunks(start, end, 30)) {
      const payload = await fetchJson(
        catalogQueryUrl({
          region,
          start: chunk.start,
          end: chunk.end,
          minMagnitude: 2.5,
        }),
        { maxBytes: 12 * 1024 * 1024, redirect: 'error' },
      );
      const snapshot = normalizeUsgsFeed(payload, { feed: 'fdsnws' });
      if (snapshot) events.push(...snapshot.events);
    }
    const consolidated = consolidateCatalog(events);
    _catalogCache.set(key, { at: now, events: consolidated });
    while (_catalogCache.size > 12)
      _catalogCache.delete(_catalogCache.keys().next().value);
    return consolidated;
  });
  return request.promise;
}

/**
 * Build the seismic forecast Vite plugin.
 *
 * @param {object} [options] Options.
 * @returns {object} Vite plugin exposing `/api/quakes/forecast`.
 */
function seismicForecastProxy({
  fetchJson = fetchRegionalJson,
  now: clock = () => Date.now(),
  modelPath = new URL(
    '../../src/layers/earthquakes/seismicModel.json',
    import.meta.url,
  ),
  invoke = invokeBedrock,
  bedrockEnabled = () => isBedrockConfigured(),
  rateLimiter = _forecastRateLimiter,
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/quakes/forecast', async (req, res) => {
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
      const names = ['west', 'south', 'east', 'north'];
      if (!names.every((name) => url.searchParams.has(name))) {
        send(400, { error: 'A west/south/east/north region is required' });
        return;
      }
      const numbers = names.map((name) => Number(url.searchParams.get(name)));
      if (!numbers.every(Number.isFinite)) {
        send(400, { error: 'A valid region is required' });
        return;
      }
      const region = {
        west: numbers[0],
        south: numbers[1],
        east: numbers[2],
        north: numbers[3],
      };
      const question = url.searchParams.get('question');
      const now = clock();

      try {
        const [model, events] = await Promise.all([
          loadModel(modelPath),
          loadCatalog(region, fetchJson, now),
        ]);
        const forecast = forecastRegion({ model, events, region, now });

        // The gate. A poll that produced the same picture reuses the previous
        // narration instead of invoking a language model again.
        const key = regionKey(region);
        const previous = _forecastStore.get(key) || null;
        const change = forecastMateriallyChanged(previous, forecast);
        _forecastStore.set(key, forecast);
        while (_forecastStore.size > 12)
          _forecastStore.delete(_forecastStore.keys().next().value);

        const cachedNarration = _narrationCache.get(key);
        let narration = cachedNarration?.narration ?? null;
        let narrationSource = cachedNarration ? 'cached' : 'none';

        if (question || change.changed || !cachedNarration) {
          if (bedrockEnabled()) {
            const result = await invoke({
              system: SYSTEM_PROMPT,
              user: buildForecastPrompt({ forecast, region, question }),
            });
            narration = Object.freeze({
              text: result.text ?? templateSummary({ forecast }),
              generatedBy:
                result.status === 'READY'
                  ? 'amazon-bedrock'
                  : 'deterministic-template',
              modelId: result.modelId,
              status: result.status,
              detail: result.detail ?? null,
            });
          } else {
            // Not configured: a template summary from the same numbers, plainly
            // labelled. Nothing is fabricated and no AWS call is implied.
            narration = Object.freeze({
              text: templateSummary({ forecast }),
              generatedBy: 'deterministic-template',
              modelId: null,
              status: 'UNCONFIGURED',
              detail:
                'Amazon Bedrock is not configured; this summary is assembled from the model output by template.',
            });
          }
          narrationSource = 'generated';
          _narrationCache.set(key, { at: now, narration });
          while (_narrationCache.size > 12)
            _narrationCache.delete(_narrationCache.keys().next().value);
        }

        send(
          200,
          {
            status: 'ready',
            region,
            forecast,
            narration,
            narrationSource,
            narrationTriggers: change.reasons,
            catalogEvents: events.length,
          },
          {
            'Cache-Control': 'no-store',
            'X-Aegis-Forecast': change.changed ? 'CHANGED' : 'STABLE',
          },
        );
      } catch (error) {
        send(
          503,
          {
            error: 'unavailable',
            message: 'Seismic forecast temporarily unavailable.',
            detail: String(error?.message || '').slice(0, 200),
          },
          { 'Cache-Control': 'no-store', 'X-Aegis-Forecast': 'NONE' },
        );
      }
    });
  }

  return {
    name: 'aegis-seismic-forecast-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

/** Clear caches. Used by tests and shutdown. */
function resetSeismicForecastCaches() {
  _catalogCache.clear();
  _catalogInFlight.clear();
  _forecastStore.clear();
  _narrationCache.clear();
  _modelPromise = null;
}

export { seismicForecastProxy, resetSeismicForecastCaches, HISTORY_DAYS };
