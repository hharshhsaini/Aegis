import * as Cesium from 'cesium';
import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

/**
 * Reusable animation primitives for incident reconstruction.
 *
 * The Nepal flood sequence is authored: a person chose every camera move, every
 * beat and every hold. A live earthquake gets no author, so its reconstruction
 * has to be assembled from primitives at the moment the event arrives. These
 * are those primitives.
 *
 * They are deliberately thin. Each one owns a render hold for its own duration
 * and releases it on every exit path, because Cesium advances animation inside
 * `Scene.render()` and the render governor stops rendering when nothing asks
 * for frames — an unheld animation does not run slowly, it does not run at all,
 * and it reports neither success nor failure while not running.
 *
 * Everything drawn here is removed by the handle it returns. A reconstruction
 * that cannot clean itself up leaves entities on the globe that outlive the
 * incident they described, which is how a console ends up showing a boundary
 * around something that stopped being true an hour ago.
 */

/** Render-hold owner ids, one per primitive so overlapping holds nest. */
let holdSequence = 0;

/**
 * Run a body with the renderer held on.
 *
 * @param {() => Promise<any>} body Work to run.
 * @returns {Promise<any>} The body's result.
 */
async function withRender(body) {
  const owner = `incident-animation-${++holdSequence}`;
  holdContinuousRender(owner);
  try {
    return await body();
  } finally {
    releaseContinuousRender(owner);
  }
}

/**
 * Wait, unless the token has been cancelled first.
 *
 * @param {number} ms Milliseconds.
 * @param {{cancelled?: boolean}} [token] Cancellation token.
 * @returns {Promise<void>} Resolution.
 */
export function sleep(ms, token) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!token) return;
    // Polling the token beats holding a listener list for something this
    // short-lived, and a cancelled phase should end promptly rather than
    // exactly.
    const poll = setInterval(() => {
      if (!token.cancelled) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    }, 80);
    setTimeout(() => clearInterval(poll), ms + 100);
  });
}

/**
 * Fly the camera to a point.
 *
 * @param {object} input Input.
 * @returns {Promise<boolean>} Whether the flight completed.
 */
export function cameraFlyTo({
  viewer,
  latitude,
  longitude,
  altitude = 250_000,
  pitchDegrees = -70,
  headingDegrees = 0,
  durationSeconds = 2.4,
  token,
}) {
  if (!viewer?.camera || !Number.isFinite(latitude))
    return Promise.resolve(false);
  return withRender(
    () =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            longitude,
            latitude,
            altitude,
          ),
          orientation: {
            heading: Cesium.Math.toRadians(headingDegrees),
            pitch: Cesium.Math.toRadians(pitchDegrees),
            roll: 0,
          },
          duration: durationSeconds,
          easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
          complete: () => finish(true),
          cancel: () => finish(false),
        });
        // A flight that reports neither outcome must still end the phase, or
        // the whole reconstruction stalls on it.
        setTimeout(() => finish(false), (durationSeconds + 2) * 1000);
        if (token?.cancelled) {
          viewer.camera.cancelFlight?.();
          finish(false);
        }
      }),
  );
}

/**
 * Orbit the camera around a point.
 *
 * @param {object} input Input.
 * @returns {Promise<void>} Resolution.
 */
export function cameraOrbit({
  viewer,
  latitude,
  longitude,
  altitude = 120_000,
  degrees = 90,
  durationSeconds = 4,
  token,
}) {
  if (!viewer?.camera || !Number.isFinite(latitude)) return Promise.resolve();
  return withRender(async () => {
    const centre = Cesium.Cartesian3.fromDegrees(longitude, latitude, 0);
    const steps = Math.max(1, Math.round(durationSeconds * 20));
    const perStep = Cesium.Math.toRadians(degrees / steps);
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(centre);
    viewer.camera.lookAtTransform(
      frame,
      new Cesium.HeadingPitchRange(
        viewer.camera.heading,
        Cesium.Math.toRadians(-45),
        altitude,
      ),
    );
    for (let step = 0; step < steps; step += 1) {
      if (token?.cancelled) break;
      viewer.camera.rotateRight(perStep);
      await sleep((durationSeconds * 1000) / steps, token);
    }
    // The transform must be released or every later camera move is expressed
    // relative to this point rather than to the globe.
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  });
}

/**
 * A pulsing point marking an epicentre or a cluster centre.
 *
 * @param {object} input Input.
 * @returns {object} Handle with `remove()`.
 */
export function pulsePoint({
  viewer,
  latitude,
  longitude,
  color = Cesium.Color.ORANGE,
  minimumPixels = 12,
  maximumPixels = 34,
  periodSeconds = 1.6,
  label = null,
}) {
  if (!viewer?.entities || !Number.isFinite(latitude)) return { remove() {} };
  const started = Date.now();
  const entity = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(longitude, latitude),
    point: {
      // A CallbackProperty is evaluated per frame, so the pulse needs the
      // renderer running; the caller holds it for the phase's duration.
      pixelSize: new Cesium.CallbackProperty(() => {
        const phase =
          ((Date.now() - started) % (periodSeconds * 1000)) /
          (periodSeconds * 1000);
        const swing = (1 - Math.cos(phase * Math.PI * 2)) / 2;
        return minimumPixels + swing * (maximumPixels - minimumPixels);
      }, false),
      color: color.withAlpha(0.85),
      outlineColor: color.withAlpha(0.35),
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    ...(label
      ? {
          label: {
            text: label,
            font: '11px "JetBrains Mono", monospace',
            fillColor: Cesium.Color.WHITE,
            pixelOffset: new Cesium.Cartesian2(0, -28),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }
      : {}),
  });
  return {
    entity,
    remove() {
      viewer.entities.remove(entity);
    },
  };
}

/**
 * A circle that grows to a radius, for an analysis or impact area.
 *
 * The label is the caller's, and callers are expected to name what the circle
 * actually is — a geographic analysis radius, a detection span — rather than
 * implying a measured impact boundary the data does not support.
 *
 * @param {object} input Input.
 * @returns {Promise<object>} Handle with `remove()`.
 */
export async function expandAffectedArea({
  viewer,
  latitude,
  longitude,
  radiusMetres,
  color = Cesium.Color.ORANGE,
  durationSeconds = 1.6,
  token,
}) {
  if (!viewer?.entities || !Number.isFinite(radiusMetres))
    return { remove() {} };
  let current = 0;
  const entity = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(longitude, latitude),
    ellipse: {
      semiMajorAxis: new Cesium.CallbackProperty(() => current || 1, false),
      semiMinorAxis: new Cesium.CallbackProperty(() => current || 1, false),
      material: color.withAlpha(0.12),
      outline: true,
      outlineColor: color.withAlpha(0.6),
      height: 0,
    },
  });
  await withRender(async () => {
    const steps = Math.max(1, Math.round(durationSeconds * 25));
    for (let step = 1; step <= steps; step += 1) {
      if (token?.cancelled) break;
      // Ease out: the boundary arrives quickly then settles, which reads as a
      // measurement being drawn rather than something spreading.
      const progress = 1 - (1 - step / steps) ** 3;
      current = radiusMetres * progress;
      await sleep((durationSeconds * 1000) / steps, token);
    }
    current = radiusMetres;
  });
  return {
    entity,
    remove() {
      viewer.entities.remove(entity);
    },
  };
}

/**
 * A static ring at a fixed radius, for a scored boundary.
 *
 * @param {object} input Input.
 * @returns {object} Handle with `remove()`.
 */
export function showRiskBoundary({
  viewer,
  latitude,
  longitude,
  radiusMetres,
  color = Cesium.Color.YELLOW,
  label = null,
}) {
  if (!viewer?.entities || !Number.isFinite(radiusMetres))
    return { remove() {} };
  const entity = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(longitude, latitude),
    ellipse: {
      semiMajorAxis: radiusMetres,
      semiMinorAxis: radiusMetres,
      material: Cesium.Color.TRANSPARENT,
      outline: true,
      outlineColor: color.withAlpha(0.75),
      outlineWidth: 2,
      height: 0,
    },
    ...(label
      ? {
          label: {
            text: label,
            font: '10px "JetBrains Mono", monospace',
            fillColor: color,
            pixelOffset: new Cesium.Cartesian2(0, 14),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }
      : {}),
  });
  return {
    entity,
    remove() {
      viewer.entities.remove(entity);
    },
  };
}

/**
 * Markers for nearby places, revealed one at a time.
 *
 * @param {object} input Input.
 * @returns {Promise<object>} Handle with `remove()`.
 */
export async function showEventMarkers({
  viewer,
  places = [],
  color = Cesium.Color.CYAN,
  staggerMs = 180,
  token,
}) {
  const entities = [];
  if (!viewer?.entities) return { remove() {} };
  await withRender(async () => {
    for (const place of places) {
      if (token?.cancelled) break;
      if (!Number.isFinite(place?.latitude)) continue;
      entities.push(
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(
            place.longitude,
            place.latitude,
          ),
          point: {
            pixelSize: 7,
            color: color.withAlpha(0.9),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: place.name
            ? {
                text: place.name,
                font: '10px "JetBrains Mono", monospace',
                fillColor: Cesium.Color.WHITE,
                pixelOffset: new Cesium.Cartesian2(0, -16),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              }
            : undefined,
        }),
      );
      await sleep(staggerMs, token);
    }
  });
  return {
    entities,
    remove() {
      for (const entity of entities) viewer.entities.remove(entity);
    },
  };
}

/**
 * A wind or spread direction arrow.
 *
 * ALWAYS labelled by the caller as modelled potential, never as a predicted
 * path: the vector is a weather-derived direction, not an observation of where
 * anything has gone or will go.
 *
 * @param {object} input Input.
 * @returns {object} Handle with `remove()`.
 */
export function showDirectionVector({
  viewer,
  latitude,
  longitude,
  bearingDegrees,
  lengthMetres = 20_000,
  color = Cesium.Color.ORANGE,
  label = 'MODELED POTENTIAL SPREAD',
}) {
  if (!viewer?.entities || !Number.isFinite(bearingDegrees))
    return { remove() {} };
  const radians = Cesium.Math.toRadians(bearingDegrees);
  const metresPerDegree = 111_320;
  const endLatitude =
    latitude + (Math.cos(radians) * lengthMetres) / metresPerDegree;
  const endLongitude =
    longitude +
    (Math.sin(radians) * lengthMetres) /
      (metresPerDegree * Math.cos(Cesium.Math.toRadians(latitude)));
  const entity = viewer.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([
        longitude,
        latitude,
        endLongitude,
        endLatitude,
      ]),
      width: 3,
      material: new Cesium.PolylineArrowMaterialProperty(color.withAlpha(0.8)),
      clampToGround: true,
    },
    position: Cesium.Cartesian3.fromDegrees(endLongitude, endLatitude),
    label: {
      text: label,
      font: '9px "JetBrains Mono", monospace',
      fillColor: color,
      pixelOffset: new Cesium.Cartesian2(0, -14),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
  return {
    entity,
    remove() {
      viewer.entities.remove(entity);
    },
  };
}
