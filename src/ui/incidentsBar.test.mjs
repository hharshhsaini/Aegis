import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODES,
  createIncidentsBar,
  incidentAge,
  phaseAt,
} from './incidentsBar.js';
import { createIncidentRegistry } from '../incidents/registry.js';
import { INCIDENT_KINDS, createIncident } from '../incidents/model.js';

/**
 * The bar is the surface that tells an operator what is happening, so these
 * tests hold it to the two promises that matter: selecting anything takes you
 * there, and authored content is never mistakable for an observation.
 */

const NOW = Date.parse('2026-09-19T12:00:00Z');

test('an authored row is never given an observation age', () => {
  const scenario = createIncident({
    id: 's',
    kind: 'SCENARIO',
    title: 'Demo',
    source: 'Authored scenario',
    live: false,
  });
  assert.equal(incidentAge(scenario, NOW), 'demo');

  const live = createIncident({
    id: 'q',
    kind: 'EARTHQUAKE',
    title: 'M5',
    source: 'USGS',
    observedAt: NOW - 600_000,
  });
  assert.equal(incidentAge(live, NOW), '10 min ago');

  // A live incident with no timestamp says so rather than inventing an age.
  const undated = createIncident({
    id: 'w',
    kind: 'WEATHER',
    title: 'Flood Risk',
    source: 'Open-Meteo',
  });
  assert.equal(incidentAge(undated, NOW), 'live');
});

test('the phase indicator tracks progress and clamps at the end', () => {
  assert.equal(phaseAt(0).id, 'signal');
  assert.equal(phaseAt(0.5).id, 'impact');
  assert.equal(phaseAt(1).id, 'response');
  assert.equal(phaseAt(-1), null);
});

function node(id = '') {
  const listeners = new Map();
  return {
    id,
    children: [],
    dataset: {},
    style: {},
    className: '',
    textContent: '',
    type: '',
    hidden: false,
    disabled: false,
    listeners,
    attributes: {},
    append(...kids) {
      this.children.push(...kids);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    replaceChildren(...kids) {
      this.children = [...kids];
    },
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) {
      listeners.get(name)?.delete(fn);
    },
    click() {
      for (const fn of listeners.get('click') || []) fn();
    },
    querySelector(selector) {
      const wanted = selector.replace('.', '');
      const walk = (current) => {
        for (const kid of current.children) {
          if (String(kid.className).split(' ').includes(wanted)) return kid;
          const found = walk(kid);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    },
  };
}

const created = [];
afterEach(() => {
  while (created.length) created.pop()?.destroy();
});

function fixture({ incidents = [], running = false, paused = false } = {}) {
  const ids = [
    'incidents-bar',
    'aegis-mode',
    'aegis-status-chip',
    'incidents-count',
    'incidents-list',
    'incidents-empty',
    'incident-detail-title',
    'incident-detail-meta',
    'incident-controls',
    'incident-run-btn',
    'incident-pause-btn',
    'incident-reset-btn',
    'incident-exit-btn',
    'incident-focus-btn',
    'incident-phase',
    'incident-progress-fill',
  ];
  const nodes = new Map(ids.map((id) => [id, node(id)]));
  const doc = {
    getElementById: (id) => nodes.get(id) || null,
    createElement: () => node(),
  };

  const registry = createIncidentRegistry();
  const calls = [];
  const focused = [];
  let status = { running, paused, elapsedMs: 0, estimatedDurationMs: 1000 };
  const director = {
    getPlaybackStatus: () => status,
    subscribe: () => () => {},
    startScene: (id, options) => {
      calls.push(['start', id, options]);
      status = { ...status, running: true, paused: false };
    },
    pauseScene: () => {
      calls.push(['pause']);
      status = { ...status, paused: true };
    },
    resumeScene: () => {
      calls.push(['resume']);
      status = { ...status, paused: false };
    },
    stopScene: (reason) => {
      calls.push(['stop', reason]);
      status = { ...status, running: false, paused: false };
    },
  };

  const bar = createIncidentsBar({
    registry,
    director,
    onFocus: (incident) => focused.push(incident.id),
    document: doc,
    now: () => NOW,
  });
  created.push(bar);
  registry.publish('test', incidents);
  return { bar, nodes, registry, calls, focused };
}

const quake = createIncident({
  id: 'eq:1',
  kind: 'EARTHQUAKE',
  title: 'M5.2 earthquake',
  place: 'Near Pokhara',
  severity: 62,
  observedAt: NOW - 1_800_000,
  location: { latitude: 28.2, longitude: 83.9 },
  source: 'USGS',
  summary: 'USGS recorded M5.2.',
});

const nepal = createIncident({
  id: 'scenario:nepal',
  kind: 'SCENARIO',
  title: 'Nepal Flood Incident',
  severity: 50,
  source: 'Authored scenario',
  live: false,
  scenarioId: 'nepal',
  detail: { shots: 25 },
});

test('the board lists every incident and counts them', () => {
  const { nodes } = fixture({ incidents: [quake, nepal] });
  assert.equal(nodes.get('incidents-count').textContent, '2');
  assert.equal(nodes.get('incidents-list').children.length, 2);
  assert.equal(nodes.get('incidents-empty').hidden, true);
});

test('an empty board says so rather than rendering nothing', () => {
  const { nodes } = fixture({ incidents: [] });
  assert.equal(nodes.get('incidents-count').textContent, '0');
  assert.equal(nodes.get('incidents-empty').hidden, false);
  assert.equal(nodes.get('incident-detail-title').textContent, 'NO INCIDENTS');
});

test('a live incident offers FOCUS and no playback controls', () => {
  // There is nothing to play about an earthquake that already happened.
  const { bar, nodes } = fixture({ incidents: [quake, nepal] });
  bar.select('eq:1');
  assert.equal(nodes.get('incident-focus-btn').hidden, false);
  assert.equal(nodes.get('incident-run-btn').hidden, true);
  assert.equal(nodes.get('incident-pause-btn').hidden, true);
  assert.match(nodes.get('incident-detail-meta').textContent, /Near Pokhara/);
  assert.match(nodes.get('incident-detail-meta').textContent, /USGS/);
  assert.match(nodes.get('incident-detail-meta').textContent, /62\/100/);
});

test('an authored incident offers playback and says it is not live data', () => {
  const { bar, nodes } = fixture({ incidents: [quake, nepal] });
  bar.select('scenario:nepal');
  assert.equal(nodes.get('incident-run-btn').hidden, false);
  assert.equal(nodes.get('incident-focus-btn').hidden, true);
  assert.match(nodes.get('incident-detail-meta').textContent, /not live data/);
  assert.match(nodes.get('incident-detail-meta').textContent, /25 shots/);
});

test('selecting any incident takes the operator to it', () => {
  // One gesture for every incident, live or authored.
  const { nodes, focused } = fixture({ incidents: [quake, nepal] });
  const [firstRow] = nodes.get('incidents-list').children;
  firstRow.querySelector('.incident-row-button').click();
  assert.deepEqual(focused, ['eq:1']);
});

test('running an authored incident flips the console into scenario mode', async () => {
  const { bar, nodes, calls } = fixture({ incidents: [nepal] });
  bar.select('scenario:nepal');
  assert.equal(nodes.get('aegis-mode').textContent, 'MONITORING');

  await bar.run();
  assert.deepEqual(calls[0], ['start', 'nepal', { single: true }]);
  assert.equal(nodes.get('aegis-mode').textContent, 'SCENARIO');
  assert.equal(nodes.get('aegis-mode').dataset.mode, MODES.SCENARIO);
  // The chip styles itself from this: authored playback has to LOOK different,
  // not merely be worded differently.
  assert.equal(nodes.get('aegis-status-chip').dataset.mode, MODES.SCENARIO);
});

test('running is refused for a live incident', async () => {
  const { bar, calls } = fixture({ incidents: [quake] });
  bar.select('eq:1');
  await bar.run();
  assert.deepEqual(calls, [], 'a detection has nothing to play');
});

test('pause, resume and exit drive the director and are announced', async () => {
  const { bar, nodes, calls } = fixture({ incidents: [nepal] });
  bar.select('scenario:nepal');
  await bar.run();

  bar.togglePause();
  assert.deepEqual(calls.at(-1), ['pause']);
  assert.equal(nodes.get('incident-pause-btn').textContent, 'RESUME');
  assert.equal(nodes.get('aegis-status-chip').dataset.paused, 'true');

  bar.togglePause();
  assert.deepEqual(calls.at(-1), ['resume']);

  bar.exit();
  assert.equal(calls.at(-1)[0], 'stop');
  assert.equal(nodes.get('aegis-mode').textContent, 'MONITORING');
  assert.equal(nodes.get('aegis-status-chip').dataset.mode, MODES.LIVE);
});

test('a selection that leaves the board falls back to the top incident', () => {
  // Otherwise the detail pane keeps describing something that is gone.
  const { bar, registry } = fixture({ incidents: [quake, nepal] });
  bar.select('eq:1');
  assert.equal(bar.selected().id, 'eq:1');
  registry.publish('test', [nepal]);
  assert.equal(bar.selected().id, 'scenario:nepal');
});

test('the bar is absent rather than fatal when its markup is missing', () => {
  const empty = { getElementById: () => null, createElement: () => node() };
  assert.equal(
    createIncidentsBar({
      registry: createIncidentRegistry(),
      director: {},
      document: empty,
    }),
    null,
  );
});

test('a row shows what kind of statement it is, not just how bad it is', () => {
  // Severity and provenance are independent facts and must not share a channel:
  // a high model score and a high observed reading look the same by colour, and
  // only the glyph separates "this happened" from "a model thinks this might".
  const model = createIncident({
    id: 'wx:flood',
    kind: INCIDENT_KINDS.WEATHER,
    title: 'Flood risk',
    severity: 72,
    source: 'Open-Meteo',
    location: { latitude: 12.9, longitude: 77.6 },
  });
  const { nodes } = fixture({ incidents: [quake, model, nepal] });

  const marks = [];
  const walk = (element) => {
    if (element?.className === 'incident-row-provenance') marks.push(element);
    for (const child of element?.children || []) walk(child);
  };
  walk(nodes.get('incidents-list'));

  const byType = Object.fromEntries(
    marks.map((mark) => [mark.dataset.sourceType, mark.textContent]),
  );
  assert.equal(byType.OBSERVED, '●', 'a USGS reading is an observation');
  assert.equal(byType.MODEL, '◇', 'a risk score is not an observation');
  assert.equal(byType.SCENARIO, '◼', 'an authored run is neither');
});
