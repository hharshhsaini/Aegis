import { riskColor } from '../risk/thresholds.js';
import { TREND_ARROWS } from '../risk/narrative.js';
import { formatCoordinates } from '../app/locationContext.js';
import { formatAge } from './dataState.js';

/**
 * REGIONAL INTELLIGENCE: what is true of the place the camera is looking at.
 *
 * The other panels each answer about one feed. This one answers about a
 * PLACE — its name, its hazard snapshot, its outlook, how many incidents are
 * open there — by combining what the existing engines have already computed.
 * It runs no model of its own and opens no request of its own beyond the
 * location name, so it cannot disagree with the panels it summarises.
 *
 * Every number it shows is either a score the risk engine produced, a count of
 * records a feed returned, or a figure from the regional brief. Where a value
 * is genuinely unknown it prints an em dash and says the source is
 * unavailable, because the one thing a regional summary must never do is fill
 * a gap with something plausible.
 */

/** The hazards shown in the snapshot, in a fixed order an operator can learn. */
const SNAPSHOT_HAZARDS = Object.freeze([
  { id: 'flood', label: 'FLOOD' },
  { id: 'fireConditions', label: 'FIRE' },
  { id: 'seismic', label: 'SEISMIC ACTIVITY' },
  { id: 'heat', label: 'HEAT' },
  { id: 'visibility', label: 'VISIBILITY' },
]);

/** Create an element with optional class and text. */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Bind the regional intelligence panel.
 *
 * @param {object} input Input.
 * @param {Document} [input.document] Document holding the markup.
 * @param {() => number} [input.now] Clock.
 * @returns {object|null} Controller, or null when the markup is absent.
 */
export function createRegionalPanel({
  document: doc = globalThis.document,
  now = () => Date.now(),
} = {}) {
  const root = doc?.getElementById?.('regional-panel');
  if (!root) return null;

  const nodes = {
    place: doc.getElementById('regional-place'),
    placeDetail: doc.getElementById('regional-place-detail'),
    coordinates: doc.getElementById('regional-coordinates'),
    status: doc.getElementById('regional-status'),
    snapshot: doc.getElementById('regional-snapshot'),
    outlook: doc.getElementById('regional-outlook'),
    incidents: doc.getElementById('regional-incidents'),
    conditions: doc.getElementById('regional-conditions'),
  };

  let location = null;
  let risks = null;
  let seismic = null;
  let forecast = null;
  let incidentCount = 0;
  let weather = null;

  /** Render the place heading from the shared location state. */
  function presentPlace() {
    if (nodes.place)
      nodes.place.textContent =
        location?.locationName ||
        (location?.status === 'RESOLVING' ? 'LOCATING…' : 'UNKNOWN LOCATION');

    if (nodes.placeDetail) {
      const detail =
        location?.secondary ||
        [location?.region, location?.country].filter(Boolean).join(', ');
      nodes.placeDetail.textContent = detail || '';
    }

    if (nodes.coordinates)
      nodes.coordinates.textContent = formatCoordinates(
        location?.latitude,
        location?.longitude,
      );

    if (nodes.status) {
      // The name and the data behind it come from different places; the status
      // describes the NAME, so an unreachable geocoder cannot make the hazard
      // scores look unavailable too.
      const label =
        location?.status === 'UNAVAILABLE'
          ? 'PLACE NAME UNAVAILABLE'
          : location?.status === 'UNRESOLVED'
            ? 'UNNAMED AREA'
            : location?.status === 'RESOLVING'
              ? 'RESOLVING'
              : 'OpenStreetMap / Nominatim';
      nodes.status.textContent = label;
      nodes.status.dataset.tone =
        location?.status === 'UNAVAILABLE' ? 'warn' : 'idle';
    }
  }

  /** Render the hazard snapshot from whatever the engines have scored. */
  function presentSnapshot() {
    if (!nodes.snapshot) return;
    const byId = { ...(risks || {}) };
    if (seismic) byId.seismic = seismic;

    nodes.snapshot.replaceChildren(
      ...SNAPSHOT_HAZARDS.map(({ id, label }) => {
        const hazard = byId[id];
        const row = el(doc, 'li', 'regional-hazard');
        row.dataset.level = hazard?.level || 'UNKNOWN';

        const name = el(doc, 'span', 'regional-hazard-name', label);
        const score = el(
          doc,
          'span',
          'regional-hazard-score',
          hazard ? String(hazard.score) : '—',
        );
        if (hazard) score.style.color = riskColor(hazard.score);
        const scale = el(doc, 'span', 'regional-hazard-scale', '/ 100');
        const trend = el(
          doc,
          'span',
          'regional-hazard-trend',
          hazard ? TREND_ARROWS[hazard.trend?.direction] || '·' : '·',
        );
        trend.dataset.direction = hazard?.trend?.direction || 'UNKNOWN';

        const bar = el(doc, 'div', 'regional-hazard-bar');
        const fill = el(doc, 'span');
        fill.style.width = `${hazard ? Math.max(0, Math.min(100, hazard.score)) : 0}%`;
        if (hazard) fill.style.background = riskColor(hazard.score);
        bar.append(fill);

        row.append(name, score, scale, trend, bar);
        // An unscored hazard says so rather than showing a confident zero.
        if (!hazard) row.title = 'No analysis for this location yet.';
        return row;
      }),
    );
  }

  /** Render the outlook from the risk engine's own forecast horizons. */
  function presentOutlook() {
    if (!nodes.outlook) return;
    const horizons = forecast?.horizons || [];
    if (!horizons.length) {
      nodes.outlook.replaceChildren(
        el(
          doc,
          'li',
          'regional-outlook-empty',
          'No forecast horizons for this location yet.',
        ),
      );
      return;
    }
    nodes.outlook.replaceChildren(
      ...horizons.slice(0, 3).map((horizon) => {
        const item = el(doc, 'li', 'regional-outlook-row');
        const when = el(
          doc,
          'span',
          'regional-outlook-when',
          `NEXT ${horizon.hours}H`,
        );
        const score = el(
          doc,
          'span',
          'regional-outlook-score',
          String(horizon.overall),
        );
        score.style.color = riskColor(horizon.overall);
        item.append(when, score);
        return item;
      }),
    );
  }

  /** Render the supporting context: conditions and open incidents. */
  function presentContext() {
    if (nodes.incidents) nodes.incidents.textContent = String(incidentCount);

    if (nodes.conditions) {
      const fields = weather
        ? [
            [
              'TEMP',
              Number.isFinite(weather.temperatureC)
                ? `${Math.round(weather.temperatureC)}°C`
                : null,
            ],
            [
              'WIND',
              Number.isFinite(weather.windKph)
                ? `${Math.round(weather.windKph)} km/h`
                : null,
            ],
            [
              'RAIN',
              Number.isFinite(weather.precipitationMm)
                ? `${weather.precipitationMm} mm`
                : null,
            ],
            [
              'CLOUD',
              Number.isFinite(weather.cloudCoverPct)
                ? `${weather.cloudCoverPct}%`
                : null,
            ],
          ].filter(([, value]) => value !== null)
        : [];
      if (!fields.length) {
        nodes.conditions.replaceChildren(
          el(
            doc,
            'span',
            'regional-conditions-empty',
            'Conditions unavailable',
          ),
        );
        return;
      }
      nodes.conditions.replaceChildren(
        ...fields.flatMap(([label, value]) => {
          const group = el(doc, 'div');
          group.append(
            el(doc, 'dt', null, label),
            el(doc, 'dd', null, String(value)),
          );
          return [group];
        }),
      );
    }
  }

  function present() {
    presentPlace();
    presentSnapshot();
    presentOutlook();
    presentContext();
  }

  present();

  return Object.freeze({
    present,
    /**
     * Adopt the shared location state.
     * @param {object} next Location state.
     */
    setLocation(next) {
      location = next;
      presentPlace();
    },
    /**
     * Adopt the weather engine's hazard scores and forecast for this point.
     * @param {object|null} analysis Risk analysis.
     */
    setAnalysis(analysis) {
      risks = analysis?.risks || null;
      forecast = analysis?.forecast || null;
      weather = analysis?.conditions
        ? {
            temperatureC: analysis.conditions.temperature,
            windKph: analysis.conditions.windSpeed,
            precipitationMm: analysis.conditions.precipitation,
            cloudCoverPct: analysis.conditions.cloudCover,
          }
        : weather;
      presentSnapshot();
      presentOutlook();
      presentContext();
    },
    /**
     * Adopt the seismic module, which comes from USGS rather than the weather
     * engine but belongs in the same snapshot.
     * @param {object|null} module Hazard-shaped seismic record.
     */
    setSeismic(module) {
      seismic = module;
      presentSnapshot();
    },
    /**
     * Adopt the count of incidents currently on the board.
     * @param {number} count Incident count.
     */
    setIncidentCount(count) {
      incidentCount = Number.isFinite(count) ? count : 0;
      presentContext();
    },
    /** Refresh age-dependent text. */
    tick() {
      if (!location?.timestamp || !nodes.status) return;
      if (location.status !== 'READY') return;
      nodes.status.textContent = `Resolved ${formatAge(now() - location.timestamp)}`;
    },
  });
}
