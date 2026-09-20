import * as Cesium from 'cesium';
import {
  holdContinuousRender,
  releaseContinuousRender,
} from './renderGovernor.js';

/**
 * Camera presets for notable locations.
 * Phase 1 default: fly to Austin, TX on load.
 */
export const CAMERA_PRESETS = {
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * The view Aegis opens on.
 *
 * A disaster-intelligence console has to open on a region, not on a street. The
 * previous default flew to 600 m over a single city, which put the operator
 * inside one neighbourhood before any feed had answered: no spatial context, no
 * visible globe, and every area query — weather, FIRMS, USGS — scoped to a few
 * blocks.
 *
 * So the opening frame is South Asia, centred between the Indian subcontinent
 * and the Himalaya. It holds India, Nepal and the surrounding region in one
 * view, keeps the limb of the Earth in shot so the globe still reads as a
 * globe, and gives the viewport-driven feeds a region-sized box to ask about.
 * Centred rather than offset, because the side rails do not reach the middle of
 * the screen at any supported width.
 */
export const INITIAL_VIEW = Object.freeze({
  longitude: 82.0,
  latitude: 21.0,
  /**
   * Chosen by looking at it: at this height the subcontinent, Nepal, the
   * Himalaya and the surrounding seas all sit inside a 16:9 frame with the limb
   * of the Earth still visible at the edges. Higher and the region becomes a
   * smudge on a small disc; lower and the horizon leaves the shot and the globe
   * reads as a flat map.
   */
  altitude: 3_000_000,
  /** A slight tilt off vertical; straight down reads as a map, not a globe. */
  pitchDegrees: -85,
});

/** The altitude the opening flight starts from, above {@link INITIAL_VIEW}. */
const APPROACH_ALTITUDE = 9_000_000;

/** Opening flight duration, in seconds. */
const FLIGHT_SECONDS = 4.0;

/** Pause before the approach begins, so the first frame settles. */
const APPROACH_DELAY_MS = 500;

/** Render-governor hold owner for the opening flight. */
const RENDER_HOLD_ID = 'initial-camera-flight';

/**
 * Open on the regional view with a short approach.
 *
 * @param {object} viewer Cesium viewer.
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToInitialView(viewer) {
  const finalView = {
    destination: Cesium.Cartesian3.fromDegrees(
      INITIAL_VIEW.longitude,
      INITIAL_VIEW.latitude,
      INITIAL_VIEW.altitude,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(INITIAL_VIEW.pitchDegrees),
      roll: 0.0,
    },
  };

  // The framing is a requirement; the approach is a flourish. A camera flight
  // is a per-frame animation that Cesium advances inside Scene.render(), so it
  // does not run at all when the render loop is suspended — which is what
  // happens whenever the page starts in a background tab. Relying on the flight
  // to deliver the opening view therefore strands the console at whatever
  // altitude the approach began from, with no error anywhere. So: fly when the
  // page can actually render, and otherwise simply arrive.
  const canAnimate =
    (viewer.scene?.canvas?.ownerDocument ?? globalThis.document)
      ?.visibilityState !== 'hidden';

  if (!canAnimate) {
    viewer.camera.setView(finalView);
    return () => {};
  }

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      INITIAL_VIEW.longitude,
      INITIAL_VIEW.latitude,
      APPROACH_ALTITUDE,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Under the render governor's idle mode nothing renders unless something asks
  // for it, and an unheld flight freezes mid-tween without firing either
  // callback. The hold is what keeps the frames coming for its duration.
  let held = true;
  holdContinuousRender(RENDER_HOLD_ID);
  const release = () => {
    if (!held) return;
    held = false;
    releaseContinuousRender(RENDER_HOLD_ID);
  };

  let arrived = false;
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) {
      release();
      return;
    }
    viewer.camera.flyTo({
      ...finalView,
      duration: FLIGHT_SECONDS,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: () => {
        arrived = true;
        release();
      },
      cancel: release,
    });
  }, APPROACH_DELAY_MS);

  // If the flight neither completed nor was cancelled — the page was hidden
  // part-way through, say — put the camera where it was always going. An
  // operator must never be left looking at the approach.
  const failsafe = setTimeout(
    () => {
      release();
      if (!arrived && !viewer.isDestroyed()) viewer.camera.setView(finalView);
    },
    APPROACH_DELAY_MS + (FLIGHT_SECONDS + 1) * 1000,
  );

  return () => {
    clearTimeout(timer);
    clearTimeout(failsafe);
    release();
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}
