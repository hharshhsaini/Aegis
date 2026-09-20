import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE_SECONDS,
  RECONSTRUCTION_LABEL,
  buildReconstruction,
  offsetLabel,
} from './reconstruction.js';
import { createIncident } from './model.js';

/**
 * A generated reconstruction walks a single observation. These tests hold it
 * to saying so: no implied replay, no invented phases, and no wording that
 * turns a modelled direction into a predicted path.
 */

const quake = createIncident({
  id: 'eq:1',
  kind: 'EARTHQUAKE',
  title: 'M5.2 earthquake',
  place: 'Near Pokhara',
  severity: 62,
  location: { latitude: 28.2, longitude: 83.9 },
  source: 'USGS',
  summary: 'USGS recorded M5.2.',
  detail: { alertLevel: 'WATCH' },
});

const fire = createIncident({
  id: 'fire:1',
  kind: 'FIRE',
  title: 'Active fire cluster · 26 detections',
  place: '12 km span',
  severity: 55,
  location: { latitude: 23.7, longitude: 86.4 },
  source: 'NASA FIRMS',
  summary: '26 satellite thermal anomaly detections.',
  detail: { spreadLevel: 'ELEVATED' },
});

test('offsets read as a clock into the walkthrough', () => {
  assert.equal(offsetLabel(0), '00:00');
  assert.equal(offsetLabel(8), '00:08');
  assert.equal(offsetLabel(72), '01:12');
});

test('a generated plan declares what it is built from', () => {
  // The provenance rides on the record rather than being left to the renderer,
  // so a walkthrough cannot be shown without it.
  const plan = buildReconstruction(quake);
  assert.equal(plan.provenance, RECONSTRUCTION_LABEL);
  assert.match(plan.basis, /not times at which anything was observed/);
  assert.equal(plan.source, 'USGS');
});

test('an authored scenario is never routed through the generator', () => {
  // Nepal has a director and 25 authored shots; five generated phases would be
  // a downgrade dressed as consistency.
  const scenario = createIncident({
    id: 'scenario:nepal',
    kind: 'SCENARIO',
    title: 'Nepal Flood Incident',
    source: 'Authored scenario',
    live: false,
    location: { latitude: 27.8, longitude: 85.9 },
  });
  assert.equal(buildReconstruction(scenario), null);
});

test('an incident with no location has no reconstruction', () => {
  assert.equal(
    buildReconstruction(
      createIncident({
        id: 'x',
        kind: 'EARTHQUAKE',
        title: 'M3',
        source: 'USGS',
      }),
    ),
    null,
  );
  assert.equal(buildReconstruction(null), null);
});

test('phases are ordered, timed, and end on current status', () => {
  const plan = buildReconstruction(quake);
  assert.ok(plan.phases.length >= 4);
  plan.phases.forEach((phase, index) => {
    assert.equal(phase.index, index);
    assert.equal(phase.offsetSeconds, index * PHASE_SECONDS);
  });
  assert.equal(plan.phases[0].label, 'INITIAL SIGNAL');
  assert.equal(plan.phases.at(-1).label, 'CURRENT STATUS');
  assert.equal(plan.durationSeconds, plan.phases.length * PHASE_SECONDS);
});

test('a phase with no data behind it is dropped, not filled', () => {
  // An earthquake USGS did not grade gets no alert phase.
  const ungraded = createIncident({
    ...quake,
    id: 'eq:2',
    detail: {},
  });
  const labels = buildReconstruction(ungraded).phases.map((p) => p.label);
  assert.ok(!labels.includes('ALERT GRADING'));
  assert.ok(labels.includes('CURRENT STATUS'));
});

test('the earthquake radius is named as geographic context, not impact', () => {
  const phase = buildReconstruction(quake).phases.find(
    (entry) => entry.id === 'context',
  );
  assert.match(phase.label, /GEOGRAPHIC ANALYSIS RADIUS/);
  assert.match(phase.detail, /not a measured impact boundary/);
});

test('fire spread is modelled potential, never a predicted path', () => {
  const plan = buildReconstruction(fire);
  const spread = plan.phases.find((entry) => entry.id === 'spread');
  assert.equal(spread.label, 'MODELED POTENTIAL SPREAD');
  assert.match(spread.detail, /not observed fire behaviour/);
  for (const phase of plan.phases) {
    assert.ok(!/predicted/i.test(phase.label));
    assert.ok(!/predicted/i.test(phase.detail));
  }
});

test('a fire cluster with no scored conditions gets no spread phase', () => {
  const unscored = createIncident({ ...fire, id: 'fire:2', detail: {} });
  const labels = buildReconstruction(unscored).phases.map((p) => p.label);
  assert.ok(!labels.includes('MODELED POTENTIAL SPREAD'));
});

test('each kind gets a radius sized for what it describes', () => {
  // A fire cluster spans kilometres and an earthquake is regional; one radius
  // for both would be wrong for at least one of them.
  assert.ok(
    buildReconstruction(fire).radiusMetres <
      buildReconstruction(quake).radiusMetres,
  );
});
