import test from 'node:test';
import assert from 'node:assert/strict';
import {
  earthquakeIntelligenceProxy,
  resetEarthquakeIntelligenceCaches,
} from 'aegis/server/providers/quakes';
import { localProviderPlugins } from '../../server/providers/local.js';
import { syntheticForecast } from '../weather/testSupport/syntheticWeather.mjs';

/**
 * USGS serves one static feed per window, so the property that matters most is
 * that a viewport never costs an upstream request: the feed is fetched once per
 * refresh window and every view is scoped from memory.
 */

const NOW_BASE = 1_000_000_000_000;

function quake({
  id = 'us1',
  lat = 35.7,
  lon = 139.7,
  mag = 6.4,
  depth = 18,
  time,
  felt = null,
  tsunami = 0,
  sig = null,
} = {}) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [lon, lat, depth] },
    properties: {
      mag,
      place: 'Test region',
      time: time ?? NOW_BASE - 600_000,
      updated: NOW_BASE,
      url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
      felt,
      tsunami,
      sig: sig ?? Math.round(mag * 100),
      status: 'reviewed',
      net: 'us',
      magType: 'mww',
      type: 'earthquake',
      title: `M ${mag} - Test region`,
    },
  };
}

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  const [route, handler] = [...routes.entries()][0];
  return {
    route,
    async request(query = '', method = 'GET') {
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

/** Build the proxy with an open limiter; the shared one is process-wide. */
function proxy(options = {}) {
  return earthquakeIntelligenceProxy({ rateLimiter: () => true, ...options });
}

function upstream({ features = [quake()], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      if (fail) throw new Error('USGS unreachable');
      if (url.includes('open-meteo'))
        return syntheticForecast({ base: { rain_6h: 0 } });
      return {
        type: 'FeatureCollection',
        metadata: { generated: NOW_BASE, title: 'USGS All Earthquakes, Past Day' },
        features,
      };
    },
  };
}

test('the endpoint answers with finished earthquake intelligence', async (t) => {
  t.after(() => resetEarthquakeIntelligenceCaches());
  resetEarthquakeIntelligenceCaches();
  const source = upstream();
  const app = install(proxy({ fetchJson: source.fetchJson, now: () => NOW_BASE }));
  assert.equal(app.route, '/api/quakes/intelligence');

  const res = await app.request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Aegis-Quakes'], 'MISS');
  const { intelligence } = res.body;
  assert.equal(intelligence.source, 'USGS');
  assert.equal(intelligence.attribution, 'USGS Earthquake Hazards Program');
  assert.equal(intelligence.eventCount, 1);
  assert.equal(intelligence.events[0].id, 'us1');
  assert.equal(intelligence.events[0].alert.level, 'SIGNIFICANT');
  // The documented USGS summary feed, not a scraped page.
  assert.match(
    source.calls[0].url,
    /^https:\/\/earthquake\.usgs\.gov\/earthquakes\/feed\/v1\.0\/summary\/all_day\.geojson$/,
  );
});

test('a viewport scopes the answer without costing an upstream request', async (t) => {
  t.after(() => resetEarthquakeIntelligenceCaches());
  resetEarthquakeIntelligenceCaches();
  const source = upstream({
    features: [
      quake({ id: 'jp', lat: 35.7, lon: 139.7 }),
      quake({ id: 'cl', lat: -33.4, lon: -70.6, mag: 5.2 }),
    ],
  });
  const app = install(proxy({ fetchJson: source.fetchJson, now: () => NOW_BASE }));

  const world = await app.request();
  assert.equal(world.body.intelligence.eventCount, 2);

  const japan = await app.request('west=130&south=30&east=146&north=46');
  assert.equal(japan.body.intelligence.eventCount, 1);
  assert.equal(japan.body.intelligence.events[0].id, 'jp');

  const chile = await app.request('west=-76&south=-40&east=-66&north=-28');
  assert.equal(chile.body.intelligence.eventCount, 1);
  assert.equal(chile.body.intelligence.events[0].id, 'cl');

  // One feed, three viewports, one upstream call.
  const feedCalls = source.calls.filter((call) => call.url.includes('usgs.gov'));
  assert.equal(feedCalls.length, 1);
});

test('the feed refreshes on its own cadence, not per request', async (t) => {
  t.after(() => resetEarthquakeIntelligenceCaches());
  resetEarthquakeIntelligenceCaches();
  const source = upstream();
  let clock = NOW_BASE;
  const app = install(proxy({ fetchJson: source.fetchJson, now: () => clock }));

  await app.request();
  clock += 4 * 60_000;
  assert.equal((await app.request()).headers['X-Aegis-Quakes'], 'HIT');
  const before = source.calls.filter((call) => call.url.includes('usgs.gov')).length;
  assert.equal(before, 1);

  clock += 2 * 60_000;
  assert.equal((await app.request()).headers['X-Aegis-Quakes'], 'MISS');
  assert.equal(
    source.calls.filter((call) => call.url.includes('usgs.gov')).length,
    2,
  );
});

test('concurrent requests share one feed download', async (t) => {
  t.after(() => resetEarthquakeIntelligenceCaches());
  resetEarthquakeIntelligenceCaches();
  const source = upstream();
  const app = install(proxy({ fetchJson: source.fetchJson, now: () => NOW_BASE }));
  const results = await Promise.all([app.request(), app.request(), app.request()]);
  assert.equal(
    source.calls.filter((call) => call.url.includes('usgs.gov')).length,
    1,
  );
  assert.ok(results.every((res) => res.status === 200));
});

test('an outage serves the previous feed, labelled stale', async (t) => {
  t.after(() => resetEarthquakeIntelligenceCaches());
  resetEarthquakeIntelligenceCaches();
  let down = false;
  const source = upstream();
  let clock = NOW_BASE;
  const app = install(
    proxy({
      now: () => clock,
      fetchJson: async (url, options) => {
        if (down && url.includes('usgs.gov')) throw new Error('USGS unreachable');
        return source.fetchJson(url, options);
      },
    }),
  );
  await app.request();
  down = true;
  clock += 10 * 60_000;
  const stale = await app.request();
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Aegis-Quakes'], 'STALE');
  assert.equal(stale.body.status, 'stale');
  assert.equal(stale.body.intelligence.eventCount, 1);
});

test('a cold failure reports unavailable rather than an empty world', async (t) => {
  t.after(() => resetEarthquakeIntelligenceCaches());
  resetEarthquakeIntelligenceCaches();
  const source = upstream({ fail: true });
  const app = install(proxy({ fetchJson: source.fetchJson, now: () => NOW_BASE }));
  const res = await app.request();
  assert.equal(res.status, 503);
  assert.equal(res.headers['X-Aegis-Quakes'], 'NONE');
  assert.match(res.body.message, /temporarily unavailable/);
  // Critically, it does NOT answer "no earthquakes".
  assert.equal(res.body.intelligence, undefined);
});

test('response weather is fetched only for a significant event', async (t) => {
  t.after(() => resetEarthquakeIntelligenceCaches());
  resetEarthquakeIntelligenceCaches();
  const quiet = upstream({ features: [quake({ id: 'small', mag: 2.2, sig: 40 })] });
  const quietApp = install(
    proxy({ fetchJson: quiet.fetchJson, now: () => NOW_BASE }),
  );
  await quietApp.request();
  assert.equal(
    quiet.calls.filter((call) => call.url.includes('open-meteo')).length,
    0,
    'a minor earthquake must not trigger a weather call',
  );

  resetEarthquakeIntelligenceCaches();
  const big = upstream({ features: [quake({ id: 'big', mag: 7.1, sig: 900 })] });
  const bigApp = install(proxy({ fetchJson: big.fetchJson, now: () => NOW_BASE }));
  const res = await bigApp.request();
  assert.equal(
    big.calls.filter((call) => call.url.includes('open-meteo')).length,
    1,
  );
  // Whatever it says, it is response context and never causal.
  if (res.body.responseWeather) {
    assert.equal(res.body.responseWeather.relationship, 'RESPONSE_CONTEXT_ONLY');
    assert.match(res.body.responseWeather.disclaimer, /no causal relationship/i);
  }
});

test('an unknown feed is refused before any upstream call', async (t) => {
  t.after(() => resetEarthquakeIntelligenceCaches());
  resetEarthquakeIntelligenceCaches();
  const source = upstream();
  const app = install(proxy({ fetchJson: source.fetchJson, now: () => NOW_BASE }));
  const res = await app.request('feed=everything_since_1900');
  assert.equal(res.status, 400);
  assert.equal(source.calls.length, 0);
  assert.equal((await app.request('', 'POST')).status, 405);
});

test('a named feed is honoured', async (t) => {
  t.after(() => resetEarthquakeIntelligenceCaches());
  resetEarthquakeIntelligenceCaches();
  const source = upstream();
  const app = install(proxy({ fetchJson: source.fetchJson, now: () => NOW_BASE }));
  await app.request('feed=significant_week');
  assert.match(source.calls[0].url, /significant_week\.geojson$/);
});

test('the provider is registered alongside the other intelligence layers', () => {
  const names = localProviderPlugins().map((plugin) => plugin.name);
  assert.ok(names.includes('aegis-earthquake-intelligence-proxy'));
  assert.ok(names.includes('aegis-fire-intelligence-proxy'));
  assert.ok(names.includes('aegis-weather-intelligence-proxy'));
});
