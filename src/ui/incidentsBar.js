import { INCIDENT_KINDS, describeSourceType } from '../incidents/model.js';
import { formatAge } from './dataState.js';
import { distanceKm, formatDistance } from '../alerts/relevance.js';

/**
 * The incidents board, along the bottom of the console.
 *
 * This replaces the single Nepal launcher. Nepal is still here — it is simply
 * one incident among however many the live feeds are currently reporting,
 * which is what it always should have been: a demonstration sitting beside
 * real detections rather than standing in for them.
 *
 * Two behaviours matter more than the layout:
 *
 *  1. SELECTING AN INCIDENT TAKES YOU THERE. Every incident carries a
 *     location, so selecting one flies the camera to it. A live detection and
 *     an authored scenario therefore begin the same way, and the operator
 *     learns one gesture rather than two.
 *  2. AUTHORED CONTENT IS LABELLED EVERYWHERE. An authored row says so on the
 *     row, the mode banner flips while it plays, and the two can never be
 *     confused by reading quickly.
 *
 * The playback controls only apply to an authored scenario, so they appear
 * only when one is selected. A live detection has nothing to play.
 */

/** The phases the Nepal sequence moves through, for the running indicator. */
export const SCENARIO_PHASES = Object.freeze([
  Object.freeze({ id: 'signal', label: 'WEATHER SIGNAL' }),
  Object.freeze({ id: 'hydrology', label: 'HYDROLOGICAL SIGNAL' }),
  Object.freeze({ id: 'escalation', label: 'FLOOD RISK ESCALATION' }),
  Object.freeze({ id: 'impact', label: 'IMPACT ANALYSIS' }),
  Object.freeze({ id: 'exposure', label: 'POPULATION EXPOSURE' }),
  Object.freeze({ id: 'response', label: 'RESPONSE CONTEXT' }),
]);

/** The two states the console can be in. */
export const MODES = Object.freeze({ LIVE: 'LIVE', SCENARIO: 'SCENARIO' });

/** Short source badges. */
const KIND_BADGE = Object.freeze({
  [INCIDENT_KINDS.EARTHQUAKE]: 'USGS',
  [INCIDENT_KINDS.FIRE]: 'FIRMS',
  [INCIDENT_KINDS.WEATHER]: 'WX',
  [INCIDENT_KINDS.SCENARIO]: 'SCENARIO',
});

/**
 * How old an incident is, in the row's own words.
 *
 * An authored scenario has no observation time, and saying "just now" about
 * one would be a small lie in a list whose entire job is telling real from
 * scripted. A live incident with no timestamp is reported as live rather than
 * given an invented age.
 *
 * @param {object} incident The incident.
 * @param {number} now Clock.
 * @returns {string} Age label.
 */
export function incidentAge(incident, now) {
  if (!incident?.live) return 'demo';
  if (!Number.isFinite(incident.observedAt)) return 'live';
  return formatAge(now - incident.observedAt);
}

/**
 * Which phase a run at this progress is in.
 *
 * Progress is a fraction of the estimated run, so phases divide it evenly.
 * An approximation, and labelled as a stage indicator rather than a clock —
 * the authored shots have their own uneven durations.
 *
 * @param {number} progress Fraction in 0..1.
 * @param {object[]} [phases] Phase list.
 * @returns {object|null} The phase, or null before a run starts.
 */
export function phaseAt(progress, phases = SCENARIO_PHASES) {
  if (!Number.isFinite(progress) || progress < 0) return null;
  const index = Math.min(
    phases.length - 1,
    Math.floor(progress * phases.length),
  );
  return phases[index] || null;
}

/**
 * Bind the incidents bar.
 *
 * @param {object} input Input.
 * @param {object} input.registry Incident registry.
 * @param {object} input.director SceneDirector, for authored scenarios.
 * @param {(incident: object) => void} [input.onFocus] Take the operator to an incident.
 * @param {Document} [input.document] Document holding the markup.
 * @param {() => number} [input.now] Clock.
 * @returns {object|null} Controller, or null when the markup is absent.
 */
export function createIncidentsBar({
  registry,
  director,
  onFocus,
  onStopReconstruction,
  readUserLocation = () => null,
  document: doc = globalThis.document,
  now = () => Date.now(),
} = {}) {
  const root = doc?.getElementById?.('incidents-bar');
  if (!root || !registry) return null;

  const nodes = {
    mode: doc.getElementById('aegis-mode'),
    statusChip: doc.getElementById('aegis-status-chip'),
    count: doc.getElementById('incidents-count'),
    list: doc.getElementById('incidents-list'),
    empty: doc.getElementById('incidents-empty'),
    detailTitle: doc.getElementById('incident-detail-title'),
    detailMeta: doc.getElementById('incident-detail-meta'),
    controls: doc.getElementById('incident-controls'),
    run: doc.getElementById('incident-run-btn'),
    pause: doc.getElementById('incident-pause-btn'),
    reset: doc.getElementById('incident-reset-btn'),
    exit: doc.getElementById('incident-exit-btn'),
    focus: doc.getElementById('incident-focus-btn'),
    phase: doc.getElementById('incident-phase'),
    progress: doc.getElementById('incident-progress-fill'),
  };

  let incidents = [];
  let selectedId = null;
  let destroyed = false;
  // The live-incident counterpart to scenario playback state.
  let reconstruction = null;

  /** The selected incident, or the first one when nothing is selected. */
  function selected() {
    return (
      incidents.find((incident) => incident.id === selectedId) ||
      incidents[0] ||
      null
    );
  }

  /** Render one incident row. */
  function renderRow(incident) {
    const item = doc.createElement('li');
    item.className = 'incident-row';
    item.dataset.incidentId = incident.id;
    item.dataset.level = incident.level;
    item.dataset.live = incident.live ? 'true' : 'false';

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'incident-row-button';

    const dot = doc.createElement('span');
    dot.className = 'incident-row-dot';

    // Two independent signals, carried by two channels that cannot mask each
    // other: the dot's COLOUR is severity, this glyph's SHAPE is what kind of
    // statement the row is — an observation, a model signal, an authority's
    // warning, an authored scenario. Shape rather than a second colour,
    // because a reader who cannot separate hues must not lose the difference
    // between "this happened" and "a model thinks this might".
    const provenance = describeSourceType(incident);
    const mark = doc.createElement('span');
    mark.className = 'incident-row-provenance';
    mark.textContent = provenance.glyph;
    mark.dataset.sourceType =
      incident.live === false ? 'SCENARIO' : incident.sourceType;
    mark.title = provenance.description;
    mark.setAttribute('aria-label', provenance.label);

    const text = doc.createElement('span');
    text.className = 'incident-row-text';
    const title = doc.createElement('span');
    title.className = 'incident-row-title';
    title.textContent = incident.title;
    const place = doc.createElement('span');
    place.className = 'incident-row-place';
    // Distance is the first thing a person wants from an incident list, so it
    // leads the line when there is a location to measure from. Without one the
    // row says nothing about nearness rather than implying it is far away.
    const km = distanceKm(readUserLocation(), incident.location);
    const where = incident.place || incident.summary || '';
    place.textContent = Number.isFinite(km)
      ? `${formatDistance(km).toUpperCase()}${where ? ` · ${where}` : ''}`
      : where;
    text.append(title, place);

    const meta = doc.createElement('span');
    meta.className = 'incident-row-meta';
    const badge = doc.createElement('span');
    badge.className = 'incident-row-badge';
    badge.dataset.kind = incident.kind;
    badge.textContent = KIND_BADGE[incident.kind] || incident.source;
    const age = doc.createElement('span');
    age.className = 'incident-row-age';
    age.textContent = incidentAge(incident, now());
    meta.append(badge, age);

    button.append(dot, mark, text, meta);
    button.addEventListener('click', () =>
      select(incident.id, { focus: true }),
    );
    item.append(button);
    return item;
  }

  /** Repaint the list and everything that depends on the selection. */
  function present() {
    if (destroyed) return;
    const status = director?.getPlaybackStatus?.() || {};
    const running = Boolean(status.running);
    const paused = Boolean(status.paused);
    const current = selected();

    if (nodes.count) nodes.count.textContent = String(incidents.length);
    if (nodes.empty) nodes.empty.hidden = incidents.length > 0;

    if (nodes.list) {
      nodes.list.replaceChildren(...incidents.map(renderRow));
      for (const row of nodes.list.children)
        row.dataset.selected =
          row.dataset.incidentId === current?.id ? 'true' : 'false';
    }

    // Mode. The console is LIVE whenever authored playback is not running.
    const mode = running ? MODES.SCENARIO : MODES.LIVE;
    if (nodes.mode) {
      // "MONITORING" rather than "LIVE INTELLIGENCE": the chip is telling the
      // operator what Aegis is DOING, and the contrast that matters is against
      // SCENARIO, which is playback and is not watching anything.
      nodes.mode.textContent =
        mode === MODES.SCENARIO ? 'SCENARIO' : 'MONITORING';
      nodes.mode.dataset.mode = mode;
    }
    // The chip styles itself from this: authored playback has to be visibly
    // different from live monitoring, not merely differently worded.
    if (nodes.statusChip) {
      nodes.statusChip.dataset.mode = mode;
      nodes.statusChip.dataset.paused = paused ? 'true' : 'false';
    }
    root.dataset.running = running ? 'true' : 'false';
    root.dataset.mode = mode;

    // Detail for the selected incident.
    if (nodes.detailTitle)
      nodes.detailTitle.textContent = current ? current.title : 'NO INCIDENTS';
    if (nodes.detailMeta)
      nodes.detailMeta.textContent = current
        ? (current.live
            ? [
                current.place,
                current.source,
                `severity ${current.severity}/100`,
              ]
            : [
                current.source,
                current.detail?.shots ? `${current.detail.shots} shots` : null,
                'not live data',
              ]
          )
            .filter(Boolean)
            .join(' · ')
        : 'Feeds are reporting nothing above the surfacing threshold.';

    // Playback controls belong to an authored scenario and nothing else.
    const isScenario = current?.kind === INCIDENT_KINDS.SCENARIO;
    if (nodes.controls) nodes.controls.dataset.scenario = String(isScenario);
    if (nodes.run) {
      nodes.run.hidden = !isScenario;
      nodes.run.disabled = !isScenario || running;
      nodes.run.textContent = running ? 'RUNNING' : 'RUN SCENARIO';
    }
    if (nodes.pause) {
      nodes.pause.hidden = !isScenario;
      nodes.pause.disabled = !running;
      nodes.pause.textContent = paused ? 'RESUME' : 'PAUSE';
    }
    if (nodes.reset) {
      nodes.reset.hidden = !isScenario;
      nodes.reset.disabled = !isScenario;
    }
    if (nodes.exit) {
      nodes.exit.hidden = !isScenario;
      nodes.exit.disabled = !running;
    }
    if (nodes.focus) {
      nodes.focus.hidden = isScenario || !current?.location;
      nodes.focus.disabled = !current?.location;
    }

    const scenarioProgress =
      running && status.estimatedDurationMs
        ? Math.min(1, (status.elapsedMs || 0) / status.estimatedDurationMs)
        : 0;
    const scenarioPhase = running ? phaseAt(scenarioProgress) : null;

    // A live reconstruction drives the same phase line and the same progress
    // bar the authored scenario does, so an operator reads one control rather
    // than learning two.
    const replaying =
      reconstruction?.status === 'RUNNING' &&
      reconstruction.plan?.incidentId === current?.id;
    const progress = replaying
      ? (reconstruction.index + 1) / Math.max(1, reconstruction.total)
      : scenarioProgress;

    if (nodes.phase)
      nodes.phase.textContent = replaying
        ? `${reconstruction.phase.offsetLabel} · ${reconstruction.phase.label}`
        : scenarioPhase
          ? scenarioPhase.label
          : current?.live
            ? current.summary || ''
            : '';
    if (nodes.progress)
      nodes.progress.style.width = `${Math.round(progress * 100)}%`;
  }

  /**
   * Select an incident, optionally taking the operator to it.
   * @param {string} id Incident id.
   * @param {object} [options] Options.
   */
  function select(id, { focus = false } = {}) {
    // Selecting somewhere else ends whatever walkthrough was running, so its
    // overlays do not outlive the incident they described.
    if (selectedId !== id) onStopReconstruction?.();
    selectedId = id;
    const incident = registry.find(id);
    // Selecting is the same gesture for every incident, live or authored: the
    // camera goes there. Only what you can DO next differs.
    if (focus && incident) onFocus?.(incident);
    present();
  }

  // --- Scenario playback ---------------------------------------------------

  async function run() {
    const current = selected();
    if (current?.kind !== INCIDENT_KINDS.SCENARIO || !current.scenarioId)
      return;
    // `single` keeps the run to this one scene: an operator asking for an
    // incident does not want the rest of the project afterwards.
    await director?.startScene?.(current.scenarioId, { single: true });
    present();
  }

  function togglePause() {
    const status = director?.getPlaybackStatus?.() || {};
    if (!status.running) return;
    if (status.paused) director?.resumeScene?.();
    else director?.pauseScene?.();
    present();
  }

  async function reset() {
    director?.stopScene?.('Scenario reset');
    await run();
  }

  function exit() {
    director?.stopScene?.('Returned to live mode');
    present();
  }

  function focusSelected() {
    const current = selected();
    if (current) onFocus?.(current);
  }

  const handlers = [
    [nodes.run, 'click', () => void run()],
    [nodes.pause, 'click', togglePause],
    [nodes.reset, 'click', () => void reset()],
    [nodes.exit, 'click', exit],
    [nodes.focus, 'click', focusSelected],
  ];
  for (const [element, event, handler] of handlers)
    element?.addEventListener(event, handler);

  const unsubscribeBoard = registry.subscribe((next) => {
    incidents = next;
    // A selection that has left the board falls back to the top incident
    // rather than leaving the detail pane describing something gone.
    if (selectedId && !next.some((incident) => incident.id === selectedId))
      selectedId = null;
    present();
  });
  const unsubscribeDirector = director?.subscribe?.(() => present()) || null;
  const ticker = setInterval(() => present(), 1000);

  present();

  return Object.freeze({
    /**
     * Adopt the live reconstruction player's state.
     * @param {object|null} state Player state.
     */
    setReconstruction(state) {
      reconstruction = state;
      present();
    },
    select,
    run,
    togglePause,
    reset,
    exit,
    present,
    /** @returns {object|null} The selected incident. */
    selected,
    /** @returns {string} The mode the console is in. */
    mode() {
      return director?.getPlaybackStatus?.()?.running
        ? MODES.SCENARIO
        : MODES.LIVE;
    },
    destroy() {
      destroyed = true;
      clearInterval(ticker);
      unsubscribeBoard?.();
      unsubscribeDirector?.();
      for (const [element, event, handler] of handlers)
        element?.removeEventListener(event, handler);
    },
  });
}
