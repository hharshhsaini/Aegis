import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coarseRegion,
  formatUtc,
  samePlace,
  worstState,
} from './statusStrip.js';
import { FEED_STATES } from './dataState.js';

test('the aggregate feed state is the worst one present', () => {
  // A green SYSTEM above a broken feed is the failure this exists to prevent.
  assert.equal(
    worstState([FEED_STATES.LIVE, FEED_STATES.LIVE, FEED_STATES.UNAVAILABLE]),
    FEED_STATES.UNAVAILABLE,
  );
  assert.equal(
    worstState([FEED_STATES.LIVE, FEED_STATES.STALE]),
    FEED_STATES.STALE,
  );
  assert.equal(
    worstState([FEED_STATES.LIVE, FEED_STATES.RECENT]),
    FEED_STATES.RECENT,
  );
  assert.equal(worstState([FEED_STATES.LIVE]), FEED_STATES.LIVE);
});

test('an unknown set of feeds reports LOADING rather than a healthy guess', () => {
  assert.equal(worstState([]), FEED_STATES.LOADING);
  assert.equal(worstState(undefined), FEED_STATES.LOADING);
  assert.equal(worstState([undefined, null]), FEED_STATES.LOADING);
});

test('regions are named only at a resolution the strip can defend', () => {
  assert.equal(coarseRegion(27.7, 85.3), 'SOUTH ASIA');
  assert.equal(coarseRegion(35.7, 139.7), 'EAST ASIA');
  assert.equal(coarseRegion(48.9, 2.35), 'EUROPE');
  assert.equal(coarseRegion(30.3, -97.7), 'NORTH AMERICA');
});

test('a point outside every band falls back to coordinates, not a guess', () => {
  // The strip has no geocoder. Inventing a country name from a centroid would
  // be asserting something it never looked up.
  const open = coarseRegion(-40, -120);
  assert.match(open, /40°S 120°W/);
  assert.equal(coarseRegion(Number.NaN, 0), '—');
});

test('UTC is rendered as a zulu clock', () => {
  assert.equal(formatUtc(new Date('2026-09-19T04:07:09Z')), '04:07:09Z');
  assert.equal(formatUtc(new Date('2026-09-19T23:59:00Z')), '23:59:00Z');
});

test('the viewing line appears only when the camera has actually left home', () => {
  // Two locations are in play and the chip must be honest about both — but a
  // VIEWING line that never went away would be noise, and one that never
  // appeared would make the console look like it was ignoring the globe.
  assert.equal(samePlace('Bengaluru', 'Bengaluru'), true);
  assert.equal(samePlace('Bengaluru', 'Kathmandu'), false);

  // The two names come from different geocoder queries — a coarse reverse
  // lookup for the device and a camera-bucket lookup for the view — so the
  // same city arrives spelled differently and must still count as home.
  assert.equal(samePlace('Bengaluru', 'Bengaluru Urban'), true);
  assert.equal(samePlace('bengaluru', 'BENGALURU'), true);
  assert.equal(samePlace('Chamorshi Taluka', 'Chamorshi'), true);

  // A missing name is not a match: with nothing to compare, the line stays
  // hidden rather than claiming the camera is somewhere it may not be.
  assert.equal(samePlace('', 'Bengaluru'), false);
  assert.equal(samePlace('Bengaluru', null), false);
  assert.equal(samePlace(null, undefined), false);
});
