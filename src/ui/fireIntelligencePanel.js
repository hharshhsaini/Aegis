import { riskColor } from '../risk/thresholds.js';
import { renderMetrics } from './metricGrid.js';
import { bindCommandPanel } from './commandPanel.js';
import {
  classifyFeedState,
  describeFeedState,
  renderFeedState,
} from './dataState.js';

/**
 * Renders the Aegis Fire Intelligence panel.
 *
 * The panel exists to hold one line straight: FIRMS publishes SATELLITE THERMAL
 * ANOMALIES, not confirmed fires. So the heading says "active fire cluster" only
 * for a coherent group, a lone pixel stays a "satellite fire detection", and a
 * standing qualifier states that none of it is ground truth. Raw FIRMS fields
 * live in a technical section rather than the summary, because an operator
 * reads the assessment first and the pixel metadata only when they doubt it.
 *
 * Feed health is the panel's other job. FIRMS is a satellite feed over a public
 * endpoint and it will fail; when it does, the panel says DATA UNAVAILABLE with
 * the age of the last good observation and a retry, and folds the transport
 * error away into a diagnostics disclosure. It never prints a status code as
 * the headline, and it never lets an unreachable feed read as "no fires".
 */

/** FIRMS publishes roughly every 15 minutes; freshness is judged against that. */
const FIRMS_FRESHNESS = Object.freeze({
  liveMs: 15 * 60_000,
  recentMs: 45 * 60_000,
});

/** Attribution, shown in every state block. */
const FIRMS_SOURCE = 'NASA FIRMS';

/** Human-readable ages, matching the weather panel's vocabulary. */
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

/** Activity status to the colour it is shown in. */
const ACTIVITY_COLORS = Object.freeze({
  INCREASING: '#ff8c42',
  DECREASING: '#3ddc97',
  STEADY: '#ffd23f',
  INSUFFICIENT_DATA: 'rgba(232, 234, 237, 0.5)',
});

/** Categorical FRP to a short label. */
const FRP_LABELS = Object.freeze({
  LOW: 'LOW',
  MODERATE: 'MODERATE',
  HIGH: 'HIGH',
  EXTREME: 'EXTREME',
});

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(doc, label, value, valueColor) {
  const line = el(doc, 'div', 'aegis-fire-row');
  line.append(el(doc, 'span', 'aegis-fire-key', label));
  const node = el(doc, 'span', 'aegis-fire-value', value);
  if (valueColor) node.style.color = valueColor;
  line.append(node);
  return line;
}

/**
 * Bind the fire intelligence panel.
 *
 * @param {object} input Binding input.
 * @param {Document} [input.document] Document holding the markup.
 * @param {() => number} [input.now] Clock.
 * @param {() => void} [input.onRefresh] Called when a re-observation is asked for.
 * @returns {object|null} Controller, or null when the markup is absent.
 */
export function createFireIntelligencePanel({
  document: doc = globalThis.document,
  now = () => Date.now(),
  onRefresh,
  onViewClusters,
} = {}) {
  const root = doc?.getElementById?.('fire-panel');
  if (!root) return null;

  const nodes = {
    status: doc.getElementById('fire-status'),
    chip: doc.getElementById('fire-feed-chip'),
    metrics: doc.getElementById('fire-metrics'),
    viewClusters: doc.getElementById('fire-view-clusters'),
    areaConditions: doc.getElementById('fire-area-conditions'),
    feedState: doc.getElementById('fire-feed-state'),
    content: doc.getElementById('fire-content'),
    heading: doc.getElementById('fire-heading'),
    summary: doc.getElementById('fire-summary'),
    stats: doc.getElementById('fire-stats'),
    activity: doc.getElementById('fire-activity'),
    activityNote: doc.getElementById('fire-activity-note'),
    conditions: doc.getElementById('fire-conditions'),
    spread: doc.getElementById('fire-spread'),
    spreadScore: doc.getElementById('fire-spread-score'),
    drivers: doc.getElementById('fire-drivers'),
    direction: doc.getElementById('fire-direction'),
    directionNote: doc.getElementById('fire-direction-note'),
    technical: doc.getElementById('fire-technical'),
    attribution: doc.getElementById('fire-attribution'),
    refresh: doc.getElementById('fire-refresh-btn'),
  };

  // One shared header implementation, so this panel's collapse behaves
  // identically to every other panel's and its event isolation is not a local
  // reimplementation that can drift.
  const header = bindCommandPanel({ panel: root, document: doc });

  const onRefreshClick = (event) => {
    event?.stopPropagation?.();
    onRefresh?.();
  };
  nodes.refresh?.addEventListener('click', onRefreshClick);

  const onViewClustersClick = (event) => {
    event?.stopPropagation?.();
    onViewClusters?.();
  };
  nodes.viewClusters?.addEventListener('click', onViewClustersClick);

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

  /** Paint the feed chip and, when there is nothing to show, the state block. */
  function applyFeedState({
    hasData = false,
    failed = false,
    loading = false,
    empty = false,
    detail = null,
  }) {
    lastFailed = Boolean(failed);
    const state = classifyFeedState({
      hasData,
      failed,
      loading,
      empty,
      observedAt: lastGoodAt,
      now: now(),
      freshness: FIRMS_FRESHNESS,
    });
    const description = describeFeedState({
      state,
      sourceLabel: FIRMS_SOURCE,
      subjectPlural: 'fire detections',
      observedAt: lastGoodAt,
      now: now(),
      detail,
    });

    header?.setStatus(description);

    // The state block only appears when it has something to say. A LIVE feed
    // showing content does not need a banner explaining that it is fine.
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

  /** Show an area-level message with no cluster selected. */
  function showAreaSummary(record) {
    setBusy(false);
    const intelligence = record?.intelligence;
    if (nodes.content) nodes.content.hidden = true;

    if (!intelligence) {
      // Reached only when the transport failed and nothing was cached.
      applyFeedState({ hasData: false, failed: true, detail: record?.error });
      if (nodes.status) nodes.status.textContent = '';
      return;
    }

    // `stale` means the last refresh failed but this observation is real.
    const failed = record?.status === 'stale' || record?.source === 'error';
    if (!failed) lastGoodAt = record?.receivedAt ?? now();
    const empty = !intelligence.detectionCount;
    applyFeedState({
      hasData: true,
      failed,
      empty,
      detail: failed ? record?.error : null,
    });

    renderAreaMetrics(intelligence);

    // Collapsed, the panel still answers the two questions worth asking.
    const clusterCount = (intelligence.clusters || []).filter(
      (cluster) => cluster.kind === 'CLUSTER',
    ).length;
    header?.setSummary(
      intelligence.detectionCount
        ? `${intelligence.detectionCount} DETECTIONS · ${clusterCount} CLUSTERS`
        : 'NO DETECTIONS IN VIEW',
    );

    if (nodes.viewClusters) nodes.viewClusters.disabled = clusterCount === 0;

    if (!nodes.status) return;
    // With no detections the state block already carries the message, so the
    // status line would only repeat it.
    nodes.status.textContent = empty
      ? ''
      : `${intelligence.summary} Select a cluster for detail.`;
  }

  /**
   * The area picture, before any cluster is selected.
   *
   * Every figure is a count or a maximum over the detections FIRMS returned
   * for this viewport — nothing is modelled here. The leading spread score is
   * the fire engine's own, and it describes WEATHER conditions for spread, not
   * observed fire behaviour.
   *
   * @param {object} intelligence Fire intelligence record.
   */
  function renderAreaMetrics(intelligence) {
    const clusters = (intelligence?.clusters || []).filter(
      (cluster) => cluster.kind === 'CLUSTER',
    );
    const detections = intelligence?.detectionCount ?? null;
    const confidences = (intelligence?.clusters || [])
      .map((cluster) => cluster.averageConfidence)
      .filter((value) => Number.isFinite(value));
    const meanConfidence = confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : null;
    const peakFrp = (intelligence?.clusters || []).reduce(
      (max, cluster) =>
        Number.isFinite(cluster.peakFrp) ? Math.max(max, cluster.peakFrp) : max,
      Number.NEGATIVE_INFINITY,
    );
    const newestAge = (intelligence?.clusters || []).reduce(
      (min, cluster) =>
        Number.isFinite(cluster.newestAgeMs)
          ? Math.min(min, cluster.newestAgeMs)
          : min,
      Number.POSITIVE_INFINITY,
    );
    const spread = intelligence?.leadingSpreadConditions || null;
    const activity = intelligence?.activity || null;

    renderMetrics(doc, nodes.metrics, [
      ['ACTIVE DETECTIONS', detections],
      ['CLUSTERS', clusters.length || (detections ? 0 : null)],
      [
        'MEAN CONFIDENCE',
        meanConfidence === null ? null : `${Math.round(meanConfidence * 100)}%`,
      ],
      [
        'MAX FRP',
        Number.isFinite(peakFrp) && peakFrp > Number.NEGATIVE_INFINITY
          ? `${Math.round(peakFrp)} MW`
          : null,
      ],
      [
        'LAST OBSERVED',
        Number.isFinite(newestAge) && newestAge < Number.POSITIVE_INFINITY
          ? formatAge(newestAge)
          : null,
      ],
      [
        'SPREAD CONDITIONS',
        spread ? `${spread.score} / 100` : null,
        spread ? riskColor(spread.score) : undefined,
      ],
    ]);

    if (nodes.areaConditions) {
      const status = activity?.status;
      nodes.areaConditions.replaceChildren();
      if (status) {
        const label = el(
          doc,
          'span',
          'aegis-metric-strip-label',
          'ACTIVITY TREND',
        );
        const value = el(
          doc,
          'span',
          'aegis-metric-strip-value',
          status === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT DATA' : status,
        );
        value.style.color = ACTIVITY_COLORS[status] || '';
        nodes.areaConditions.append(label, value);
      }
    }
  }

  /**
   * Render one selected cluster.
   * @param {object} cluster Enriched cluster.
   * @param {object} [context] Area context.
   */
  function showCluster(cluster, { activity } = {}) {
    setBusy(false);
    if (!cluster) {
      if (nodes.content) nodes.content.hidden = true;
      return;
    }
    if (nodes.status) nodes.status.textContent = '';
    if (nodes.content) nodes.content.hidden = false;
    // A selected cluster is content; the state block steps aside for it.
    if (nodes.feedState) nodes.feedState.hidden = true;

    if (nodes.heading)
      nodes.heading.textContent =
        cluster.kind === 'CLUSTER'
          ? 'ACTIVE FIRE CLUSTER'
          : 'SATELLITE FIRE DETECTIONS';

    if (nodes.summary)
      nodes.summary.textContent =
        cluster.kind === 'CLUSTER'
          ? `${cluster.detectionCount} thermal anomalies detected across ${cluster.spanKm} km.`
          : `${cluster.detectionCount} thermal anomaly detection${cluster.detectionCount > 1 ? 's' : ''} in this area.`;

    if (nodes.stats) {
      nodes.stats.replaceChildren(
        row(doc, 'Detections', String(cluster.detectionCount)),
        row(
          doc,
          'Confidence',
          cluster.averageConfidence === null
            ? '—'
            : `${Math.round(cluster.averageConfidence * 100)}%`,
        ),
        row(
          doc,
          'Peak FRP',
          cluster.peakFrpBand
            ? `${FRP_LABELS[cluster.peakFrpBand]} · ${Math.round(cluster.peakFrp)} MW`
            : '—',
        ),
        row(doc, 'Detection area', `${cluster.detectionAreaKm2} km²`),
        row(
          doc,
          'First detected',
          formatAge(now() - Date.parse(cluster.oldestDetectionAt)),
        ),
        row(doc, 'Latest detection', formatAge(cluster.newestAgeMs)),
      );
    }

    // Fire activity: the trend, or an honest statement that there isn't one.
    if (nodes.activity) {
      const status = activity?.status || 'INSUFFICIENT_DATA';
      nodes.activity.textContent =
        status === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT DATA' : status;
      nodes.activity.style.color = ACTIVITY_COLORS[status];
    }
    if (nodes.activityNote)
      nodes.activityNote.textContent =
        activity?.note || 'Insufficient observations for trend analysis.';

    // Environmental conditions at the cluster.
    if (nodes.conditions) {
      const weather = cluster.weather;
      nodes.conditions.replaceChildren(
        ...(weather
          ? [
              row(doc, 'Temperature', `${Math.round(weather.temperature)}°C`),
              row(doc, 'Humidity', `${Math.round(weather.humidity)}%`),
              row(doc, 'Wind', `${Math.round(weather.windSpeed)} km/h`),
              row(
                doc,
                'Gusts',
                Number.isFinite(weather.windGusts)
                  ? `${Math.round(weather.windGusts)} km/h`
                  : '—',
              ),
              row(
                doc,
                'VPD',
                Number.isFinite(weather.vapourPressureDeficit)
                  ? `${weather.vapourPressureDeficit.toFixed(2)} kPa`
                  : '—',
              ),
              row(
                doc,
                'Recent rain (24h)',
                Number.isFinite(weather.recentRain24h)
                  ? `${weather.recentRain24h} mm`
                  : '—',
              ),
            ]
          : [row(doc, 'Weather', 'unavailable for this cluster')]),
      );
    }

    // Fire spread conditions: environment, not behaviour.
    const spread = cluster.spreadConditions;
    if (nodes.spread) {
      nodes.spread.textContent = spread ? spread.level : 'UNAVAILABLE';
      nodes.spread.style.color = spread ? riskColor(spread.score) : '';
    }
    if (nodes.spreadScore) {
      nodes.spreadScore.textContent = spread ? `${spread.score} / 100` : '—';
      if (spread) nodes.spreadScore.style.color = riskColor(spread.score);
    }
    if (nodes.drivers) {
      const drivers = spread?.leadingDrivers || [];
      nodes.drivers.replaceChildren(
        ...(drivers.length
          ? drivers.map((driver) =>
              el(doc, 'li', null, driver.detail || driver.label),
            )
          : [
              el(
                doc,
                'li',
                null,
                spread
                  ? 'No individual driver is elevated.'
                  : 'Weather unavailable for this cluster.',
              ),
            ]),
      );
    }

    // Potential environmental direction.
    const vector = cluster.spreadVector;
    if (nodes.direction)
      nodes.direction.textContent = vector
        ? `${vector.spreadTowardCardinal} →  ${Math.round(vector.windSpeedKmh)} km/h wind`
        : '—';
    if (nodes.directionNote)
      nodes.directionNote.textContent = vector
        ? vector.label
        : 'Wind data unavailable for this cluster.';

    // Raw FIRMS fields, kept out of the way.
    if (nodes.technical) {
      const newest = cluster.detections?.[0];
      nodes.technical.replaceChildren(
        row(doc, 'Satellites', cluster.satellites.join(', ') || '—'),
        row(doc, 'Sources', cluster.sources.join(', ') || '—'),
        row(doc, 'Instrument', newest?.instrument || '—'),
        row(
          doc,
          'Brightness (I-4)',
          Number.isFinite(newest?.brightnessTemperature)
            ? `${newest.brightnessTemperature} K`
            : '—',
        ),
        row(doc, 'Confidence (raw)', String(newest?.confidenceRaw ?? '—')),
        row(doc, 'Day / night', newest?.dayNight || '—'),
        row(
          doc,
          'Centre',
          `${cluster.center.latitude}, ${cluster.center.longitude}`,
        ),
      );
    }
  }

  return Object.freeze({
    showAreaSummary,
    showCluster,
    setBusy,
    applyFeedState,
    header,
    /**
     * Report a failed observation.
     *
     * The message is a transport detail, so it goes to the diagnostics
     * disclosure. What the operator reads is the feed state.
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
    /** Refresh the chip so a live feed visibly ages into RECENT and STALE. */
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
        freshness: FIRMS_FRESHNESS,
      });
    },
    destroy() {
      nodes.refresh?.removeEventListener('click', onRefreshClick);
      nodes.viewClusters?.removeEventListener('click', onViewClustersClick);
      header?.destroy();
    },
  });
}
