import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsgsFeed, toEarthquakeEvent, feedUrl } from './usgsEvents.js';
import { clusterEarthquakes, describeSequence, distanceKm } from './sequences.js';
import { earthquakeActivity, ACTIVITY_STATES } from './activity.js';
import { assessAlert, deriveEarthquakeEvents, EARTHQUAKE_EVENTS } from './alerts.js';
import {
  geographicExposure,
  normalizeAnalysisRadiusKm,
  EXPOSURE_STATUS,
  ANALYSIS_RADIUS_LABEL,
} from './exposure.js';
import {
  assembleEarthquakeIntelligence,
  earthquakeIncidentRecord,
  responseWeatherContext,
} from './intelligence.js';
import { magnitudeCategory, depthCategory, USGS_FEEDS } from './thresholds.js';

/**
 * The line this layer must never cross is prediction. These tests check the
 * arithmetic, and equally that the language stays on observations USGS made.
 */

const NOW = Date.parse('2026-09-18T12:00:00Z');

/** Build a USGS-shaped feature. */
function feature({
  id = 'us1000abcd',
  lat = 35.7,
  lon = 139.7,
  depth = 18,
  mag = 6.4,
  time = NOW - 20 * 60_000,
  place = '12 km ESE of Somewhere',
  felt = null,
  tsunami = 0,
  sig = null,
  status = 'reviewed',
  alert = null,
  type = 'earthquake',
} = {}) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [lon, lat, depth] },
    properties: {
      mag,
      place,
      time,
      updated: time + 60_000,
      url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
      detail: `https://earthquake.usgs.gov/.../${id}.geojson`,
      felt,
      cdi: felt ? 4.6 : null,
      mmi: null,
      alert,
      status,
      tsunami,
      sig: sig ?? Math.round((mag ?? 0) * 100),
      net: 'us',
      code: id.slice(2),
      magType: 'mww',
      type,
      title: `M ${mag} - ${place}`,
    },
  };
}

const feed = (features, metadata = {}) => ({
  type: 'FeatureCollection',
  metadata: { generated: NOW, title: 'USGS All Earthquakes, Past Day', ...metadata },
  features,
});

test('a USGS feature normalizes into the Aegis model with its metadata intact', () => {
  const event = toEarthquakeEvent(
    feature({ felt: 1284, tsunami: 1, sig: 842, alert: 'orange' }),
  );
  assert.equal(event.id, 'us1000abcd');
  assert.equal(event.magnitude, 6.4);
  assert.equal(event.depth, 18);
  assert.equal(event.latitude, 35.7);
  assert.equal(event.longitude, 139.7);
  assert.equal(event.place, '12 km ESE of Somewhere');
  assert.equal(event.timeIso, new Date(NOW - 20 * 60_000).toISOString());
  assert.ok(event.updatedIso);
  assert.equal(event.tsunami, true);
  assert.equal(event.felt, 1284);
  assert.equal(event.significance, 842);
  assert.equal(event.eventType, 'earthquake');
  assert.equal(event.status, 'reviewed');
  assert.equal(event.source, 'USGS');
  assert.match(event.url, /earthquake\.usgs\.gov\/earthquakes\/eventpage/);
  assert.equal(event.magnitudeCategory.label, 'Strong');
  assert.equal(event.depthCategory.label, 'Shallow');
  // Nothing USGS published is lost.
  assert.equal(event.raw.magType, 'mww');
  assert.equal(event.raw.alert, 'orange');
  assert.equal(event.raw.net, 'us');
});

test('the tsunami flag is read from USGS, never inferred from magnitude', () => {
  const big = toEarthquakeEvent(feature({ mag: 8.2, tsunami: 0 }));
  const small = toEarthquakeEvent(feature({ id: 'us2', mag: 4.1, tsunami: 1 }));
  assert.equal(big.tsunami, false, 'a great quake with no USGS flag is not flagged');
  assert.equal(small.tsunami, true, 'the flag follows USGS, not size');
});

test('a feed normalizes, deduplicates and orders newest first', () => {
  const snapshot = normalizeUsgsFeed(
    feed([
      feature({ id: 'a', time: NOW - 3 * 3_600_000 }),
      feature({ id: 'b', time: NOW - 60_000 }),
      feature({ id: 'a', time: NOW - 3 * 3_600_000 }),
      { type: 'Feature', id: 'bad', geometry: null, properties: {} },
    ]),
    { feed: 'all_day' },
  );
  assert.equal(snapshot.count, 2);
  assert.deepEqual(
    snapshot.events.map((event) => event.id),
    ['b', 'a'],
  );
  assert.equal(snapshot.attribution, 'USGS Earthquake Hazards Program');
  assert.equal(normalizeUsgsFeed({ nope: true }), null);
});

test('feed urls are the documented USGS summary feeds', () => {
  assert.equal(
    feedUrl('all_day'),
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
  );
  assert.equal(
    feedUrl('significant_week'),
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson',
  );
  assert.throws(() => feedUrl('everything_ever'), /Unknown USGS feed/);
  assert.ok(USGS_FEEDS.all_day.windowHours === 24);
});

test('magnitude and depth categories follow the configured bands', () => {
  assert.equal(magnitudeCategory(2.4).label, 'Minor');
  assert.equal(magnitudeCategory(2.5).label, 'Light');
  assert.equal(magnitudeCategory(4.5).label, 'Moderate');
  assert.equal(magnitudeCategory(6.0).label, 'Strong');
  assert.equal(magnitudeCategory(7.0).label, 'Major');
  assert.equal(magnitudeCategory(8.4).label, 'Great');
  assert.equal(magnitudeCategory(null), null);
  assert.equal(depthCategory(12).label, 'Shallow');
  assert.equal(depthCategory(120).label, 'Intermediate');
  assert.equal(depthCategory(450).label, 'Deep');
  assert.equal(depthCategory(null), null);
});

test('events close in space and time form one sequence', () => {
  const events = normalizeUsgsFeed(
    feed([
      ...Array.from({ length: 6 }, (_, index) =>
        feature({
          id: `seq${index}`,
          lat: 35.7 + index * 0.05,
          lon: 139.7,
          mag: 4 + index * 0.2,
          time: NOW - index * 20 * 60_000,
        }),
      ),
      feature({ id: 'far', lat: -20, lon: -70, time: NOW - 30 * 60_000 }),
    ]),
  ).events;
  const clusters = clusterEarthquakes(events, { now: NOW });
  const sequence = clusters.find((cluster) => cluster.eventCount > 1);
  assert.equal(sequence.eventCount, 6);
  assert.equal(sequence.kind, 'SEQUENCE');
  assert.equal(sequence.maxMagnitude, 5);
  assert.ok(sequence.minDepthKm <= sequence.maxDepthKm);
  assert.ok(sequence.spanHours > 0);
  assert.ok(sequence.eventsPerHour > 0);
  assert.ok(clusters.some((cluster) => cluster.eventCount === 1));
});

test('a sequence is described neutrally, never as aftershocks', () => {
  const events = normalizeUsgsFeed(
    feed(
      Array.from({ length: 5 }, (_, index) =>
        feature({ id: `s${index}`, lat: 35.7 + index * 0.02, time: NOW - index * 600_000 }),
      ),
    ),
  ).events;
  const [cluster] = clusterEarthquakes(events, { now: NOW });
  const text = describeSequence(cluster);
  assert.match(text, /Earthquake sequence detected/);
  assert.doesNotMatch(text, /aftershock|foreshock|mainshock/i);
});

test('events far apart in time are not one sequence', () => {
  const events = normalizeUsgsFeed(
    feed([
      feature({ id: 'x', lat: 35.7, lon: 139.7, time: NOW - 60_000 }),
      // Same place, four days earlier: outside the temporal window.
      feature({ id: 'y', lat: 35.7, lon: 139.7, time: NOW - 96 * 3_600_000 }),
    ]),
  ).events;
  const clusters = clusterEarthquakes(events, { now: NOW });
  assert.equal(clusters.length, 2);
});

test('activity rates are counted from the feed, and compared window to window', () => {
  const events = normalizeUsgsFeed(
    feed([
      ...Array.from({ length: 9 }, (_, index) =>
        feature({ id: `recent${index}`, time: NOW - index * 25 * 60_000 }),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        feature({ id: `older${index}`, time: NOW - (7 + index) * 3_600_000 }),
      ),
    ]),
  ).events;
  const activity = earthquakeActivity({ events, now: NOW, feedWindowHours: 24 });
  assert.equal(activity.rates.last1h, 3);
  assert.equal(activity.rates.last6h, 9);
  assert.equal(activity.rates.last24h, 12);
  assert.equal(activity.currentWindowEvents, 9);
  assert.equal(activity.previousWindowEvents, 3);
  assert.equal(activity.status, ACTIVITY_STATES.INCREASING);
  assert.equal(activity.changePercent, 200);
  assert.equal(activity.largestRecent.magnitude, 6.4);
});

test('a feed too short to hold two windows reports insufficient data', () => {
  const events = normalizeUsgsFeed(
    feed([feature({ id: 'one', time: NOW - 60_000 })]),
  ).events;
  const activity = earthquakeActivity({ events, now: NOW, feedWindowHours: 1 });
  assert.equal(activity.status, ACTIVITY_STATES.INSUFFICIENT);
  assert.equal(activity.changePercent, null);
  assert.equal(activity.note, 'Insufficient observations for trend analysis.');
});

test('alerts stay at INFORMATION unless the source data raises them', () => {
  const ordinary = toEarthquakeEvent(feature({ id: 'm3', mag: 3.2, sig: 120 }));
  assert.equal(assessAlert(ordinary).level, 'INFORMATION');

  const moderate = toEarthquakeEvent(feature({ id: 'm5', mag: 5.1, sig: 400 }));
  assert.equal(assessAlert(moderate).level, 'WATCH');

  const strong = toEarthquakeEvent(feature({ id: 'm6', mag: 6.4, sig: 700 }));
  const strongAlert = assessAlert(strong);
  assert.equal(strongAlert.level, 'SIGNIFICANT');
  assert.ok(strongAlert.drivers.some((driver) => /magnitude 6\.4/.test(driver)));

  // A USGS tsunami flag alone is enough, whatever the magnitude.
  const flagged = toEarthquakeEvent(feature({ id: 'ts', mag: 4.2, tsunami: 1 }));
  const flaggedAlert = assessAlert(flagged);
  assert.equal(flaggedAlert.level, 'SIGNIFICANT');
  assert.ok(flaggedAlert.drivers.some((driver) => /tsunami flag/.test(driver)));
});

test('a busy sequence raises a watch without a large event', () => {
  const events = normalizeUsgsFeed(
    feed(
      Array.from({ length: 10 }, (_, index) =>
        feature({
          id: `sw${index}`,
          mag: 3.1,
          sig: 100,
          lat: 35.7 + index * 0.01,
          time: NOW - index * 900_000,
        }),
      ),
    ),
  ).events;
  const [cluster] = clusterEarthquakes(events, { now: NOW });
  assert.equal(assessAlert(events[0], { cluster }).level, 'WATCH');
});

test('internal events are emitted for notable observations only', () => {
  const snapshot = normalizeUsgsFeed(
    feed([
      feature({ id: 'big', mag: 6.6, sig: 800, time: NOW - 300_000 }),
      ...Array.from({ length: 4 }, (_, index) =>
        feature({ id: `tiny${index}`, mag: 1.8, sig: 20, lat: -10 - index, lon: 20 }),
      ),
    ]),
    { feed: 'all_day' },
  );
  const intelligence = assembleEarthquakeIntelligence({ snapshot, now: NOW });
  const types = intelligence.internalEvents.map((event) => event.type);
  assert.ok(types.includes(EARTHQUAKE_EVENTS.SIGNIFICANT_EARTHQUAKE_DETECTED));
  // Four M1.8 events must not each raise an internal event.
  assert.equal(
    intelligence.internalEvents.filter(
      (event) => event.type === EARTHQUAKE_EVENTS.EARTHQUAKE_DETECTED,
    ).length,
    0,
  );
  const significant = intelligence.internalEvents.find(
    (event) => event.type === EARTHQUAKE_EVENTS.SIGNIFICANT_EARTHQUAKE_DETECTED,
  );
  assert.equal(significant.source, 'USGS');
  assert.equal(significant.eventId, 'big');
  assert.equal(significant.severity, 'SIGNIFICANT');
  assert.ok(significant.timestamp && significant.location && significant.drivers.length);
});

test('an event already reported is not announced again', () => {
  const snapshot = normalizeUsgsFeed(
    feed([feature({ id: 'big', mag: 6.6, sig: 800 })]),
    { feed: 'all_day' },
  );
  const first = assembleEarthquakeIntelligence({ snapshot, now: NOW });
  assert.equal(first.internalEvents.length >= 1, true);
  const second = assembleEarthquakeIntelligence({
    snapshot,
    now: NOW,
    previous: {
      clusters: first.clusters,
      activity: first.activity,
      eventIds: first.events.map((event) => event.id),
    },
  });
  assert.equal(
    second.internalEvents.filter((event) =>
      event.type.includes('EARTHQUAKE_DETECTED'),
    ).length,
    0,
  );
});

test('a sequence forming raises its own event', () => {
  const build = (count) =>
    normalizeUsgsFeed(
      feed(
        Array.from({ length: count }, (_, index) =>
          feature({
            id: `q${index}`,
            mag: 3.4,
            sig: 150,
            lat: 35.7 + index * 0.01,
            time: NOW - index * 600_000,
          }),
        ),
      ),
      { feed: 'all_day' },
    );
  const before = assembleEarthquakeIntelligence({ snapshot: build(2), now: NOW });
  const after = assembleEarthquakeIntelligence({
    snapshot: build(6),
    now: NOW,
    previous: {
      clusters: before.clusters,
      activity: before.activity,
      eventIds: before.events.map((event) => event.id),
    },
  });
  assert.ok(
    after.internalEvents.some(
      (event) => event.type === EARTHQUAKE_EVENTS.EARTHQUAKE_SEQUENCE_DETECTED,
    ),
  );
});

test('exposure reports its own absence instead of inventing infrastructure', async () => {
  const exposure = await geographicExposure({
    center: { latitude: 35.7, longitude: 139.7 },
    radiusKm: 25,
  });
  assert.equal(exposure.status, EXPOSURE_STATUS.UNAVAILABLE);
  assert.equal(exposure.analysisRadiusKm, 25);
  assert.equal(exposure.radiusLabel, ANALYSIS_RADIUS_LABEL);
  assert.match(exposure.basis, /Not a damage radius/);
  for (const category of Object.values(exposure.categories)) {
    assert.equal(category.count, null, 'no count may be invented');
    assert.equal(category.status, EXPOSURE_STATUS.UNAVAILABLE);
  }
  assert.match(exposure.note, /not connected/);
});

test('exposure uses a real provider when one is supplied', async () => {
  const exposure = await geographicExposure({
    center: { latitude: 35.7, longitude: 139.7 },
    radiusKm: 10,
    provider: {
      describe: async ({ radiusKm }) => ({
        attribution: 'OpenStreetMap contributors',
        hospitals: { count: 3, items: ['A', 'B', 'C'] },
        roads: { count: radiusKm },
      }),
    },
  });
  assert.equal(exposure.status, EXPOSURE_STATUS.READY);
  assert.equal(exposure.categories.hospitals.count, 3);
  assert.equal(exposure.categories.roads.count, 10);
  assert.equal(exposure.categories.schools.count, null);
  assert.equal(exposure.attribution, 'OpenStreetMap contributors');
});

test('the analysis radius snaps to an offered value', () => {
  assert.equal(normalizeAnalysisRadiusKm(5), 5);
  assert.equal(normalizeAnalysisRadiusKm(23), 25);
  assert.equal(normalizeAnalysisRadiusKm(4000), 100);
  assert.equal(normalizeAnalysisRadiusKm(null), 25);
});

test('weather is response context only, and says so', () => {
  const event = toEarthquakeEvent(feature());
  const wet = responseWeatherContext({
    event,
    metrics: { rain_6h: 18, forecast_rain_12h: 22, wind_speed_10m: 12 },
  });
  assert.equal(wet.relationship, 'RESPONSE_CONTEXT_ONLY');
  assert.match(wet.notes[0], /post-event response planning/);
  assert.match(wet.disclaimer, /no causal relationship/i);
  for (const note of wet.notes)
    assert.doesNotMatch(note, /caused|trigger|because of the rain|predict/i);
  // Quiet weather produces nothing at all rather than filler.
  assert.equal(
    responseWeatherContext({ event, metrics: { rain_6h: 0, wind_speed_10m: 5 } }),
    null,
  );
  assert.equal(responseWeatherContext({ event, metrics: null }), null);
});

test('the assembled intelligence reports only what USGS recorded', () => {
  const snapshot = normalizeUsgsFeed(
    feed([
      feature({ id: 'big', mag: 6.4, felt: 1284, sig: 842, time: NOW - 900_000 }),
      feature({ id: 'small', mag: 2.1, lat: -33, lon: -70, time: NOW - 1_800_000 }),
    ]),
    { feed: 'all_day' },
  );
  const intelligence = assembleEarthquakeIntelligence({ snapshot, now: NOW });
  assert.equal(intelligence.source, 'USGS');
  assert.equal(intelligence.attribution, 'USGS Earthquake Hazards Program');
  assert.equal(intelligence.eventCount, 2);
  assert.equal(intelligence.largestEvent.id, 'big');
  assert.deepEqual(intelligence.alerts.significant, ['big']);
  assert.match(intelligence.summary, /recorded by USGS/);
  // No prediction vocabulary anywhere in the payload.
  const text = JSON.stringify(intelligence);
  assert.doesNotMatch(text, /will occur|expected to strike|prediction|forecast(?!_)/i);
  assert.doesNotMatch(text, /damage|casualt|destroyed/i);
});

test('an empty view reports what was recorded, not that nothing happened', () => {
  const snapshot = normalizeUsgsFeed(feed([]), { feed: 'all_day' });
  const intelligence = assembleEarthquakeIntelligence({ snapshot, now: NOW });
  assert.equal(intelligence.eventCount, 0);
  assert.match(intelligence.summary, /No earthquakes recorded by USGS/);
  assert.doesNotMatch(intelligence.summary, /safe|no risk|nothing happened/i);
});

test('the Bedrock incident record carries USGS values and their constraints', () => {
  const snapshot = normalizeUsgsFeed(
    feed([feature({ id: 'big', mag: 6.4, felt: 1284, sig: 842, tsunami: 0 })]),
    { feed: 'all_day' },
  );
  const intelligence = assembleEarthquakeIntelligence({ snapshot, now: NOW });
  const event = intelligence.events[0];
  const record = earthquakeIncidentRecord(event, {
    cluster: intelligence.clusters[0],
    activity: intelligence.activity,
  });
  assert.equal(record.incidentType, 'EARTHQUAKE');
  assert.equal(record.source, 'USGS');
  assert.equal(record.eventId, 'big');
  assert.equal(record.magnitude, 6.4);
  assert.equal(record.depthKm, 18);
  assert.equal(record.feltReports, 1284);
  assert.equal(record.tsunamiFlag, false);
  assert.equal(record.usgsSignificance, 842);
  assert.equal(record.aegisAlertLevel, 'SIGNIFICANT');
  assert.match(record.usgsEventPage, /earthquake\.usgs\.gov/);
  assert.equal(record.geographicContext.radiusLabel, ANALYSIS_RADIUS_LABEL);
  assert.ok(
    record.constraints.some((line) => /cannot be predicted/i.test(line)),
    'the record must state what it does not claim',
  );
  assert.ok(JSON.parse(JSON.stringify(record)), 'must serialize for Bedrock');
});

test('distances are sane', () => {
  const oneDegree = distanceKm(
    { latitude: 0, longitude: 0 },
    { latitude: 1, longitude: 0 },
  );
  assert.ok(Math.abs(oneDegree - 111.2) < 1, `${oneDegree}`);
});
