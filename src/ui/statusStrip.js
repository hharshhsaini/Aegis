import { FEED_STATES, formatAge } from './dataState.js';

/**
 * The Aegis status chip: two lines under the wordmark.
 *
 * This used to be a seven-cell telemetry strip — MODE, SYSTEM, DATA, REGION,
 * MONITORING, UTC, LAST SYNC — across the top of the screen. Every one of those
 * is an implementation fact. What a person opening a disaster console needs to
 * know is that Aegis is watching, and where; a strip that says it seven ways
 * reads as a dashboard and buries the globe it is supposed to be watching.
 *
 * So the same readings are still taken, and carried differently:
 *
 *  - The DOT carries feed health. Every registered feed is aggregated by taking
 *    the WORST state among them, which is the only aggregation safe to read at
 *    a glance: with two feeds live and one unreachable, "LIVE" would be a lie
 *    of omission. A green dot therefore never sits above a broken feed.
 *  - The WORD beside it carries live-versus-scenario, written by the incident
 *    bar, because authored playback must never be mistaken for live data.
 *  - The PLACE line carries the monitored location, falling back to where the
 *    camera is looking only when nothing is being monitored.
 *  - Everything else — which feed is degraded, UTC, staleness — moves into the
 *    tooltip. Available, not ambient.
 *
 * The chip never invents a region name. It prefers the resolved place name from
 * the shared location context, falls back to a coarse band while that is still
 * resolving, and falls back again to nothing at all.
 */

/** Worst-first, for aggregating across feeds. */
const SEVERITY = Object.freeze([
  FEED_STATES.UNAVAILABLE,
  FEED_STATES.STALE,
  FEED_STATES.NO_DATA,
  FEED_STATES.LOADING,
  FEED_STATES.RECENT,
  FEED_STATES.LIVE,
]);

/** System health implied by the worst feed state. */
const SYSTEM_BY_STATE = Object.freeze({
  [FEED_STATES.LIVE]: { label: 'NORMAL', tone: 'ok' },
  [FEED_STATES.RECENT]: { label: 'NORMAL', tone: 'ok' },
  [FEED_STATES.LOADING]: { label: 'STARTING', tone: 'idle' },
  [FEED_STATES.NO_DATA]: { label: 'NORMAL', tone: 'ok' },
  [FEED_STATES.STALE]: { label: 'DEGRADED', tone: 'warn' },
  [FEED_STATES.UNAVAILABLE]: { label: 'IMPAIRED', tone: 'alert' },
});

/** Tone for a feed state, matching the panel chips. */
const TONE_BY_STATE = Object.freeze({
  [FEED_STATES.LIVE]: 'ok',
  [FEED_STATES.RECENT]: 'ok',
  [FEED_STATES.LOADING]: 'idle',
  [FEED_STATES.NO_DATA]: 'idle',
  [FEED_STATES.STALE]: 'warn',
  [FEED_STATES.UNAVAILABLE]: 'alert',
});

/**
 * Reduce several feed states to the one worth showing: the worst.
 * @param {string[]} states Feed state ids.
 * @returns {string} The worst state present, or LOADING when none are known.
 */
export function worstState(states) {
  const present = (states || []).filter(Boolean);
  if (!present.length) return FEED_STATES.LOADING;
  for (const candidate of SEVERITY)
    if (present.includes(candidate)) return candidate;
  return FEED_STATES.LOADING;
}

/**
 * Name a latitude/longitude at the coarsest useful resolution.
 *
 * Broad bands only. A console that claimed a country name from a centroid would
 * be asserting something it has not looked up, and the strip has no geocoder.
 *
 * @param {number} latitude Degrees.
 * @param {number} longitude Degrees.
 * @returns {string} A broad region name.
 */
export function coarseRegion(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '—';
  const bands = [
    { name: 'SOUTH ASIA', west: 60, east: 98, south: 5, north: 38 },
    { name: 'EAST ASIA', west: 98, east: 146, south: 18, north: 54 },
    { name: 'SOUTHEAST ASIA', west: 92, east: 142, south: -11, north: 18 },
    { name: 'EUROPE', west: -12, east: 42, south: 35, north: 72 },
    { name: 'AFRICA', west: -18, east: 52, south: -36, north: 35 },
    { name: 'MIDDLE EAST', west: 32, east: 63, south: 12, north: 42 },
    { name: 'NORTH AMERICA', west: -170, east: -52, south: 15, north: 72 },
    { name: 'SOUTH AMERICA', west: -82, east: -34, south: -56, north: 13 },
    { name: 'OCEANIA', west: 110, east: 180, south: -48, north: -10 },
  ];
  const match = bands.find(
    (band) =>
      longitude >= band.west &&
      longitude <= band.east &&
      latitude >= band.south &&
      latitude <= band.north,
  );
  if (match) return match.name;
  const ns = latitude >= 0 ? 'N' : 'S';
  const ew = longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(latitude).toFixed(0)}°${ns} ${Math.abs(longitude).toFixed(0)}°${ew}`;
}

/**
 * Are these two place names the same place?
 *
 * A loose comparison on purpose. The monitored name comes from a reverse
 * geocode of a coarse point and the viewed name from a geocode of the camera's
 * bucket, so the same city can arrive as "Bengaluru" and "Bengaluru Urban".
 * Treating those as different would leave a VIEWING line up permanently while
 * the camera sat exactly where it started.
 *
 * @param {string} a First name.
 * @param {string} b Second name.
 * @returns {boolean} Whether they name the same place.
 */
export function samePlace(a, b) {
  const normalize = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

/** Format a Date as HH:MM:SSZ. */
export function formatUtc(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

/**
 * Bind the status strip.
 *
 * @param {object} input Input.
 * @param {Document} [input.document] Document holding the markup.
 * @param {() => number} [input.now] Clock.
 * @param {() => object} [input.readFeeds] Returns `{ [name]: state }`.
 * @param {() => ({latitude: number, longitude: number}|null)} [input.readCamera] Camera centre.
 * @param {() => (string|null)} [input.readPlaceName] Resolved place name, when known.
 * @param {() => number|null} [input.readLastSync] Epoch ms of the most recent arrival.
 * @param {number} [input.tickMs] Repaint interval.
 * @returns {object|null} Controller, or null when the markup is absent.
 */
export function createStatusStrip({
  document: doc = globalThis.document,
  now = () => Date.now(),
  readFeeds = () => ({}),
  readCamera = () => null,
  readPlaceName = () => null,
  readLastSync = () => null,
  readMonitoring = () => null,
  tickMs = 1000,
} = {}) {
  const root = doc?.getElementById?.('aegis-status-chip');
  if (!root) return null;

  const nodes = {
    dot: doc.getElementById('aegis-status-dot'),
    place: doc.getElementById('aegis-chip-place'),
    viewing: doc.getElementById('aegis-chip-viewing'),
  };

  /**
   * Repaint the chip.
   *
   * Everything the old strip spelled out in cells is still computed — it is
   * just carried by the dot's tone and the chip's tooltip instead of taking
   * seven columns of the operator's attention. The word beside the dot is
   * owned by the incident bar, which is what knows whether authored playback
   * is running; nothing here overwrites it.
   */
  function present() {
    const feeds = readFeeds() || {};
    const state = worstState(Object.values(feeds));
    const system = SYSTEM_BY_STATE[state] || SYSTEM_BY_STATE[FEED_STATES.LIVE];
    const monitoring = readMonitoring();

    if (nodes.dot) nodes.dot.dataset.tone = TONE_BY_STATE[state] || 'idle';

    // Two locations, and the console has to be honest about both. The
    // monitored place is what the alert layer measures from; the viewed place
    // is where the camera is and what the map panels are reporting on. They
    // are equal at startup and diverge the moment the user explores, and a
    // console that showed only one of them would look like it was ignoring
    // whichever was hidden.
    const placeName = readPlaceName();
    const camera = readCamera();
    const viewed =
      placeName ||
      (camera ? coarseRegion(camera.latitude, camera.longitude) : null);

    if (nodes.place) {
      nodes.place.textContent = monitoring?.place
        ? `DEVICE · ${monitoring.place}`
        : viewed || '—';
      nodes.place.dataset.monitored = monitoring?.place ? 'true' : 'false';
    }

    if (nodes.viewing) {
      // Only when it says something the line above does not. While the camera
      // is over the monitored place this is noise, and it hides itself.
      const differs =
        viewed && monitoring?.place && !samePlace(viewed, monitoring.place);
      nodes.viewing.hidden = !differs;
      nodes.viewing.textContent = differs ? `VIEWING · ${viewed}` : '';
    }

    // The detail an operator may still want, kept one hover away rather than
    // on screen: which feed is degraded, how stale the data is, and the fact
    // that a closed tab watches nothing.
    const culprits = Object.entries(feeds)
      .filter(([, value]) => value === state)
      .map(([name]) => name);
    const at = readLastSync();
    root.title = [
      `SYSTEM ${system.label}`,
      `DATA ${state === FEED_STATES.NO_DATA ? 'NO DATA' : state}${
        culprits.length ? ` (${culprits.join(', ')})` : ''
      }`,
      `UTC ${formatUtc(new Date(now()))}`,
      `LAST SYNC ${Number.isFinite(at) ? formatAge(now() - at) : '—'}`,
      monitoring?.place
        ? `MONITORING ${monitoring.place}${
            Number.isFinite(monitoring.nearby)
              ? ` · ${monitoring.nearby} nearby`
              : ''
          }${monitoring.voice ? ' · voice on' : ' · voice off'}`
        : 'MONITORING global — no monitored location set',
      'Monitored while Aegis is open in this tab. Aegis cannot monitor with the app closed.',
    ].join('\n');
  }

  const timer = setInterval(present, tickMs);
  present();

  return Object.freeze({
    present,
    destroy() {
      clearInterval(timer);
    },
  });
}
