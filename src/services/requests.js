import { createOverpassFeatureSource } from '../sources/overpassFeatures.js';
/** Parse bounded retry information from a service response. */
function retryAfterMs(value) {
  if (value == null || String(value).trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Construct independent request services for compatible application protocols. */
export function createApplicationRequestServices({
  fetchImpl = (...args) => fetch(...args),
  signal: lifetime,
  endpoints = {},
  features,
} = {}) {
  const urls = {
    boundaries: '/api/overpass',
    terrain: '/api/terrain/heights',
    regional: '/api/regional-brief',
    weather: '/api/weather-effects',
    weatherIntelligence: '/api/weather/intelligence',
    fireIntelligence: '/api/fires/intelligence',
    earthquakeIntelligence: '/api/quakes/intelligence',
    seismicForecast: '/api/quakes/forecast',
    summary: '/api/openai/hud-summary',
    ...endpoints,
  };
  async function request(endpoint, { signal, ...init } = {}) {
    signal = AbortSignal.any([lifetime, signal].filter(Boolean));
    signal.throwIfAborted();
    const response = await fetchImpl(endpoint, {
      ...init,
      signal,
      redirect: 'error',
    });
    signal.throwIfAborted();
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* Status remains authoritative for non-JSON errors. */
    }
    signal.throwIfAborted();
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      data,
    };
  }
  function pointUrl(endpoint, latitude, longitude) {
    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    )
      throw new TypeError('Valid coordinates are required');
    return `${endpoint}?${new URLSearchParams({ latitude: latitude.toFixed(5), longitude: longitude.toFixed(5) })}`;
  }
  function requireOk(response, label) {
    if (!response.ok)
      throw new Error(`${label} unavailable (${response.status})`);
    return response.data;
  }
  const services = {
    boundaries: {
      async query(query, { signal } = {}) {
        const response = await request(urls.boundaries, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        });
        const retry = response.headers?.get?.('Retry-After');
        if (
          response.status === 429 ||
          (response.status === 503 && retry != null)
        )
          return { rateLimited: true, retryAfterMs: retryAfterMs(retry) };
        if (!response.ok) return null;
        const remark = String(response.data?.remark || '').toLowerCase();
        if (/runtime error|timed out|out of memory/.test(remark)) return null;
        return Array.isArray(response.data?.elements)
          ? response.data.elements
          : null;
      },
    },
    terrain: {
      async getHeights(points, { signal } = {}) {
        const query = points
          .map(({ lat, lon }) => `${lon.toFixed(5)},${lat.toFixed(5)}`)
          .join(';');
        return requireOk(
          await request(`${urls.terrain}?points=${encodeURIComponent(query)}`, {
            signal,
          }),
          'Terrain heights',
        )?.results;
      },
    },
    regional: {
      async getBrief(latitude, longitude, options) {
        return requireOk(
          await request(pointUrl(urls.regional, latitude, longitude), options),
          'Regional brief',
        );
      },
    },
    weather: {
      async getConditions(latitude, longitude, options) {
        return requireOk(
          await request(pointUrl(urls.weather, latitude, longitude), options),
          'Weather',
        );
      },
    },
    weatherIntelligence: {
      /**
       * Fetch the risk analysis for a point.
       *
       * The response carries the finished analysis, not raw weather: scoring
       * happens server-side so the browser never holds 40 variables it would
       * have to reduce itself, and so the same code path serves a Lambda later.
       *
       * @param {number} latitude Degrees north.
       * @param {number} longitude Degrees east.
       * @param {object} [options] Request options.
       * @returns {Promise<{status: string, analysis: object, ageMs?: number}>} Analysis envelope.
       */
      async analyze(latitude, longitude, options) {
        return requireOk(
          await request(
            pointUrl(urls.weatherIntelligence, latitude, longitude),
            options,
          ),
          'Weather intelligence',
        );
      },
    },
    fireIntelligence: {
      /**
       * Observe satellite fire activity for a bounding box.
       *
       * The box is a viewport, not a point: FIRMS is queried by area, and the
       * server snaps the box onto a shared grid so nearby viewports reuse one
       * upstream call. The MAP_KEY stays server-side; nothing in this request
       * carries it.
       *
       * @param {{west: number, south: number, east: number, north: number}} bbox Viewport box.
       * @param {object} [options] Request options.
       * @returns {Promise<{status: string, intelligence: object, detections: object[]}>} Observation.
       */
      async observe({ west, south, east, north }, options) {
        if (
          ![west, south, east, north].every((value) => Number.isFinite(value))
        )
          throw new TypeError('A valid bounding box is required');
        const params = new URLSearchParams({
          west: west.toFixed(3),
          south: south.toFixed(3),
          east: east.toFixed(3),
          north: north.toFixed(3),
        });
        return requireOk(
          await request(`${urls.fireIntelligence}?${params}`, options),
          'Fire intelligence',
        );
      },
    },
    earthquakeIntelligence: {
      /**
       * Observe recent USGS earthquakes, scoped to a viewport.
       *
       * The bounding box scopes the ANSWER, not the request: USGS publishes one
       * feed for the planet and the server caches it, so panning re-scopes data
       * already held instead of re-downloading it.
       *
       * @param {object} query Query.
       * @param {object|null} [query.bbox] Viewport box.
       * @param {string} [query.feed] USGS feed id.
       * @param {object} [options] Request options.
       * @returns {Promise<{status: string, intelligence: object}>} Observation.
       */
      async observe({ bbox = null, around = null, feed } = {}, options) {
        const params = new URLSearchParams();
        if (feed) params.set('feed', feed);
        // A radius query asks what is near a POINT rather than what is on
        // screen. Local Intelligence needs that question; the globe needs the
        // box. Both read one server-cached feed, so asking both costs one
        // upstream fetch rather than two.
        if (around) {
          const { latitude, longitude, radiusKm } = around;
          if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            !Number.isFinite(radiusKm)
          )
            throw new TypeError('A valid radius query is required');
          params.set('latitude', latitude.toFixed(4));
          params.set('longitude', longitude.toFixed(4));
          params.set('maxradiuskm', String(Math.round(radiusKm)));
        } else if (bbox) {
          for (const key of ['west', 'south', 'east', 'north']) {
            if (!Number.isFinite(bbox[key]))
              throw new TypeError('A valid bounding box is required');
            params.set(key, bbox[key].toFixed(3));
          }
        }
        const query = params.toString();
        return requireOk(
          await request(
            query
              ? `${urls.earthquakeIntelligence}?${query}`
              : urls.earthquakeIntelligence,
            options,
          ),
          'Earthquake intelligence',
        );
      },
    },
    seismicForecast: {
      /**
       * Fetch the ML seismic-activity forecast for a region.
       *
       * Inference runs server-side: the browser never holds the model artifact
       * or the 45-day catalog it needs, and the same route becomes the Lambda
       * or SageMaker endpoint later.
       *
       * @param {object} region Region box.
       * @param {object} [options] Request options with an optional `question`.
       * @returns {Promise<object>} Forecast envelope.
       */
      async forecast({ west, south, east, north }, options = {}) {
        if (
          ![west, south, east, north].every((value) => Number.isFinite(value))
        )
          throw new TypeError('A valid region is required');
        const params = new URLSearchParams({
          west: west.toFixed(3),
          south: south.toFixed(3),
          east: east.toFixed(3),
          north: north.toFixed(3),
        });
        if (options.question) params.set('question', options.question);
        return requireOk(
          await request(`${urls.seismicForecast}?${params}`, options),
          'Seismic forecast',
        );
      },
    },
    summary: {
      async summarize(context, { signal } = {}) {
        return request(urls.summary, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(context),
        });
      },
    },
  };
  services.features =
    features ??
    createOverpassFeatureSource({
      boundarySource: services.boundaries,
      signal: lifetime,
    });
  return services;
}
