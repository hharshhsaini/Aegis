/**
 * One place that knows where the operator is looking.
 *
 * Before this, several surfaces each answered "where are we?" their own way —
 * the status strip from raw camera degrees, the intelligence panel from the
 * last point somebody clicked, the search box from whatever it last resolved —
 * so they could and did disagree, and a stale name could sit on screen long
 * after the camera had moved somewhere else entirely.
 *
 * This module makes that one piece of state. It watches the camera, waits for
 * it to SETTLE, resolves a name for where it ended up, and publishes the
 * result. Everything that needs a location subscribes rather than asking a
 * geocoder itself.
 *
 * Three things keep it cheap, because a Cesium camera generates a new position
 * every frame and the upstream geocoder is a public service with a one request
 * per second policy:
 *
 *  1. DEBOUNCE. Nothing happens until the camera has been still for a moment.
 *     A flight across the planet costs one lookup, not three hundred.
 *  2. BUCKETING. The position is rounded before it is used as a cache key, at
 *     a resolution that depends on altitude — from orbit a tenth of a degree
 *     is the same place, from a few kilometres up it is not.
 *  3. CACHING. A bucket that has been resolved is never resolved again.
 *
 * The published name is always attributed and may be null. An unresolved
 * location reports coordinates rather than guessing a nearby city.
 */

/** How long the camera must be still before its position is resolved. */
export const SETTLE_MS = 700;

/**
 * Coordinate rounding by altitude.
 *
 * The question "is this the same place as last time?" has a different answer
 * at 3,000 km than at 3 km, so the bucket size follows the camera's height.
 * Coarse buckets high up stop a slow orbital drift from resolving repeatedly;
 * fine buckets low down stop two different neighbourhoods sharing an answer.
 */
export const BUCKETS = Object.freeze([
  { aboveMetres: 2_000_000, degrees: 5 },
  { aboveMetres: 500_000, degrees: 1 },
  { aboveMetres: 100_000, degrees: 0.25 },
  { aboveMetres: 20_000, degrees: 0.05 },
  { aboveMetres: 0, degrees: 0.01 },
]);

/** Entries retained in the resolved-location cache. */
const MAX_CACHE = 80;

/**
 * The bucket size for an altitude.
 * @param {number} altitudeMetres Camera height.
 * @returns {number} Rounding, in degrees.
 */
export function bucketDegrees(altitudeMetres) {
  const height = Number.isFinite(altitudeMetres) ? altitudeMetres : 0;
  for (const bucket of BUCKETS)
    if (height >= bucket.aboveMetres) return bucket.degrees;
  return BUCKETS[BUCKETS.length - 1].degrees;
}

/**
 * Round a position onto its bucket.
 * @param {object} position Camera position.
 * @returns {{latitude: number, longitude: number, degrees: number}} Bucketed point.
 */
export function bucketPosition({ latitude, longitude, altitude }) {
  const degrees = bucketDegrees(altitude);
  const snap = (value) => Math.round(value / degrees) * degrees;
  return {
    latitude: Number(snap(latitude).toFixed(4)),
    longitude: Number(snap(longitude).toFixed(4)),
    degrees,
  };
}

/**
 * A display name for a resolved place.
 *
 * Two lines, the way an operator reads a location: what it is, then where that
 * is. A place with no locality falls back to its region, then its country, and
 * finally to nothing at all — the caller shows coordinates rather than a
 * plausible-looking guess.
 *
 * @param {object|null} place Regional brief place record.
 * @returns {{primary: string|null, secondary: string|null}} Display name.
 */
export function describePlace(place) {
  if (!place) return { primary: null, secondary: null };
  const primary = place.locality || place.region || place.country || null;
  const secondary =
    place.locality && place.region && place.region !== place.locality
      ? place.country
        ? `${place.region}, ${place.country}`
        : place.region
      : place.locality && place.country
        ? place.country
        : place.region && place.country && place.region !== place.country
          ? place.country
          : null;
  return { primary, secondary };
}

/**
 * Format a coordinate pair for display.
 * @param {number} latitude Degrees.
 * @param {number} longitude Degrees.
 * @returns {string} Display string.
 */
export function formatCoordinates(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
  const ns = latitude >= 0 ? 'N' : 'S';
  const ew = longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(latitude).toFixed(4)}° ${ns}  ${Math.abs(longitude).toFixed(4)}° ${ew}`;
}

/**
 * Create the shared location context.
 *
 * @param {object} input Input.
 * @param {object} input.viewer Cesium viewer.
 * @param {(latitude: number, longitude: number, options?: object) => Promise<object>} input.fetchBrief Regional brief transport.
 * @param {number} [input.settleMs] Camera settle delay.
 * @param {() => number} [input.now] Clock.
 * @returns {object} Frozen context.
 */
export function createLocationContext({
  viewer,
  fetchBrief,
  settleMs = SETTLE_MS,
  now = () => Date.now(),
}) {
  const cache = new Map();
  const listeners = new Set();
  let state = Object.freeze({
    latitude: null,
    longitude: null,
    altitude: null,
    locationName: null,
    region: null,
    country: null,
    countryCode: null,
    label: null,
    status: 'IDLE',
    source: 'OpenStreetMap / Nominatim',
    timestamp: null,
  });
  let settleTimer = null;
  let requestToken = 0;
  let destroyed = false;

  const publish = (next) => {
    state = Object.freeze({ ...state, ...next });
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // One broken subscriber must not stop the others.
      }
    }
  };

  /** The camera's current position, in degrees. */
  function cameraPosition() {
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) return null;
    return {
      latitude: (carto.latitude * 180) / Math.PI,
      longitude: (carto.longitude * 180) / Math.PI,
      altitude: carto.height,
    };
  }

  /**
   * Resolve a position to a place, through the cache.
   * @param {object} position Camera position.
   * @returns {Promise<void>} Resolution.
   */
  async function resolve(position) {
    const bucket = bucketPosition(position);
    const key = `${bucket.latitude},${bucket.longitude}@${bucket.degrees}`;

    // Coordinates are published immediately: they are known exactly, and
    // waiting for a name to show where the camera is would leave the previous
    // location's coordinates on screen — the stale-label bug in miniature.
    publish({
      latitude: position.latitude,
      longitude: position.longitude,
      altitude: position.altitude,
      timestamp: now(),
    });

    const cached = cache.get(key);
    if (cached) {
      publish({ ...cached, status: 'READY' });
      return;
    }

    const token = ++requestToken;
    publish({ status: 'RESOLVING' });
    try {
      const brief = await fetchBrief(bucket.latitude, bucket.longitude);
      // A camera that moved on while this was in flight owns the state now.
      if (destroyed || token !== requestToken) return;
      const place = brief?.place || null;
      const { primary, secondary } = describePlace(place);
      const resolved = {
        locationName: primary,
        region: place?.region ?? null,
        country: place?.country ?? null,
        countryCode: place?.countryCode ?? null,
        label: place?.label ?? null,
        secondary,
      };
      if (primary) {
        cache.set(key, resolved);
        while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      }
      publish({ ...resolved, status: primary ? 'READY' : 'UNRESOLVED' });
    } catch {
      if (destroyed || token !== requestToken) return;
      // An unreachable geocoder leaves the coordinates standing and says the
      // name is unavailable. It never leaves the PREVIOUS place's name up.
      publish({
        locationName: null,
        region: null,
        country: null,
        countryCode: null,
        label: null,
        status: 'UNAVAILABLE',
      });
    }
  }

  /** Called whenever the camera stops moving. */
  function onCameraSettled() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (destroyed) return;
      const position = cameraPosition();
      if (position) void resolve(position);
    }, settleMs);
  }

  const removeListener =
    viewer?.camera?.moveEnd?.addEventListener?.(onCameraSettled) || null;

  // Resolve the opening view without waiting for the operator to move.
  onCameraSettled();

  return Object.freeze({
    /** @returns {object} The current location state. */
    get() {
      return state;
    },
    /**
     * Subscribe to location changes. The listener is called immediately.
     * @param {(state: object) => void} listener Listener.
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    /**
     * Adopt a location the operator chose explicitly — a search result, an
     * incident. Published at once so the UI does not wait for the camera to
     * arrive and settle before it agrees with what was just selected.
     *
     * @param {object} location Location to adopt.
     */
    adopt({
      latitude,
      longitude,
      altitude = null,
      locationName = null,
      region = null,
      country = null,
    }) {
      publish({
        latitude,
        longitude,
        altitude,
        locationName,
        region,
        country,
        status: locationName ? 'READY' : 'RESOLVING',
        timestamp: now(),
      });
    },
    /** Force a resolve of the current camera position. */
    refresh() {
      const position = cameraPosition();
      if (position) void resolve(position);
    },
    destroy() {
      destroyed = true;
      clearTimeout(settleTimer);
      removeListener?.();
      listeners.clear();
      cache.clear();
    },
  });
}
