import * as Cesium from 'cesium';

/**
 * The area of interest for the viewport-driven feeds.
 *
 * Every area feed in Aegis — FIRMS, Open-Meteo, USGS — asks about the region an
 * operator is actually looking at. Deriving that region from the camera is
 * usually `computeViewRectangle`, but that returns NOTHING whenever the horizon
 * is in shot, which is exactly the framing a disaster console opens on. A null
 * there does not mean "no area of interest": it means the camera is far enough
 * out that the frame includes space.
 *
 * Treating that as "no area" is what made a zoomed-out view silently stop
 * asking FIRMS anything at all, while the earthquake feed fell through to the
 * whole planet. So when the rectangle is unavailable this module falls back to
 * a box centred on the camera's SUB-POINT — the spot on the ground directly
 * beneath it — sized from its altitude. The box is an approximation of what is
 * on screen and is capped, because a request for a hemisphere is not a useful
 * question to ask any of these feeds.
 */

/** Widest box worth asking about, in degrees of longitude. */
export const MAX_SPAN_DEGREES = 80;

/** Narrowest fallback box, so a near-surface camera still gets a usable area. */
export const MIN_SPAN_DEGREES = 2;

/**
 * Approximate the on-screen span from camera altitude.
 *
 * One degree of latitude is about 111 km. A camera at altitude h with a ~60°
 * vertical field of view sees roughly 1.15·h across the ground, so the span in
 * degrees is that divided by 111 km. Approximate by design — it feeds a cache
 * grid that snaps to 5° anyway.
 *
 * @param {number} altitudeMetres Camera height above the ellipsoid.
 * @returns {number} Span in degrees, clamped.
 */
export function spanForAltitude(altitudeMetres) {
  if (!Number.isFinite(altitudeMetres) || altitudeMetres <= 0)
    return MIN_SPAN_DEGREES;
  const span = (altitudeMetres * 1.15) / 111_000;
  return Math.min(MAX_SPAN_DEGREES, Math.max(MIN_SPAN_DEGREES, span));
}

/**
 * A bounding box around the camera's sub-point.
 *
 * @param {object} viewer Cesium viewer.
 * @returns {{west: number, south: number, east: number, north: number}|null} Box in degrees.
 */
export function subPointBoundingBox(viewer) {
  const carto = viewer?.camera?.positionCartographic;
  if (!carto) return null;
  const latitude = Cesium.Math.toDegrees(carto.latitude);
  const longitude = Cesium.Math.toDegrees(carto.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const span = spanForAltitude(carto.height);
  const half = span / 2;
  // Latitude clamps at the poles; longitude does not wrap, because a box that
  // crosses the antimeridian describes the wrong half of the planet to every
  // consumer here. A camera over the dateline gets the clamped box instead.
  const south = Math.max(-90, latitude - half);
  const north = Math.min(90, latitude + half);
  const west = Math.max(-180, longitude - half);
  const east = Math.min(180, longitude + half);
  if (east <= west || north <= south) return null;
  return { west, south, east, north };
}

/**
 * The viewport as a bounding box, with a sub-point fallback.
 *
 * @param {object} viewer Cesium viewer.
 * @returns {{west: number, south: number, east: number, north: number}|null} Box in degrees.
 */
export function viewportBoundingBox(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle?.(
    viewer.scene?.globe?.ellipsoid,
  );
  if (rectangle) {
    const box = {
      west: Cesium.Math.toDegrees(rectangle.west),
      south: Cesium.Math.toDegrees(rectangle.south),
      east: Cesium.Math.toDegrees(rectangle.east),
      north: Cesium.Math.toDegrees(rectangle.north),
    };
    // An inverted box means the rectangle crossed the antimeridian; asking for
    // it would describe the planet the wrong way round, so fall through.
    if (box.east > box.west && box.north > box.south) {
      const span = Math.max(box.east - box.west, box.north - box.south);
      if (span <= MAX_SPAN_DEGREES) return box;
      // A rectangle wider than any feed can usefully answer is narrowed to the
      // sub-point box rather than sent as-is.
      return subPointBoundingBox(viewer) || box;
    }
  }
  return subPointBoundingBox(viewer);
}
