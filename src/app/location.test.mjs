import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCURACY_FRAMING,
  CONSENT,
  CONSENT_STORAGE_KEY,
  COARSE_DECIMALS,
  coarsen,
  createDeviceLocation,
  framingForAccuracy,
  readConsent,
} from './deviceLocation.js';
import {
  BUCKETS,
  bucketDegrees,
  bucketPosition,
  createLocationContext,
  describePlace,
  formatCoordinates,
} from './locationContext.js';

/**
 * Two promises are under test here, and both are promises to the user rather
 * than to a caller.
 *
 * The first is about PRECISION: Aegis asks a browser for a position accurate
 * to metres and must not let that precision escape the module that received
 * it. A coarse fix is enough to frame a city and band a distance; an exact one
 * would put somebody's street into a screenshot, a share link or a log.
 *
 * The second is about WHERE THE USER IS versus WHERE THE USER IS LOOKING.
 * These are different facts with different owners, and conflating them would
 * silently redirect a person's alerts to whatever city they last panned over.
 *
 * Neither promise is visible in the rendered UI, so both are pinned here.
 */

const BENGALURU_EXACT = { latitude: 12.97159827, longitude: 77.59456213 };

/** A localStorage stand-in. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

/** A geolocation stand-in that succeeds with the given fix. */
const grantingGeolocation = (coords) => ({
  getCurrentPosition: (ok) => ok({ coords }),
});

/** A geolocation stand-in that fails with the given error code. */
const failingGeolocation = (code) => ({
  getCurrentPosition: (_ok, fail) => fail({ code }),
});

// --- Precision -------------------------------------------------------------

test('a position is rounded to about a kilometre before it leaves the module', () => {
  const coarse = coarsen(BENGALURU_EXACT);
  // Two decimals is ~1.1 km: enough for a distance band and a city framing,
  // not enough to identify a building.
  assert.equal(coarse.latitude, 12.97);
  assert.equal(coarse.longitude, 77.59);
  assert.equal(COARSE_DECIMALS, 2);
});

test('the published location is the coarse one, never the exact fix', async () => {
  const storage = fakeStorage();
  const device = createDeviceLocation({
    geolocation: grantingGeolocation({ ...BENGALURU_EXACT, accuracy: 1200 }),
    storage,
    now: () => 1,
  });

  const state = await device.request();

  assert.equal(state.consent, CONSENT.GRANTED);
  assert.deepEqual(state.location, { latitude: 12.97, longitude: 77.59 });

  // The decisive assertion: the exact fix must not survive anywhere on the
  // state other modules read, at any depth.
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('12.97159827'), serialized);
  assert.ok(!serialized.includes('77.59456213'), serialized);
});

test('consent storage never holds coordinates', async () => {
  const storage = fakeStorage();
  const device = createDeviceLocation({
    geolocation: grantingGeolocation({ ...BENGALURU_EXACT, accuracy: 30 }),
    storage,
  });
  await device.request();

  assert.deepEqual([...storage.map.keys()], [CONSENT_STORAGE_KEY]);
  assert.equal(storage.map.get(CONSENT_STORAGE_KEY), CONSENT.GRANTED);
});

// --- Framing ---------------------------------------------------------------

test('a coarse fix is framed regionally and a precise one is never framed at a roof', () => {
  // A 60 km accuracy radius cannot support a city view, so it does not get one.
  assert.equal(framingForAccuracy(60_000).label, 'REGIONAL');
  assert.equal(framingForAccuracy(20_000).label, 'METRO');
  assert.equal(framingForAccuracy(30).label, 'CITY');

  // The tightest framing Aegis will ever choose is still city scale. This is
  // the guard against a precise fix turning the console into surveillance.
  const closest = Math.min(...ACCURACY_FRAMING.map((band) => band.altitude));
  assert.ok(closest >= 50_000, `closest framing was ${closest} m`);
});

test('an unusable accuracy falls back to the widest framing, not the closest', () => {
  // Not knowing how good a fix is must not be read as knowing it is good.
  assert.equal(framingForAccuracy(Number.NaN).label, 'REGIONAL');
  assert.equal(framingForAccuracy(undefined).label, 'REGIONAL');
  assert.equal(framingForAccuracy(Infinity).label, 'REGIONAL');
});

// --- Consent ---------------------------------------------------------------

test('a refusal is remembered, so the console asks once and never nags', async () => {
  const storage = fakeStorage();
  const device = createDeviceLocation({
    geolocation: failingGeolocation(1),
    storage,
  });

  assert.equal(device.shouldAsk(), true);
  const state = await device.request();
  assert.equal(state.consent, CONSENT.DENIED);
  assert.equal(device.shouldAsk(), false);

  // A fresh context on the next page load must honour the same decision.
  const reopened = createDeviceLocation({
    geolocation: failingGeolocation(1),
    storage,
  });
  assert.equal(reopened.shouldAsk(), false);
});

test('a device that cannot answer is not recorded as a refusal', async () => {
  // Position-unavailable and timeout are the device failing, not the user
  // declining, and the two must stay distinguishable.
  for (const code of [2, 3]) {
    const storage = fakeStorage();
    const device = createDeviceLocation({
      geolocation: failingGeolocation(code),
      storage,
    });
    const state = await device.request();
    assert.equal(state.consent, CONSENT.UNAVAILABLE);
    assert.notEqual(state.consent, CONSENT.DENIED);
  }
});

test('a browser with no geolocation at all is unavailable, not broken', async () => {
  const device = createDeviceLocation({
    geolocation: undefined,
    storage: fakeStorage(),
  });
  const state = await device.request();
  assert.equal(state.consent, CONSENT.UNAVAILABLE);
  assert.equal(state.location, null);
});

test('declining asks the browser for nothing at all', () => {
  let asked = false;
  const device = createDeviceLocation({
    geolocation: {
      getCurrentPosition: () => {
        asked = true;
      },
    },
    storage: fakeStorage(),
  });

  const state = device.decline();
  assert.equal(state.consent, CONSENT.DENIED);
  assert.equal(asked, false);
});

test('blocked storage degrades to asking again rather than throwing', () => {
  const blocked = {
    getItem: () => {
      throw new Error('private browsing');
    },
    setItem: () => {
      throw new Error('private browsing');
    },
  };

  assert.equal(readConsent(blocked), CONSENT.UNASKED);
  const device = createDeviceLocation({
    geolocation: undefined,
    storage: blocked,
  });
  assert.doesNotThrow(() => device.decline());
});

test('a corrupt stored value is treated as unasked, not as consent', () => {
  const storage = fakeStorage({ [CONSENT_STORAGE_KEY]: 'YES_OBVIOUSLY' });
  assert.equal(readConsent(storage), CONSENT.UNASKED);
});

// --- Viewed location -------------------------------------------------------

/** A Cesium viewer stand-in whose camera can be moved. */
function fakeViewer(latitude, longitude, altitude) {
  const listeners = new Set();
  const toRad = (deg) => (deg * Math.PI) / 180;
  const viewer = {
    camera: {
      positionCartographic: {
        latitude: toRad(latitude),
        longitude: toRad(longitude),
        height: altitude,
      },
      moveEnd: {
        addEventListener: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
    },
    moveTo(nextLat, nextLon, nextAlt = altitude) {
      viewer.camera.positionCartographic = {
        latitude: toRad(nextLat),
        longitude: toRad(nextLon),
        height: nextAlt,
      };
      for (const fn of listeners) fn();
    },
    listenerCount: () => listeners.size,
  };
  return viewer;
}

const settle = (ms = 12) => new Promise((resolve) => setTimeout(resolve, ms));

test('the camera is bucketed by altitude, so orbital drift is the same place', () => {
  assert.equal(bucketDegrees(3_000_000), 5);
  assert.equal(bucketDegrees(600_000), 1);
  assert.equal(bucketDegrees(150_000), 0.25);
  assert.equal(bucketDegrees(50_000), 0.05);
  assert.equal(bucketDegrees(1_000), 0.01);
  // Buckets must widen monotonically with height or the cache key is unstable.
  const degrees = BUCKETS.map((bucket) => bucket.degrees);
  assert.deepEqual(degrees, [...degrees].sort((a, b) => b - a));

  const bucket = bucketPosition({
    latitude: 12.9716,
    longitude: 77.5946,
    altitude: 3_000_000,
  });
  assert.deepEqual(bucket, { latitude: 15, longitude: 80, degrees: 5 });
});

test('a settled camera is geocoded once, and a repeat of the same bucket is free', async () => {
  const asked = [];
  const viewer = fakeViewer(12.9716, 77.5946, 120_000);
  const context = createLocationContext({
    viewer,
    settleMs: 1,
    fetchBrief: async (latitude, longitude) => {
      asked.push([latitude, longitude]);
      return { place: { locality: 'Bengaluru', region: 'Karnataka', country: 'India' } };
    },
  });

  await settle();
  assert.equal(asked.length, 1);
  assert.equal(context.get().locationName, 'Bengaluru');
  assert.equal(context.get().status, 'READY');

  // A nudge that lands in the same 0.25° bucket must not cost a second lookup.
  viewer.moveTo(12.98, 77.6, 120_000);
  await settle();
  assert.equal(asked.length, 1);

  context.destroy();
});

test('the geocoder is asked about a bucket, never about the exact camera point', async () => {
  const asked = [];
  const viewer = fakeViewer(12.971598, 77.594562, 3_000_000);
  const context = createLocationContext({
    viewer,
    settleMs: 1,
    fetchBrief: async (latitude, longitude) => {
      asked.push([latitude, longitude]);
      return { place: { locality: 'Bengaluru', country: 'India' } };
    },
  });

  await settle();
  assert.deepEqual(asked, [[15, 80]]);

  context.destroy();
});

test('a reply that arrives after the camera moved on is discarded', async () => {
  const viewer = fakeViewer(12.9716, 77.5946, 120_000);
  const releases = [];
  const context = createLocationContext({
    viewer,
    settleMs: 1,
    fetchBrief: (latitude) =>
      new Promise((resolve) => {
        releases.push(() =>
          resolve({
            place: { locality: latitude > 20 ? 'Kathmandu' : 'Bengaluru' },
          }),
        );
      }),
  });

  await settle();
  viewer.moveTo(27.7172, 85.324, 120_000);
  await settle();
  assert.equal(releases.length, 2);

  // The stale Bengaluru reply lands last and must not overwrite Kathmandu.
  releases[1]();
  await settle();
  releases[0]();
  await settle();

  assert.equal(context.get().locationName, 'Kathmandu');
  context.destroy();
});

test('an unreachable geocoder clears the name instead of leaving a stale one', async () => {
  let fail = false;
  const viewer = fakeViewer(12.9716, 77.5946, 120_000);
  const context = createLocationContext({
    viewer,
    settleMs: 1,
    fetchBrief: async () => {
      if (fail) throw new Error('offline');
      return { place: { locality: 'Bengaluru', country: 'India' } };
    },
  });

  await settle();
  assert.equal(context.get().locationName, 'Bengaluru');

  fail = true;
  viewer.moveTo(27.7172, 85.324, 120_000);
  await settle();

  // Showing "Bengaluru" over Nepal would be worse than showing nothing.
  assert.equal(context.get().locationName, null);
  assert.equal(context.get().status, 'UNAVAILABLE');
  context.destroy();
});

test('an unresolved place reports coordinates rather than guessing a city', () => {
  assert.deepEqual(describePlace(null), { primary: null, secondary: null });
  assert.deepEqual(describePlace({ country: 'India' }), {
    primary: 'India',
    secondary: null,
  });
  assert.equal(
    describePlace({ locality: 'Bengaluru', region: 'Karnataka', country: 'India' })
      .secondary,
    'Karnataka, India',
  );
  assert.equal(formatCoordinates(12.9716, -77.5946), '12.9716° N  77.5946° W');
  assert.equal(formatCoordinates(Number.NaN, 1), '');
});

test('teardown stops deferred geocoding and releases the camera listener', async () => {
  let asked = 0;
  const viewer = fakeViewer(12.9716, 77.5946, 120_000);
  const context = createLocationContext({
    viewer,
    settleMs: 5,
    fetchBrief: async () => {
      asked += 1;
      return { place: { locality: 'Bengaluru' } };
    },
  });

  context.destroy();
  await settle(20);

  assert.equal(asked, 0);
  assert.equal(viewer.listenerCount(), 0);
});

// --- The separation itself -------------------------------------------------

test('panning the globe never moves the location the console monitors', async () => {
  const storage = fakeStorage();
  const device = createDeviceLocation({
    geolocation: grantingGeolocation({ ...BENGALURU_EXACT, accuracy: 1200 }),
    storage,
  });
  await device.request();

  const viewer = fakeViewer(12.9716, 77.5946, 120_000);
  const viewed = createLocationContext({
    viewer,
    settleMs: 1,
    fetchBrief: async (latitude) => ({
      place: { locality: latitude > 20 ? 'Kathmandu' : 'Bengaluru' },
    }),
  });

  await settle();
  viewer.moveTo(27.7172, 85.324, 120_000);
  await settle();

  // The operator is looking at Kathmandu and is still sitting in Bengaluru.
  assert.equal(viewed.get().locationName, 'Kathmandu');
  assert.deepEqual(device.get().location, { latitude: 12.97, longitude: 77.59 });
  assert.equal(device.get().consent, CONSENT.GRANTED);

  viewed.destroy();
});
