import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_FOCUS_MIN_MAGNITUDE,
  FOCUS_SOURCES,
  createEventFocus,
  worthUnpromptedFocus,
} from './eventFocus.js';
import { buildEventBriefing, proximityPhrase, timePhrase } from './eventBriefing.js';

/**
 * The bug these cover: clicking an earthquake marker did nothing. The pick
 * succeeded, the handler checked whether it had MISSED, and dropped the hit —
 * so the camera moved, the marker was under the cursor, and no part of the
 * intelligence system was ever told.
 *
 * What must stay true now that it is told: a click always gets an answer, the
 * camera alone usually does not, the same event is not narrated twice, and a
 * distant event is never described as a personal one.
 */

const NOW = Date.parse('2026-09-20T12:00:00Z');

const quake = (over = {}) => ({
  id: over.id || 'us7000abcd',
  kind: 'EARTHQUAKE',
  magnitude: over.magnitude ?? 2.6,
  depth: over.depth ?? 10,
  place: over.place ?? '55 km W of Anchor Point, Alaska',
  time: over.time ?? NOW - 9 * 60_000,
  status: over.status ?? 'automatic',
  tsunami: over.tsunami ?? false,
  felt: over.felt ?? null,
  latitude: over.latitude ?? 59.7,
  longitude: over.longitude ?? -152.8,
});

test('an explicit click always earns a briefing, however small the event', () => {
  // The exact reported case: a magnitude 2.6 would never be announced on its
  // own, but clicking it is a question and a question deserves an answer.
  const focus = createEventFocus({ now: () => NOW });
  const result = focus.focus(quake(), FOCUS_SOURCES.MARKER_CLICK);

  assert.equal(result.speak, true);
  assert.equal(result.reason, 'explicit');
  assert.equal(result.type, 'EVENT_FOCUSED');
  assert.equal(focus.current().id, 'us7000abcd');
});

test('the camera alone does not narrate every small event it passes', () => {
  const focus = createEventFocus({ now: () => NOW });

  // Drifting over a minor event must not start a commentary.
  const minor = focus.focus(quake({ magnitude: 2.6 }), FOCUS_SOURCES.CAMERA);
  assert.equal(minor.speak, false);
  assert.equal(minor.reason, 'below-camera-threshold');

  // A significant one being inspected is worth saying once.
  const major = focus.focus(
    quake({ id: 'us-major', magnitude: 5.4 }),
    FOCUS_SOURCES.CAMERA,
  );
  assert.equal(major.speak, true);
  assert.equal(worthUnpromptedFocus({ magnitude: CAMERA_FOCUS_MIN_MAGNITUDE }), true);
  assert.equal(worthUnpromptedFocus({ magnitude: 4.4 }), false);
  // A non-seismic event has no equivalent single number to threshold on, so it
  // is never narrated on sight.
  assert.equal(worthUnpromptedFocus({ kind: 'FIRE' }), false);
});

test('nudging the camera around one event is one briefing, not twenty', () => {
  let clock = NOW;
  const focus = createEventFocus({ now: () => clock });

  assert.equal(focus.focus(quake(), FOCUS_SOURCES.MARKER_CLICK).speak, true);

  clock += 5_000;
  const again = focus.focus(quake(), FOCUS_SOURCES.MARKER_CLICK);
  assert.equal(again.speak, false);
  assert.equal(again.reason, 'already-briefed');

  // Past the cooldown it may be asked about again.
  clock += 61_000;
  assert.equal(focus.focus(quake(), FOCUS_SOURCES.MARKER_CLICK).speak, true);
});

test('clicking a different event always answers, cooldown or not', () => {
  let clock = NOW;
  const focus = createEventFocus({ now: () => clock });
  focus.focus(quake({ id: 'first' }), FOCUS_SOURCES.MARKER_CLICK);

  clock += 1_000;
  // The operator just asked about something else. Holding that behind a
  // cooldown would make the console look broken.
  const second = focus.focus(quake({ id: 'second' }), FOCUS_SOURCES.MARKER_CLICK);
  assert.equal(second.speak, true);
  assert.equal(focus.lastSpokenId(), 'second');
});

test('subscribers are told about every focus, spoken or not', () => {
  const seen = [];
  const focus = createEventFocus({ now: () => NOW });
  const off = focus.subscribe((payload) =>
    seen.push(`${payload.eventId}:${payload.speak}`),
  );

  focus.focus(quake({ id: 'a' }), FOCUS_SOURCES.MARKER_CLICK);
  focus.focus(quake({ id: 'b', magnitude: 1.2 }), FOCUS_SOURCES.CAMERA);

  // The overlay still needs to highlight an event the voice declined to
  // narrate, so a silent focus is still published.
  assert.deepEqual(seen, ['a:true', 'b:false']);
  off();
  focus.focus(quake({ id: 'c' }), FOCUS_SOURCES.MARKER_CLICK);
  assert.equal(seen.length, 2);
});

// --- The briefing itself -----------------------------------------------------

test('a viewed event is described as viewed, never as near you', () => {
  // Bengaluru device, Alaskan earthquake: the exact confusion §8 forbids.
  const text = buildEventBriefing(quake(), {
    deviceDistanceKm: 9_100,
    viewedPlaceName: 'Alaska',
    now: NOW,
  });

  assert.ok(!/from your location/i.test(text), text);
  assert.ok(!/near you/i.test(text), text);
  assert.match(text, /Anchor Point/);
});

test('a genuinely near event is described as near', () => {
  const text = buildEventBriefing(quake({ place: null }), {
    deviceDistanceKm: 42,
    viewedPlaceName: 'Bengaluru',
    now: NOW,
  });
  assert.match(text, /42 kilometres from your location/);
});

test('the briefing states only fields the provider actually published', () => {
  const text = buildEventBriefing(quake(), { now: NOW });
  assert.match(text, /Magnitude 2\.6/);
  assert.match(text, /depth of 10 kilometres/);
  assert.match(text, /Recorded 9 minutes ago/);
  assert.match(text, /automatic solution that has not yet been reviewed/);

  // A missing depth is omitted, never defaulted. A fabricated "10 km" would
  // be indistinguishable from a real reading.
  const sparse = buildEventBriefing(
    { kind: 'EARTHQUAKE', id: 'x', magnitude: 3.1, depth: null, place: null, time: null },
    { now: NOW },
  );
  assert.ok(!/depth/i.test(sparse), sparse);
  assert.ok(!/Recorded/.test(sparse), sparse);
  assert.match(sparse, /Magnitude 3\.1/);
});

test('the tsunami flag is reported as a flag, never as an all-clear', () => {
  const quiet = buildEventBriefing(quake(), { now: NOW });
  assert.match(quiet, /has not set a tsunami flag/);
  // "No tsunami" would be Aegis making a claim USGS did not.
  assert.ok(!/no tsunami (is|will|expected)/i.test(quiet), quiet);

  const flagged = buildEventBriefing(quake({ tsunami: true }), { now: NOW });
  assert.match(flagged, /has set a tsunami flag/);
});

test('no briefing tells anybody they are in danger or what to do', () => {
  const samples = [
    buildEventBriefing(quake({ magnitude: 7.8 }), { deviceDistanceKm: 5, now: NOW }),
    buildEventBriefing(
      { kind: 'FIRE', id: 'f', detectionCount: 120, maxFrp: 340 },
      { deviceDistanceKm: 8, now: NOW },
    ),
    buildEventBriefing(
      { kind: 'WEATHER', id: 'w', title: 'Flood risk', severity: 91 },
      { deviceDistanceKm: 3, now: NOW },
    ),
  ];
  for (const text of samples)
    for (const forbidden of [
      /evacuat/i,
      /stay indoors/i,
      /do not go/i,
      /you are in danger/i,
      /seek shelter/i,
      /will (flood|strike|hit)/i,
    ])
      assert.ok(!forbidden.test(text), `${forbidden} appeared in: ${text}`);
});

test('a fire briefing keeps the thermal-anomaly qualifier', () => {
  const text = buildEventBriefing(
    { kind: 'FIRE', id: 'f', detectionCount: 50, maxFrp: 210, meanConfidence: 64 },
    { deviceDistanceKm: 18, now: NOW },
  );
  assert.match(text, /50 satellite thermal detections/);
  assert.match(text, /not a confirmed wildfire/);
  assert.match(text, /18 kilometres from your location/);
});

test('a hazard briefing is labelled as a model estimate', () => {
  const text = buildEventBriefing(
    { kind: 'WEATHER', id: 'w', title: 'Flood risk', severity: 72 },
    { viewedPlaceName: 'Nepal', now: NOW },
  );
  assert.match(text, /model score is 72 out of 100/);
  assert.match(text, /model estimate/);
  assert.ok(!/is flooding/i.test(text), text);
});

test('time and proximity phrases degrade rather than guess', () => {
  assert.equal(timePhrase(null, NOW), '');
  assert.equal(timePhrase(NOW + 5_000, NOW), '', 'a future stamp says nothing');
  assert.equal(timePhrase(NOW - 30_000, NOW), 'less than a minute ago');
  assert.equal(timePhrase(NOW - 2 * 3_600_000, NOW), 'about 2 hours ago');

  assert.equal(proximityPhrase({}), '');
  assert.equal(proximityPhrase({ deviceDistanceKm: null }), '');
});
