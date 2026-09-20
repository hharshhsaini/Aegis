import { riskColor, RISK_LEVELS } from '../risk/thresholds.js';
import { TREND_ARROWS, priorityActions } from '../risk/narrative.js';
import { classifyFeedState, describeFeedState } from './dataState.js';

/**
 * Renders one analysis into the Aegis Intelligence panel.
 *
 * The panel answers four questions in order — what is happening, how bad is it,
 * why, and what is projected — and deliberately does NOT print the forty
 * variables behind the answer. Current conditions appear once, small, as
 * supporting evidence; everything above them is the assessment.
 *
 * All text comes from the analysis object. The renderer adds no judgement of
 * its own, so what an operator reads is always what the engine scored, and a
 * threshold change in configuration reaches the screen without a UI change.
 *
 * The panel is organised the way an operator reads a situation — DATA, RISK,
 * ANALYSIS, OUTLOOK, ACTION — and each risk module carries its own score,
 * status, trend and one line of explanation, so the whole picture is legible at
 * a glance. Raw observations are still available, folded away at the bottom,
 * because an operator checks the evidence only after doubting the assessment.
 */

/** Open-Meteo publishes hourly; freshness is judged against that cadence. */
const WEATHER_FRESHNESS = Object.freeze({
  liveMs: 60 * 60_000,
  recentMs: 180 * 60_000,
});

/** Attribution for the feed chip. */
const WEATHER_SOURCE = 'Open-Meteo';

/** Level id to CSS custom property. */
const LEVEL_COLORS = Object.freeze(
  Object.fromEntries(RISK_LEVELS.map((band) => [band.id, band.color])),
);

/** Compact labels for the conditions grid. */
const CONDITION_FIELDS = Object.freeze([
  ['temperature', 'TEMP', (value) => `${Math.round(value)}°C`],
  ['humidity', 'HUMIDITY', (value) => `${Math.round(value)}%`],
  ['precipitation', 'RAIN', (value) => `${value.toFixed(1)} mm`],
  ['windSpeed', 'WIND', (value) => `${Math.round(value)} km/h`],
  ['windGusts', 'GUSTS', (value) => `${Math.round(value)} km/h`],
  ['visibility', 'VISIBILITY', (value) => `${(value / 1000).toFixed(1)} km`],
]);

/**
 * Format an age as the panel's "updated" line.
 * @param {number} ms Milliseconds since the analysis was generated.
 * @returns {string} Human phrase.
 */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hr ago' : `${hours} hrs ago`;
}

/**
 * Format a coordinate pair for the footer.
 * @param {{latitude: number, longitude: number}} point Analyzed point.
 * @returns {string} Display string.
 */
export function formatPoint({ latitude, longitude } = {}) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
  const ns = latitude >= 0 ? 'N' : 'S';
  const ew = longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(latitude).toFixed(2)}°${ns} ${Math.abs(longitude).toFixed(2)}°${ew}`;
}

/**
 * Rank hazards for display: worst first, so the panel leads with what matters.
 * @param {object} risks Hazard assessments keyed by id.
 * @returns {object[]} Hazards in display order.
 */
export function orderRisks(risks) {
  return Object.values(risks || {}).sort((a, b) => b.score - a.score);
}

/**
 * Collect the reasons behind the current picture.
 *
 * Drivers are pulled from the hazards that are actually active. A driver behind
 * a NORMAL hazard is not a reason for anything, and listing it would pad the
 * WHY section with noise that competes with the real signal.
 *
 * @param {object} risks Hazard assessments keyed by id.
 * @param {number} [limit=5] Maximum reasons.
 * @returns {object[]} Driver records with their hazard label.
 */
export function collectReasons(risks, limit = 5) {
  return orderRisks(risks)
    .filter((hazard) => hazard.level !== 'NORMAL')
    .flatMap((hazard) =>
      hazard.leadingDrivers.map((entry) => ({
        ...entry,
        hazard: hazard.label,
      })),
    )
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, limit);
}

/** Create an element with optional class and text. */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Bind the intelligence panel to a document.
 *
 * @param {object} input Binding input.
 * @param {Document} [input.document] Document holding the panel markup.
 * @param {() => number} [input.now] Clock, injectable for tests.
 * @param {() => void} [input.onRefresh] Called when the operator asks for a re-analysis.
 * @returns {object|null} Panel controller, or null when the markup is absent.
 */
export function createIntelligencePanel({
  document: doc = globalThis.document,
  now = () => Date.now(),
  onRefresh,
} = {}) {
  const root = doc?.getElementById?.('intelligence-panel');
  if (!root) return null;

  const nodes = {
    placeholder: doc.getElementById('intel-placeholder'),
    chip: doc.getElementById('intel-feed-chip'),
    region: doc.getElementById('intel-region'),
    actions: doc.getElementById('intel-actions'),
    content: doc.getElementById('intel-content'),
    dot: doc.getElementById('intel-headline-dot'),
    label: doc.getElementById('intel-headline-label'),
    level: doc.getElementById('intel-headline-level'),
    score: doc.getElementById('intel-headline-score'),
    trend: doc.getElementById('intel-headline-trend'),
    summary: doc.getElementById('intel-headline-summary'),
    conditions: doc.getElementById('intel-conditions'),
    risks: doc.getElementById('intel-risks'),
    drivers: doc.getElementById('intel-drivers'),
    forecast: doc.getElementById('intel-forecast'),
    forecastNote: doc.getElementById('intel-forecast-note'),
    changesSection: doc.getElementById('intel-changes-section'),
    changes: doc.getElementById('intel-changes'),
    location: doc.getElementById('intel-location'),
    updated: doc.getElementById('intel-updated'),
    footer: root.querySelector('.aegis-intel-footer'),
    refresh: doc.getElementById('intel-refresh-btn'),
  };

  let current = null;
  let seismicModule = null;
  const onRefreshClick = () => onRefresh?.();
  nodes.refresh?.addEventListener('click', onRefreshClick);

  /**
   * One risk module: score, status, trend, explanation.
   *
   * Takes the same shape every hazard assessment already has, which is what
   * lets a USGS-derived seismic module sit in the same list as the weather
   * engine's own hazards without a second renderer.
   *
   * @param {object} hazard Hazard assessment.
   * @returns {HTMLElement} List item.
   */
  function renderRiskModule(hazard) {
    const item = el(doc, 'li', 'aegis-risk-module');
    const color = LEVEL_COLORS[hazard.level] || riskColor(hazard.score);
    item.dataset.level = hazard.level;

    const head = el(doc, 'div', 'aegis-risk-module-head');
    const dot = el(doc, 'span', 'aegis-risk-dot');
    dot.style.background = color;
    const score = el(
      doc,
      'span',
      'aegis-risk-module-score',
      String(hazard.score),
    );
    score.style.color = color;
    head.append(
      dot,
      el(doc, 'span', 'aegis-risk-name', hazard.label.toUpperCase()),
      score,
      el(doc, 'span', 'aegis-risk-module-scale', '/ 100'),
    );

    const statusRow = el(doc, 'div', 'aegis-risk-module-status');
    const level = el(doc, 'span', 'aegis-risk-module-level', hazard.level);
    level.style.color = color;
    const arrow = TREND_ARROWS[hazard.trend?.direction] || '·';
    const trend = el(doc, 'span', 'aegis-risk-module-trend', arrow);
    trend.dataset.direction = hazard.trend?.direction || 'UNKNOWN';
    statusRow.append(level, trend);

    const bar = el(doc, 'div', 'aegis-risk-bar');
    const fill = el(doc, 'span');
    fill.style.width = `${Math.max(0, Math.min(100, hazard.score))}%`;
    fill.style.background = color;
    bar.append(fill);

    item.append(head, statusRow, bar);
    // A NORMAL hazard's explanation is "nothing is happening", which is not
    // worth a line in a column an operator scans for what is.
    if (hazard.level !== 'NORMAL' && hazard.summary)
      item.append(el(doc, 'p', 'aegis-risk-module-note', hazard.summary));
    return item;
  }

  /** Show that an analysis is in flight without blanking the previous one. */
  function setBusy(busy) {
    nodes.refresh?.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (busy && !current) updateChip({ loading: true });
  }

  /**
   * Paint the feed chip.
   *
   * The chip is the panel's whole answer to "is this current?", which is why a
   * transport failure over a held analysis shows STALE rather than an error:
   * the numbers on screen are still real, they are simply not new.
   *
   * @param {object} [input] State input.
   */
  function updateChip({ loading = false, failed = false } = {}) {
    if (!nodes.chip) return;
    const generatedAt = current?.analysis?.generatedAt;
    const observedAt = generatedAt ? Date.parse(generatedAt) : null;
    const state = classifyFeedState({
      hasData: Boolean(current?.analysis),
      failed: failed || current?.status === 'stale',
      loading,
      observedAt,
      now: now(),
      freshness: WEATHER_FRESHNESS,
    });
    const description = describeFeedState({
      state,
      sourceLabel: WEATHER_SOURCE,
      subjectPlural: 'observations',
      observedAt,
      now: now(),
    });
    nodes.chip.textContent = description.label;
    nodes.chip.dataset.tone = description.tone;
    nodes.chip.title =
      description.message || `${WEATHER_SOURCE} · ${description.label}`;
  }

  /**
   * Report a failure in place, keeping any analysis already on screen.
   *
   * The raw message is a transport detail. What the operator reads is the feed
   * state; the message only reaches the footer, and only as supporting text.
   *
   * @param {string} message Raw failure text.
   */
  function showError(message) {
    setBusy(false);
    if (current) {
      if (nodes.footer) nodes.footer.dataset.state = 'stale';
      if (nodes.updated)
        nodes.updated.textContent = 'stale · last analysis retained';
      updateChip({ failed: true });
      return;
    }
    if (nodes.placeholder) {
      nodes.placeholder.textContent =
        'Conditions analysis unavailable for this location. Select a location to retry.';
      nodes.placeholder.hidden = false;
      nodes.placeholder.title = message || '';
    }
    if (nodes.content) nodes.content.hidden = true;
    updateChip({ failed: true });
  }

  /**
   * Render one analysis.
   * @param {object} record Service record carrying `analysis`, `status`, `point`.
   */
  function render(record) {
    const analysis = record?.analysis;
    if (!analysis) {
      showError(record?.error || 'Weather intelligence unavailable.');
      return;
    }
    current = record;
    setBusy(false);
    if (nodes.placeholder) nodes.placeholder.hidden = true;
    if (nodes.content) nodes.content.hidden = false;

    // Headline: the worst active hazard, with its own words.
    const headline = orderRisks(analysis.risks)[0];
    const color = riskColor(headline?.score ?? 0);
    if (nodes.dot) nodes.dot.style.background = color;
    if (nodes.label) nodes.label.textContent = headline?.label ?? '—';
    if (nodes.level) {
      nodes.level.textContent = headline?.level ?? '—';
      nodes.level.style.color = color;
    }
    if (nodes.score) {
      nodes.score.textContent = String(headline?.score ?? 0);
      nodes.score.style.color = color;
    }
    if (nodes.trend) {
      const trend = headline?.trend;
      const arrow = TREND_ARROWS[trend?.direction] || '';
      const delta =
        Number.isFinite(trend?.change) && trend.source === 'observed'
          ? ` ${trend.change > 0 ? '+' : ''}${trend.change} since last update`
          : trend?.source === 'projected'
            ? ' projected'
            : '';
      nodes.trend.textContent = `${arrow}${delta}`;
      nodes.trend.dataset.direction = trend?.direction || 'UNKNOWN';
    }
    if (nodes.summary) nodes.summary.textContent = headline?.summary ?? '';

    // Conditions: the supporting evidence, once.
    if (nodes.conditions) {
      nodes.conditions.replaceChildren(
        ...CONDITION_FIELDS.flatMap(([key, label, format]) => {
          const value = analysis.conditions?.[key];
          if (!Number.isFinite(value)) return [];
          const group = el(doc, 'div');
          group.append(
            el(doc, 'dt', null, label),
            el(doc, 'dd', null, format(value)),
          );
          return [group];
        }),
      );
    }

    // Every hazard, worst first, as a compact module: name, score, status,
    // trend and one line of why. Anything longer belongs in ANALYSIS.
    if (nodes.risks) {
      const modules = orderRisks(analysis.risks).map((hazard) =>
        renderRiskModule(hazard),
      );
      // The seismic module comes from USGS rather than from the weather engine,
      // so it is supplied separately and appended in the same shape. Mixing the
      // sources is the point: an operator wants one risk column, not two.
      if (seismicModule) modules.push(renderRiskModule(seismicModule));
      nodes.risks.replaceChildren(...modules);
    }

    // WHY: the drivers that actually produced the active scores.
    if (nodes.drivers) {
      const reasons = collectReasons(analysis.risks);
      nodes.drivers.replaceChildren(
        ...(reasons.length
          ? reasons.map((entry) => {
              const item = el(doc, 'li');
              item.append(
                el(doc, 'span', null, `${entry.label} — ${entry.hazard}`),
                el(doc, 'span', 'aegis-driver-state', entry.state),
              );
              const state = item.querySelector('.aegis-driver-state');
              if (state)
                state.style.color =
                  entry.state === 'HIGH'
                    ? LEVEL_COLORS.HIGH
                    : entry.state === 'ELEVATED'
                      ? LEVEL_COLORS.ELEVATED
                      : LEVEL_COLORS.MODERATE;
              return item;
            })
          : [el(doc, 'li', null, 'No hazard drivers are currently active.')]),
      );
    }

    // Forecast windows, scored at their own hour.
    if (nodes.forecast) {
      nodes.forecast.replaceChildren(
        ...(analysis.forecast?.horizons || []).map((horizon) => {
          const cell = el(doc, 'li', 'aegis-forecast-cell');
          const score = el(
            doc,
            'span',
            'aegis-forecast-score',
            String(horizon.overall),
          );
          score.style.color = riskColor(horizon.overall);
          cell.append(
            el(doc, 'span', 'aegis-forecast-hour', `${horizon.hours}H`),
            score,
          );
          return cell;
        }),
      );
    }
    if (nodes.forecastNote)
      nodes.forecastNote.textContent =
        (analysis.forecast?.notes || [])[0] || '';

    // ACTION: monitoring priorities restated from the scored hazards. Nothing
    // here is generated; every line names a hazard the engine actually scored.
    if (nodes.actions) {
      nodes.actions.replaceChildren(
        ...priorityActions(analysis.risks).map((action) => {
          const item = el(doc, 'li', null, action.text);
          if (action.level && action.level !== 'NORMAL')
            item.style.borderLeftColor =
              LEVEL_COLORS[action.level] || 'transparent';
          return item;
        }),
      );
    }

    // Significant changes, when the engine detected any.
    const changes = analysis.significantChanges || [];
    if (nodes.changesSection)
      nodes.changesSection.hidden = changes.length === 0;
    if (nodes.changes) {
      nodes.changes.replaceChildren(
        ...changes.slice(0, 4).map((event) => {
          const item = el(doc, 'li');
          const direction = event.direction === 'INCREASE' ? '↑' : '↓';
          item.append(
            el(
              doc,
              'span',
              null,
              `${event.label} ${direction} ${event.previous_value} → ${event.current_value} ${event.unit}`.trim(),
            ),
            el(doc, 'span', 'aegis-driver-state', event.severity),
          );
          return item;
        }),
      );
    }

    if (nodes.region)
      nodes.region.textContent = record.regionLabel
        ? `CURRENT REGION · ${record.regionLabel}`
        : `ANALYZED POINT · ${formatPoint(record.point || analysis.location)}`;

    if (nodes.location)
      nodes.location.textContent = formatPoint(
        record.point || analysis.location,
      );
    if (nodes.footer)
      nodes.footer.dataset.state = record.status === 'stale' ? 'stale' : 'live';
    if (nodes.updated) {
      const age = now() - Date.parse(analysis.generatedAt);
      nodes.updated.textContent =
        record.status === 'stale'
          ? `stale · ${formatAge(age)}`
          : `updated ${formatAge(age)}`;
    }
    updateChip();
  }

  return Object.freeze({
    render,
    setBusy,
    showError,
    /**
     * Supply the seismic module from the USGS side of the application.
     *
     * The earthquake intelligence controller already holds this data; passing
     * it in rather than fetching it here keeps one request and one source of
     * truth behind both panels.
     *
     * @param {object|null} hazard Hazard-shaped record, or null to remove it.
     */
    setSeismicModule(hazard) {
      seismicModule = hazard || null;
      if (current?.analysis) render(current);
    },
    /** Refresh only the age line, so the panel does not look frozen between polls. */
    tick() {
      updateChip();
      if (!current?.analysis || !nodes.updated) return;
      const age = now() - Date.parse(current.analysis.generatedAt);
      nodes.updated.textContent =
        current.status === 'stale'
          ? `stale · ${formatAge(age)}`
          : `updated ${formatAge(age)}`;
    },
    destroy() {
      nodes.refresh?.removeEventListener('click', onRefreshClick);
    },
  });
}
