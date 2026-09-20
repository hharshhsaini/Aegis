import { driverState, riskLevel, DRIVER_STATES } from './thresholds.js';

/**
 * Shared scoring primitives. Every hazard model is the same shape — normalize
 * each signal onto 0..1, weight it, and keep the normalized value so the score
 * can explain itself — and that shape lives here rather than in each model.
 */

/**
 * Position a value on a `[start, saturate]` ramp.
 *
 * A descending ramp (start > saturate) is not a special case: it is how signals
 * whose LOW end is hazardous are expressed, such as humidity for fire spread or
 * metres of visibility. Values outside the ramp clamp to 0 or 1, and a
 * non-finite reading returns 0 so a missing variable can never invent risk.
 *
 * @param {number|null|undefined} value Observed value.
 * @param {readonly [number, number]} bounds `[start, saturate]` in the value's own units.
 * @returns {number} Normalized 0..1 position.
 */
export function ramp(value, [start, saturate]) {
  if (!Number.isFinite(value)) return 0;
  if (start === saturate) return value >= start ? 1 : 0;
  const span = saturate - start;
  return Math.min(1, Math.max(0, (value - start) / span));
}

/**
 * Convert a weighted set of normalized signals into a 0–100 score.
 *
 * Weights are normalized by the total weight PRESENT, so a missing variable
 * redistributes its influence across the signals that did arrive rather than
 * silently dragging the score toward zero.
 *
 * @param {Array<{weight: number, intensity: number}>} signals Weighted signals.
 * @returns {number} Score rounded to an integer 0–100.
 */
export function weightedScore(signals) {
  let weighted = 0;
  let total = 0;
  for (const { weight, intensity } of signals) {
    if (!Number.isFinite(weight) || weight <= 0) continue;
    total += weight;
    weighted += weight * Math.min(1, Math.max(0, intensity || 0));
  }
  if (total <= 0) return 0;
  return Math.round((weighted / total) * 100);
}

/**
 * Build one explainable driver record.
 *
 * `contribution` is the share of the final score this driver is responsible
 * for, which is what lets the panel rank drivers honestly instead of listing
 * them in declaration order.
 *
 * @param {object} input Driver definition.
 * @param {string} input.id Stable driver id.
 * @param {string} input.label Operator-facing name.
 * @param {number} input.intensity Normalized 0..1 position on its ramp.
 * @param {number} input.weight Model weight.
 * @param {number|null} [input.value] Raw observed value.
 * @param {string} [input.unit] Unit for display.
 * @param {string} [input.detail] Short phrase for the explanation line.
 * @returns {object} Frozen driver record.
 */
export function driver({
  id,
  label,
  intensity,
  weight,
  value = null,
  unit = '',
  detail = '',
}) {
  const normalized = Math.min(1, Math.max(0, intensity || 0));
  return Object.freeze({
    id,
    label,
    value: Number.isFinite(value) ? value : null,
    unit,
    detail,
    weight,
    intensity: Number(normalized.toFixed(3)),
    contribution: Number((normalized * weight).toFixed(3)),
    state: driverState(normalized),
  });
}

/**
 * Rank drivers by how much of the score they actually account for.
 * @param {object[]} drivers Driver records.
 * @returns {object[]} Drivers, strongest contribution first.
 */
export function rankDrivers(drivers) {
  return [...drivers].sort((a, b) => b.contribution - a.contribution);
}

/**
 * The drivers worth naming as reasons — those at or above MODERATE.
 * @param {object[]} drivers Driver records.
 * @param {number} [limit=4] Maximum number returned.
 * @returns {object[]} Leading drivers.
 */
export function leadingDrivers(drivers, limit = 4) {
  return rankDrivers(drivers)
    .filter((entry) => entry.intensity >= DRIVER_STATES.MODERATE)
    .slice(0, limit);
}

/**
 * Assemble a hazard result from its drivers.
 *
 * `damping` exists for models with a gating precondition — flash flood without
 * rainfall, fire spread during active rain — where the honest answer is to pull
 * the whole score down rather than to zero one driver and leave the rest
 * reading high. The reason is recorded so the damping is visible, never silent.
 *
 * @param {object} input Assembly input.
 * @param {string} input.id Hazard id.
 * @param {string} input.label Operator-facing hazard name.
 * @param {object[]} input.drivers Driver records.
 * @param {number} [input.damping=1] Multiplier in 0..1 applied to the score.
 * @param {string} [input.dampingReason] Why the score was damped.
 * @returns {object} Frozen hazard assessment without trend (added later).
 */
export function assembleHazard({
  id,
  label,
  drivers,
  damping = 1,
  dampingReason = '',
}) {
  const raw = weightedScore(drivers);
  const score = Math.round(raw * Math.min(1, Math.max(0, damping)));
  return Object.freeze({
    id,
    label,
    score,
    level: riskLevel(score),
    drivers: Object.freeze(rankDrivers(drivers)),
    leadingDrivers: Object.freeze(leadingDrivers(drivers)),
    damped:
      damping < 1
        ? Object.freeze({ factor: damping, reason: dampingReason })
        : null,
  });
}
