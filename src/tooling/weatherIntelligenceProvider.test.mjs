import test from 'node:test';
import assert from 'node:assert/strict';
import {
  weatherIntelligenceProxy,
  resetWeatherIntelligenceCaches,
} from 'aegis/server/providers/weather';
import { localProviderPlugins } from '../../server/providers/local.js';
import { syntheticForecast } from '../weather/testSupport/syntheticWeather.mjs';
import { forecastRequestUrl, HOURLY_VARIABLES } from '../sources/openMeteo.js';

/**
 * The intelligence endpoint stands in for the Lambda half of the target AWS
 * pipeline, so these tests hold it to the promises that matter operationally:
 * one upstream call per cell per window, no duplicate calls under concurrency,
 * an answer that survives an upstream outage, and trends measured against what
 * the service last reported.
 */

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  const [route, handler] = [...routes.entries()][0];
  return {
    route,
    async request(query = 'latitude=27.72&longitude=85.32', method = 'GET') {
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

function upstream(t, { payload = syntheticForecast(), fail = false } = {}) {
  const calls = [];
  t.after(() => resetWeatherIntelligenceCaches());
  resetWeatherIntelligenceCaches();
  return {
    calls,
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      if (fail) throw new Error('upstream down');
      return typeof payload === 'function' ? payload(calls.length) : payload;
    },
  };
}

test('the endpoint answers with a finished analysis, not raw weather', async (t) => {
  const source = upstream(t);
  const app = install(weatherIntelligenceProxy({ fetchJson: source.fetchJson }));
  assert.equal(app.route, '/api/weather/intelligence');

  const res = await app.request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Aegis-Weather'], 'MISS');
  assert.equal(res.body.status, 'ready');
  const { analysis } = res.body;
  assert.equal(analysis.schemaVersion, '1.0.0');
  assert.ok(analysis.risks.flood && analysis.risks.fireConditions);
  assert.ok(Array.isArray(analysis.forecast.horizons));
  // The browser must not be handed 40 hourly arrays to reduce itself.
  assert.equal(analysis.series, undefined);
  assert.equal(analysis.hourly, undefined);
});

test('one batched upstream request carries every variable the engine needs', async (t) => {
  const source = upstream(t);
  const app = install(weatherIntelligenceProxy({ fetchJson: source.fetchJson }));
  await app.request();

  assert.equal(source.calls.length, 1, 'one request, not one per variable');
  const url = new URL(source.calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
  const hourly = url.searchParams.get('hourly').split(',');
  assert.deepEqual(hourly, [...HOURLY_VARIABLES]);
  assert.ok(url.searchParams.get('current').includes('temperature_2m'));
  assert.equal(url.searchParams.get('timezone'), 'UTC');
  assert.equal(url.searchParams.get('past_hours'), '24');
  // Units are pinned because every threshold is written in them.
  assert.equal(url.searchParams.get('wind_speed_unit'), 'kmh');
  assert.equal(url.searchParams.get('precipitation_unit'), 'mm');
  assert.equal(source.calls[0].options.redirect, 'error');
});

test('nearby requests share one upstream call through the cache grid', async (t) => {
  const source = upstream(t);
  const app = install(weatherIntelligenceProxy({ fetchJson: source.fetchJson }));

  const first = await app.request('latitude=27.7231&longitude=85.3240');
  const second = await app.request('latitude=27.7198&longitude=85.3162');
  assert.equal(first.headers['X-Aegis-Weather'], 'MISS');
  assert.equal(second.headers['X-Aegis-Weather'], 'HIT');
  assert.equal(second.body.status, 'cached');
  assert.equal(source.calls.length, 1, 'the second viewer must not re-fetch');

  // A genuinely different location still gets its own analysis.
  await app.request('latitude=41.90&longitude=12.50');
  assert.equal(source.calls.length, 2);
});

test('concurrent cold requests are coalesced into a single upstream call', async (t) => {
  const source = upstream(t);
  const app = install(weatherIntelligenceProxy({ fetchJson: source.fetchJson }));

  const [a, b, c] = await Promise.all([
    app.request(),
    app.request(),
    app.request(),
  ]);
  assert.equal(source.calls.length, 1);
  for (const res of [a, b, c]) assert.equal(res.status, 200);
  assert.ok(
    [a, b, c].some((res) => res.headers['X-Aegis-Weather'] === 'INFLIGHT'),
    'joined requests must report that they shared one call',
  );
});

test('an expired analysis is refreshed, not served from the fresh cache', async (t) => {
  const source = upstream(t);
  let clock = 1_000_000;
  const app = install(
    weatherIntelligenceProxy({
      fetchJson: source.fetchJson,
      now: () => clock,
    }),
  );
  await app.request();
  clock += 4 * 60_000; // inside the fresh window
  assert.equal((await app.request()).headers['X-Aegis-Weather'], 'HIT');
  assert.equal(source.calls.length, 1);

  clock += 2 * 60_000; // past it
  assert.equal((await app.request()).headers['X-Aegis-Weather'], 'MISS');
  assert.equal(source.calls.length, 2, 'an expired cell refreshes exactly once');
});

test('an upstream outage serves the last analysis, labelled stale', async (t) => {
  let down = false;
  let clock = 1_000_000;
  const source = upstream(t);
  const app = install(
    weatherIntelligenceProxy({
      now: () => clock,
      fetchJson: async (url, options) => {
        if (down) throw new Error('upstream down');
        return source.fetchJson(url, options);
      },
    }),
  );
  const fresh = await app.request();
  assert.equal(fresh.body.status, 'ready');

  down = true;
  clock += 10 * 60_000; // past fresh, inside the stale window
  const stale = await app.request();
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Aegis-Weather'], 'STALE');
  assert.equal(stale.body.status, 'stale');
  assert.equal(stale.body.ageMs, 10 * 60_000, 'the age is reported, not hidden');
  assert.equal(
    stale.body.analysis.generatedAt,
    fresh.body.analysis.generatedAt,
    'the stale answer is the previous analysis, not a fabricated one',
  );

  clock += 60 * 60_000; // past the stale window too
  const expired = await app.request();
  assert.equal(expired.status, 503, 'an hour-old analysis is not presented as current');
});

test('a cold upstream failure reports unavailable rather than inventing risk', async (t) => {
  const source = upstream(t, { fail: true });
  const app = install(weatherIntelligenceProxy({ fetchJson: source.fetchJson }));
  const res = await app.request();
  assert.equal(res.status, 503);
  assert.equal(res.headers['X-Aegis-Weather'], 'NONE');
  assert.match(res.body.error, /temporarily unavailable/);
  assert.equal(res.body.analysis, undefined);
});

test('the retained previous analysis is what trends are measured against', async (t) => {
  let call = 0;
  const source = upstream(t, {
    payload: () => {
      call += 1;
      // Second poll: the same cell, now under heavy rain on wet ground.
      return call === 1
        ? syntheticForecast()
        : syntheticForecast({
            base: { soil_moisture_0_to_1cm: 0.43, soil_moisture_1_to_3cm: 0.43 },
            shape: (hour, values) => ({ ...values, precipitation: 8, rain: 8 }),
          });
    },
  });
  let clock = 1_000_000;
  const app = install(
    weatherIntelligenceProxy({ fetchJson: source.fetchJson, now: () => clock }),
  );

  const first = await app.request();
  clock += 6 * 60_000; // a later poll of the same cell, past the fresh window
  const second = await app.request();

  const trend = second.body.analysis.risks.flood.trend;
  assert.equal(trend.source, 'observed', 'a second poll compares against the first');
  assert.equal(trend.previous, first.body.analysis.risks.flood.score);
  assert.equal(trend.direction, 'INCREASING');
  assert.ok(
    second.body.analysis.significantChanges.length > 0,
    'a real change must produce change events for downstream workflows',
  );
});

test('the endpoint refuses invalid input and non-GET methods', async (t) => {
  const source = upstream(t);
  const app = install(weatherIntelligenceProxy({ fetchJson: source.fetchJson }));

  const bad = await app.request('latitude=999&longitude=0');
  assert.equal(bad.status, 400);
  const missing = await app.request('');
  assert.equal(missing.status, 400);
  const posted = await app.request('latitude=1&longitude=1', 'POST');
  assert.equal(posted.status, 405);
  assert.equal(source.calls.length, 0, 'rejected requests never reach upstream');
});

test('the provider is registered with the local server', () => {
  const names = localProviderPlugins().map((plugin) => plugin.name);
  assert.ok(names.includes('aegis-weather-intelligence-proxy'));
  // The pre-existing cockpit weather proxy stays: this is an addition.
  assert.ok(names.includes('weather-effects-proxy'));
});

test('the request builder rejects coordinates it cannot use', () => {
  assert.throws(() => forecastRequestUrl({ latitude: 91, longitude: 0 }), /coordinates/);
  assert.throws(() => forecastRequestUrl({ latitude: 0, longitude: 181 }), /coordinates/);
  assert.throws(() => forecastRequestUrl({ latitude: null, longitude: 0 }), /coordinates/);
});
