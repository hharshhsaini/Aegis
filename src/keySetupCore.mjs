/**
 * The provider registry — the pure core.
 *
 * One registry, a few pure functions, zero dependencies. This is the single
 * place that knows what each provider is called, which environment variables
 * carry its credential, what it unlocks, and whether that credential is
 * injected into the browser bundle by design.
 *
 * It used to back an in-app panel that accepted credentials and wrote them to
 * disk. That is gone: credentials come from the environment, and this module
 * only ever READS an environment someone else supplies. It cannot write one.
 *
 * It also never returns a credential. `keySetupStatus()` maps each provider's
 * env vars to a boolean and discards the values, which is what lets the status
 * it produces be handed to the browser safely.
 *
 * Nothing here touches the filesystem, the network, or process.env — callers
 * pass an environment in, which is also what makes every behavior below
 * unit-testable.
 */

/**
 * Provider credentials, in display order — most magic per
 * minute first. `tier` mirrors the README's color legend: 'metered' (🔴) is a
 * billing-enabled account, 'free' (🟡) is a register-and-paste key.
 * `clientExposed` marks the two keys that are injected into the browser
 * bundle by design (restrict them at the provider, per SECURITY.md).
 * `hidden` keeps advanced configuration out of the panel and missing-key count.
 */
export const KEY_SETUP_KEYS = Object.freeze([
  Object.freeze({
    id: 'google-maps',
    title: 'GOOGLE MAPS',
    unlocks: 'The photorealistic 3D planet + place search',
    getUrl: 'https://developers.google.com/maps/documentation/tile/get-api-key',
    envVars: Object.freeze(['GOOGLE_MAPS_API_KEY']),
    tier: 'metered',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'google-maps-server',
    title: 'GOOGLE MAPS — SERVER',
    unlocks: 'Places context + Street View fallback; optional separate key',
    getUrl:
      'https://developers.google.com/maps/documentation/places/web-service/get-api-key',
    envVars: Object.freeze(['GOOGLE_MAPS_SERVER_API_KEY']),
    tier: 'metered',
    hidden: true,
  }),
  Object.freeze({
    id: 'openai',
    title: 'OPENAI',
    unlocks: 'Voice control — talk to the planet',
    getUrl: 'https://platform.openai.com/api-keys',
    envVars: Object.freeze(['OPENAI_API_KEY']),
    tier: 'metered',
  }),
  Object.freeze({
    id: 'aisstream',
    title: 'AISSTREAM',
    unlocks: 'Live ships, worldwide',
    getUrl: 'https://aisstream.io',
    envVars: Object.freeze(['AISSTREAM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'firms',
    title: 'NASA FIRMS',
    unlocks: 'Live active-fire detections',
    getUrl: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/',
    envVars: Object.freeze(['FIRMS_MAP_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'tomtom',
    title: 'TOMTOM',
    unlocks: 'Real live traffic (keyless runs a simulation)',
    getUrl: 'https://developer.tomtom.com',
    envVars: Object.freeze(['TOMTOM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'cesium-ion',
    title: 'CESIUM ION',
    unlocks: 'Bing imagery map stacks + world terrain',
    getUrl: 'https://ion.cesium.com/tokens',
    envVars: Object.freeze(['CESIUM_ION_TOKEN']),
    tier: 'free',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'opensky',
    title: 'OPENSKY',
    unlocks: 'More flight-polling credits (anonymous works without)',
    getUrl: 'https://opensky-network.org',
    envVars: Object.freeze(['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'launch-library',
    title: 'LAUNCH LIBRARY',
    unlocks: 'Higher space-missions request allowance',
    getUrl: 'https://thespacedevs.com',
    envVars: Object.freeze(['LL2_API_TOKEN']),
    tier: 'free',
  }),
]);

/** Hostnames a Provider Settings request may arrive under or originate from. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** Socket addresses that count as this machine. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Parse an exact local request authority from a Host header. */
function localAuthority(hostHeader, protocol) {
  const raw = String(hostHeader || '')
    .trim()
    .toLowerCase();
  const scheme = String(protocol || '').toLowerCase();
  if (!raw || !['http:', 'https:'].includes(scheme) || /[\s/?#@]/.test(raw))
    return null;
  try {
    const parsed = new URL(`${scheme}//${raw}`);
    return LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase())
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

/** Parse one RFC-4180-shaped CSV record, sufficient for `whoami /fo csv`. */
function parseCsvRecord(text) {
  const source = String(text || '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!source || /[\r\n]/.test(source)) return null;
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

/**
 * The admission gate for the Provider Settings endpoints — pure, exported so
 * every refusal below is pinned by a unit assertion rather than a review note.
 *
 * Why each check exists:
 *  - sharing signals: any tunnel/LAN sharing mode disables the surface
 *    outright — a credential-writing endpoint has no business existing on a
 *    shared instance, and tunnel traffic reaches the server FROM loopback, so
 *    the socket check below cannot carry that boundary alone;
 *  - loopback socket: refuses LAN peers when the server is bound wide;
 *  - local Host header: tunnel and DNS-rebinding traffic carries a foreign
 *    Host even when the socket says loopback;
 *  - exact same Origin on POST: a hostile web page can make a browser POST to
 *    localhost, and a non-browser caller must not bypass that boundary merely
 *    by omitting the header;
 *  - JSON Content-Type on POST: forces cross-origin browsers into a CORS
 *    preflight this server never answers, closing the simple-request CSRF
 *    write primitive.
 *
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function admitKeySetupRequest({
  method,
  remoteAddress,
  hostHeader,
  protocol = 'http:',
  origin,
  contentType,
  proxyHeaders = {},
  env = {},
} = {}) {
  // A request carrying reverse-proxy / CDN forwarding headers did not originate
  // on this machine, whatever its socket says. Refuse them outright as defense
  // in depth — the shipped tunnel (Pinokio) is force-closed at boot, so these
  // only appear when someone has deliberately fronted the dev server.
  const PROXY_SIGNALS = [
    'forwarded',
    'via',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-port',
    'x-forwarded-proto',
    'x-real-ip',
    'cf-connecting-ip',
    'cf-ray',
  ];
  if (
    PROXY_SIGNALS.some((name) => String(proxyHeaders[name] || '').trim() !== '')
  ) {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings does not answer proxied requests',
    };
  }
  // Every sharing signal the launcher recognizes (scripts/pinokio-preflight.mjs)
  // also disables this surface — so the gate's set is complete, not a subset the
  // two files could drift apart on. One DELIBERATE divergence: preflight is a
  // boot check that treats an empty PINOKIO_SHARE_VAR as sharing-on (fail closed
  // before Start), but here an empty/unset value is the NORMAL git-clone and
  // Pinokio state — treating it as sharing would disable Provider Settings for
  // every ordinary launch. So a bare/sentinel value is not sharing; only a real
  // tunnel var is. This is defense in depth regardless: the loopback+Host checks
  // below independently refuse LAN/tunnel traffic, and under Pinokio the launcher
  // refuses to boot at all when sharing is genuinely on.
  const shareVar = String(env.PINOKIO_SHARE_VAR ?? '').trim();
  const sharingEnabled =
    ['PINOKIO_SHARE_CLOUDFLARE', 'PINOKIO_SHARE_LOCAL'].some((name) =>
      /^(1|true)$/i.test(String(env[name] || '').trim()),
    ) ||
    (shareVar !== '' && shareVar !== '__gev_sharing_disabled__');
  if (sharingEnabled) {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings is disabled while sharing is enabled',
    };
  }
  if (!LOOPBACK_ADDRESSES.has(String(remoteAddress || ''))) {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings answers only the machine running the server',
    };
  }
  const authority = localAuthority(hostHeader, protocol);
  if (!authority) {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings answers only local hostnames',
    };
  }
  if (
    method === 'POST' &&
    (origin === undefined || origin === null || origin === '')
  ) {
    return {
      ok: false,
      status: 403,
      error: 'Provider Settings requires an exact local Origin',
    };
  }
  if (origin !== undefined && origin !== null && origin !== '') {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(String(origin));
    } catch {
      return { ok: false, status: 403, error: 'Unrecognized Origin refused' };
    }
    const exactOrigin =
      parsedOrigin.username === '' &&
      parsedOrigin.password === '' &&
      parsedOrigin.pathname === '/' &&
      parsedOrigin.search === '' &&
      parsedOrigin.hash === '' &&
      parsedOrigin.origin === authority;
    if (!exactOrigin) {
      return {
        ok: false,
        status: 403,
        error: 'Cross-origin requests are refused',
      };
    }
  }
  if (
    method === 'POST' &&
    !String(contentType || '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    return {
      ok: false,
      status: 415,
      error: 'Content-Type must be application/json',
    };
  }
  return { ok: true };
}

/** @returns {Set<string>} every env var the panel is allowed to write. */
export function knownKeySetupEnvVars() {
  const names = new Set();
  for (const entry of KEY_SETUP_KEYS) {
    for (const envVar of entry.envVars) names.add(envVar);
  }
  return names;
}

/** Tooltip guidance for a control gated by one registry entry. */
export function keySetupRequirement(id) {
  const entry = KEY_SETUP_KEYS.find((candidate) => candidate.id === id);
  if (!entry || entry.hidden) return '';
  // Names the environment variable and stops there. The application no longer
  // has anywhere to paste a credential, so pointing at a settings panel would
  // be pointing at something that does not exist.
  return `Needs ${entry.envVars.join(' + ')} — set it in the environment (see .env.example)`;
}

/**
 * Build the status payload the panel renders from: the registry, plus
 * per-entry `set` resolved against the given environment. It never includes
 * a value, suffix, or other credential material.
 * @param {Record<string, string|undefined>} env e.g. process.env
 */
export function keySetupStatus(env = {}) {
  const keys = KEY_SETUP_KEYS.filter((entry) => !entry.hidden).map((entry) => {
    const values = entry.envVars.map((name) => String(env[name] ?? '').trim());
    const set = values.every((value) => value.length > 0);
    return {
      id: entry.id,
      title: entry.title,
      unlocks: entry.unlocks,
      getUrl: entry.getUrl,
      envVars: [...entry.envVars],
      tier: entry.tier,
      clientExposed: Boolean(entry.clientExposed),
      set,
    };
  });
  return {
    keys,
    setCount: keys.filter((key) => key.set).length,
    total: keys.length,
  };
}
