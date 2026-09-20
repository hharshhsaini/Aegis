import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWeatherIntelligenceService,
  CLIENT_CACHE_MS,
} from './weatherIntelligence.js';

/**
 * The client service exists to protect the API budget from the UI. A camera
 * moving across a city, a panel polling, and an operator clicking twice must
 * not become three upstream calls, and a failed poll must not blank a panel an
 * operator is reading.
 */

function transport({ fail = false } = {}) {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    calls,
    release,
    gate,
    async fetchAnalysis(latitude, longitude) {
      calls.push({ latitude, longitude });
      if (fail) throw new Error('offline');
      return {
        status: 'ready',
        analysis: {
          generatedAt: new Date().toISOString(),
          overall: { score: 42, level: 'MODERATE' },
          risks: {},
          call: calls.length,
        },
      };
    },
  };
}

test('nearby requests reuse one analysis instead of re-fetching', async () => {
  const source = transport();
  const service = createWeatherIntelligenceService({
    fetchAnalysis: source.fetchAnalysis,
  });
  await service.analyze(27.7231, 85.324);
  const second = await service.analyze(27.7198, 85.3162);
  assert.equal(source.calls.length, 1, 'the same cell must not be fetched twice');
  assert.equal(second.source, 'cache');
  // The upstream call is made on the rounded cell, matching the server's grid.
  assert.deepEqual(source.calls[0], { latitude: 27.72, longitude: 85.32 });

  await service.analyze(41.9, 12.5);
  assert.equal(source.calls.length, 2, 'a different place is a different question');
});

test('an expired entry refetches, and force bypasses the cache', async () => {
  const source = transport();
  let clock = 0;
  const service = createWeatherIntelligenceService({
    fetchAnalysis: source.fetchAnalysis,
    now: () => clock,
  });
  await service.analyze(27.72, 85.32);
  clock += CLIENT_CACHE_MS - 1;
  await service.analyze(27.72, 85.32);
  assert.equal(source.calls.length, 1);

  clock += 2;
  await service.analyze(27.72, 85.32);
  assert.equal(source.calls.length, 2);

  await service.analyze(27.72, 85.32, { force: true });
  assert.equal(source.calls.length, 3, 'an explicit refresh always asks');
});

test('concurrent callers for one cell share a single request', async () => {
  const source = transport();
  const service = createWeatherIntelligenceService({
    fetchAnalysis: source.fetchAnalysis,
  });
  const [a, b, c] = await Promise.all([
    service.analyze(27.72, 85.32),
    service.analyze(27.72, 85.32),
    service.analyze(27.72, 85.32),
  ]);
  assert.equal(source.calls.length, 1);
  assert.equal(a.analysis.call, b.analysis.call);
  assert.equal(b.analysis.call, c.analysis.call);
});

test('a failed refresh keeps the previous analysis and flags it', async () => {
  let offline = false;
  const source = transport();
  const service = createWeatherIntelligenceService({
    fetchAnalysis: async (...args) => {
      if (offline) throw new Error('offline');
      return source.fetchAnalysis(...args);
    },
    ttlMs: 0,
  });
  const first = await service.analyze(27.72, 85.32);
  offline = true;
  const second = await service.analyze(27.72, 85.32);

  assert.equal(second.status, 'stale');
  assert.equal(second.analysis, first.analysis, 'the last good analysis stands');
  assert.match(second.error, /offline/);
});

test('a first request that fails reports an error rather than fabricating one', async () => {
  const source = transport({ fail: true });
  const service = createWeatherIntelligenceService({
    fetchAnalysis: source.fetchAnalysis,
  });
  const record = await service.analyze(27.72, 85.32);
  assert.equal(record.status, 'error');
  assert.equal(record.analysis, null);
});

test('subscribers are notified, and one broken listener does not stop the others', async () => {
  const source = transport();
  const service = createWeatherIntelligenceService({
    fetchAnalysis: source.fetchAnalysis,
  });
  const seen = [];
  service.subscribe(() => {
    throw new Error('broken subscriber');
  });
  const stop = service.subscribe((record) => seen.push(record.status));
  await service.analyze(27.72, 85.32);
  assert.deepEqual(seen, ['ready']);

  // A late subscriber receives the standing analysis immediately.
  const late = [];
  service.subscribe((record) => late.push(record.status));
  assert.deepEqual(late, ['ready']);

  stop();
  await service.analyze(27.72, 85.32, { force: true });
  assert.deepEqual(seen, ['ready'], 'an unsubscribed listener stops hearing');
});

test('invalid coordinates never reach the network', async () => {
  const source = transport();
  const service = createWeatherIntelligenceService({
    fetchAnalysis: source.fetchAnalysis,
  });
  assert.equal(await service.analyze(91, 0), null);
  assert.equal(await service.analyze(0, 181), null);
  assert.equal(await service.analyze(Number.NaN, 0), null);
  assert.equal(source.calls.length, 0);
  assert.throws(() => createWeatherIntelligenceService({}), /transport/);
});
