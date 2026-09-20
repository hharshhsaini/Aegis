import * as Cesium from 'cesium';
import { ANALYSIS_RADIUS_LABEL } from '../layers/earthquakes/exposure.js';

/**
 * Earthquake observations on the globe.
 *
 * Visual language, distinct from the fire layer's amber and the weather
 * overlay's risk tints: cool violet-to-white by DEPTH, sized by MAGNITUDE,
 * faded by AGE. Depth carries the colour because it is the property a
 * seismologist reads first and the one the panel explains.
 *
 * Level of detail keeps a busy day legible. Zoomed out, only sequence rings and
 * the larger events are drawn; zoomed in, every recorded event appears. A
 * magnitude floor rises with altitude, so a global view shows the events worth
 * seeing from a global view rather than ten thousand dots.
 *
 * The analysis circle drawn around a selected epicentre is labelled as a
 * geographic analysis radius wherever it appears. It is not a damage radius.
 */

/** Camera height below which every recorded event is drawn, in metres. */
export const DETAIL_ALTITUDE_M = 1_200_000;

/** Magnitude floor by camera height: {@link magnitudeFloor} reads this. */
const ALTITUDE_FLOORS = Object.freeze([
  { aboveM: 6_000_000, magnitude: 4.5 },
  { aboveM: 3_000_000, magnitude: 3.5 },
  { aboveM: 1_200_000, magnitude: 2.5 },
  { aboveM: 0, magnitude: -Infinity },
]);

/** Depth colours, shallow to deep. */
const DEPTH_COLORS = Object.freeze([
  { maxKm: 35, color: '#ff4d6d' },
  { maxKm: 70, color: '#ff8fa3' },
  { maxKm: 300, color: '#c77dff' },
  { maxKm: Infinity, color: '#7aa2ff' },
]);

/** Sequence rings, drawn where several events group together. */
const SEQUENCE_COLOR = '#c77dff';

/**
 * The smallest magnitude worth drawing at a camera height.
 * @param {number} heightM Camera height.
 * @returns {number} Magnitude floor.
 */
export function magnitudeFloor(heightM) {
  if (!Number.isFinite(heightM)) return 2.5;
  return (
    ALTITUDE_FLOORS.find((entry) => heightM > entry.aboveM)?.magnitude ??
    -Infinity
  );
}

/**
 * Colour for an event's depth.
 * @param {number|null} depthKm Depth.
 * @returns {string} CSS colour.
 */
export function depthColor(depthKm) {
  if (!Number.isFinite(depthKm))
    return DEPTH_COLORS[DEPTH_COLORS.length - 1].color;
  return DEPTH_COLORS.find((band) => depthKm < band.maxKm).color;
}

/**
 * Marker size for a magnitude.
 *
 * Magnitude is logarithmic, so the marker grows with the square of it: the
 * visual difference between M3 and M7 should look like the difference in energy,
 * not like four steps of the same size.
 *
 * @param {number|null} magnitude Reported magnitude.
 * @returns {number} Pixel size.
 */
export function markerPixelSize(magnitude) {
  if (!Number.isFinite(magnitude)) return 6;
  const clamped = Math.max(0, magnitude);
  return Math.min(42, 4 + clamped * clamped * 0.55);
}

/**
 * Opacity for an event's age. Older events fade but never vanish.
 * @param {number|null} ageMs Age in milliseconds.
 * @returns {number} Alpha 0..1.
 */
export function ageAlpha(ageMs) {
  if (!Number.isFinite(ageMs)) return 0.6;
  const hours = ageMs / 3_600_000;
  if (hours <= 1) return 1;
  if (hours >= 24) return 0.42;
  return 1 - (hours / 24) * 0.58;
}

/**
 * Create the earthquake overlay controller.
 *
 * @param {object} input Input.
 * @param {object} input.viewer Cesium viewer.
 * @param {(event: object) => void} [input.onEventSelected] Selection callback.
 * @returns {object} Frozen controller.
 */
export function createQuakeOverlay({ viewer, onEventSelected }) {
  if (!viewer?.entities) throw new TypeError('A Cesium viewer is required');

  const entities = [];
  let radiusEntity = null;
  let events = [];
  let clusters = [];
  let selectedId = null;
  let analysisRadiusKm = null;

  const scene = viewer.scene;

  function clearEntities() {
    for (const entity of entities) viewer.entities.remove(entity);
    entities.length = 0;
  }

  function clearRadius() {
    if (radiusEntity) viewer.entities.remove(radiusEntity);
    radiusEntity = null;
  }

  /** Remove everything this overlay drew. */
  function clear() {
    clearEntities();
    clearRadius();
    events = [];
    clusters = [];
    selectedId = null;
    scene?.requestRender?.();
  }

  /** Events worth drawing at the current camera height. */
  function visibleEvents() {
    const height = viewer.camera?.positionCartographic?.height;
    const floor = magnitudeFloor(height);
    return events.filter(
      (event) => !Number.isFinite(event.magnitude) || event.magnitude >= floor,
    );
  }

  function render(now = Date.now()) {
    clearEntities();
    const height = viewer.camera?.positionCartographic?.height ?? 0;

    // Sequence rings first, so individual events draw over them.
    if (height > DETAIL_ALTITUDE_M / 3)
      for (const cluster of clusters) {
        if (cluster.kind !== 'SEQUENCE') continue;
        const color = Cesium.Color.fromCssColorString(SEQUENCE_COLOR);
        const radius = Math.max(20_000, (cluster.radiusKm || 20) * 1000);
        entities.push(
          viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(
              cluster.center.longitude,
              cluster.center.latitude,
            ),
            ellipse: {
              semiMajorAxis: radius,
              semiMinorAxis: radius,
              material: color.withAlpha(0.1),
              outline: true,
              outlineColor: color.withAlpha(0.5),
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            label: {
              text: `EARTHQUAKE SEQUENCE · ${cluster.eventCount} events · max M${cluster.maxMagnitude ?? '—'}`,
              font: '500 11px "JetBrains Mono", monospace',
              fillColor: color,
              showBackground: true,
              backgroundColor:
                Cesium.Color.fromCssColorString('#0a0a0f').withAlpha(0.78),
              backgroundPadding: new Cesium.Cartesian2(8, 5),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              pixelOffset: new Cesium.Cartesian2(0, -14),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
                0,
                4_000_000,
              ),
            },
          }),
        );
      }

    for (const event of visibleEvents()) {
      const color = Cesium.Color.fromCssColorString(depthColor(event.depth));
      const alpha = ageAlpha(
        Number.isFinite(event.time) ? now - event.time : null,
      );
      const selected = event.id === selectedId;
      const entity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(
          event.longitude,
          event.latitude,
        ),
        point: {
          pixelSize: markerPixelSize(event.magnitude) * (selected ? 1.35 : 1),
          color: color.withAlpha(alpha),
          outlineColor: selected
            ? Cesium.Color.WHITE
            : Cesium.Color.BLACK.withAlpha(0.5),
          outlineWidth: selected ? 3 : 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        // Only the notable events carry a label; the rest are read by clicking.
        label:
          selected ||
          (Number.isFinite(event.magnitude) && event.magnitude >= 5.5)
            ? {
                text: `M${event.magnitude?.toFixed(1) ?? '—'} · ${event.depth ?? '—'} km`,
                font: '500 11px "JetBrains Mono", monospace',
                fillColor: color,
                showBackground: true,
                backgroundColor:
                  Cesium.Color.fromCssColorString('#0a0a0f').withAlpha(0.8),
                backgroundPadding: new Cesium.Cartesian2(7, 4),
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -12),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
                  0,
                  3_000_000,
                ),
              }
            : undefined,
      });
      entity.aegisQuakeId = event.id;
      entities.push(entity);
    }
    scene?.requestRender?.();
  }

  /**
   * Draw the geographic analysis circle around the selected epicentre.
   *
   * The label is part of the drawing: an unlabelled circle around an earthquake
   * reads as a damage estimate, which this is not.
   */
  function renderRadius(event, radiusKm) {
    clearRadius();
    if (!event || !Number.isFinite(radiusKm)) return;
    const color = Cesium.Color.fromCssColorString('#8ecae6');
    radiusEntity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(event.longitude, event.latitude),
      ellipse: {
        semiMajorAxis: radiusKm * 1000,
        semiMinorAxis: radiusKm * 1000,
        material: color.withAlpha(0.07),
        outline: true,
        outlineColor: color.withAlpha(0.55),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      label: {
        text: `${ANALYSIS_RADIUS_LABEL}: ${radiusKm} km`,
        font: '400 10px "JetBrains Mono", monospace',
        fillColor: color,
        showBackground: true,
        backgroundColor:
          Cesium.Color.fromCssColorString('#0a0a0f').withAlpha(0.8),
        backgroundPadding: new Cesium.Cartesian2(7, 4),
        verticalOrigin: Cesium.VerticalOrigin.TOP,
        pixelOffset: new Cesium.Cartesian2(0, 12),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          4_000_000,
        ),
      },
    });
    scene?.requestRender?.();
  }

  return Object.freeze({
    /**
     * Render one observation.
     * @param {object} intelligence Engine output.
     * @param {number} [now] Clock, for age fading.
     */
    show(intelligence, now = Date.now()) {
      events = intelligence?.events ? [...intelligence.events] : [];
      clusters = intelligence?.clusters ? [...intelligence.clusters] : [];
      if (selectedId && !events.some((event) => event.id === selectedId)) {
        selectedId = null;
        clearRadius();
      }
      render(now);
      const selected = events.find((event) => event.id === selectedId);
      if (selected && analysisRadiusKm)
        renderRadius(selected, analysisRadiusKm);
    },
    /**
     * Select one event.
     * @param {string|null} eventId USGS event id.
     * @param {number|null} [radiusKm] Analysis radius to draw.
     * @returns {object|null} The selected event.
     */
    select(eventId, radiusKm = analysisRadiusKm) {
      selectedId = eventId;
      analysisRadiusKm = radiusKm;
      const event = events.find((entry) => entry.id === eventId) || null;
      render();
      if (event && Number.isFinite(radiusKm)) renderRadius(event, radiusKm);
      else clearRadius();
      return event;
    },
    /** Change the analysis radius for the current selection. */
    setAnalysisRadius(radiusKm) {
      analysisRadiusKm = radiusKm;
      const event = events.find((entry) => entry.id === selectedId) || null;
      if (event) renderRadius(event, radiusKm);
      return event;
    },
    /** Re-evaluate level of detail after the camera settles. */
    refreshDetail() {
      render();
    },
    /**
     * Resolve a picked object to an event.
     * @param {object} picked Result of `scene.pick`.
     * @returns {object|null} The event, or null.
     */
    eventFromPick(picked) {
      const id = picked?.id?.aegisQuakeId;
      if (!id) return null;
      const event = events.find((entry) => entry.id === id) || null;
      if (event) {
        selectedId = id;
        render();
        if (Number.isFinite(analysisRadiusKm))
          renderRadius(event, analysisRadiusKm);
        onEventSelected?.(event);
      }
      return event;
    },
    clear,
    getEvents: () => events,
    getSelected: () => events.find((event) => event.id === selectedId) || null,
    getVisibleCount: () => visibleEvents().length,
    destroy: clear,
  });
}
