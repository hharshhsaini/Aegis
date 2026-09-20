import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIntelligencePanel,
  collectReasons,
  orderRisks,
  formatAge,
  formatPoint,
} from './intelligencePanel.js';
import { analyzeSnapshot } from '../risk/riskEngine.js';
import { normalizeForecast } from '../weather/normalize.js';
import { syntheticForecast } from '../weather/testSupport/syntheticWeather.mjs';

/**
 * The panel is the product surface, so these tests hold it to the product
 * claim: an assessment first, raw variables only as supporting evidence, and
 * nothing on screen that the engine did not produce.
 */

function node(id = '') {
  const listeners = new Map();
  return {
    id,
    children: [],
    dataset: {},
    style: {},
    className: '',
    textContent: '',
    title: '',
    hidden: false,
    attributes: {},
    listeners,
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return this.attributes[name];
    },
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) {
      listeners.get(name)?.delete(callback);
    },
    fire(name, event = {}) {
      for (const callback of listeners.get(name) || []) callback(event);
    },
    append(...kids) {
      for (const kid of kids) this.children.push(kid);
    },
    replaceChildren(...kids) {
      this.children = [...kids];
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
    /** Flatten this subtree's text, as a reader would see it. */
    text() {
      return [this.textContent, ...this.children.map((kid) => kid.text())]
        .filter(Boolean)
        .join(' ');
    },
  };
}

/** A document holding exactly the ids the panel markup defines. */
function fakeDocument() {
  const ids = [
    'intelligence-panel',
    'intel-placeholder',
    'intel-content',
    'intel-headline-dot',
    'intel-headline-label',
    'intel-headline-level',
    'intel-headline-score',
    'intel-headline-trend',
    'intel-headline-summary',
    'intel-conditions',
    'intel-region',
    'intel-risks',
    'intel-drivers',
    'intel-actions',
    'intel-feed-chip',
    'intel-forecast',
    'intel-forecast-note',
    'intel-changes-section',
    'intel-changes',
    'intel-location',
    'intel-updated',
    'intel-refresh-btn',
  ];
  const nodes = new Map(ids.map((id) => [id, node(id)]));
  const footer = node('footer');
  footer.className = 'aegis-intel-footer';
  nodes.get('intelligence-panel').children.push(footer);
  return {
    nodes,
    getElementById: (id) => nodes.get(id) || null,
    createElement: () => node(),
  };
}

const analysisFor = (options) =>
  analyzeSnapshot(normalizeForecast(syntheticForecast(options)));

const FLOODING = {
  base: {
    soil_moisture_0_to_1cm: 0.44,
    soil_moisture_1_to_3cm: 0.43,
    soil_moisture_3_to_9cm: 0.42,
    precipitation_probability: 92,
  },
  shape: (hour, values) => ({ ...values, precipitation: 6, rain: 6 }),
};

test('the panel leads with the assessment, not the variables', () => {
  const doc = fakeDocument();
  const panel = createIntelligencePanel({ document: doc, now: () => Date.now() });
  const analysis = analysisFor(FLOODING);
  panel.render({ analysis, status: 'ready', point: analysis.location });

  assert.equal(doc.nodes.get('intel-placeholder').hidden, true);
  assert.equal(doc.nodes.get('intel-content').hidden, false);

  const worst = orderRisks(analysis.risks)[0];
  assert.equal(doc.nodes.get('intel-headline-label').textContent, worst.label);
  assert.equal(doc.nodes.get('intel-headline-score').textContent, String(worst.score));
  assert.equal(doc.nodes.get('intel-headline-level').textContent, worst.level);
  assert.equal(doc.nodes.get('intel-headline-summary').textContent, worst.summary);

  // Conditions appear once, as supporting evidence — six fields, not forty.
  const conditions = doc.nodes.get('intel-conditions');
  assert.ok(conditions.children.length <= 6);
  assert.match(conditions.text(), /TEMP/);
  // The panel must not become a variable dump.
  assert.doesNotMatch(conditions.text(), /soil_moisture|vapour_pressure|dew_point/i);
});

test('risk modules are ordered worst-first and carry their own trend arrow', () => {
  const doc = fakeDocument();
  const panel = createIntelligencePanel({ document: doc });
  const analysis = analysisFor(FLOODING);
  panel.render({ analysis, status: 'ready', point: analysis.location });

  const modules = doc.nodes.get('intel-risks').children;
  assert.equal(
    modules.length,
    6,
    'every hazard is listed, not just the active ones',
  );
  const scores = modules.map((module) =>
    Number(module.querySelector('.aegis-risk-module-score')?.textContent),
  );
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  for (const module of modules)
    assert.ok(
      ['↑', '↓', '→', '·'].includes(
        module.querySelector('.aegis-risk-module-trend')?.textContent,
      ),
    );
});

test('a risk module states its level and explains itself when it is active', () => {
  // The whole point of the module layout: score, status, trend and one line of
  // why, all readable without opening anything.
  const doc = fakeDocument();
  const panel = createIntelligencePanel({ document: doc });
  const analysis = analysisFor(FLOODING);
  panel.render({ analysis, status: 'ready', point: analysis.location });

  const [worst] = doc.nodes.get('intel-risks').children;
  const level = worst.querySelector('.aegis-risk-module-level')?.textContent;
  assert.ok(
    ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'].includes(level),
    `the worst hazard states a level, got ${level}`,
  );
  assert.ok(
    worst.querySelector('.aegis-risk-module-note')?.textContent?.length > 10,
    'an active hazard carries its explanation on the module itself',
  );
});

test('a seismic module from USGS joins the same risk column', () => {
  // Seismicity comes from a different feed but belongs in one risk column, so
  // it is supplied from outside and rendered in the same shape.
  const doc = fakeDocument();
  const panel = createIntelligencePanel({ document: doc });
  const analysis = analysisFor(FLOODING);
  panel.render({ analysis, status: 'ready', point: analysis.location });
  assert.equal(doc.nodes.get('intel-risks').children.length, 6);

  panel.setSeismicModule({
    id: 'seismic',
    label: 'Seismic Activity',
    score: 44,
    level: 'MODERATE',
    leadingDrivers: [],
    trend: { direction: 'STABLE', source: 'observed', change: 0 },
    summary: 'USGS recorded 12 earthquakes in this view over the last 24h.',
  });
  const modules = doc.nodes.get('intel-risks').children;
  assert.equal(modules.length, 7, 'the seismic module is appended');
  const labels = modules.map(
    (module) => module.querySelector('.aegis-risk-name')?.textContent,
  );
  assert.ok(labels.includes('SEISMIC ACTIVITY'));

  panel.setSeismicModule(null);
  assert.equal(
    doc.nodes.get('intel-risks').children.length,
    6,
    'removing it leaves the weather hazards alone',
  );
});

test('ACTION restates the scored hazards rather than inventing advice', () => {
  const doc = fakeDocument();
  const panel = createIntelligencePanel({ document: doc });
  const analysis = analysisFor(FLOODING);
  panel.render({ analysis, status: 'ready', point: analysis.location });

  const actions = doc.nodes.get('intel-actions').children;
  assert.ok(actions.length > 0, 'a quiet picture still says so');
  const labels = Object.values(analysis.risks).map((hazard) =>
    hazard.label.toLowerCase(),
  );
  for (const action of actions)
    assert.ok(
      labels.some((label) => action.textContent.includes(label)) ||
        action.textContent.includes('No hazard is scored above normal'),
      `every action names a scored hazard: ${action.textContent}`,
    );
});

test('WHY lists only drivers behind hazards that are actually active', () => {
  const analysis = analysisFor(FLOODING);
  const reasons = collectReasons(analysis.risks);
  assert.ok(reasons.length > 0);
  for (const reason of reasons) {
    const hazard = Object.values(analysis.risks).find(
      (entry) => entry.label === reason.hazard,
    );
    assert.notEqual(hazard.level, 'NORMAL', `${reason.hazard} is quiet`);
  }
  // Strongest contribution first, so the first line is the main reason.
  const contributions = reasons.map((entry) => entry.contribution);
  assert.deepEqual(contributions, [...contributions].sort((a, b) => b - a));

  // A calm day has no reasons to give, and says so rather than inventing one.
  const doc = fakeDocument();
  const panel = createIntelligencePanel({ document: doc });
  const calm = analysisFor();
  panel.render({ analysis: calm, status: 'ready', point: calm.location });
  assert.match(doc.nodes.get('intel-drivers').text(), /No hazard drivers/);
});

test('the forecast row shows one cell per horizon with its own score', () => {
  const doc = fakeDocument();
  const panel = createIntelligencePanel({ document: doc });
  const analysis = analysisFor(FLOODING);
  panel.render({ analysis, status: 'ready', point: analysis.location });

  const cells = doc.nodes.get('intel-forecast').children;
  assert.deepEqual(
    cells.map((cell) => cell.children[0].textContent),
    ['3H', '6H', '12H', '24H'],
  );
  for (const [index, cell] of cells.entries())
    assert.equal(
      Number(cell.children[1].textContent),
      analysis.forecast.horizons[index].overall,
    );
  // Projection wording stays hedged wherever it is shown.
  const note = doc.nodes.get('intel-forecast-note').textContent;
  if (note) assert.match(note, /projected to/);
});

test('significant changes stay hidden until the engine detects one', () => {
  const doc = fakeDocument();
  const panel = createIntelligencePanel({ document: doc });
  const calm = analysisFor();
  panel.render({ analysis: calm, status: 'ready', point: calm.location });
  assert.equal(doc.nodes.get('intel-changes-section').hidden, true);

  const squall = analyzeSnapshot(
    normalizeForecast(
      syntheticForecast({
        shape: (hour, values) => ({
          ...values,
          wind_gusts_10m: hour >= -1 ? 95 : 14,
          wind_speed_10m: hour >= -1 ? 55 : 8,
        }),
      }),
    ),
    { previous: calm },
  );
  panel.render({ analysis: squall, status: 'ready', point: squall.location });
  assert.equal(doc.nodes.get('intel-changes-section').hidden, false);
  assert.match(doc.nodes.get('intel-changes').text(), /Wind gusts|Wind speed/);
});

test('a stale answer is labelled rather than presented as current', () => {
  const doc = fakeDocument();
  const generated = Date.parse('2026-09-18T12:00:00Z');
  const panel = createIntelligencePanel({
    document: doc,
    now: () => generated + 22 * 60_000,
  });
  const analysis = analysisFor(FLOODING);
  panel.render({ analysis, status: 'stale', point: analysis.location });
  assert.match(doc.nodes.get('intel-updated').textContent, /^stale · /);
  assert.equal(
    doc.nodes.get('intelligence-panel').querySelector('.aegis-intel-footer').dataset
      .state,
    'stale',
  );
});

test('a failed refresh keeps the last assessment on screen', () => {
  const doc = fakeDocument();
  const panel = createIntelligencePanel({ document: doc });
  const analysis = analysisFor(FLOODING);
  panel.render({ analysis, status: 'ready', point: analysis.location });
  const shown = doc.nodes.get('intel-headline-score').textContent;

  panel.showError('Weather intelligence unavailable (503).');
  assert.equal(
    doc.nodes.get('intel-content').hidden,
    false,
    'the panel is not blanked',
  );
  assert.equal(doc.nodes.get('intel-headline-score').textContent, shown);

  // The operator reads a feed state, never a transport error. The raw message
  // is a diagnostic, and putting a status code in the panel's own status line
  // tells them nothing about the assessment they are looking at.
  const updated = doc.nodes.get('intel-updated').textContent;
  assert.match(updated, /stale/);
  assert.ok(!updated.includes('503'), 'no status code reaches the panel body');
  assert.equal(doc.nodes.get('intel-feed-chip').textContent, 'STALE');
});

test('with no analysis at all the panel asks for a location', () => {
  const doc = fakeDocument();
  const panel = createIntelligencePanel({ document: doc });
  panel.showError('Weather intelligence unavailable.');
  assert.equal(doc.nodes.get('intel-placeholder').hidden, false);
  assert.equal(doc.nodes.get('intel-content').hidden, true);
});

test('the refresh control reports progress and asks for a re-analysis', () => {
  const doc = fakeDocument();
  let refreshes = 0;
  const panel = createIntelligencePanel({
    document: doc,
    onRefresh: () => {
      refreshes += 1;
    },
  });
  doc.nodes.get('intel-refresh-btn').fire('click');
  assert.equal(refreshes, 1);

  panel.setBusy(true);
  assert.equal(doc.nodes.get('intel-refresh-btn').getAttribute('aria-busy'), 'true');
  const analysis = analysisFor();
  panel.render({ analysis, status: 'ready', point: analysis.location });
  assert.equal(doc.nodes.get('intel-refresh-btn').getAttribute('aria-busy'), 'false');

  panel.destroy();
  doc.nodes.get('intel-refresh-btn').fire('click');
  assert.equal(refreshes, 1, 'a destroyed panel stops requesting work');
});

test('age and coordinates are formatted for an operator, not a machine', () => {
  assert.equal(formatAge(0), 'just now');
  assert.equal(formatAge(59_000), 'just now');
  assert.equal(formatAge(60_000), '1 min ago');
  assert.equal(formatAge(8 * 60_000), '8 min ago');
  assert.equal(formatAge(90 * 60_000), '1 hr ago');
  assert.equal(formatAge(Number.NaN), 'just now');
  assert.equal(formatPoint({ latitude: 27.72, longitude: 85.32 }), '27.72°N 85.32°E');
  assert.equal(formatPoint({ latitude: -33.9, longitude: -18.4 }), '33.90°S 18.40°W');
  assert.equal(formatPoint({}), '');
});

test('the panel renders nothing when its markup is absent', () => {
  assert.equal(
    createIntelligencePanel({ document: { getElementById: () => null } }),
    null,
  );
});
