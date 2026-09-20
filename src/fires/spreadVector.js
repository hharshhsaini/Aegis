/**
 * Wind to a modeled potential spread direction.
 *
 * One detail governs this whole module: meteorological wind direction is the
 * direction the wind comes FROM. A 90° wind is an easterly — it blows toward
 * the west. Fire is carried the other way, so the spread bearing is the wind
 * bearing plus 180°. Getting this backwards would point every arrow in Aegis at
 * exactly the wrong half of the map, so the two values are named separately and
 * never mixed: `windFromDegrees` and `spreadTowardDegrees`.
 *
 * What this produces is an environmental statement — where wind would carry
 * fire right now — not a prediction of where a fire will go. Terrain, fuel,
 * suppression and fire behaviour itself are not in this calculation, and the
 * label that ships with it says so.
 */

const COMPASS = Object.freeze([
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
]);

/** The wording that must accompany any drawn vector. */
export const SPREAD_VECTOR_LABEL =
  'Modeled potential spread direction based on current wind';

/**
 * Name a bearing in compass points.
 * @param {number|null} degrees Bearing, degrees clockwise from north.
 * @returns {string|null} Compass point, or null without a bearing.
 */
export function cardinalDirection(degrees) {
  if (!Number.isFinite(degrees)) return null;
  const normalized = ((degrees % 360) + 360) % 360;
  return COMPASS[Math.round(normalized / 22.5) % 16];
}

/**
 * Build the modeled spread vector for a location's current wind.
 *
 * Length is a VISUAL scale for the arrow, derived from wind speed alone. It is
 * not a distance the fire is expected to travel, and is capped so a gale does
 * not draw a line across a continent.
 *
 * @param {object} metrics Derived weather metrics for the cluster's location.
 * @returns {object|null} Frozen vector, or null when wind is unknown.
 */
export function spreadVector(metrics) {
  const windFromDegrees = metrics?.wind_direction_10m;
  const speed = metrics?.wind_speed_10m;
  if (!Number.isFinite(windFromDegrees) || !Number.isFinite(speed)) return null;
  const spreadTowardDegrees = (windFromDegrees + 180) % 360;
  return Object.freeze({
    windFromDegrees,
    windFromCardinal: cardinalDirection(windFromDegrees),
    spreadTowardDegrees,
    spreadTowardCardinal: cardinalDirection(spreadTowardDegrees),
    windSpeedKmh: speed,
    windGustsKmh: Number.isFinite(metrics.wind_gusts_10m)
      ? metrics.wind_gusts_10m
      : null,
    // 10 km at a calm 10 km/h, 40 km in a 60 km/h wind — a legible arrow, not a
    // forecast distance.
    vectorLengthKm: Number(Math.min(40, 6 + speed * 0.55).toFixed(1)),
    label: SPREAD_VECTOR_LABEL,
    basis: 'current 10 m wind only; terrain, fuel and fire behaviour excluded',
  });
}
