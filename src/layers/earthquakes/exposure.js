import { DEFAULT_ANALYSIS_RADIUS_KM, ANALYSIS_RADII_KM } from './thresholds.js';

/**
 * Geographic exposure context around an epicentre.
 *
 * This module is an INTERFACE, not a dataset. Aegis does not yet carry
 * population, road, hospital or school data, and the one thing it must never do
 * is make some up: a fabricated "3 hospitals within 25 km" would be acted on.
 * So every category reports `UNAVAILABLE` until a real provider is supplied,
 * and the shape of the answer is fixed now so the OpenStreetMap/Overpass phase
 * can fill it in without changing a caller.
 *
 * The radius is a GEOGRAPHIC ANALYSIS RADIUS: a circle drawn to ask "what is
 * near this point". It is not a damage radius and not an affected area — the
 * data to claim either does not exist here.
 */

/** Categories the exposure context will report once data providers exist. */
export const EXPOSURE_CATEGORIES = Object.freeze([
  { id: 'populatedAreas', label: 'Populated areas' },
  { id: 'roads', label: 'Roads' },
  { id: 'hospitals', label: 'Hospitals' },
  { id: 'schools', label: 'Schools' },
  { id: 'emergencyFacilities', label: 'Emergency facilities' },
  { id: 'criticalInfrastructure', label: 'Critical infrastructure' },
]);

/** Status values a category can report. */
export const EXPOSURE_STATUS = Object.freeze({
  UNAVAILABLE: 'UNAVAILABLE',
  READY: 'READY',
  ERROR: 'ERROR',
});

/**
 * The label that must accompany any drawn radius.
 * Never "damage radius", never "predicted affected area".
 */
export const ANALYSIS_RADIUS_LABEL = 'Geographic analysis radius';

/**
 * Validate a requested analysis radius.
 * @param {number} km Requested radius.
 * @returns {number} A supported radius.
 */
export function normalizeAnalysisRadiusKm(km) {
  if (!Number.isFinite(km)) return DEFAULT_ANALYSIS_RADIUS_KM;
  // Snap to the offered set rather than accepting arbitrary values, so the
  // radius an operator sees is always one the UI offered.
  return ANALYSIS_RADII_KM.reduce(
    (best, candidate) =>
      Math.abs(candidate - km) < Math.abs(best - km) ? candidate : best,
    DEFAULT_ANALYSIS_RADIUS_KM,
  );
}

/**
 * Build the exposure context for one epicentre.
 *
 * @param {object} input Input.
 * @param {{latitude: number, longitude: number}} input.center Epicentre.
 * @param {number} [input.radiusKm] Analysis radius.
 * @param {object|null} [input.provider] Exposure provider, when one exists.
 *   Must expose `describe({ center, radiusKm })` returning per-category counts.
 * @returns {Promise<object>} Frozen exposure record.
 */
export async function geographicExposure({
  center,
  radiusKm = DEFAULT_ANALYSIS_RADIUS_KM,
  provider = null,
}) {
  const radius = normalizeAnalysisRadiusKm(radiusKm);
  const base = {
    center,
    analysisRadiusKm: radius,
    radiusLabel: ANALYSIS_RADIUS_LABEL,
    // Stated on the record itself so a consumer — including an LLM — cannot
    // present the circle as an impact estimate.
    basis:
      'Geographic analysis radius only. Not a damage radius and not an affected-area estimate.',
  };

  if (!provider?.describe) {
    return Object.freeze({
      ...base,
      status: EXPOSURE_STATUS.UNAVAILABLE,
      categories: Object.freeze(
        Object.fromEntries(
          EXPOSURE_CATEGORIES.map((category) => [
            category.id,
            Object.freeze({
              label: category.label,
              status: EXPOSURE_STATUS.UNAVAILABLE,
              count: null,
              note: 'No dataset connected yet.',
            }),
          ]),
        ),
      ),
      note: 'Exposure datasets are not connected. Aegis reports no infrastructure counts rather than estimating them.',
    });
  }

  try {
    const described = await provider.describe({ center, radiusKm: radius });
    const categories = {};
    for (const category of EXPOSURE_CATEGORIES) {
      const value = described?.[category.id];
      categories[category.id] = Object.freeze({
        label: category.label,
        status: Number.isFinite(value?.count)
          ? EXPOSURE_STATUS.READY
          : EXPOSURE_STATUS.UNAVAILABLE,
        count: Number.isFinite(value?.count) ? value.count : null,
        items: Object.freeze(Array.isArray(value?.items) ? value.items : []),
        note: value?.note ?? null,
      });
    }
    return Object.freeze({
      ...base,
      status: EXPOSURE_STATUS.READY,
      categories: Object.freeze(categories),
      attribution: described?.attribution ?? null,
      note: null,
    });
  } catch (error) {
    return Object.freeze({
      ...base,
      status: EXPOSURE_STATUS.ERROR,
      categories: Object.freeze({}),
      note: `Exposure lookup failed: ${error?.message || 'unknown error'}`,
    });
  }
}
