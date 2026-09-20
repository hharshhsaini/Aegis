import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_RADIUS_KM,
  NEARBY_RADIUS_KM,
  PROVENANCE,
  PROXIMITY,
  REGIONAL_RADIUS_KM,
  classifyRelevance,
  compareRelevance,
  distanceKm,
  formatDistance,
  isGloballySignificant,
  localSet,
  partitionByScope,
  passesThreshold,
  proximityOf,
} from './relevance.js';
import {
  MATERIAL_SEVERITY_DELTA,
  composeAnnouncement,
  createAnnouncer,
} from './announcer.js';
import {
  composeChangeBriefing,
  composeSituationBriefing,
  composeWorldBriefing,
} from './briefing.js';
import { createIncident } from '../incidents/model.js';

/**
 * These tests are mostly about what must NOT happen. The alert layer can wake
 * somebody up, so the rules it enforces — distance beats severity, a model
 * never speaks with authority, a feed cannot repeat itself into noise — are
 * pinned here rather than left to review.
 */

const BENGALURU = { latitude: 12.9716, longitude: 77.5946 };
const NOW = Date.parse('2026-09-20T12:00:00Z');

const at = (latitude, longitude, over = {}) =>
  createIncident({
    id: over.id || 'eq:1',
    kind: over.kind || 'EARTHQUAKE',
    title: over.title || 'M5.1 earthquake',
    place: over.place ?? 'Somewhere',
    severity: over.severity ?? 60,
    observedAt: over.observedAt ?? NOW - 60_000,
    location: { latitude, longitude },
    source: over.source || 'USGS',
    summary: over.summary || '',
  });

test('distance is great-circle and survives unusable input', () => {
  // Bengaluru to Chennai is ~290 km.
  const chennai = { latitude: 13.0827, longitude: 80.2707 };
  const km = distanceKm(BENGALURU, chennai);
  assert.ok(km > 270 && km < 310, `got ${km}`);
  assert.equal(distanceKm(BENGALURU, null), null);
  assert.equal(distanceKm(null, chennai), null);
  assert.equal(distanceKm(BENGALURU, { latitude: 'x', longitude: 1 }), null);
});

test('an unknown distance is treated as global, never as near', () => {
  // Not knowing where something is must never earn an interruption.
  assert.equal(proximityOf(null), PROXIMITY.GLOBAL);
  assert.equal(proximityOf(Number.NaN), PROXIMITY.GLOBAL);
});

test('distance bands follow the documented edges', () => {
  assert.equal(proximityOf(10), PROXIMITY.LOCAL);
  assert.equal(proximityOf(50), PROXIMITY.LOCAL);
  assert.equal(proximityOf(120), PROXIMITY.NEARBY);
  assert.equal(proximityOf(400), PROXIMITY.REGIONAL);
  assert.equal(proximityOf(8000), PROXIMITY.GLOBAL);
});

test('the same magnitude near and far reach different levels', () => {
  // The core promise: a person is not interrupted about the far side of the
  // planet by an event that would matter next door.
  const near = classifyRelevance({
    incident: at(13.0, 77.6, { severity: 65 }),
    userLocation: BENGALURU,
    now: NOW,
  });
  const far = classifyRelevance({
    incident: at(35.6, 139.7, { id: 'eq:2', severity: 65 }),
    userLocation: BENGALURU,
    now: NOW,
  });
  assert.equal(near.proximity, PROXIMITY.LOCAL);
  assert.equal(near.level, 'WARNING');
  assert.equal(far.proximity, PROXIMITY.GLOBAL);
  assert.equal(far.speakable, false, 'a distant M5 must not speak');
});

test('a distant event must be severe before it is heard at all', () => {
  const major = classifyRelevance({
    incident: at(35.6, 139.7, { id: 'eq:3', severity: 92 }),
    userLocation: BENGALURU,
    now: NOW,
  });
  assert.equal(major.proximity, PROXIMITY.GLOBAL);
  assert.equal(major.speakable, true);
  assert.equal(major.level, 'NOTICE', 'severe but distant is not a warning');
});

test('a model score is capped below WARNING however high it reads', () => {
  // A risk index moving is not an event happening.
  const model = classifyRelevance({
    incident: at(12.98, 77.6, { id: 'wx:1', kind: 'WEATHER', severity: 95 }),
    userLocation: BENGALURU,
    provenance: PROVENANCE.MODEL,
    now: NOW,
  });
  assert.equal(model.proximity, PROXIMITY.LOCAL);
  assert.equal(model.level, 'NOTICE');
  assert.notEqual(model.level, 'URGENT');
});

test('only an official warning, and only a near one, reaches URGENT', () => {
  const near = classifyRelevance({
    incident: at(12.98, 77.6, { id: 'off:1', severity: 30 }),
    userLocation: BENGALURU,
    provenance: PROVENANCE.OFFICIAL,
    now: NOW,
  });
  assert.equal(near.level, 'URGENT');
  assert.equal(near.speakable, true, 'an authority speaks regardless of score');

  // An official warning for the other side of the world is news, not an alarm.
  const far = classifyRelevance({
    incident: at(35.6, 139.7, { id: 'off:2', severity: 30 }),
    userLocation: BENGALURU,
    provenance: PROVENANCE.OFFICIAL,
    now: NOW,
  });
  assert.equal(far.level, 'WARNING');
});

test('the user threshold gates what voice may consider', () => {
  const notice = classifyRelevance({
    incident: at(35.6, 139.7, { id: 'eq:4', severity: 92 }),
    userLocation: BENGALURU,
    now: NOW,
  });
  assert.equal(passesThreshold(notice, 'ALL'), true);
  assert.equal(passesThreshold(notice, 'IMPORTANT'), true);
  assert.equal(passesThreshold(notice, 'WARNING+'), false);
  assert.equal(passesThreshold(notice, 'URGENT ONLY'), false);
  assert.equal(passesThreshold({ speakable: false }, 'ALL'), false);
});

test('ordering puts the near and serious first', () => {
  const mk = (proximity, level, severity) => ({
    proximity,
    level,
    severity,
    ageMs: 0,
  });
  const sorted = [
    mk(PROXIMITY.GLOBAL, 'NOTICE', 95),
    mk(PROXIMITY.LOCAL, 'NOTICE', 40),
    mk(PROXIMITY.LOCAL, 'WARNING', 60),
    mk(PROXIMITY.REGIONAL, 'WARNING', 80),
  ].sort(compareRelevance);
  assert.deepEqual(
    sorted.map((entry) => `${entry.proximity}/${entry.level}`),
    ['LOCAL/WARNING', 'LOCAL/NOTICE', 'REGIONAL/WARNING', 'GLOBAL/NOTICE'],
  );
});

test('wording names the source and the kind of statement', () => {
  const incident = at(12.98, 77.6, { severity: 65 });
  const observed = composeAnnouncement({
    incident,
    relevance: classifyRelevance({
      incident,
      userLocation: BENGALURU,
      now: NOW,
    }),
  });
  assert.match(observed, /USGS reports/);

  const fire = at(12.98, 77.6, {
    id: 'fire:1',
    kind: 'FIRE',
    title: 'Active fire cluster',
    source: 'NASA FIRMS',
    severity: 65,
  });
  const fireText = composeAnnouncement({
    incident: fire,
    relevance: classifyRelevance({
      incident: fire,
      userLocation: BENGALURU,
      now: NOW,
    }),
  });
  // FIRMS sees thermal anomalies; the sentence has to say so.
  assert.match(fireText, /thermal anomaly detection, not a confirmed wildfire/);
  assert.ok(!/wildfire is heading/i.test(fireText));
});

test('no template can turn a model score into a prediction or an instruction', () => {
  const incident = at(12.98, 77.6, {
    id: 'wx:2',
    kind: 'WEATHER',
    title: 'Flood Risk',
    source: 'Open-Meteo',
    severity: 72,
  });
  const text = composeAnnouncement({
    incident,
    relevance: classifyRelevance({
      incident,
      userLocation: BENGALURU,
      provenance: PROVENANCE.MODEL,
      now: NOW,
    }),
  });
  assert.match(text, /model estimate, not an observation/);
  for (const forbidden of [
    /will flood/i,
    /you are in danger/i,
    /do not go out/i,
    /evacuate/i,
    /heading toward/i,
    /is going to happen/i,
  ])
    assert.ok(!forbidden.test(text), `unsafe phrasing: ${forbidden}`);
});

test('only an official record produces authoritative phrasing', () => {
  const incident = at(12.98, 77.6, {
    id: 'off:3',
    title: 'Cyclone warning',
    source: 'NDMA',
  });
  const official = composeAnnouncement({
    incident,
    relevance: classifyRelevance({
      incident,
      userLocation: BENGALURU,
      provenance: PROVENANCE.OFFICIAL,
      now: NOW,
    }),
  });
  assert.match(official, /An official warning has been issued/);

  const observed = composeAnnouncement({
    incident,
    relevance: classifyRelevance({
      incident,
      userLocation: BENGALURU,
      now: NOW,
    }),
  });
  assert.ok(
    !/official warning/i.test(observed),
    'observed data claimed authority',
  );
});

/** An announcer with a controllable clock and captured speech. */
function announcerFixture({ threshold = 'IMPORTANT', enabled = true } = {}) {
  let clock = NOW;
  const spokenText = [];
  const cards = [];
  const announcer = createAnnouncer({
    speak: (text) => spokenText.push(text),
    onAnnounce: (card) => cards.push(card),
    now: () => clock,
    readThreshold: () => threshold,
    readEnabled: () => enabled,
  });
  return {
    announcer,
    spokenText,
    cards,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const localWarning = (over = {}) => {
  const incident = at(12.98, 77.6, { severity: 65, ...over });
  return {
    incident,
    relevance: classifyRelevance({
      incident,
      userLocation: BENGALURU,
      now: NOW,
    }),
  };
};

test('an incident is announced once, not on every feed refresh', () => {
  const f = announcerFixture();
  assert.equal(f.announcer.consider(localWarning()).spoken, true);
  for (let i = 0; i < 4; i += 1) {
    const again = f.announcer.consider(localWarning());
    assert.equal(again.spoken, false);
    assert.equal(again.reason, 'already-announced');
  }
  assert.equal(
    f.spokenText.length,
    1,
    'five updates produced one announcement',
  );
});

test('a material change re-announces; a refined number does not', () => {
  const f = announcerFixture();
  f.announcer.consider(localWarning());
  f.advance(10 * 60_000);

  const tweak = f.announcer.consider(
    localWarning({ severity: 65 + MATERIAL_SEVERITY_DELTA - 5 }),
  );
  assert.equal(tweak.spoken, false, 'a small revision stayed silent');

  const jump = f.announcer.consider(
    localWarning({ severity: 65 + MATERIAL_SEVERITY_DELTA }),
  );
  assert.equal(jump.spoken, true, 'a large move was re-announced');
});

test('the cooldown holds back a second routine announcement', () => {
  const f = announcerFixture();
  f.announcer.consider(localWarning({ id: 'eq:a' }));
  const immediate = f.announcer.consider(localWarning({ id: 'eq:b' }));
  assert.equal(immediate.spoken, false);
  assert.equal(immediate.reason, 'cooling-down');

  f.advance(90_000);
  assert.equal(f.announcer.consider(localWarning({ id: 'eq:c' })).spoken, true);
});

test('an official warning is never held behind a routine announcement', () => {
  const f = announcerFixture();
  f.announcer.consider(localWarning({ id: 'eq:d' }));
  const incident = at(12.98, 77.6, {
    id: 'off:4',
    title: 'Cyclone warning',
    source: 'NDMA',
  });
  const urgent = f.announcer.consider({
    incident,
    relevance: classifyRelevance({
      incident,
      userLocation: BENGALURU,
      provenance: PROVENANCE.OFFICIAL,
      now: NOW,
    }),
  });
  assert.equal(urgent.spoken, true, 'an authority bypassed the cooldown');
});

test('muting silences the audio but still shows the card', () => {
  const f = announcerFixture({ enabled: false });
  assert.equal(f.announcer.consider(localWarning()).spoken, true);
  assert.equal(f.spokenText.length, 0, 'nothing was spoken');
  assert.equal(f.cards.length, 1, 'the operator still sees it');
});

test('a raised threshold suppresses lower levels', () => {
  const f = announcerFixture({ threshold: 'URGENT ONLY' });
  const decision = f.announcer.consider(localWarning());
  assert.equal(decision.spoken, false);
  assert.equal(decision.reason, 'below-threshold');
});

test('the situation briefing reports an absence of records, not safety', () => {
  const briefing = composeSituationBriefing({
    location: {
      locationName: 'Bengaluru',
      region: 'Karnataka',
      country: 'India',
    },
    scored: [],
  });
  assert.match(briefing.text, /You are currently in Bengaluru, Karnataka\./);
  assert.match(
    briefing.text,
    /No incidents have been recorded within 50 kilometres/,
  );
  // "Nothing recorded" is a statement about the feeds; "you are safe" is not.
  assert.ok(!/safe|all clear|no danger/i.test(briefing.text));
});

test('the situation briefing counts each band and names the closest', () => {
  const mk = (lat, lon, over) => {
    const incident = at(lat, lon, over);
    return {
      incident,
      relevance: classifyRelevance({
        incident,
        userLocation: BENGALURU,
        now: NOW,
      }),
    };
  };
  const briefing = composeSituationBriefing({
    location: {
      locationName: 'Bengaluru',
      region: 'Karnataka',
      country: 'India',
    },
    scored: [
      mk(12.99, 77.6, { id: 'a', title: 'M4.2 earthquake' }),
      mk(13.9, 77.6, { id: 'b', title: 'M3.9 earthquake' }),
      mk(35.6, 139.7, { id: 'c', title: 'M6.4 earthquake', severity: 92 }),
    ],
  });
  assert.equal(briefing.counts.local, 1);
  assert.equal(briefing.counts.global, 1);
  assert.match(briefing.text, /M4\.2 earthquake/);
  assert.match(
    briefing.text,
    /not currently assessed as locally relevant/,
  );
});

test('an unconfigured official feed is disclosed in the briefing', () => {
  const briefing = composeSituationBriefing({
    location: { locationName: 'Bengaluru' },
    scored: [],
    officialAlerts: { configured: false },
  });
  assert.match(briefing.text, /Official warning feeds are not configured/);
});

test('the change briefing covers only what is new', () => {
  const quiet = composeChangeBriefing({ announcements: [], scored: [] });
  assert.match(quiet.text, /Nothing new has been recorded/);

  const busy = composeChangeBriefing({
    announcements: [
      {
        text: 'USGS reports M5.2 earthquake approximately 140 kilometres from your location.',
        at: NOW,
      },
      {
        text: 'An active fire cluster has been detected approximately 30 kilometres from your location.',
        at: NOW + 1,
      },
    ],
  });
  assert.match(busy.text, /2 significant events were detected/);
  assert.match(busy.text, /fire cluster/);
});

test('the world briefing summarises rather than reading everything out', () => {
  const many = Array.from({ length: 12 }, (_, index) => {
    const incident = at(35 + index, 139, { id: `w${index}`, severity: 80 });
    return {
      incident,
      relevance: classifyRelevance({
        incident,
        userLocation: BENGALURU,
        now: NOW,
      }),
    };
  });
  const briefing = composeWorldBriefing({ scored: many });
  assert.equal(briefing.counts.significant, 3, 'capped at three');
  assert.equal(composeWorldBriefing({ scored: [] }).counts.significant, 0);
});

test('distances read the way a person would say them', () => {
  assert.equal(formatDistance(0.4), 'under 1 km away');
  assert.equal(formatDistance(4.25), '4.3 km away');
  assert.equal(formatDistance(72.4), '72 km away');
  assert.equal(formatDistance(null), '');
});

// --- Speaking unprompted ----------------------------------------------------

test('an unprompted announcement names itself before it says anything else', () => {
  // The listener may be in another tab. The first two words have to establish
  // who is talking and whether to stop what they are doing.
  const quake = at(13.0, 77.6, { severity: 65 });
  const warning = composeAnnouncement({
    incident: quake,
    relevance: classifyRelevance({
      incident: quake,
      userLocation: BENGALURU,
      now: NOW,
    }),
  });
  assert.ok(warning.startsWith('Aegis warning.'), warning);

  const distant = at(35.6, 139.7, { id: 'eq:far', severity: 92 });
  const update = composeAnnouncement({
    incident: distant,
    relevance: classifyRelevance({
      incident: distant,
      userLocation: BENGALURU,
      now: NOW,
    }),
  });
  assert.ok(update.startsWith('Aegis update.'), update);
});

test('a distant event is closed with a finding, never with reassurance', () => {
  const distant = at(35.6, 139.7, { id: 'eq:jp', severity: 92 });
  const text = composeAnnouncement({
    incident: distant,
    relevance: classifyRelevance({
      incident: distant,
      userLocation: BENGALURU,
      now: NOW,
    }),
  });
  assert.match(text, /No local impact has been identified/);
  // Aegis reports what it has found. It never tells anybody they are safe.
  for (const forbidden of [/you are safe/i, /no danger/i, /nothing to worry/i])
    assert.ok(!forbidden.test(text), `${forbidden} appeared in: ${text}`);
});

test('a sequence is announced as a sequence, not as a queue of events', () => {
  const spokenTexts = [];
  const announcer = createAnnouncer({
    speak: (text) => spokenTexts.push(text),
    now: () => NOW,
  });

  // Six separate nearby earthquakes arriving in one feed refresh.
  const entries = [0, 1, 2, 3, 4, 5].map((index) => {
    const incident = at(13.0 + index * 0.01, 77.6, {
      id: `eq:seq:${index}`,
      title: `M5.${index} earthquake`,
      severity: 62 + index,
    });
    return {
      incident,
      relevance: classifyRelevance({
        incident,
        userLocation: BENGALURU,
        now: NOW,
      }),
    };
  });

  const decisions = announcer.considerAll(entries);

  assert.equal(spokenTexts.length, 1, 'six events, one sentence');
  assert.match(spokenTexts[0], /Seismic activity has increased/);
  assert.match(spokenTexts[0], /6 events/);
  // The strongest is the evidence offered for the claim.
  assert.match(spokenTexts[0], /M5\.5 earthquake/);
  assert.equal(
    decisions.filter((decision) => decision.spoken).length,
    6,
    'every member is marked spoken, so the tail cannot leak out later',
  );
});

test('a grouped sequence does not re-announce its own members afterwards', () => {
  const spokenTexts = [];
  let clock = NOW;
  const announcer = createAnnouncer({
    speak: (text) => spokenTexts.push(text),
    now: () => clock,
  });

  const build = () =>
    [0, 1, 2, 3].map((index) => {
      const incident = at(13.0 + index * 0.01, 77.6, {
        id: `eq:tail:${index}`,
        severity: 64,
      });
      return {
        incident,
        relevance: classifyRelevance({
          incident,
          userLocation: BENGALURU,
          now: clock,
        }),
      };
    });

  announcer.considerAll(build());
  assert.equal(spokenTexts.length, 1);

  // The same four events, well past any cooldown. Nothing has changed about
  // them, so there is nothing new to say.
  clock += 30 * 60_000;
  announcer.considerAll(build());
  assert.equal(spokenTexts.length, 1, 'a refresh is not a new development');
});

test('two events of a kind stay individual — a pair is not a pattern', () => {
  const spokenTexts = [];
  let clock = NOW;
  const announcer = createAnnouncer({
    speak: (text) => spokenTexts.push(text),
    now: () => clock,
  });

  const entries = [0, 1].map((index) => {
    const incident = at(13.0 + index * 0.01, 77.6, {
      id: `eq:pair:${index}`,
      severity: 64,
    });
    return {
      incident,
      relevance: classifyRelevance({
        incident,
        userLocation: BENGALURU,
        now: clock,
      }),
    };
  });

  announcer.considerAll(entries);
  assert.equal(spokenTexts.length, 1, 'the second is held by the cooldown');
  assert.match(spokenTexts[0], /USGS reports/, 'said as an individual event');
  assert.ok(!/activity has increased/.test(spokenTexts[0]));
});

test('a fire sequence keeps the thermal-anomaly qualifier', () => {
  const spokenTexts = [];
  const announcer = createAnnouncer({
    speak: (text) => spokenTexts.push(text),
    now: () => NOW,
  });

  const entries = [0, 1, 2, 3].map((index) => {
    const incident = at(13.0 + index * 0.01, 77.6, {
      id: `fire:${index}`,
      kind: 'FIRE',
      title: 'Active fire cluster',
      severity: 64,
      source: 'NASA FIRMS',
    });
    return {
      incident,
      relevance: classifyRelevance({
        incident,
        userLocation: BENGALURU,
        now: NOW,
      }),
    };
  });

  announcer.considerAll(entries);
  assert.equal(spokenTexts.length, 1);
  // Volume must never upgrade a detection into a confirmed wildfire.
  assert.match(spokenTexts[0], /not confirmed wildfires/);
  assert.ok(!/wildfire is heading/i.test(spokenTexts[0]));
});

// --- Geography ---------------------------------------------------------------

test('the configured radii are the ones the pipeline actually enforces', () => {
  // The panel used to print "WITHIN 50 KM" beside a count produced by a
  // different rule. These are the same numbers doing both jobs.
  assert.equal(LOCAL_RADIUS_KM, 50);
  assert.equal(NEARBY_RADIUS_KM, 250);
  assert.equal(REGIONAL_RADIUS_KM, 1000);

  assert.equal(proximityOf(LOCAL_RADIUS_KM - 1), PROXIMITY.LOCAL);
  assert.equal(proximityOf(LOCAL_RADIUS_KM + 1), PROXIMITY.NEARBY);
  assert.equal(proximityOf(NEARBY_RADIUS_KM + 1), PROXIMITY.REGIONAL);
  assert.equal(proximityOf(REGIONAL_RADIUS_KM + 1), PROXIMITY.GLOBAL);
});

test('a local surface never presents a distant event as a near one', () => {
  // The bug this pins: with the camera over another continent, every incident
  // the console held was thousands of kilometres away, and the local panel
  // listed them as "nearest" because they were the only ones there were.
  const far = [
    at(-1.29, 36.82, { id: 'fire:nairobi', kind: 'FIRE', severity: 70 }),
    at(51.5, -0.12, { id: 'fire:london', kind: 'FIRE', severity: 65 }),
  ].map((incident) => ({
    incident,
    relevance: classifyRelevance({
      incident,
      userLocation: BENGALURU,
      now: NOW,
    }),
  }));

  for (const entry of far)
    assert.ok(
      entry.relevance.distanceKm > REGIONAL_RADIUS_KM,
      `${entry.incident.id} was ${entry.relevance.distanceKm} km away`,
    );

  // An empty local set is the honest answer, not the closest of a set that was
  // never about this location.
  assert.deepEqual(localSet(far), []);
  assert.equal(partitionByScope(far).global.length, 2);
});

test('the same event is local to one place and global to another', () => {
  // The hard acceptance criterion: two locations must not receive identical
  // intelligence about the same world.
  const kathmandu = { latitude: 27.7172, longitude: 85.324 };
  const quake = at(27.8, 85.4, { id: 'eq:np', severity: 70 });

  const toKathmandu = classifyRelevance({
    incident: quake,
    userLocation: kathmandu,
    now: NOW,
  });
  const toBengaluru = classifyRelevance({
    incident: quake,
    userLocation: BENGALURU,
    now: NOW,
  });

  assert.equal(toKathmandu.proximity, PROXIMITY.LOCAL);
  assert.equal(toBengaluru.proximity, PROXIMITY.GLOBAL);
  assert.ok(toKathmandu.distanceKm < 20, `${toKathmandu.distanceKm} km`);
  assert.ok(toBengaluru.distanceKm > 1500, `${toBengaluru.distanceKm} km`);

  // And the difference reaches the voice: near enough to speak there, silent
  // here.
  assert.equal(toKathmandu.speakable, true);
  assert.equal(toBengaluru.speakable, false);
});

test('severity can carry a distant event, but the floor is high', () => {
  const major = at(35.6, 139.7, { id: 'eq:major', severity: 95 });
  const ordinary = at(35.6, 139.7, { id: 'eq:ordinary', severity: 70 });
  const score = (incident) => ({
    incident,
    relevance: classifyRelevance({
      incident,
      userLocation: BENGALURU,
      now: NOW,
    }),
  });

  assert.equal(isGloballySignificant(score(major)), true);
  assert.equal(isGloballySignificant(score(ordinary)), false);
});
