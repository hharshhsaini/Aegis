import {
  ANALYSIS_RADII_KM,
  DEFAULT_ANALYSIS_RADIUS_KM,
} from '../layers/earthquakes/thresholds.js';
import { ANALYSIS_RADIUS_LABEL } from '../layers/earthquakes/exposure.js';
import {
  classifyFeedState,
  describeFeedState,
  renderFeedState,
} from './dataState.js';
import { renderMetrics } from './metricGrid.js';
import { bindCommandPanel } from './commandPanel.js';

/**
 * Renders the Aegis Earthquake Intelligence panel.
 *
 * Every figure shown here is a USGS measurement or a count of USGS records, and
 * the panel says so: the source line, the "USGS" prefixes on status,
 * significance and the tsunami flag, and the link to the original event page.
 * Aegis adds organization — sequence, activity, alert level — never a new
 * physical claim, and never a forecast.
 */

/** Ages, in the same vocabulary the other intelligence panels use. */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m ago` : `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Alert levels to their display colour. */
const ALERT_COLORS = Object.freeze({
  SIGNIFICANT: '#ff4d6d',
  WATCH: '#ffd23f',
  INFORMATION: 'rgba(232, 234, 237, 0.55)',
});

/** Activity states to their display colour. */
const ACTIVITY_COLORS = Object.freeze({
  INCREASING: '#ff8c42',
  DECREASING: '#3ddc97',
  STEADY: '#ffd23f',
  INSUFFICIENT_DATA: 'rgba(232, 234, 237, 0.5)',
});

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(doc, label, value, color) {
  const line = el(doc, 'div', 'aegis-quake-row');
  line.append(el(doc, 'span', 'aegis-quake-key', label));
  const node = el(doc, 'span', 'aegis-quake-value', value);
  if (color) node.style.color = color;
  line.append(node);
  return line;
}

/**
 * Bind the earthquake panel.
 *
 * @param {object} input Input.
 * @param {Document} [input.document] Document holding the markup.
 * @param {() => number} [input.now] Clock.
 * @param {() => void} [input.onRefresh] Called when a refresh is asked for.
 * @param {(km: number) => void} [input.onRadiusChange] Called when the analysis radius changes.
 * @returns {object|null} Controller, or null when the markup is absent.
 */
/** USGS summary feeds regenerate every few minutes. */
const USGS_FRESHNESS = Object.freeze({
  liveMs: 20 * 60_000,
  recentMs: 60 * 60_000,
});

/** Attribution, shown in every state block. */
const USGS_SOURCE = 'USGS';

export function createEarthquakePanel({
  document: doc = globalThis.document,
  now = () => Date.now(),
  onRefresh,
  onRadiusChange,
} = {}) {
  const root = doc?.getElementById?.('quake-panel');
  if (!root) return null;

  const nodes = {
    status: doc.getElementById('quake-status'),
    chip: doc.getElementById('quake-feed-chip'),
    metrics: doc.getElementById('quake-metrics'),
    feedState: doc.getElementById('quake-feed-state'),
    content: doc.getElementById('quake-content'),
    heading: doc.getElementById('quake-heading'),
    magnitude: doc.getElementById('quake-magnitude'),
    magnitudeCategory: doc.getElementById('quake-magnitude-category'),
    alert: doc.getElementById('quake-alert'),
    facts: doc.getElementById('quake-facts'),
    depthNote: doc.getElementById('quake-depth-note'),
    feltNote: doc.getElementById('quake-felt-note'),
    sequence: doc.getElementById('quake-sequence'),
    sequenceNote: doc.getElementById('quake-sequence-note'),
    activity: doc.getElementById('quake-activity'),
    activityNote: doc.getElementById('quake-activity-note'),
    radius: doc.getElementById('quake-radius'),
    exposure: doc.getElementById('quake-exposure'),
    weather: doc.getElementById('quake-weather'),
    link: doc.getElementById('quake-usgs-link'),
    forecast: doc.getElementById('quake-forecast'),
    forecastProbability: doc.getElementById('quake-forecast-probability'),
    forecastTarget: doc.getElementById('quake-forecast-target'),
    forecastBaseline: doc.getElementById('quake-forecast-baseline'),
    forecastObserved: doc.getElementById('quake-forecast-observed'),
    forecastAnomaly: doc.getElementById('quake-forecast-anomaly'),
    forecastTrend: doc.getElementById('quake-forecast-trend'),
    forecastDrivers: doc.getElementById('quake-forecast-drivers'),
    forecastSummary: doc.getElementById('quake-forecast-summary'),
    forecastModel: doc.getElementById('quake-forecast-model'),
    refresh: doc.getElementById('quake-refresh-btn'),
  };

  let radiusKm = DEFAULT_ANALYSIS_RADIUS_KM;
  // The same shared header the fire panel uses, so both collapse identically
  // and neither reimplements the event isolation the toggle needs.
  const header = bindCommandPanel({ panel: root, document: doc });

  const onRefreshClick = (event) => {
    event?.stopPropagation?.();
    onRefresh?.();
  };
  nodes.refresh?.addEventListener('click', onRefreshClick);

  // The analysis radius is operator-chosen, from the offered set only.
  const radiusButtons = [];
  if (nodes.radius) {
    nodes.radius.replaceChildren(
      ...ANALYSIS_RADII_KM.map((km) => {
        const button = el(doc, 'button', 'aegis-quake-radius-btn', `${km}`);
        button.type = 'button';
        button.dataset.km = String(km);
        button.setAttribute('aria-pressed', km === radiusKm ? 'true' : 'false');
        button.addEventListener('click', () => {
          radiusKm = km;
          for (const other of radiusButtons)
            other.setAttribute(
              'aria-pressed',
              other.dataset.km === String(km) ? 'true' : 'false',
            );
          onRadiusChange?.(km);
        });
        radiusButtons.push(button);
        return button;
      }),
    );
  }

  let busy = false;
  let lastGoodAt = null;
  // Remembered so feedState() answers with the same state the panel is
  // showing. Without it the status strip could report a healthy system above a
  // panel that is visibly stale.
  let lastFailed = false;

  function setBusy(value) {
    busy = Boolean(value);
    nodes.refresh?.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (busy && lastGoodAt === null) applyFeedState({ loading: true });
  }

  /**
   * Paint the feed chip and, when there is nothing to show, the state block.
   *
   * The USGS summary feeds regenerate every few minutes, so freshness is judged
   * against that rather than against an arbitrary number.
   *
   * @param {object} [input] State input.
   * @returns {object} The state description.
   */
  function applyFeedState({
    hasData = false,
    failed = false,
    loading = false,
    empty = false,
    detail = null,
  } = {}) {
    lastFailed = Boolean(failed);
    const state = classifyFeedState({
      hasData,
      failed,
      loading,
      empty,
      observedAt: lastGoodAt,
      now: now(),
      freshness: USGS_FRESHNESS,
    });
    const description = describeFeedState({
      state,
      sourceLabel: USGS_SOURCE,
      subjectPlural: 'earthquakes',
      observedAt: lastGoodAt,
      now: now(),
      detail,
    });
    header?.setStatus(description);
    const showBlock = Boolean(description.headline);
    if (nodes.feedState) {
      nodes.feedState.hidden = !showBlock;
      if (showBlock)
        renderFeedState({
          document: doc,
          container: nodes.feedState,
          description,
          onRetry: onRefresh ? () => onRefresh() : null,
        });
      else nodes.feedState.replaceChildren();
    }
    return description;
  }

  /**
   * The area picture, from the USGS records in view.
   *
   * Counts and maxima over what the feed returned — no model runs here. The
   * sequence line reports what the clustering found rather than asserting that
   * a sequence is under way, and an empty feed window reports zero events
   * rather than "no risk", which is a claim about the ground.
   *
   * @param {object} intelligence Earthquake intelligence record.
   */
  function renderAreaMetrics(intelligence) {
    const events = intelligence?.events || [];
    const largest = intelligence?.largestEvent || null;
    // The normalized USGS record names this `depth`, in kilometres.
    const depths = events
      .map((event) => event.depth)
      .filter((value) => Number.isFinite(value));
    const newest = events.reduce((latest, event) => {
      const at = Date.parse(event.timeIso);
      return Number.isFinite(at) && at > latest ? at : latest;
    }, Number.NEGATIVE_INFINITY);
    const activity = intelligence?.activity || null;
    const sequences = intelligence?.sequenceCount ?? null;

    renderMetrics(doc, nodes.metrics, [
      ['EVENTS IN VIEW', intelligence ? events.length : null],
      ['LARGEST', largest?.magnitude != null ? `M${largest.magnitude}` : null],
      [
        'DEPTH',
        depths.length
          ? `${Math.round(depths.reduce((sum, value) => sum + value, 0) / depths.length)} km`
          : null,
      ],
      [
        'LAST EVENT',
        newest > Number.NEGATIVE_INFINITY ? formatAge(now() - newest) : null,
      ],
      [
        'ACTIVITY TREND',
        activity?.status
          ? activity.status === 'INSUFFICIENT_DATA'
            ? 'INSUFFICIENT'
            : activity.status
          : null,
      ],
      [
        'SEQUENCE SIGNAL',
        sequences === null
          ? null
          : sequences > 0
            ? `${sequences} CLUSTERED`
            : 'NONE',
      ],
    ]);
  }

  /** Area-level view: what USGS recorded here, with no event selected. */
  function showAreaSummary(record) {
    setBusy(false);
    const intelligence = record?.intelligence;
    if (nodes.content) nodes.content.hidden = true;
    if (!intelligence) {
      applyFeedState({ hasData: false, failed: true, detail: record?.error });
      if (nodes.status) nodes.status.textContent = '';
      return;
    }
    const failed = record?.status === 'stale' || record?.source === 'error';
    if (!failed) lastGoodAt = record?.receivedAt ?? now();
    applyFeedState({
      hasData: true,
      failed,
      empty: !intelligence.eventCount,
      detail: failed ? record?.error : null,
    });
    renderAreaMetrics(intelligence);

    // Collapsed, the header still carries the count and the largest event —
    // the two figures an operator scans a seismic panel for.
    const count = intelligence.eventCount ?? 0;
    header?.setSummary(
      count
        ? `${count} EVENT${count === 1 ? '' : 'S'}${
            intelligence.largestEvent?.magnitude != null
              ? ` · MAX M${intelligence.largestEvent.magnitude}`
              : ''
          }`
        : 'NO EVENTS IN VIEW',
    );

    if (!nodes.status) return;
    const activity = intelligence.activity;
    const parts = [intelligence.summary];
    if (activity?.status && activity.status !== 'INSUFFICIENT_DATA')
      parts.push(
        `Activity ${activity.status.toLowerCase()}: ${activity.rates.last6h} events in 6h (${activity.rates.last24h} in 24h).`,
      );
    if (intelligence.eventCount) parts.push('Select an event for detail.');
    nodes.status.textContent = parts.join(' ');
  }

  /**
   * Render one selected earthquake.
   * @param {object} event Graded event.
   * @param {object} [context] Context.
   */
  function showEvent(
    event,
    { intelligence = null, responseWeather = null } = {},
  ) {
    setBusy(false);
    if (!event) {
      if (nodes.content) nodes.content.hidden = true;
      return;
    }
    if (nodes.status) nodes.status.textContent = '';
    if (nodes.content) nodes.content.hidden = false;

    const alertLevel = event.alert?.level || 'INFORMATION';
    if (nodes.heading)
      nodes.heading.textContent =
        event.place || event.title || 'Recorded earthquake';
    if (nodes.magnitude)
      nodes.magnitude.textContent = Number.isFinite(event.magnitude)
        ? `M${event.magnitude.toFixed(1)}`
        : 'M—';
    if (nodes.magnitudeCategory)
      nodes.magnitudeCategory.textContent =
        event.magnitudeCategory?.label ?? '';
    if (nodes.alert) {
      nodes.alert.textContent =
        alertLevel === 'SIGNIFICANT' ? 'SIGNIFICANT EVENT' : alertLevel;
      nodes.alert.style.color = ALERT_COLORS[alertLevel];
    }

    if (nodes.facts) {
      nodes.facts.replaceChildren(
        row(
          doc,
          'Depth',
          Number.isFinite(event.depth) ? `${event.depth} km` : '—',
        ),
        row(doc, 'Location', event.place || '—'),
        row(doc, 'Detected', event.time ? formatAge(now() - event.time) : '—'),
        row(doc, 'USGS status', event.status ? event.status : '—'),
        row(
          doc,
          'Tsunami flag',
          // The flag is USGS's statement, and is labelled as such. Absence is
          // reported as absence, never as safety.
          event.tsunami ? 'USGS: YES' : 'USGS: not set',
          event.tsunami ? ALERT_COLORS.SIGNIFICANT : undefined,
        ),
        row(
          doc,
          'Felt reports',
          Number.isFinite(event.felt)
            ? event.felt.toLocaleString('en-US')
            : '—',
        ),
        row(
          doc,
          'USGS significance',
          Number.isFinite(event.significance)
            ? String(event.significance)
            : '—',
        ),
        row(doc, 'Magnitude type', event.magnitudeType || '—'),
      );
    }

    if (nodes.depthNote)
      nodes.depthNote.textContent = event.depthCategory
        ? `${event.depthCategory.label} focus${
            event.depthCategory.id === 'SHALLOW'
              ? ' — this is a relatively shallow earthquake.'
              : '.'
          }`
        : '';

    if (nodes.feltNote) nodes.feltNote.textContent = event.feltNote || '';

    const cluster = intelligence?.clusters?.find((entry) =>
      entry.events.some((member) => member.id === event.id),
    );
    if (nodes.sequence) {
      const isSequence = cluster?.kind === 'SEQUENCE';
      nodes.sequence.textContent = isSequence
        ? `${cluster.eventCount} events`
        : 'No sequence detected';
      nodes.sequence.style.color = isSequence
        ? ALERT_COLORS.WATCH
        : ALERT_COLORS.INFORMATION;
    }
    if (nodes.sequenceNote)
      nodes.sequenceNote.textContent =
        cluster?.kind === 'SEQUENCE'
          ? `Earthquake sequence detected: largest M${cluster.maxMagnitude ?? '—'}, within ${cluster.radiusKm} km over ${cluster.spanHours ?? '—'} h. Aegis does not classify this as an aftershock sequence.`
          : '';

    const activity = intelligence?.activity;
    if (nodes.activity) {
      const status = activity?.status || 'INSUFFICIENT_DATA';
      nodes.activity.textContent =
        status === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT DATA' : status;
      nodes.activity.style.color = ACTIVITY_COLORS[status];
    }
    if (nodes.activityNote)
      nodes.activityNote.textContent =
        activity?.note || 'Insufficient observations for trend analysis.';

    // Exposure is an interface, not a dataset yet: it reports its own absence
    // rather than letting the panel imply a count.
    if (nodes.exposure)
      nodes.exposure.textContent = `${ANALYSIS_RADIUS_LABEL}: ${radiusKm} km. Population, road, hospital, school and emergency-facility datasets are not connected yet, so no counts are reported.`;

    if (nodes.weather)
      nodes.weather.textContent =
        responseWeather?.eventId === event.id && responseWeather.notes.length
          ? responseWeather.notes.join(' ')
          : '';

    if (nodes.link) {
      if (event.url) {
        nodes.link.href = event.url;
        nodes.link.hidden = false;
      } else nodes.link.hidden = true;
    }
  }

  /**
   * Render the model forecast.
   *
   * The probability is never shown alone: the target sits directly beneath it,
   * the region's own baseline beside it, and the model's validated skill below.
   * A bare "71%" is precisely the ambiguity this panel exists to avoid.
   *
   * @param {object|null} record Forecast envelope from the service.
   */
  function showForecast(record) {
    const forecast = record?.forecast;
    if (!nodes.forecast) return;
    if (!forecast) {
      nodes.forecast.hidden = true;
      return;
    }
    nodes.forecast.hidden = false;

    const percent = (value) =>
      Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';

    if (forecast.status === 'MODEL_UNAVAILABLE') {
      // Honest degradation: observed activity still shows, the forecast does not
      // pretend to exist.
      if (nodes.forecastProbability)
        nodes.forecastProbability.textContent = '—';
      if (nodes.forecastTarget)
        nodes.forecastTarget.textContent =
          forecast.note ||
          'MODEL STATUS · INSUFFICIENT HISTORY for this region.';
      if (nodes.forecastDrivers) nodes.forecastDrivers.replaceChildren();
      if (nodes.forecastSummary) nodes.forecastSummary.textContent = '';
      if (nodes.forecastModel) nodes.forecastModel.textContent = '';
      return;
    }

    if (nodes.forecastProbability) {
      nodes.forecastProbability.textContent = percent(forecast.probability);
      nodes.forecastProbability.style.color =
        forecast.probability >= 0.6
          ? ALERT_COLORS.SIGNIFICANT
          : forecast.probability >= 0.3
            ? ALERT_COLORS.WATCH
            : ACTIVITY_COLORS.DECREASING;
    }
    if (nodes.forecastTarget)
      nodes.forecastTarget.textContent = `${forecast.targetDescription} · next ${forecast.forecastWindowHours}h`;
    if (nodes.forecastBaseline)
      nodes.forecastBaseline.textContent = percent(
        forecast.baselineProbability,
      );
    if (nodes.forecastObserved)
      nodes.forecastObserved.textContent = `${forecast.anomaly?.currentCount ?? '—'} events`;

    if (nodes.forecastAnomaly) {
      const anomaly = forecast.anomaly;
      nodes.forecastAnomaly.textContent = Number.isFinite(
        anomaly?.changePercent,
      )
        ? `${anomaly.changePercent > 0 ? '+' : ''}${anomaly.changePercent}%`
        : anomaly?.level === 'INSUFFICIENT_BASELINE'
          ? 'no baseline'
          : '—';
      nodes.forecastAnomaly.style.color =
        anomaly?.level === 'UNUSUAL' || anomaly?.level === 'HIGHLY_UNUSUAL'
          ? ALERT_COLORS.SIGNIFICANT
          : anomaly?.level === 'ELEVATED'
            ? ALERT_COLORS.WATCH
            : '';
    }
    if (nodes.forecastTrend) {
      nodes.forecastTrend.textContent = forecast.trend;
      nodes.forecastTrend.style.color = ACTIVITY_COLORS[forecast.trend] ?? '';
    }
    if (nodes.forecastDrivers)
      nodes.forecastDrivers.replaceChildren(
        ...(forecast.drivers?.length
          ? forecast.drivers.map((driver) => el(doc, 'li', null, driver.text))
          : [
              el(doc, 'li', null, 'No single feature dominates this forecast.'),
            ]),
      );
    if (nodes.forecastSummary)
      nodes.forecastSummary.textContent = record.narration?.text || '';
    if (nodes.forecastModel) {
      const validation = forecast.validation;
      // Who wrote the summary is stated, so a template is never mistaken for
      // an AI-generated one.
      const generator =
        record.narration?.generatedBy === 'amazon-bedrock'
          ? 'Summary by Amazon Bedrock'
          : 'Summary generated deterministically (Bedrock not configured)';
      nodes.forecastModel.textContent = validation
        ? `${forecast.model.name} ${forecast.model.version} · held-out Brier ${validation.brierScore} vs baseline ${validation.baselineBrierScore}, ROC-AUC ${validation.rocAuc}. ${generator}.`
        : `${forecast.model.name} ${forecast.model.version}. ${generator}.`;
    }
  }

  return Object.freeze({
    showAreaSummary,
    showEvent,
    showForecast,
    setBusy,
    header,
    getRadiusKm: () => radiusKm,
    applyFeedState,
    /**
     * Report a failed observation.
     *
     * The message is a transport detail and goes to the diagnostics
     * disclosure; the operator reads the feed state.
     *
     * @param {string} message Raw failure text.
     */
    showError(message) {
      setBusy(false);
      if (nodes.content) nodes.content.hidden = true;
      if (nodes.status) nodes.status.textContent = '';
      applyFeedState({
        hasData: lastGoodAt !== null,
        failed: true,
        detail: message,
      });
    },
    /** Refresh the chip so a live feed visibly ages. */
    tick() {
      if (lastGoodAt === null) return;
      applyFeedState({ hasData: true });
    },
    /** @returns {string} The current feed state id. */
    feedState() {
      return classifyFeedState({
        hasData: lastGoodAt !== null,
        failed: lastFailed,
        loading: busy,
        observedAt: lastGoodAt,
        now: now(),
        freshness: USGS_FRESHNESS,
      });
    },
    destroy() {
      nodes.refresh?.removeEventListener('click', onRefreshClick);
      header?.destroy();
    },
  });
}
