import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fireIntelligenceProxy,
  resetFireIntelligenceCaches,
} from 'aegis/server/providers/fires';
import { localProviderPlugins } from '../../server/providers/local.js';
import { syntheticForecast } from '../weather/testSupport/syntheticWeather.mjs';

/**
 * The route owns the FIRMS key, the transaction budget and the failure story,
 * so these tests hold it to all three: the key never appears in a response or
 * an error, one cell costs one upstream call per window, and an outage degrades
 * to a labelled stale answer rather than a blank map or an invented one.
 */

const KEY = 'test-map-key-abcdef';
const HEADER =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';

function csvFor(count, { lat = -30.6, lon = 148.04 } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(11, 16).replace(':', '');
  const rows = Array.from(
    { length: count },
    (_, index) =>
      `${lat + index * 0.004},${lon + index * 0.004},330.1,0.4,0.4,${today},${time},N20,VIIRS,n,2.0NRT,295.2,25.5,D`,
  );
  return [HEADER, ...rows].join('\n');
}

/** Build the proxy with an open rate limiter: the shared one is process-wide,
 * and a suite that makes dozens of requests would trip it on its own behalf. */
function proxy(options = {}) {
  return fireIntelligenceProxy({ rateLimiter: () => true, ...options });
}

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  const [route, handler] = [...routes.entries()][0];
  return {
    route,
    async request(query = 'west=144&south=-37&east=152&north=-30', method = 'GET') {
      const res = {
        writeHead(status, headers) {
          Object.assign(this, { status, headers });
        },
        end(body) {
          this.body = body ? JSON.parse(body) : null;
        },
      };
      await handler({ url: `/?${query}`, method }, res);
      return res;
    },
  };
}

function environment(t, { key = KEY } = {}) {
  const previous = {
    nasa: process.env.NASA_FIRMS_MAP_KEY,
    legacy: process.env.FIRMS_MAP_KEY,
  };
  if (key) process.env.NASA_FIRMS_MAP_KEY = key;
  else {
    delete process.env.NASA_FIRMS_MAP_KEY;
    delete process.env.FIRMS_MAP_KEY;
  }
  resetFireIntelligenceCaches();
  t.after(() => {
    resetFireIntelligenceCaches();
    if (previous.nasa === undefined) delete process.env.NASA_FIRMS_MAP_KEY;
    else process.env.NASA_FIRMS_MAP_KEY = previous.nasa;
    if (previous.legacy === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = previous.legacy;
  });
}

/** Upstream doubles: FIRMS CSV and Open-Meteo JSON. */
function upstream({ detections = 8, failFirms = false, failWeather = false } = {}) {
  const firmsCalls = [];
  const weatherCalls = [];
  return {
    firmsCalls,
    weatherCalls,
    fetchText: async (url, options) => {
      firmsCalls.push({ url, options });
      if (failFirms) throw new Error(`upstream 500 for ${url}`);
      return csvFor(detections);
    },
    fetchJson: async (url) => {
      weatherCalls.push({ url });
      if (failWeather) throw new Error('weather down');
      return syntheticForecast({
        base: { temperature_2m: 36, relative_humidity_2m: 14, wind_speed_10m: 35 },
      });
    },
  };
}

test('the endpoint returns finished fire intelligence for a viewport', async (t) => {
  environment(t);
  const source = upstream();
  const app = install(
    proxy({
      fetchText: source.fetchText,
      fetchJson: source.fetchJson,
    }),
  );
  assert.equal(app.route, '/api/fires/intelligence');

  const res = await app.request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Aegis-Fires'], 'MISS');
  assert.equal(res.body.status, 'ready');
  const { intelligence } = res.body;
  assert.equal(intelligence.provider, 'NASA FIRMS');
  assert.equal(intelligence.detectionCount, 8);
  assert.equal(intelligence.clusterCount, 1);
  assert.equal(res.body.detections.length, 8);
  // Weather correlation happened for the cluster.
  const [cluster] = intelligence.clusters;
  assert.ok(cluster.spreadConditions.score > 0);
  assert.ok(cluster.spreadVector.spreadTowardCardinal);
  assert.equal(source.weatherCalls.length, 1, 'one weather call per cluster');
});

test('the MAP_KEY never appears in a response, and only in the upstream URL', async (t) => {
  environment(t);
  const source = upstream();
  const app = install(
    proxy({
      fetchText: source.fetchText,
      fetchJson: source.fetchJson,
    }),
  );
  const res = await app.request();
  assert.ok(source.firmsCalls[0].url.includes(KEY), 'upstream is authenticated');
  assert.ok(
    !JSON.stringify(res.body).includes(KEY),
    'the key must never reach the client',
  );
  assert.ok(!JSON.stringify(res.headers).includes(KEY));
});

test('an upstream error is redacted before it is returned', async (t) => {
  environment(t);
  const source = upstream({ failFirms: true });
  const app = install(
    proxy({
      fetchText: source.fetchText,
      fetchJson: source.fetchJson,
    }),
  );
  const res = await app.request();
  assert.equal(res.status, 503);
  const body = JSON.stringify(res.body);
  // The upstream message contained the URL, and therefore the key.
  assert.ok(!body.includes(KEY), `key leaked in: ${body}`);
  assert.match(res.body.message, /temporarily unavailable/);
});

test('without a key the feature is unconfigured, not broken', async (t) => {
  environment(t, { key: null });
  const source = upstream();
  const app = install(
    proxy({
      fetchText: source.fetchText,
      fetchJson: source.fetchJson,
    }),
  );
  const res = await app.request();
  assert.equal(res.status, 503);
  assert.equal(res.headers['X-Aegis-Fires'], 'NOKEY');
  assert.equal(res.body.error, 'no_key');
  assert.match(res.body.message, /NASA_FIRMS_MAP_KEY/);
  assert.equal(source.firmsCalls.length, 0, 'upstream is never touched without a key');
});

test('the legacy FIRMS_MAP_KEY still works', async (t) => {
  environment(t, { key: null });
  process.env.FIRMS_MAP_KEY = 'legacy-key';
  const source = upstream();
  const app = install(
    proxy({
      fetchText: source.fetchText,
      fetchJson: source.fetchJson,
    }),
  );
  const res = await app.request();
  assert.equal(res.status, 200);
  assert.ok(source.firmsCalls[0].url.includes('legacy-key'));
});

test('nearby viewports share one upstream call through the grid', async (t) => {
  environment(t);
  const source = upstream();
  const app = install(
    proxy({
      fetchText: source.fetchText,
      fetchJson: source.fetchJson,
    }),
  );
  const first = await app.request('west=146.2&south=-34.8&east=149.1&north=-32.2');
  const second = await app.request('west=146.9&south=-34.1&east=149.8&north=-31.4');
  assert.equal(first.headers['X-Aegis-Fires'], 'MISS');
  assert.equal(second.headers['X-Aegis-Fires'], 'HIT');
  assert.equal(source.firmsCalls.length, 1, 'a pan inside one cell costs nothing');

  await app.request('west=-124&south=36&east=-118&north=42');
  assert.equal(source.firmsCalls.length, 2, 'a different region is a new question');
});

test('concurrent requests for one cell are coalesced', async (t) => {
  environment(t);
  const source = upstream();
  const app = install(
    proxy({
      fetchText: source.fetchText,
      fetchJson: source.fetchJson,
    }),
  );
  const results = await Promise.all([app.request(), app.request(), app.request()]);
  assert.equal(source.firmsCalls.length, 1);
  assert.ok(
    results.some((res) => res.headers['X-Aegis-Fires'] === 'INFLIGHT'),
    'joined requests report that they shared one call',
  );
});

test('a cell refreshes on the FIRMS publication cadence, not per request', async (t) => {
  environment(t);
  const source = upstream();
  let clock = 1_000_000;
  const app = install(
    proxy({
      fetchText: source.fetchText,
      fetchJson: source.fetchJson,
      now: () => clock,
    }),
  );
  await app.request();
  clock += 14 * 60_000;
  await app.request();
  assert.equal(source.firmsCalls.length, 1, 'inside the window, nothing is refetched');

  clock += 2 * 60_000;
  await app.request();
  assert.equal(source.firmsCalls.length, 2, 'past 15 minutes it refreshes once');
});

test('an outage serves the previous observation, labelled stale', async (t) => {
  environment(t);
  let down = false;
  const source = upstream();
  let clock = 1_000_000;
  const app = install(
    proxy({
      fetchText: async (...args) => {
        if (down) throw new Error('FIRMS unreachable');
        return source.fetchText(...args);
      },
      fetchJson: source.fetchJson,
      now: () => clock,
    }),
  );
  const fresh = await app.request();
  assert.equal(fresh.body.status, 'ready');

  down = true;
  clock += 20 * 60_000;
  const stale = await app.request();
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Aegis-Fires'], 'STALE');
  assert.equal(stale.body.status, 'stale');
  assert.equal(stale.body.ageMs, 20 * 60_000);
  assert.equal(
    stale.body.intelligence.observedAt,
    fresh.body.intelligence.observedAt,
    'the stale answer is the previous observation, not a new one',
  );
});

test('fire detections still report when weather correlation fails', async (t) => {
  environment(t);
  const source = upstream({ failWeather: true });
  const app = install(
    proxy({
      fetchText: source.fetchText,
      fetchJson: source.fetchJson,
    }),
  );
  const res = await app.request();
  assert.equal(res.status, 200);
  assert.equal(res.body.intelligence.detectionCount, 8);
  const [cluster] = res.body.intelligence.clusters;
  assert.equal(cluster.spreadConditions, null);
  assert.equal(cluster.weatherStatus, 'UNAVAILABLE');
});

test('an area with no detections says so about the data', async (t) => {
  environment(t);
  const source = upstream({ detections: 0 });
  const app = install(
    proxy({
      fetchText: source.fetchText,
      fetchJson: source.fetchJson,
    }),
  );
  const res = await app.request();
  assert.equal(res.status, 200);
  assert.equal(res.body.intelligence.detectionCount, 0);
  assert.match(
    res.body.intelligence.summary,
    /No active satellite fire detections in the selected area and time window/,
  );
  assert.equal(source.weatherCalls.length, 0, 'no clusters, no weather calls');
});

test('the second observation of a cell carries a real trend', async (t) => {
  environment(t);
  let count = 8;
  let clock = 1_000_000;
  const source = {
    fetchText: async () => csvFor(count),
    fetchJson: upstream().fetchJson,
  };
  const app = install(
    proxy({
      fetchText: source.fetchText,
      fetchJson: source.fetchJson,
      now: () => clock,
    }),
  );
  const first = await app.request();
  assert.equal(first.body.intelligence.activity.status, 'INSUFFICIENT_DATA');

  count = 16;
  clock += 16 * 60_000;
  const second = await app.request();
  assert.equal(second.body.intelligence.activity.status, 'INCREASING');
  assert.equal(second.body.intelligence.activity.previousDetectionCount, 8);
  assert.ok(
    second.body.intelligence.events.some(
      (event) => event.type === 'FIRE_ACTIVITY_INCREASED',
    ),
  );
});

test('bad input and wrong methods are refused before upstream', async (t) => {
  environment(t);
  const source = upstream();
  const app = install(
    proxy({
      fetchText: source.fetchText,
      fetchJson: source.fetchJson,
    }),
  );
  assert.equal((await app.request('west=10&south=10&east=5&north=20')).status, 400);
  assert.equal((await app.request('')).status, 400);
  assert.equal((await app.request('west=1&south=1&east=2&north=2', 'POST')).status, 405);
  assert.equal(source.firmsCalls.length, 0);
});

test('the provider is registered with the local server', () => {
  const names = localProviderPlugins().map((plugin) => plugin.name);
  assert.ok(names.includes('aegis-fire-intelligence-proxy'));
  // The pre-existing world-wide FIRMS layer and the weather route stay.
  assert.ok(names.includes('aegis-weather-intelligence-proxy'));
  assert.ok(names.some((name) => String(name).includes('firms')));
});
