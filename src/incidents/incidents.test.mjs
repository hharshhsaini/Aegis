import test from 'node:test';
import assert from 'node:assert/strict';
import { compareIncidents, createIncident, incidentLevel } from './model.js';
import {
  SURFACE_THRESHOLD,
  earthquakeIncidents,
  fireIncidents,
  scenarioIncidents,
  weatherIncidents,
} from './sources.js';
import { createIncidentRegistry } from './registry.js';

/**
 * The board's whole job is telling an operator what is happening without
 * misleading them, so these tests are mostly about honesty: that authored
 * content never passes for an observation, that nothing is invented, and that
 * a feed which goes quiet takes its incidents with it.
 */

const NOW = Date.parse('2026-09-19T12:00:00Z');

test('severity bands match the risk engine vocabulary', () => {
  assert.equal(incidentLevel(0), 'NORMAL');
  assert.equal(incidentLevel(30), 'LOW');
  assert.equal(incidentLevel(50), 'MODERATE');
  assert.equal(incidentLevel(70), 'ELEVATED');
  assert.equal(incidentLevel(90), 'HIGH');
  assert.equal(incidentLevel(Number.NaN), 'NORMAL');
});

test('an authored scenario always sorts below a live detection', () => {
  // A script sitting above a real earthquake would bury the thing that just
  // happened, however the two happen to be scored.
  const scenario = createIncident({
    id: 's',
    kind: 'SCENARIO',
    title: 'Demo',
    severity: 99,
    source: 'Authored scenario',
    live: false,
  });
  const live = createIncident({
    id: 'q',
    kind: 'EARTHQUAKE',
    title: 'M3',
    severity: 10,
    source: 'USGS',
    live: true,
  });
  assert.deepEqual([scenario, live].sort(compareIncidents), [live, scenario]);
});

test('live incidents order by severity, then recency', () => {
  const make = (id, severity, observedAt) =>
    createIncident({
      id,
      kind: 'FIRE',
      title: id,
      severity,
      observedAt,
      source: 'NASA FIRMS',
    });
  const sorted = [
    make('old-big', 80, NOW - 9_000_000),
    make('new-small', 30, NOW),
    make('new-big', 80, NOW),
  ].sort(compareIncidents);
  assert.deepEqual(
    sorted.map((incident) => incident.id),
    ['new-big', 'old-big', 'new-small'],
  );
});

test('earthquake severity comes from magnitude, lifted by USGS grading', () => {
  const [significant, plain] = earthquakeIncidents(
    {
      events: [
        {
          id: 'a',
          magnitude: 5.0,
          place: 'Somewhere',
          timeIso: '2026-09-19T11:00:00Z',
          latitude: 10,
          longitude: 20,
          alert: { level: 'SIGNIFICANT' },
        },
        {
          id: 'b',
          magnitude: 5.0,
          place: 'Elsewhere',
          timeIso: '2026-09-19T10:00:00Z',
          latitude: 11,
          longitude: 21,
          alert: { level: 'INFORMATION' },
        },
      ],
    },
    NOW,
  );
  assert.ok(
    significant.severity > plain.severity,
    'the feed’s own grading lifts the event it flagged',
  );
  assert.equal(significant.source, 'USGS');
  assert.equal(significant.live, true);
  assert.deepEqual(significant.location, { latitude: 10, longitude: 20 });
});

test('small earthquakes stay off the board', () => {
  const quiet = earthquakeIncidents(
    {
      events: [
        {
          id: 'tiny',
          magnitude: 1.2,
          place: 'Nowhere',
          timeIso: '2026-09-19T11:00:00Z',
          latitude: 1,
          longitude: 1,
          alert: { level: 'INFORMATION' },
        },
      ],
    },
    NOW,
  );
  assert.deepEqual(quiet, []);
});

test('only coherent fire clusters become incidents, in FIRMS wording', () => {
  const incidents = fireIncidents(
    {
      clusters: [
        {
          id: 'c1',
          kind: 'CLUSTER',
          detectionCount: 40,
          center: { latitude: 5, longitude: 6 },
          spanKm: 12,
          peakFrpBand: 'HIGH',
          newestAgeMs: 3_600_000,
          spreadConditions: { score: 60, level: 'ELEVATED' },
        },
        {
          id: 'lone',
          kind: 'DETECTIONS',
          detectionCount: 1,
          center: { latitude: 7, longitude: 8 },
          spanKm: 0,
          peakFrpBand: 'LOW',
          newestAgeMs: 1000,
          spreadConditions: { score: 5, level: 'NORMAL' },
        },
      ],
    },
    NOW,
  );
  assert.equal(
    incidents.length,
    1,
    'a lone pixel is a measurement, not an incident',
  );
  const [fire] = incidents;
  assert.equal(fire.source, 'NASA FIRMS');
  // "wildfire" is a claim about the ground that a satellite pixel cannot make.
  assert.ok(!/wildfire/i.test(fire.title));
  assert.ok(!/wildfire/i.test(fire.summary));
  assert.match(fire.summary, /thermal anomaly/i);
  assert.match(fire.summary, /not confirmed ground truth/i);
  assert.equal(fire.observedAt, NOW - 3_600_000);
});

test('weather incidents are the hazards the engine already scored', () => {
  const incidents = weatherIncidents(
    {
      generatedAt: '2026-09-19T11:55:00Z',
      location: { latitude: 27.7, longitude: 85.3 },
      risks: {
        flood: {
          id: 'flood',
          label: 'Flood Risk',
          score: 72,
          level: 'ELEVATED',
          summary: 'Rainfall accumulation is elevated.',
        },
        heat: {
          id: 'heat',
          label: 'Heat Risk',
          score: 4,
          level: 'NORMAL',
          summary: 'No significant heat signal.',
        },
      },
    },
    { latitude: 27.7, longitude: 85.3 },
    'Kathmandu',
  );
  assert.equal(
    incidents.length,
    1,
    'a quiet hazard is the absence of an incident',
  );
  assert.equal(incidents[0].title, 'Flood Risk');
  assert.equal(incidents[0].severity, 72);
  assert.equal(incidents[0].place, 'Kathmandu');
  assert.equal(incidents[0].source, 'Open-Meteo');
});

test('the surfacing floor is applied consistently', () => {
  const [below] = weatherIncidents({
    generatedAt: '2026-09-19T11:55:00Z',
    location: { latitude: 0, longitude: 0 },
    risks: {
      wind: {
        id: 'wind',
        label: 'Wind Risk',
        score: SURFACE_THRESHOLD - 1,
        level: 'LOW',
        summary: '',
      },
    },
  });
  assert.equal(below, undefined);
});

test('scenarios are marked as authored and carry no observation time', () => {
  const [scenario] = scenarioIncidents([
    { id: 'nepal', title: 'Nepal Flood Incident', shots: 25 },
  ]);
  assert.equal(scenario.live, false);
  assert.equal(scenario.observedAt, null);
  assert.equal(scenario.scenarioId, 'nepal');
  assert.match(scenario.source, /authored/i);
  assert.match(scenario.summary, /not live data/i);
});

test('a feed that goes quiet removes its own incidents', () => {
  // A stale incident left on the board because its source stopped answering is
  // worse than no incident at all.
  const registry = createIncidentRegistry();
  registry.publish('fires', [
    createIncident({
      id: 'f1',
      kind: 'FIRE',
      title: 'Cluster',
      severity: 60,
      source: 'NASA FIRMS',
    }),
  ]);
  assert.equal(registry.list().length, 1);
  registry.publish('fires', []);
  assert.equal(registry.list().length, 0);
});

test('the registry only notifies when the board actually changed', () => {
  const registry = createIncidentRegistry();
  const seen = [];
  registry.subscribe((list) => seen.push(list.length));
  assert.deepEqual(seen, [0], 'subscribing delivers the current board');

  const incident = createIncident({
    id: 'q1',
    kind: 'EARTHQUAKE',
    title: 'M5',
    severity: 60,
    source: 'USGS',
  });
  assert.equal(registry.publish('quakes', [incident]), true);
  assert.deepEqual(seen, [0, 1]);

  // Republishing the same thing must not repaint a list the operator may be
  // pointing at.
  assert.equal(registry.publish('quakes', [incident]), false);
  assert.deepEqual(seen, [0, 1]);
});

test('a severity change does repaint, because the band may have moved', () => {
  const registry = createIncidentRegistry();
  const seen = [];
  registry.subscribe((list) => seen.push(list[0]?.severity ?? null));
  const at = (severity) =>
    createIncident({
      id: 'q1',
      kind: 'EARTHQUAKE',
      title: 'M5',
      severity,
      source: 'USGS',
    });
  registry.publish('quakes', [at(40)]);
  registry.publish('quakes', [at(80)]);
  assert.deepEqual(seen, [null, 40, 80]);
});

test('the board is capped so it cannot grow without bound', () => {
  const registry = createIncidentRegistry({ limit: 3 });
  registry.publish(
    'fires',
    Array.from({ length: 10 }, (_, index) =>
      createIncident({
        id: `f${index}`,
        kind: 'FIRE',
        title: `Cluster ${index}`,
        severity: index * 10,
        source: 'NASA FIRMS',
      }),
    ),
  );
  assert.equal(registry.list().length, 3);
  // The worst survive the cap, not the first ten encountered.
  assert.deepEqual(
    registry.list().map((incident) => incident.severity),
    [90, 80, 70],
  );
});

test('incidents from every source merge into one ordered board', () => {
  const registry = createIncidentRegistry();
  registry.publish(
    'quakes',
    earthquakeIncidents(
      {
        events: [
          {
            id: 'q',
            magnitude: 6.1,
            place: 'Ridge',
            timeIso: '2026-09-19T11:00:00Z',
            latitude: 1,
            longitude: 2,
            alert: { level: 'WATCH' },
          },
        ],
      },
      NOW,
    ),
  );
  registry.publish(
    'scenarios',
    scenarioIncidents([
      { id: 'nepal', title: 'Nepal Flood Incident', shots: 25 },
    ]),
  );
  const board = registry.list();
  assert.equal(board.length, 2);
  assert.equal(board[0].kind, 'EARTHQUAKE', 'the real event leads');
  assert.equal(board[1].kind, 'SCENARIO');
  assert.equal(registry.find('scenario:nepal')?.title, 'Nepal Flood Incident');
});
