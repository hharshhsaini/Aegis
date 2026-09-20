import * as Cesium from 'cesium';
import { RISK_LEVELS } from '../risk/thresholds.js';

/**
 * The risk overlay on the globe.
 *
 * One analysis, one overlay. The map is not peppered with markers: an area is
 * drawn only where the engine found something worth looking at, and a quiet
 * location draws nothing at all. That restraint is the point — an overlay that
 * always appears carries no information, and an operator learns to ignore it.
 *
 * Prominence scales with the finding. MODERATE is a soft tint; HIGH is a solid,
 * outlined region. The colors are the same scale the panel uses, so a color
 * means one thing across the whole product.
 */

/** Level id to display treatment. NORMAL and LOW draw nothing by design. */
const LEVEL_STYLE = Object.freeze({
  MODERATE: { fill: 0.1, outline: 0.35, radiusM: 12_000 },
  ELEVATED: { fill: 0.17, outline: 0.55, radiusM: 16_000 },
  HIGH: { fill: 0.24, outline: 0.8, radiusM: 20_000 },
});

const LEVEL_COLORS = Object.freeze(
  Object.fromEntries(RISK_LEVELS.map((band) => [band.id, band.color])),
);

/**
 * Create the overlay controller.
 *
 * @param {object} input Controller input.
 * @param {object} input.viewer Cesium viewer.
 * @returns {object} Frozen controller with `show`, `clear` and `destroy`.
 */
export function createRiskOverlay({ viewer }) {
  if (!viewer?.entities) throw new TypeError('A Cesium viewer is required');
  let entity = null;

  /** Remove the overlay, if one is drawn. */
  function clear() {
    if (entity) viewer.entities.remove(entity);
    entity = null;
    viewer.scene?.requestRender?.();
  }

  /**
   * Draw the overlay for one analysis, or clear it when nothing is notable.
   *
   * @param {object} analysis Engine analysis.
   * @param {{latitude: number, longitude: number}} point Analyzed point.
   */
  function show(analysis, point) {
    const overall = analysis?.overall;
    const style = LEVEL_STYLE[overall?.level];
    if (!style || !Number.isFinite(point?.latitude)) {
      clear();
      return;
    }
    const color = Cesium.Color.fromCssColorString(
      LEVEL_COLORS[overall.level] || '#ffd23f',
    );
    const position = Cesium.Cartesian3.fromDegrees(
      point.longitude,
      point.latitude,
    );
    const worst = analysis.risks?.[overall.peak];
    const description = `${worst?.label ?? 'Environmental risk'} ${worst?.score ?? overall.score}/100 · ${overall.level}`;

    if (!entity) {
      entity = viewer.entities.add({
        position,
        // `clampToGround` keeps the disc on terrain rather than floating over
        // valleys, which is where flood risk is read.
        ellipse: {
          semiMajorAxis: style.radiusM,
          semiMinorAxis: style.radiusM,
          material: color.withAlpha(style.fill),
          outline: true,
          outlineColor: color.withAlpha(style.outline),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          text: description,
          font: '500 12px "JetBrains Mono", monospace',
          fillColor: color,
          showBackground: true,
          backgroundColor:
            Cesium.Color.fromCssColorString('#0a0a0f').withAlpha(0.75),
          backgroundPadding: new Cesium.Cartesian2(9, 6),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -14),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // The label is context for the disc, not a target the operator should
          // chase across a zoomed-out globe.
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            2_500_000,
          ),
        },
      });
    } else {
      entity.position = position;
      entity.ellipse.semiMajorAxis = style.radiusM;
      entity.ellipse.semiMinorAxis = style.radiusM;
      entity.ellipse.material = color.withAlpha(style.fill);
      entity.ellipse.outlineColor = color.withAlpha(style.outline);
      entity.label.text = description;
      entity.label.fillColor = color;
    }
    viewer.scene?.requestRender?.();
  }

  return Object.freeze({
    show,
    clear,
    destroy: clear,
    /** Exposed for tests: whether an overlay is currently drawn. */
    isVisible: () => entity !== null,
  });
}

export { LEVEL_STYLE };
