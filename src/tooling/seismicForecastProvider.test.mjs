import test from 'node:test';
import assert from 'node:assert/strict';
import {
  seismicForecastProxy,
  resetSeismicForecastCaches,
} from '../../server/providers/seismicForecast.js';
import {
  signInvokeRequest,
  isBedrockConfigured,
  invokeBedrock,
  bedrockConfig,
} from '../../server/providers/bedrock.js';
import { localProviderPlugins } from '../../server/providers/local.js';

/**
 * The route's job is to serve inference cheaply and to keep the language model
 * out of the hot path. These tests hold it to both, and hold the Bedrock client
 * to being real — a correctly signed request, or an honest UNCONFIGURED.
 */

const NOW = Date.parse('2026-09-18T12:00:00Z');
const REGION = 'west=130&south=30&east=145&north=45';

function catalogPayload(count, { end = NOW, magnitude = 3.1 } = {}) {
  return {
    type: 'FeatureCollection',
    metadata: { generated: end },
    features: Array.from({ length: count }, (_, index) => ({
      type: 'Feature',
      id: `q${index}`,
      geometry: { type: 'Point', coordinates: [137 + index * 0.01, 37 + index * 0.01, 25] },
      properties: {
        mag: magnitude,
        place: 'Test region',
        time: end - index * 3_600_000,
        updated: end,
        url: `https://earthquake.usgs.gov/earthquakes/eventpage/q${index}`,
        sig: 150,
        status: 'reviewed',
        type: 'earthquake',
        tsunami: 0,
      },
    })),
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
    async request(query = REGION, method = 'GET') {
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

function harness(overrides = {}) {
  resetSeismicForecastCaches();
  const calls = { catalog: 0, bedrock: 0 };
  const plugin = seismicForecastProxy({
    now: () => NOW,
    rateLimiter: () => true,
    fetchJson: async () => {
      calls.catalog += 1;
      return catalogPayload(120);
    },
    bedrockEnabled: () => false,
    invoke: async () => {
      calls.bedrock += 1;
      return { status: 'READY', text: 'Narration.', modelId: 'test-model' };
    },
    ...overrides,
  });
  return { app: install(plugin), calls };
}

test('the route serves a forecast with its target and evidence', async (t) => {
  t.after(() => resetSeismicForecastCaches());
  const { app } = harness();
  assert.equal(app.route, '/api/quakes/forecast');

  const res = await app.request();
  assert.equal(res.status, 200);
  const { forecast, narration } = res.body;
  assert.equal(forecast.status, 'READY');
  assert.ok(forecast.probability >= 0 && forecast.probability <= 1);
  assert.equal(forecast.targetDescription, '≥3 events M≥2.5 within 24h');
  assert.equal(forecast.forecastWindowHours, 24);
  assert.ok(forecast.model.version);
  assert.ok(forecast.validation.brierScore >= 0);
  assert.ok(forecast.anomaly);
  assert.match(forecast.disclaimer, /not a prediction of a specific earthquake/i);
  // Unconfigured Bedrock degrades to a labelled template, never to silence.
  assert.equal(narration.generatedBy, 'deterministic-template');
  assert.equal(narration.status, 'UNCONFIGURED');
  assert.match(narration.text, /probability of ≥3 events/);
});

test('the catalog is cached, so a second forecast costs no upstream request', async (t) => {
  t.after(() => resetSeismicForecastCaches());
  const { app, calls } = harness();
  await app.request();
  const first = calls.catalog;
  await app.request();
  assert.equal(calls.catalog, first, 'the same region reuses its cached catalog');
});

test('Bedrock is invoked on change and skipped when nothing moved', async (t) => {
  t.after(() => resetSeismicForecastCaches());
  const { app, calls } = harness({ bedrockEnabled: () => true });

  const first = await app.request();
  assert.equal(calls.bedrock, 1, 'the first forecast is narrated');
  assert.equal(first.body.narration.generatedBy, 'amazon-bedrock');
  assert.equal(first.body.narrationSource, 'generated');

  const second = await app.request();
  assert.equal(calls.bedrock, 1, 'an unchanged forecast must not invoke the model again');
  assert.equal(second.body.narrationSource, 'cached');
  assert.equal(second.headers['X-Aegis-Forecast'], 'STABLE');
});

test('an operator question always reaches the model', async (t) => {
  t.after(() => resetSeismicForecastCaches());
  const { app, calls } = harness({ bedrockEnabled: () => true });
  await app.request();
  await app.request(`${REGION}&question=Should%20I%20be%20concerned`);
  assert.equal(calls.bedrock, 2, 'a question is always answered fresh');
});

test('a missing model artifact still returns observations', async (t) => {
  t.after(() => resetSeismicForecastCaches());
  const { app } = harness({
    modelPath: new URL('./does-not-exist.json', import.meta.url),
  });
  const res = await app.request();
  assert.equal(res.status, 200);
  assert.equal(res.body.forecast.status, 'MODEL_UNAVAILABLE');
  assert.equal(res.body.forecast.probability, null);
  assert.ok(res.body.forecast.anomaly, 'the anomaly detector is independent of the model');
  assert.match(res.body.narration.text, /No forecasting model is available/);
});

test('a catalog failure reports unavailable rather than a fabricated forecast', async (t) => {
  t.after(() => resetSeismicForecastCaches());
  const { app } = harness({
    fetchJson: async () => {
      throw new Error('USGS unreachable');
    },
  });
  const res = await app.request();
  assert.equal(res.status, 503);
  assert.equal(res.body.forecast, undefined);
  assert.match(res.body.message, /temporarily unavailable/);
});

test('a bad region is refused', async (t) => {
  t.after(() => resetSeismicForecastCaches());
  const { app, calls } = harness();
  assert.equal((await app.request('west=abc&south=30&east=145&north=45')).status, 400);
  assert.equal((await app.request('west=130')).status, 400);
  assert.equal((await app.request(REGION, 'POST')).status, 405);
  assert.equal(calls.catalog, 0);
});

test('Bedrock signing produces a well-formed SigV4 request', () => {
  const config = {
    region: 'us-east-1',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    sessionToken: '',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  };
  const signed = signInvokeRequest({
    config,
    body: '{"hello":"world"}',
    now: new Date('2026-09-18T12:00:00Z'),
  });
  assert.equal(
    signed.url,
    'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke',
  );
  assert.match(signed.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
  assert.match(signed.headers.authorization, /20260918\/us-east-1\/bedrock\/aws4_request/);
  assert.match(signed.headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
  assert.match(signed.headers.authorization, /Signature=[0-9a-f]{64}$/);
  assert.equal(signed.headers['x-amz-date'], '20260918T120000Z');
  // The signature must depend on the payload.
  const other = signInvokeRequest({
    config,
    body: '{"hello":"there"}',
    now: new Date('2026-09-18T12:00:00Z'),
  });
  assert.notEqual(signed.headers.authorization, other.headers.authorization);
});

test('an unconfigured Bedrock says so instead of inventing prose', async () => {
  assert.equal(isBedrockConfigured({ region: '', accessKeyId: '', secretAccessKey: '' }), false);
  assert.equal(
    isBedrockConfigured({ region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b' }),
    true,
  );
  const result = await invokeBedrock({
    system: 's',
    user: 'u',
    config: { region: '', accessKeyId: '', secretAccessKey: '', modelId: 'm' },
    fetchImpl: () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(result.status, 'UNCONFIGURED');
  assert.equal(result.text, null);
  assert.match(result.detail, /AWS_REGION/);
});

test('a configured Bedrock call reads the model response', async () => {
  const result = await invokeBedrock({
    system: 'system',
    user: 'user',
    config: {
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      sessionToken: '',
      modelId: 'test-model',
    },
    fetchImpl: async (url, init) => {
      assert.match(url, /bedrock-runtime\.us-east-1\.amazonaws\.com/);
      assert.ok(init.headers.authorization.startsWith('AWS4-HMAC-SHA256'));
      const body = JSON.parse(init.body);
      assert.equal(body.system, 'system');
      assert.equal(body.temperature, 0.2);
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'Summary text.' }] }),
      };
    },
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.text, 'Summary text.');
});

test('a Bedrock error degrades without throwing', async () => {
  const result = await invokeBedrock({
    system: 's',
    user: 'u',
    config: {
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      modelId: 'm',
    },
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'denied' }) }),
  });
  assert.equal(result.status, 'ERROR');
  assert.equal(result.text, null);
  assert.match(result.detail, /403/);
});

test('configuration comes from the environment only', () => {
  const config = bedrockConfig({
    AWS_REGION: 'eu-west-1',
    AWS_ACCESS_KEY_ID: 'key',
    AWS_SECRET_ACCESS_KEY: 'secret',
    BEDROCK_MODEL_ID: 'custom-model',
  });
  assert.equal(config.region, 'eu-west-1');
  assert.equal(config.modelId, 'custom-model');
  assert.equal(bedrockConfig({}).region, '');
});

test('the forecast provider is registered with the local server', () => {
  const names = localProviderPlugins().map((plugin) => plugin.name);
  assert.ok(names.includes('aegis-seismic-forecast-proxy'));
  assert.ok(names.includes('aegis-earthquake-intelligence-proxy'));
});
