/**
 * Related public media for an incident.
 *
 * Aegis already receives public media: the regional brief returns Google News
 * RSS articles for the place it resolves. This module turns that into a
 * PROVIDER-SHAPED pipeline so a second source — a YouTube Data API key behind
 * the existing server layer being the obvious one — can be added without the
 * incident UI learning anything new.
 *
 * Three constraints are structural rather than stylistic:
 *
 *  1. NOTHING HERE IS GROUND TRUTH. A news item or a video near an incident is
 *     a thing somebody published, not a confirmed observation. Every item
 *     carries its source and the UI labels the section as related media.
 *  2. NO SCRAPING. Providers are API-shaped and server-side; the browser never
 *     parses somebody's HTML.
 *  3. AN EMPTY RESULT IS AN ANSWER. No media means MEDIA UNAVAILABLE, not a
 *     broken panel and not an invented link.
 *
 * A YouTube provider is deliberately NOT implemented here — it needs a key and
 * a server route, which is a separate decision. The seam it would plug into is
 * `createMediaService({ providers })`, and `youtubeQuery()` below already
 * builds the search terms it would use.
 */

/** Items shown for one incident. */
export const MAX_MEDIA_ITEMS = 6;

/** How long a media answer is reused before it is asked for again. */
export const MEDIA_CACHE_MS = 10 * 60_000;

/**
 * Search terms for an incident.
 *
 * Built from what the incident actually knows — its place, its kind and its
 * date — rather than from a headline, so the query cannot assert anything the
 * incident record does not already say.
 *
 * @param {object} incident Incident record.
 * @returns {string} Query string.
 */
export function youtubeQuery(incident) {
  const kindWords = {
    EARTHQUAKE: 'earthquake',
    FIRE: 'fire',
    FLOOD: 'flood',
    WEATHER: 'severe weather',
    SCENARIO: 'flood',
  };
  const place =
    incident?.place || incident?.locationName || incident?.region || '';
  const parts = [place, kindWords[incident?.kind] || ''].filter(Boolean);
  return parts.join(' ').trim();
}

/**
 * Normalize one item into the shape the UI renders.
 *
 * @param {object} raw Provider item.
 * @param {string} source Provider label.
 * @returns {object|null} Frozen media item, or null when unusable.
 */
export function normalizeMediaItem(raw, source) {
  const url = raw?.url || raw?.link || null;
  const title = raw?.title || null;
  if (!url || !title) return null;
  const publishedAt =
    raw?.publishedAt || raw?.published || raw?.pubDate || null;
  const parsed = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  return Object.freeze({
    id: raw?.id || url,
    title,
    url,
    channel: raw?.channel || raw?.publisher || raw?.source || source,
    thumbnailUrl: raw?.thumbnailUrl || raw?.thumbnail || null,
    publishedAt: Number.isFinite(parsed) ? parsed : null,
    source,
    // Stated on every item so a consumer cannot lose it: this is published
    // material near an incident, not a verified observation of it.
    verified: false,
  });
}

/**
 * A provider backed by the regional brief's existing article feed.
 *
 * This is the one live provider today. It asks the brief about the incident's
 * own coordinates, so the articles are about the place the incident is in.
 *
 * @param {object} input Input.
 * @param {(latitude: number, longitude: number) => Promise<object>} input.fetchBrief Regional brief transport.
 * @returns {object} Provider.
 */
export function createRegionalNewsProvider({ fetchBrief }) {
  return {
    id: 'regional-news',
    label: 'Google News RSS',
    async search(incident) {
      const location = incident?.location;
      if (
        !Number.isFinite(location?.latitude) ||
        !Number.isFinite(location?.longitude)
      )
        return [];
      const brief = await fetchBrief(location.latitude, location.longitude);
      const source = brief?.newsSource || 'Google News RSS';
      return (brief?.articles || [])
        .map((article) => normalizeMediaItem(article, source))
        .filter(Boolean);
    },
  };
}

/**
 * Compose providers into one media service.
 *
 * Providers are tried in order and their results concatenated, newest first.
 * One provider failing does not fail the section: a source that cannot answer
 * contributes nothing and the others still do.
 *
 * @param {object} input Input.
 * @param {object[]} [input.providers] Media providers.
 * @param {() => number} [input.now] Clock.
 * @returns {object} Frozen service.
 */
export function createMediaService({
  providers = [],
  now = () => Date.now(),
} = {}) {
  const cache = new Map();

  return Object.freeze({
    /** @returns {string[]} The provider labels in use, for attribution. */
    sources() {
      return providers.map((provider) => provider.label);
    },
    /**
     * Find related media for an incident.
     *
     * @param {object} incident Incident record.
     * @returns {Promise<{items: object[], status: string, sources: string[]}>} Result.
     */
    async find(incident) {
      if (!incident) return { items: [], status: 'NO_DATA', sources: [] };
      const key = incident.id;
      const cached = cache.get(key);
      if (cached && now() - cached.at < MEDIA_CACHE_MS) return cached.result;

      const collected = [];
      const answered = [];
      for (const provider of providers) {
        try {
          const items = await provider.search(incident);
          answered.push(provider.label);
          collected.push(...items);
        } catch {
          // A source that cannot answer contributes nothing; the section is
          // not an error because one provider is down.
        }
      }

      const items = collected
        .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
        .slice(0, MAX_MEDIA_ITEMS);
      const result = Object.freeze({
        items: Object.freeze(items),
        // UNAVAILABLE means no provider answered; NO_DATA means they answered
        // with nothing. The difference matters for the same reason it does
        // everywhere else in this application.
        status: items.length
          ? 'READY'
          : answered.length
            ? 'NO_DATA'
            : 'UNAVAILABLE',
        sources: Object.freeze(answered),
      });
      cache.set(key, { at: now(), result });
      while (cache.size > 32) cache.delete(cache.keys().next().value);
      return result;
    },
    clear() {
      cache.clear();
    },
  });
}
