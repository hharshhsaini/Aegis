import test from 'node:test';
import assert from 'node:assert/strict';
import { createRiskOverlay } from './riskOverlay.js';
import { analyzeSnapshot } from '../risk/riskEngine.js';
import { normalizeForecast } from '../weather/normalize.js';
import { syntheticForecast } from '../weather/testSupport/syntheticWeather.mjs';

/**
 * The overlay's value is its restraint. These tests pin the two behaviors that
 * make it trustworthy: nothing is drawn where nothing was found, and one
 * analysis draws one region — never a trail of markers across the globe.
 */

function stubViewer() {
  const added = [];
  return {
    added,
    scene: { requestRender() {} },
    entities: {
      // Cesium returns the very Entity it stored, and `remove` takes that same
      // reference back. The stub must do likewise or teardown silently fails.
      add(entity) {
        added.push(entity);
        return entity;
      },
      remove(entity) {
        const index = added.findIndex((candidate) => candidate === entity);
        if (index >= 0) added.splice(index, 1);
      },
    },
  };
}

const analysisFor = (options) =>
  analyzeSnapshot(normalizeForecast(syntheticForecast(options)));

const HEAVY = {
  base: {
    soil_moisture_0_to_1cm: 0.45,
    soil_moisture_1_to_3cm: 0.44,
    soil_moisture_3_to_9cm: 0.44,
    precipitation_probability: 95,
  },
  shape: (hour, values) => ({ ...values, precipitation: 12, rain: 12 }),
};

const POINT = { latitude: 27.7, longitude: 85.3 };

test('a quiet location draws nothing at all', () => {
  const viewer = stubViewer();
  const overlay = createRiskOverlay({ viewer });
  const calm = analysisFor();
  assert.equal(calm.overall.level, 'NORMAL');
  overlay.show(calm, POINT);
  assert.equal(viewer.added.length, 0);
  assert.equal(overlay.isVisible(), false);
});

test('a significant finding draws one region carrying its own reading', () => {
  const viewer = stubViewer();
  const overlay = createRiskOverlay({ viewer });
  const analysis = analysisFor(HEAVY);
  assert.ok(['MODERATE', 'ELEVATED', 'HIGH'].includes(analysis.overall.level));
  overlay.show(analysis, POINT);

  assert.equal(viewer.added.length, 1);
  const [entity] = viewer.added;
  assert.ok(entity.ellipse.semiMajorAxis > 0);
  assert.equal(entity.ellipse.semiMajorAxis, entity.ellipse.semiMinorAxis);
  // The label states the hazard and the score, so the globe agrees with the panel.
  const worst = analysis.risks[analysis.overall.peak];
  assert.match(entity.label.text, new RegExp(worst.label));
  assert.match(entity.label.text, new RegExp(`${worst.score}/100`));
  assert.match(entity.label.text, new RegExp(analysis.overall.level));
});

test('repeated analyses update one region instead of littering markers', () => {
  const viewer = stubViewer();
  const overlay = createRiskOverlay({ viewer });
  const analysis = analysisFor(HEAVY);
  for (let i = 0; i < 5; i += 1)
    overlay.show(analysis, { latitude: 27.7 + i * 0.4, longitude: 85.3 });
  assert.equal(viewer.added.length, 1, 'five analyses must not leave five markers');
});

test('a risk that subsides removes its region', () => {
  const viewer = stubViewer();
  const overlay = createRiskOverlay({ viewer });
  overlay.show(analysisFor(HEAVY), POINT);
  assert.equal(overlay.isVisible(), true);
  overlay.show(analysisFor(), POINT);
  assert.equal(viewer.added.length, 0, 'the overlay clears when the risk clears');
  assert.equal(overlay.isVisible(), false);
});

test('higher levels draw more prominently than lower ones', async () => {
  const { LEVEL_STYLE } = await import('./riskOverlay.js');
  assert.ok(LEVEL_STYLE.HIGH.fill > LEVEL_STYLE.ELEVATED.fill);
  assert.ok(LEVEL_STYLE.ELEVATED.fill > LEVEL_STYLE.MODERATE.fill);
  assert.ok(LEVEL_STYLE.HIGH.radiusM > LEVEL_STYLE.MODERATE.radiusM);
  // NORMAL and LOW have no treatment: they are not drawn.
  assert.equal(LEVEL_STYLE.NORMAL, undefined);
  assert.equal(LEVEL_STYLE.LOW, undefined);
});

test('teardown and bad input are handled without throwing', () => {
  const viewer = stubViewer();
  const overlay = createRiskOverlay({ viewer });
  overlay.show(analysisFor(HEAVY), POINT);
  overlay.show(null, POINT);
  assert.equal(viewer.added.length, 0);
  overlay.show(analysisFor(HEAVY), { latitude: null, longitude: null });
  assert.equal(viewer.added.length, 0);
  overlay.destroy();
  assert.throws(() => createRiskOverlay({}), /viewer/);
});
