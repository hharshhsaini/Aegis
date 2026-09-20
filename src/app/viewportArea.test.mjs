import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SPAN_DEGREES,
  MIN_SPAN_DEGREES,
  spanForAltitude,
  subPointBoundingBox,
  viewportBoundingBox,
} from './viewportArea.js';

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/**
 * A viewer stub.
 * @param {object} input Camera state.
 * @returns {object} Viewer-shaped object.
 */
function viewer({ rectangle = null, latitude = 0, longitude = 0, height = 0 }) {
  return {
    camera: {
      computeViewRectangle: () => rectangle,
      positionCartographic: {
        latitude: toRadians(latitude),
        longitude: toRadians(longitude),
        height,
      },
    },
    scene: { globe: { ellipsoid: {} } },
  };
}

/** A Cesium-style rectangle in radians. */
function rectangle(west, south, east, north) {
  return {
    west: toRadians(west),
    south: toRadians(south),
    east: toRadians(east),
    north: toRadians(north),
  };
}

test('a usable view rectangle is used as-is', () => {
  const box = viewportBoundingBox(
    viewer({ rectangle: rectangle(80, 25, 90, 30) }),
  );
  assert.ok(Math.abs(box.west - 80) < 1e-6);
  assert.ok(Math.abs(box.north - 30) < 1e-6);
});

test('a camera with the horizon in shot still yields an area', () => {
  // This is the case that mattered: computeViewRectangle returns nothing at
  // regional altitudes, and treating that as "no area of interest" stopped the
  // fire feed asking anything at all.
  const box = viewportBoundingBox(
    viewer({ rectangle: null, latitude: 21, longitude: 82, height: 3_000_000 }),
  );
  assert.ok(box, 'a box is produced from the sub-point');
  assert.ok(box.west < 82 && box.east > 82, 'centred on the camera longitude');
  assert.ok(box.south < 21 && box.north > 21, 'centred on the camera latitude');
});

test('a rectangle wider than any feed can answer is narrowed', () => {
  const box = viewportBoundingBox(
    viewer({
      rectangle: rectangle(-180, -90, 180, 90),
      latitude: 21,
      longitude: 82,
      height: 3_000_000,
    }),
  );
  assert.ok(box.east - box.west <= MAX_SPAN_DEGREES);
  assert.ok(box.west < 82 && box.east > 82);
});

test('an inverted rectangle falls through rather than describing the wrong half', () => {
  // A view crossing the antimeridian comes back inverted; sending it would ask
  // about everything except what is on screen.
  const box = viewportBoundingBox(
    viewer({
      rectangle: rectangle(170, 10, -170, 20),
      latitude: 15,
      longitude: 179,
      height: 500_000,
    }),
  );
  assert.ok(box.east > box.west, 'the returned box is not inverted');
});

test('span grows with altitude and stays within its bounds', () => {
  assert.equal(spanForAltitude(0), MIN_SPAN_DEGREES);
  assert.equal(spanForAltitude(Number.NaN), MIN_SPAN_DEGREES);
  assert.equal(spanForAltitude(40_000_000), MAX_SPAN_DEGREES);
  const low = spanForAltitude(200_000);
  const high = spanForAltitude(2_000_000);
  assert.ok(high > low);
  assert.ok(high <= MAX_SPAN_DEGREES);
});

test('the sub-point box clamps at the poles', () => {
  const box = subPointBoundingBox(
    viewer({ latitude: 88, longitude: 0, height: 4_000_000 }),
  );
  assert.ok(box.north <= 90);
  assert.ok(box.south < box.north);
});

test('a viewer without a camera yields nothing rather than a guess', () => {
  assert.equal(viewportBoundingBox({}), null);
  assert.equal(subPointBoundingBox({}), null);
});
