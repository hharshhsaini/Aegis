/**
 * The user's own location — asked for once, held carefully, kept separate.
 *
 * Two distinctions carry this module:
 *
 *  1. DEVICE vs VIEWED. Where the user IS and where the user is LOOKING are
 *     different facts and the console needs both. Panning to Kathmandu must not
 *     redirect somebody's earthquake alerts away from the city they are sitting
 *     in. Device location is what the alert layer monitors by default; viewed
 *     location is what the regional panel follows. The user can point
 *     monitoring at the viewed location deliberately, and never by accident.
 *
 *  2. PRECISION vs NEED. A browser will hand over metre-level coordinates. Very
 *     little here needs them: the camera frames a city, the geocoder is asked
 *     about a bucket, and distance banding works in tens of kilometres. So the
 *     exact fix stays in memory, the COARSE one is what leaves this module, and
 *     neither is written to storage, a URL, or a log.
 *
 * Permission is requested once. A denial is remembered so the app never nags,
 * and a denial is not a failure: Aegis works globally without it.
 */

/** Where the consent decision is remembered. Never holds coordinates. */
export const CONSENT_STORAGE_KEY = 'aegis.location.consent.v1';

/** Consent states. */
export const CONSENT = Object.freeze({
  UNASKED: 'UNASKED',
  GRANTED: 'GRANTED',
  DENIED: 'DENIED',
  UNAVAILABLE: 'UNAVAILABLE',
});

/**
 * Camera framing by fix accuracy, in metres of accuracy to metres of altitude.
 *
 * A coarse fix is framed regionally because that is all it supports; a precise
 * one is framed at city scale rather than at the user's roof. The console has
 * no reason to show somebody their own street, and doing so would make a
 * screen-share or a screenshot leak where they live.
 */
export const ACCURACY_FRAMING = Object.freeze([
  { accuracyOver: 50_000, altitude: 900_000, label: 'REGIONAL' },
  { accuracyOver: 5_000, altitude: 220_000, label: 'METRO' },
  { accuracyOver: 0, altitude: 90_000, label: 'CITY' },
]);

/** Coordinate rounding applied before a position leaves this module. */
export const COARSE_DECIMALS = 2;

/**
 * Framing for a reported accuracy.
 * @param {number} accuracyMetres Reported accuracy radius.
 * @returns {{altitude: number, label: string}} Camera framing.
 */
export function framingForAccuracy(accuracyMetres) {
  const accuracy = Number.isFinite(accuracyMetres) ? accuracyMetres : Infinity;
  for (const band of ACCURACY_FRAMING)
    if (accuracy > band.accuracyOver)
      return { altitude: band.altitude, label: band.label };
  const last = ACCURACY_FRAMING[ACCURACY_FRAMING.length - 1];
  return { altitude: last.altitude, label: last.label };
}

/**
 * Round a position to the precision the rest of the app is allowed to see.
 *
 * Two decimal places is roughly a kilometre — enough for distance bands, a
 * geocode and a city-scale camera, and not enough to identify a building.
 *
 * @param {{latitude: number, longitude: number}} position Exact position.
 * @returns {{latitude: number, longitude: number}} Coarse position.
 */
export function coarsen({ latitude, longitude }) {
  const round = (value) => Number(value.toFixed(COARSE_DECIMALS));
  return { latitude: round(latitude), longitude: round(longitude) };
}

/** Read the remembered consent decision. */
export function readConsent(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(CONSENT_STORAGE_KEY);
    return Object.values(CONSENT).includes(value) ? value : CONSENT.UNASKED;
  } catch {
    // Private browsing, blocked storage: treat as unasked rather than failing.
    return CONSENT.UNASKED;
  }
}

/** Remember a consent decision. */
export function writeConsent(value, storage = globalThis.localStorage) {
  try {
    storage?.setItem(CONSENT_STORAGE_KEY, value);
  } catch {
    // Not being able to remember means asking again next time, which is a
    // worse experience but not a broken one.
  }
}

/**
 * Create the device location context.
 *
 * @param {object} input Input.
 * @param {object} [input.geolocation] Geolocation API.
 * @param {object} [input.storage] Consent storage.
 * @param {() => number} [input.now] Clock.
 * @returns {object} Frozen context.
 */
export function createDeviceLocation({
  geolocation = globalThis.navigator?.geolocation,
  storage = globalThis.localStorage,
  now = () => Date.now(),
} = {}) {
  const listeners = new Set();
  let state = Object.freeze({
    consent: readConsent(storage),
    // The coarse position — the only one that leaves this module.
    location: null,
    accuracyMetres: null,
    framing: null,
    locationName: null,
    region: null,
    country: null,
    updatedAt: null,
  });

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

  return Object.freeze({
    get: () => state,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    /** @returns {boolean} Whether the consent card should be shown. */
    shouldAsk: () => state.consent === CONSENT.UNASKED,

    /**
     * Ask the browser for a position.
     *
     * The browser owns the permission dialog; this never tries to pre-empt or
     * work around it. Called only from an explicit user action.
     *
     * @returns {Promise<object>} The resulting state.
     */
    async request() {
      if (!geolocation?.getCurrentPosition) {
        writeConsent(CONSENT.UNAVAILABLE, storage);
        publish({ consent: CONSENT.UNAVAILABLE });
        return state;
      }
      return new Promise((resolve) => {
        geolocation.getCurrentPosition(
          (position) => {
            const accuracy = position?.coords?.accuracy;
            // Coarsened immediately: the exact fix is never stored on the
            // state that other modules read.
            const coarse = coarsen({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
            });
            writeConsent(CONSENT.GRANTED, storage);
            publish({
              consent: CONSENT.GRANTED,
              location: coarse,
              accuracyMetres: Number.isFinite(accuracy) ? accuracy : null,
              framing: framingForAccuracy(accuracy),
              updatedAt: now(),
            });
            resolve(state);
          },
          (error) => {
            // PERMISSION_DENIED is 1; anything else is the device being unable
            // to answer, which should not be remembered as a refusal.
            const denied = error?.code === 1;
            const decision = denied ? CONSENT.DENIED : CONSENT.UNAVAILABLE;
            writeConsent(decision, storage);
            publish({ consent: decision });
            resolve(state);
          },
          { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
        );
      });
    },

    /** Record that the user chose to continue without location. */
    decline() {
      writeConsent(CONSENT.DENIED, storage);
      publish({ consent: CONSENT.DENIED });
      return state;
    },

    /**
     * Attach the resolved place name for the device location.
     * @param {object} place Place fields.
     */
    setPlace({ locationName = null, region = null, country = null }) {
      publish({ locationName, region, country });
    },

    destroy() {
      listeners.clear();
    },
  });
}
