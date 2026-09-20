import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachTimelineScrubber,
  fractionAt,
  fractionOf,
  readRange,
} from './timelineScrubber.js';

/**
 * The scrubber exists because a native range input leaks its pointer events to
 * every ancestor, and the Nepal reconstruction clock sits inside a panel that
 * closes itself on `pointerleave`. So most of these tests are about what must
 * NOT happen: nothing the scrubber handles may reach anything above it.
 */

/** A range input stub with the parts the scrubber touches. */
function rangeInput({
  min = '0',
  max = '1000',
  value = '0',
  width = 200,
} = {}) {
  const listeners = new Map();
  return {
    min,
    max,
    value,
    dataset: {},
    listeners,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    getAttribute(name) {
      return { min, max }[name] ?? null;
    },
    getBoundingClientRect: () => ({ left: 100, width, right: 100 + width }),
    captured: [],
    released: [],
    setPointerCapture(id) {
      this.captured.push(id);
    },
    releasePointerCapture(id) {
      this.released.push(id);
    },
    fire(type, event = {}) {
      const record = {
        stopped: 0,
        stoppedImmediate: 0,
        stopPropagation() {
          record.stopped += 1;
        },
        stopImmediatePropagation() {
          record.stoppedImmediate += 1;
        },
        ...event,
      };
      for (const handler of listeners.get(type) || []) handler(record);
      return record;
    },
  };
}

test('the range is read from properties, attributes, then a default', () => {
  assert.deepEqual(readRange({ min: '0', max: '1000' }), { min: 0, max: 1000 });
  // A host that models the element without property accessors still reports
  // the authored range; defaulting to 0..100 against a 0..1000 control would
  // put every seek at the end of the timeline.
  assert.deepEqual(
    readRange({ getAttribute: (name) => ({ min: '0', max: '1000' })[name] }),
    { min: 0, max: 1000 },
  );
  assert.deepEqual(readRange({}), { min: 0, max: 100 });
});

test('a value maps to a fraction of its own range', () => {
  assert.equal(fractionOf({ min: '0', max: '1000', value: '285' }), 0.285);
  assert.equal(fractionOf({ min: '0', max: '1000', value: '0' }), 0);
  assert.equal(fractionOf({ min: '0', max: '1000', value: '1000' }), 1);
  // Out of range and unparseable values clamp rather than propagating NaN
  // into a scene clock.
  assert.equal(fractionOf({ min: '0', max: '1000', value: '5000' }), 1);
  assert.equal(fractionOf({ min: '0', max: '1000', value: 'x' }), 0);
});

test('a pointer position maps onto the track and clamps outside it', () => {
  const input = rangeInput();
  assert.equal(fractionAt(input, 100), 0);
  assert.equal(fractionAt(input, 200), 0.5);
  assert.equal(fractionAt(input, 300), 1);
  // Capture keeps the drag alive well past the element's own bounds.
  assert.equal(fractionAt(input, -500), 0);
  assert.equal(fractionAt(input, 5000), 1);
});

test('a drag captures the pointer and releases it on pointerup', () => {
  const input = rangeInput();
  attachTimelineScrubber({ element: input, range: { min: 0, max: 1000 } });

  input.fire('pointerdown', { pointerId: 7, button: 0, clientX: 150 });
  assert.deepEqual(input.captured, [7], 'the drag is bound to this control');
  assert.equal(input.dataset.scrubbing, 'true');

  input.fire('pointerup', { pointerId: 7 });
  assert.deepEqual(input.released, [7]);
  assert.equal(input.dataset.scrubbing, undefined);
});

test('every handled event is stopped before it can reach an ancestor', () => {
  // This is the bug: a drag that reaches the panel closes the modal, and one
  // that reaches the canvas moves the globe.
  const input = rangeInput();
  attachTimelineScrubber({ element: input, range: { min: 0, max: 1000 } });

  const down = input.fire('pointerdown', {
    pointerId: 1,
    button: 0,
    clientX: 150,
  });
  assert.ok(down.stopped > 0, 'pointerdown is stopped');

  const move = input.fire('pointermove', { pointerId: 1, clientX: 180 });
  assert.ok(move.stopped > 0, 'pointermove is stopped');

  const up = input.fire('pointerup', { pointerId: 1 });
  assert.ok(up.stopped > 0, 'pointerup is stopped');

  for (const type of ['click', 'dblclick', 'wheel', 'contextmenu']) {
    const event = input.fire(type, {});
    assert.ok(event.stopped > 0, `${type} is stopped`);
  }
});

test('dragging moves the clock forward and backward', () => {
  const previews = [];
  const commits = [];
  const input = rangeInput();
  attachTimelineScrubber({
    element: input,
    range: { min: 0, max: 1000 },
    onPreview: (fraction) => previews.push(Number(fraction.toFixed(3))),
    onCommit: (fraction) => commits.push(Number(fraction.toFixed(3))),
  });

  // 00:23 → 02:00, then back again. Both are ordinary seeks.
  input.fire('pointerdown', { pointerId: 1, button: 0, clientX: 120 });
  input.fire('pointermove', { pointerId: 1, clientX: 260 });
  input.fire('pointerup', { pointerId: 1 });
  assert.deepEqual(previews, [0.1, 0.8]);
  assert.deepEqual(commits, [0.8]);

  input.fire('pointerdown', { pointerId: 2, button: 0, clientX: 260 });
  input.fire('pointermove', { pointerId: 2, clientX: 110 });
  input.fire('pointerup', { pointerId: 2 });
  assert.deepEqual(previews.slice(2), [0.8, 0.05]);
  assert.deepEqual(commits, [0.8, 0.05]);
});

test('a secondary button does not seek', () => {
  const previews = [];
  const input = rangeInput();
  attachTimelineScrubber({
    element: input,
    range: { min: 0, max: 1000 },
    onPreview: (fraction) => previews.push(fraction),
  });
  input.fire('pointerdown', { pointerId: 1, button: 2, clientX: 200 });
  assert.deepEqual(previews, [], 'a right-click on the timeline is not a seek');
});

test('playback cannot move the playhead out from under a live drag', () => {
  const input = rangeInput();
  const scrubber = attachTimelineScrubber({
    element: input,
    range: { min: 0, max: 1000 },
  });

  scrubber.setFraction(0.25);
  assert.equal(input.value, '250');

  input.fire('pointerdown', { pointerId: 1, button: 0, clientX: 200 });
  assert.equal(input.value, '500', 'the pointer owns the handle');
  scrubber.setFraction(0.9);
  assert.equal(input.value, '500', 'a playback tick is ignored mid-drag');

  input.fire('pointerup', { pointerId: 1 });
  scrubber.setFraction(0.9);
  assert.equal(input.value, '900', 'and applies again once the drag ends');
});

test('arrow keys are handled here and not passed to beat navigation', () => {
  const commits = [];
  const input = rangeInput({ value: '500' });
  attachTimelineScrubber({
    element: input,
    range: { min: 0, max: 1000 },
    onCommit: (fraction) => commits.push(fraction),
  });

  const down = input.fire('keydown', { key: 'ArrowLeft' });
  assert.ok(down.stopped > 0, 'the arrow never reaches a prev/next handler');
  input.fire('keyup', { key: 'ArrowLeft' });
  assert.deepEqual(commits, [0.5]);

  // A key the scrubber does not handle is left alone for the rest of the app.
  const tab = input.fire('keydown', { key: 'Tab' });
  assert.equal(tab.stopped, 0);
});

test('a cancelled pointer ends the drag rather than stranding it', () => {
  const input = rangeInput();
  const scrubber = attachTimelineScrubber({
    element: input,
    range: { min: 0, max: 1000 },
  });
  input.fire('pointerdown', { pointerId: 3, button: 0, clientX: 150 });
  assert.equal(scrubber.isDragging(), true);
  input.fire('pointercancel', { pointerId: 3 });
  assert.equal(scrubber.isDragging(), false);
  assert.deepEqual(input.released, [3]);
});

test('destroy removes every listener it added', () => {
  const input = rangeInput();
  const scrubber = attachTimelineScrubber({ element: input });
  const before = [...input.listeners.values()].reduce(
    (total, set) => total + set.size,
    0,
  );
  assert.ok(before > 0);
  scrubber.destroy();
  const after = [...input.listeners.values()].reduce(
    (total, set) => total + set.size,
    0,
  );
  assert.equal(after, 0, 'a torn-down scrubber cannot swallow a later gesture');
});

test('a missing element yields no controller rather than throwing', () => {
  assert.equal(attachTimelineScrubber({ element: null }), null);
  assert.equal(attachTimelineScrubber(), null);
});

test('a synthetic event without propagation methods does not throw', () => {
  // Hosts and tests dispatch plain objects; a scrubber that threw on one would
  // take the whole panel down with it.
  const input = rangeInput();
  const previews = [];
  attachTimelineScrubber({
    element: input,
    range: { min: 0, max: 1000 },
    onPreview: (fraction) => previews.push(fraction),
  });
  input.value = '285';
  for (const handler of input.listeners.get('input')) handler({});
  assert.deepEqual(previews, [0.285]);
});
