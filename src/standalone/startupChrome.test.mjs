import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * The handover from the startup sequence to the console.
 *
 * Two independent things have to finish before the cover lifts: the
 * application's own restoration, and the introduction playing over the top.
 * These tests hold the rule that neither is allowed to be skipped by the other
 * — and that a shutdown part-way through leaves nothing behind that can still
 * reveal UI for an application that is going away.
 */

const source = readFileSync(
  new URL('../app/startupChrome.js', import.meta.url),
  'utf8',
)
  // Lazy up to the first `;` so this strips multi-line import blocks as well
  // as single-line ones.
  .replace(/^import[\s\S]*?;\n/gm, '')
  .replace('export function', 'function');

function fixture() {
  const timers = new Map();
  const listeners = new Map();
  const events = [];
  let restored;
  let finishSequence;
  let nextTimer = 0;
  const controller = new AbortController();
  const context = {
    console,
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    initFirstRunExperience() {
      events.push('welcome');
      return { destroy: () => events.push('welcome:destroy') };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  const sequenceFinished = new Promise((resolve) => {
    finishSequence = resolve;
  });
  const stop = context.startApplicationChrome({
    loadingScreen: {
      classList: { add: (value) => events.push(value) },
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type) => listeners.delete(type),
    },
    styleManager: {
      initialRestorePromise: new Promise((resolve) => {
        restored = resolve;
      }),
    },
    dataManager: {},
    signal: controller.signal,
    initializeWelcome: context.initFirstRunExperience,
    playFullIntro: () => true,
    startSequence: () => ({
      finished: sequenceFinished,
      destroy: () => events.push('sequence:destroy'),
    }),
  });
  return {
    events,
    listeners,
    stop,
    restored,
    finishSequence,
    controller,
    fire(delay) {
      for (const [id, task] of timers) {
        if (task.delay === delay) {
          timers.delete(id);
          task.fn();
        }
      }
    },
    timers,
  };
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test('the cover waits for restoration AND the introduction', async () => {
  const f = fixture();

  // The introduction has finished but the console has not restored. Lifting
  // here would drop the user onto a half-built application.
  f.finishSequence();
  await flush();
  assert.deepEqual(f.events, []);

  f.restored();
  await flush();
  assert.deepEqual(f.events, ['hidden']);

  f.listeners.get('transitionend')();
  assert.deepEqual(f.events, ['hidden', 'welcome']);

  await f.stop();
  assert.deepEqual(f.events.slice(-2), ['sequence:destroy', 'welcome:destroy']);
  assert.equal(f.timers.size, 0);
});

test('a restored console still waits for the sequence to hand over', async () => {
  const f = fixture();

  // The reverse race: the application was ready first. The introduction is
  // allowed to finish at its own pace rather than being cut off.
  f.restored();
  await flush();
  assert.deepEqual(f.events, []);

  f.finishSequence();
  await flush();
  assert.deepEqual(f.events, ['hidden']);
  await f.stop();
});

test('the bounded fallback reveals welcome if no transition ever fires', async () => {
  const f = fixture();
  f.restored();
  f.finishSequence();
  await flush();
  // Some browsers will not emit transitionend for a hidden element; the
  // console must still arrive.
  f.fire(900);
  assert.deepEqual(f.events, ['hidden', 'welcome']);
  await f.stop();
});

test('shutdown while restore is pending never reveals late welcome UI', async () => {
  const f = fixture();
  f.controller.abort();
  await f.stop();
  f.restored();
  f.finishSequence();
  await flush();
  f.fire(900);
  assert.deepEqual(f.events, ['sequence:destroy']);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test('shutdown during the cover transition cancels the listener and fallback', async () => {
  const f = fixture();
  f.restored();
  f.finishSequence();
  await flush();
  const transition = f.listeners.get('transitionend');
  f.controller.abort();
  await f.stop();
  transition();
  f.fire(900);
  assert.deepEqual(f.events, ['hidden', 'sequence:destroy']);
});
