import test from 'node:test';
import assert from 'node:assert/strict';
import { flyToInitialView, INITIAL_VIEW } from '../camera.js';
import { getRenderGovernorDiagnostics } from '../renderGovernor.js';

test('teardown before the initial camera delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flights = 0;
  let cancelled = 0;
  const stop = flyToInitialView({
    isDestroyed: () => false,
    camera: {
      setView() {},
      flyTo() {
        flights++;
      },
      cancelFlight() {
        cancelled++;
      },
    },
  });
  stop();
  t.mock.timers.tick(1000);
  assert.equal(flights, 0);
  assert.equal(cancelled, 1);
});

test('the opening frame is regional, not street level', () => {
  // A console that opens at 600 m has no spatial context and scopes every
  // viewport-driven feed to a few city blocks.
  assert.ok(
    INITIAL_VIEW.altitude > 1_000_000,
    'opens far enough out to read as a region',
  );
  assert.ok(
    INITIAL_VIEW.longitude > 60 && INITIAL_VIEW.longitude < 100,
    'centred on South Asia',
  );
  assert.ok(INITIAL_VIEW.latitude > 0 && INITIAL_VIEW.latitude < 40);
});

test('the opening flight holds continuous render and releases on arrival', (t) => {
  // Under the render governor's idle mode Cesium never advances the flight
  // tween, so an unheld opening flight silently strands the camera at the
  // approach altitude. The hold is the fix; failing to release it would pin
  // the renderer on for the rest of the session.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete = null;
  flyToInitialView({
    isDestroyed: () => false,
    camera: {
      setView() {},
      flyTo(options) {
        complete = options.complete;
      },
      cancelFlight() {},
    },
  });
  assert.ok(
    getRenderGovernorDiagnostics().holds.includes('initial-camera-flight'),
    'the hold is taken before the flight starts',
  );

  t.mock.timers.tick(600);
  assert.equal(
    typeof complete,
    'function',
    'the flight registers a completion callback',
  );

  complete();
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('initial-camera-flight'),
    'arrival releases the hold',
  );
});

test('tearing down mid-flight still releases the render hold', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = flyToInitialView({
    isDestroyed: () => false,
    camera: { setView() {}, flyTo() {}, cancelFlight() {} },
  });
  stop();
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('initial-camera-flight'),
    'teardown never leaves the renderer pinned on',
  );
});

test('a page that cannot render arrives at the framing without animating', () => {
  // A tab that starts in the background suspends the render loop, so the
  // flight tween never advances and never reports failure. Arriving directly
  // is the only way the opening view is guaranteed.
  let setViews = [];
  let flights = 0;
  flyToInitialView({
    isDestroyed: () => false,
    scene: { canvas: { ownerDocument: { visibilityState: 'hidden' } } },
    camera: {
      setView(options) {
        setViews.push(options);
      },
      flyTo() {
        flights++;
      },
      cancelFlight() {},
    },
  });
  assert.equal(flights, 0, 'no flight is attempted');
  assert.equal(setViews.length, 1, 'the camera is placed once');
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('initial-camera-flight'),
    'no render hold is taken for a view that does not animate',
  );
});

test('a flight that never lands is corrected to the intended framing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const setViews = [];
  flyToInitialView({
    isDestroyed: () => false,
    scene: { canvas: { ownerDocument: { visibilityState: 'visible' } } },
    camera: {
      setView(options) {
        setViews.push(options);
      },
      // A flight that reports neither completion nor cancellation, which is
      // exactly what a suspended render loop produces.
      flyTo() {},
      cancelFlight() {},
    },
  });
  t.mock.timers.tick(600);
  assert.equal(setViews.length, 1, 'only the approach has been placed');

  t.mock.timers.tick(6000);
  assert.equal(setViews.length, 2, 'the failsafe places the final view');
  assert.ok(
    !getRenderGovernorDiagnostics().holds.includes('initial-camera-flight'),
    'the failsafe also releases the hold',
  );
});
