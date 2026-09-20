import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDetections, normalizeConfidence } from './detections.js';
import {
  clusterDetections,
  distanceMeters,
  frpBand,
  MIN_CLUSTER_DETECTIONS,
} from './clustering.js';
import { compareActivity, ACTIVITY_STATES } from './activity.js';
import { deriveFireEvents, FIRE_EVENTS } from './events.js';
import { spreadVector, cardinalDirection } from './spreadVector.js';
import {
  assembleFireIntelligence,
  fireIncidentRecord,
  significantClusters,
} from './intelligence.js';
import {
  snapBoundingBox,
  clampBoundingBox,
  areaRequestUrl,
  redactMapKey,
  VIIRS_SOURCES,
  DEFAULT_SOURCES,
} from '../sources/firmsArea.js';
import { deriveMetrics } from '../weather/derived.js';
import { normalizeForecast } from '../weather/normalize.js';
import { syntheticForecast } from '../weather/testSupport/syntheticWeather.mjs';

/**
 * FIRMS publishes thermal anomalies, not confirmed fires, and these tests hold
 * the whole layer to that distinction as much as to its arithmetic.
 */

const HEADER =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';

/** Build a FIRMS CSV body from row overrides. */
function csv(rows) {
  const body = rows.map((row) => {
    const {
      lat,
      lon,
      bright = 330.1,
      date = '2026-09-18',
      time = '1012',
      sat = 'N20',
      conf = 'n',
      frp = 12.5,
      dn = 'D',
    } = row;
    return `${lat},${lon},${bright},0.4,0.4,${date},${time},${sat},VIIRS,${conf},2.0NRT,295.2,${frp},${dn}`;
  });
  return [HEADER, ...body].join('\n');
}

/** A tight group of detections around a point. */
function group(lat, lon, count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    lat: lat + index * 0.004,
    lon: lon + index * 0.004,
    ...overrides,
  }));
}

const NOW = Date.parse('2026-09-18T12:00:00Z');

test('FIRMS rows normalize into Aegis detections', () => {
  const detections = parseDetections(
    csv([{ lat: -30.6, lon: 148.04, conf: 'h', frp: 84.2, dn: 'N' }]),
    { source: 'VIIRS_NOAA20_NRT', now: NOW },
  );
  assert.equal(detections.length, 1);
  const [detection] = detections;
  assert.equal(detection.latitude, -30.6);
  assert.equal(detection.longitude, 148.04);
  assert.equal(detection.acquiredAt, '2026-09-18T10:12:00.000Z');
  assert.equal(detection.satelliteName, 'NOAA-20');
  assert.equal(detection.instrument, 'VIIRS');
  assert.equal(detection.confidence, 0.9);
  assert.equal(detection.confidenceRaw, 'h');
  assert.equal(detection.fireRadiativePower, 84.2);
  assert.equal(detection.brightnessTemperature, 330.1);
  assert.equal(detection.dayNight, 'NIGHT');
  assert.equal(detection.source, 'VIIRS_NOAA20_NRT');
  assert.equal(detection.provider, 'NASA FIRMS');
  assert.ok(detection.id.includes('@2026-09-18T10:12:00.000Z'));
});

test('confidence normalizes from both VIIRS classes and MODIS numbers', () => {
  assert.equal(normalizeConfidence('l'), 0.3);
  assert.equal(normalizeConfidence('n'), 0.65);
  assert.equal(normalizeConfidence('h'), 0.9);
  assert.equal(normalizeConfidence('80'), 0.8);
  assert.equal(normalizeConfidence(100), 1);
  assert.equal(normalizeConfidence(''), null);
  assert.equal(normalizeConfidence('nonsense'), null);
});

test('detections older than the window are dropped', () => {
  const detections = parseDetections(
    csv([
      { lat: 1, lon: 1, date: '2026-09-18', time: '1012' },
      { lat: 2, lon: 2, date: '2026-09-16', time: '1012' },
    ]),
    { source: 'VIIRS_NOAA20_NRT', now: NOW, maxAgeMs: 24 * 60 * 60 * 1000 },
  );
  assert.equal(detections.length, 1);
  assert.equal(detections[0].latitude, 1);
});

test('a malformed or empty response yields no detections rather than throwing', () => {
  assert.deepEqual(parseDetections('', { source: 'X' }), []);
  assert.deepEqual(parseDetections(HEADER, { source: 'X' }), []);
  assert.deepEqual(parseDetections('<html>error</html>', { source: 'X' }), []);
});

test('nearby detections form one cluster and distant ones stay separate', () => {
  const detections = parseDetections(
    csv([...group(-30.6, 148.04, 6), ...group(-33.9, 151.2, 4)]),
    { source: 'VIIRS_NOAA20_NRT', now: NOW },
  );
  const clusters = clusterDetections(detections, { now: NOW });
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].detectionCount, 6);
  assert.equal(clusters[1].detectionCount, 4);
  assert.equal(clusters[0].kind, 'CLUSTER');
  // Chained detections along a front stay in one cluster rather than splitting.
  assert.ok(clusters[0].spanKm > 0 && clusters[0].spanKm < 5);
});

test('a lone detection is reported as detections, never as a cluster', () => {
  const detections = parseDetections(csv([{ lat: 10, lon: 10 }]), {
    source: 'VIIRS_NOAA20_NRT',
    now: NOW,
  });
  const [cluster] = clusterDetections(detections, { now: NOW });
  assert.equal(cluster.detectionCount, 1);
  assert.equal(cluster.kind, 'DETECTIONS');
  assert.ok(MIN_CLUSTER_DETECTIONS > 1);
});

test('cluster statistics summarize what the satellites actually saw', () => {
  const detections = parseDetections(
    csv([
      { lat: -30.6, lon: 148.04, frp: 10, conf: 'n', time: '0800' },
      { lat: -30.604, lon: 148.044, frp: 250, conf: 'h', time: '1012' },
      { lat: -30.608, lon: 148.048, frp: 40, conf: 'l', time: '0930' },
    ]),
    { source: 'VIIRS_NOAA20_NRT', now: NOW },
  );
  const [cluster] = clusterDetections(detections, { now: NOW });
  assert.equal(cluster.detectionCount, 3);
  assert.equal(cluster.peakFrp, 250);
  assert.equal(cluster.peakFrpBand, 'HIGH');
  assert.equal(cluster.averageFrp, 100);
  assert.equal(cluster.averageConfidence, Number(((0.65 + 0.9 + 0.3) / 3).toFixed(3)));
  assert.equal(cluster.newestDetectionAt, '2026-09-18T10:12:00.000Z');
  assert.equal(cluster.oldestDetectionAt, '2026-09-18T08:00:00.000Z');
  assert.equal(cluster.newestAgeMs, NOW - Date.parse('2026-09-18T10:12:00.000Z'));
  assert.equal(cluster.observationSpanMs, 7_920_000); // 2h 12m
  // Detection area is pixel footprint, not burned area.
  assert.equal(cluster.detectionAreaKm2, Number((3 * 0.375 * 0.375).toFixed(2)));
  assert.deepEqual(cluster.satellites, ['NOAA-20']);
});

test('FRP bands and distances behave', () => {
  assert.equal(frpBand(5), 'LOW');
  assert.equal(frpBand(50), 'MODERATE');
  assert.equal(frpBand(200), 'HIGH');
  assert.equal(frpBand(900), 'EXTREME');
  assert.equal(frpBand(null), null);
  // One degree of latitude is ~111 km anywhere.
  const oneDegree = distanceMeters(
    { latitude: 0, longitude: 0 },
    { latitude: 1, longitude: 0 },
  );
  assert.ok(Math.abs(oneDegree - 111_195) < 1_000, `${oneDegree}`);
  // Longitude converges at high latitude.
  const atEquator = distanceMeters(
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 1 },
  );
  const atSixty = distanceMeters(
    { latitude: 60, longitude: 0 },
    { latitude: 60, longitude: 1 },
  );
  assert.ok(atSixty < atEquator * 0.55, `${atSixty} vs ${atEquator}`);
});

test('a first observation reports no trend rather than inventing one', () => {
  const detections = parseDetections(csv(group(-30.6, 148.04, 10)), {
    source: 'VIIRS_NOAA20_NRT',
    now: NOW,
  });
  const activity = compareActivity({ detections, now: NOW });
  assert.equal(activity.status, ACTIVITY_STATES.INSUFFICIENT);
  assert.equal(activity.changePercent, null);
  assert.match(activity.note, /Insufficient observations for trend analysis/);
});

test('activity compares this observation with the previous one', () => {
  const previous = parseDetections(csv(group(-30.6, 148.04, 10)), {
    source: 'VIIRS_NOAA20_NRT',
    now: NOW,
  });
  const grown = parseDetections(csv(group(-30.6, 148.04, 16)), {
    source: 'VIIRS_NOAA20_NRT',
    now: NOW,
  });
  const up = compareActivity({
    detections: grown,
    previousDetections: previous,
    previousObservedMs: NOW - 20 * 60_000,
    now: NOW,
  });
  assert.equal(up.status, ACTIVITY_STATES.INCREASING);
  assert.equal(up.changePercent, 60);
  assert.equal(up.detectionCount, 16);
  assert.equal(up.previousDetectionCount, 10);
  assert.equal(up.newDetections, 6);
  assert.match(up.note, /up 60%/);

  const down = compareActivity({
    detections: previous,
    previousDetections: grown,
    previousObservedMs: NOW - 20 * 60_000,
    now: NOW,
  });
  assert.equal(down.status, ACTIVITY_STATES.DECREASING);
  assert.equal(down.clearedDetections, 6);

  // Small movement is noise, not a trend.
  const steady = compareActivity({
    detections: parseDetections(csv(group(-30.6, 148.04, 11)), { now: NOW }),
    previousDetections: previous,
    now: NOW,
  });
  assert.equal(steady.status, ACTIVITY_STATES.STEADY);
});

test('tiny counts never produce a percentage', () => {
  const two = parseDetections(csv(group(1, 1, 2)), { now: NOW });
  const one = parseDetections(csv(group(1, 1, 1)), { now: NOW });
  const activity = compareActivity({
    detections: two,
    previousDetections: one,
    now: NOW,
  });
  assert.equal(activity.status, ACTIVITY_STATES.INSUFFICIENT);
  assert.equal(activity.changePercent, null);
});

test('wind becomes a spread bearing, not a wind bearing', () => {
  // A 90° wind is an easterly: it blows TOWARD the west.
  const metrics = { wind_direction_10m: 90, wind_speed_10m: 30, wind_gusts_10m: 45 };
  const vector = spreadVector(metrics);
  assert.equal(vector.windFromDegrees, 90);
  assert.equal(vector.windFromCardinal, 'E');
  assert.equal(vector.spreadTowardDegrees, 270);
  assert.equal(vector.spreadTowardCardinal, 'W');
  assert.equal(vector.windSpeedKmh, 30);
  assert.match(vector.label, /Modeled potential spread direction/);
  assert.doesNotMatch(vector.label, /predicted|forecast fire|fire path/i);
  assert.match(vector.basis, /terrain, fuel and fire behaviour excluded/);
  // Wrapping past north stays in range.
  assert.equal(spreadVector({ ...metrics, wind_direction_10m: 200 }).spreadTowardDegrees, 20);
  assert.equal(spreadVector({ wind_speed_10m: 10 }), null);
});

test('compass naming covers the quadrants', () => {
  assert.equal(cardinalDirection(0), 'N');
  assert.equal(cardinalDirection(45), 'NE');
  assert.equal(cardinalDirection(180), 'S');
  assert.equal(cardinalDirection(315), 'NW');
  assert.equal(cardinalDirection(359), 'N');
  assert.equal(cardinalDirection(null), null);
});

test('clusters correlate with weather into fire-spread conditions', () => {
  const detections = parseDetections(csv(group(-30.6, 148.04, 8)), {
    source: 'VIIRS_NOAA20_NRT',
    now: NOW,
  });
  const hotDry = deriveMetrics(
    normalizeForecast(
      syntheticForecast({
        base: {
          temperature_2m: 38,
          relative_humidity_2m: 12,
          vapour_pressure_deficit: 4.1,
          wind_speed_10m: 40,
          wind_direction_10m: 225,
          wind_gusts_10m: 62,
        },
      }),
    ),
  );
  const intelligence = assembleFireIntelligence({
    detections,
    weatherFor: () => hotDry,
    sources: DEFAULT_SOURCES,
    now: NOW,
  });
  const [cluster] = intelligence.clusters;
  assert.ok(cluster.spreadConditions.score >= 61, `${cluster.spreadConditions.score}`);
  assert.ok(['ELEVATED', 'HIGH'].includes(cluster.spreadConditions.level));
  assert.match(cluster.spreadConditions.disclaimer, /not a fire detection/i);
  assert.equal(cluster.weather.temperature, 38);
  assert.equal(cluster.weather.windSpeed, 40);
  assert.equal(cluster.spreadVector.spreadTowardCardinal, 'NE');
  assert.equal(cluster.weatherStatus, 'READY');
});

test('a cluster without weather still reports its detections', () => {
  const detections = parseDetections(csv(group(-30.6, 148.04, 8)), { now: NOW });
  const intelligence = assembleFireIntelligence({
    detections,
    weatherFor: () => null,
    now: NOW,
  });
  const [cluster] = intelligence.clusters;
  assert.equal(cluster.spreadConditions, null);
  assert.equal(cluster.weatherStatus, 'UNAVAILABLE');
  assert.equal(cluster.detectionCount, 8);
});

test('only the significant clusters are enriched, bounding weather calls', () => {
  const detections = parseDetections(
    csv(
      Array.from({ length: 12 }, (_, index) => group(index * 2, index * 2, 5)).flat(),
    ),
    { now: NOW },
  );
  const clusters = clusterDetections(detections, { now: NOW });
  assert.equal(clusters.length, 12);
  assert.equal(significantClusters(clusters).length, 5);
});

test('an empty area says so about the DATA, not about the ground', () => {
  const intelligence = assembleFireIntelligence({ detections: [], now: NOW });
  assert.equal(intelligence.detectionCount, 0);
  assert.equal(intelligence.clusterCount, 0);
  assert.match(intelligence.summary, /No active satellite fire detections/);
  assert.doesNotMatch(intelligence.summary, /no fires?\b|safe|clear of fire/i);
});

test('vocabulary never promotes a detection into a confirmed wildfire', () => {
  const detections = parseDetections(csv(group(-30.6, 148.04, 9)), { now: NOW });
  const intelligence = assembleFireIntelligence({ detections, now: NOW });
  const text = JSON.stringify(intelligence);
  assert.doesNotMatch(text, /wildfire detected|NASA detected a|confirmed fire/i);
  assert.match(intelligence.qualifier, /Not confirmed ground truth/);
  assert.match(intelligence.summary, /satellite fire detections/);
});

test('a first observation announces only the largest clusters', () => {
  const clusters = clusterDetections(
    parseDetections(
      csv(Array.from({ length: 8 }, (_, i) => group(i * 3, i * 3, 5)).flat()),
      { now: NOW },
    ),
    { now: NOW },
  );
  const events = deriveFireEvents({
    clusters,
    activity: compareActivity({ detections: [], now: NOW }),
  });
  assert.equal(events.length, 3);
  assert.ok(events.every((event) => event.type === FIRE_EVENTS.FIRE_DETECTED));
  for (const event of events) {
    assert.ok(event.timestamp && event.location && event.severity);
    assert.equal(event.source, 'NASA FIRMS');
    assert.equal(event.previousState, null);
    assert.ok(event.currentState.detections >= 3);
  }
});

test('a new cluster and rising activity raise their own events', () => {
  const before = clusterDetections(
    parseDetections(csv(group(-30.6, 148.04, 6)), { now: NOW }),
    { now: NOW },
  );
  const afterDetections = parseDetections(
    csv([...group(-30.6, 148.04, 12), ...group(-25.0, 140.0, 5)]),
    { now: NOW },
  );
  const after = clusterDetections(afterDetections, { now: NOW });
  const activity = compareActivity({
    detections: afterDetections,
    previousDetections: parseDetections(csv(group(-30.6, 148.04, 6)), { now: NOW }),
    now: NOW,
  });
  const events = deriveFireEvents({
    clusters: after,
    previousClusters: before,
    activity,
  });
  const types = events.map((event) => event.type);
  assert.ok(types.includes(FIRE_EVENTS.FIRE_CLUSTER_FORMED));
  assert.ok(types.includes(FIRE_EVENTS.FIRE_ACTIVITY_INCREASED));
  const increased = events.find(
    (event) => event.type === FIRE_EVENTS.FIRE_ACTIVITY_INCREASED,
  );
  assert.equal(increased.currentState.detections, 17);
  assert.equal(increased.previousState.detections, 6);
});

test('worsening spread conditions raise an event of their own', () => {
  const base = clusterDetections(
    parseDetections(csv(group(-30.6, 148.04, 8)), { now: NOW }),
    { now: NOW },
  );
  const withScore = (score) =>
    base.map((cluster) => ({
      ...cluster,
      spreadConditions: { score, level: score >= 61 ? 'ELEVATED' : 'MODERATE', leadingDrivers: [] },
    }));
  const events = deriveFireEvents({
    clusters: withScore(70),
    previousClusters: withScore(50),
    activity: compareActivity({ detections: [], previousDetections: [], now: NOW }),
  });
  assert.ok(
    events.some(
      (event) => event.type === FIRE_EVENTS.FIRE_SPREAD_CONDITIONS_INCREASED,
    ),
  );
});

test('a steady observation produces no events', () => {
  const detections = parseDetections(csv(group(-30.6, 148.04, 8)), { now: NOW });
  const clusters = clusterDetections(detections, { now: NOW });
  const events = deriveFireEvents({
    clusters,
    previousClusters: clusters,
    activity: compareActivity({
      detections,
      previousDetections: detections,
      now: NOW,
    }),
  });
  assert.deepEqual(events, []);
});

test('the Bedrock incident record carries numbers and their qualification', () => {
  const detections = parseDetections(csv(group(-30.6, 148.04, 9, { frp: 150 })), {
    source: 'VIIRS_NOAA20_NRT',
    now: NOW,
  });
  const metrics = deriveMetrics(
    normalizeForecast(
      syntheticForecast({
        base: {
          temperature_2m: 34,
          relative_humidity_2m: 31,
          wind_speed_10m: 32,
          wind_direction_10m: 225,
        },
      }),
    ),
  );
  const intelligence = assembleFireIntelligence({
    detections,
    weatherFor: () => metrics,
    now: NOW,
  });
  const record = fireIncidentRecord(intelligence.clusters[0], {
    activity: intelligence.activity,
  });
  assert.equal(record.incidentType, 'ACTIVE_FIRE_CLUSTER');
  assert.equal(record.observationType, 'SATELLITE_THERMAL_ANOMALY');
  assert.equal(record.groundTruth, false);
  assert.equal(record.dataSource, 'NASA FIRMS (VIIRS near-real-time)');
  assert.equal(record.detections, 9);
  assert.equal(record.weather.temperature, 34);
  assert.equal(record.potentialSpreadDirection.cardinal, 'NE');
  assert.match(record.fireSpreadConditions.basis, /not a prediction/i);
  assert.match(record.qualifier, /Not confirmed ground truth/);
  assert.ok(JSON.parse(JSON.stringify(record)), 'must serialize for Bedrock');
});

test('bounding boxes snap outward onto the shared grid', () => {
  const snapped = snapBoundingBox({ west: -122.4, south: 37.1, east: -121.9, north: 37.9 });
  assert.deepEqual(snapped, { west: -125, south: 35, east: -120, north: 40 });
  // Two nearby viewports resolve to the same cell, which is what makes the
  // cache work.
  assert.deepEqual(
    snapBoundingBox({ west: -124.9, south: 35.2, east: -120.1, north: 39.9 }),
    snapped,
  );
  assert.equal(snapBoundingBox({ west: 10, south: 10, east: 5, north: 20 }), null);
  assert.equal(snapBoundingBox({ west: 'x', south: 1, east: 2, north: 3 }), null);
});

test('a globe-wide view is clamped rather than requesting the planet', () => {
  const whole = snapBoundingBox({ west: -179, south: -89, east: 179, north: 89 });
  const { bbox, clamped } = clampBoundingBox(whole);
  assert.equal(clamped, true);
  assert.ok((bbox.east - bbox.west) * (bbox.north - bbox.south) <= 8_000);
  const small = snapBoundingBox({ west: 10, south: 10, east: 12, north: 12 });
  assert.equal(clampBoundingBox(small).clamped, false);
});

test('the request URL is well formed and the key can always be redacted', () => {
  const bbox = { west: -125, south: 35, east: -120, north: 40 };
  const url = areaRequestUrl({ mapKey: 'SECRETKEY', source: VIIRS_SOURCES[0], bbox });
  assert.equal(
    url,
    'https://firms.modaps.eosdis.nasa.gov/api/area/csv/SECRETKEY/VIIRS_NOAA20_NRT/-125,35,-120,40/2',
  );
  assert.ok(!redactMapKey(url, 'SECRETKEY').includes('SECRETKEY'));
  assert.match(redactMapKey(url, 'SECRETKEY'), /«FIRMS_KEY»/);
  assert.throws(() => areaRequestUrl({ source: VIIRS_SOURCES[0], bbox }), /MAP_KEY/);
  assert.throws(
    () => areaRequestUrl({ mapKey: 'K', source: 'MODIS_SOMETHING', bbox }),
    /Unsupported FIRMS source/,
  );
});

test('the default source set is the smallest that gives coverage', () => {
  assert.equal(DEFAULT_SOURCES.length, 1);
  assert.ok(VIIRS_SOURCES.includes(DEFAULT_SOURCES[0]));
  assert.equal(VIIRS_SOURCES.length, 3);
});
