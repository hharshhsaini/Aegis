import * as Cesium from 'cesium';
import {
  LOCAL_RADIUS_KM,
  NEARBY_RADIUS_KM,
  PROVENANCE,
  PROXIMITY,
  REGIONAL_RADIUS_KM,
  classifyRelevance,
  compareRelevance,
  distanceKm,
  formatDistance,
  isGloballySignificant,
  partitionByScope,
} from '../alerts/relevance.js';
import { createAnnouncer } from '../alerts/announcer.js';
import { createSpeaker } from '../alerts/speech.js';
import { composeSituationBriefing } from '../alerts/briefing.js';
import { buildEventBriefing } from '../alerts/eventBriefing.js';
import { createVoiceQueue, VOICE_STATES } from '../alerts/voiceQueue.js';
import {
  createLiveFeed,
  kindForAnnouncement,
  MESSAGE_KINDS,
} from '../ui/liveFeed.js';
import { renderMetrics } from '../ui/metricGrid.js';
import { bindCommandPanel } from '../ui/commandPanel.js';
import { CONSENT } from './deviceLocation.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

/**
 * Local Intelligence: the console pointed at one person.
 *
 * This is what turns a disaster map into a disaster console. It owns the
 * MONITORED location — which is the device location by default and can be
 * pointed somewhere else deliberately — scores every incident against it, and
 * decides what is worth saying out loud.
 *
 * The distinction it exists to protect: panning the globe to Kathmandu changes
 * what you are LOOKING at, not what you are being warned about. Regional
 * Intelligence follows the camera; this follows the person. Redirecting alerts
 * takes an explicit "monitor this area".
 *
 * Speech goes through the browser's own synthesiser rather than the Realtime
 * voice assistant. That is deliberate: alerts must work with no API key
 * configured, the text is deterministic template output that needs no model,
 * and the conversational assistant stays exactly as it was.
 */

/** What the console is monitoring. */
export const MONITORING = Object.freeze({
  DEVICE: 'DEVICE',
  VIEWED: 'VIEWED',
});

/** Where the voice preferences live. No credentials, no coordinates. */
const VOICE_PREFS_KEY = 'aegis.voice.alerts.v1';

/** Render-hold owner for the fly-to-user flight. */
const FLIGHT_HOLD = 'device-location-flight';

/** How long the voice alert card stays up. */
const CARD_MS = 12_000;

/** Read stored voice preferences. */
function readPrefs(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(VOICE_PREFS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      enabled: parsed?.enabled !== false,
      threshold: parsed?.threshold || 'IMPORTANT',
    };
  } catch {
    return { enabled: true, threshold: 'IMPORTANT' };
  }
}

/** Persist voice preferences. */
function writePrefs(prefs, storage = globalThis.localStorage) {
  try {
    storage?.setItem(VOICE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Preferences that cannot persist still apply for this session.
  }
}

/**
 * Which provenance an incident's data carries.
 *
 * Read from the record rather than guessed: an official provider marks its own
 * incidents, the weather engine's hazards are model output, and everything
 * else is an observation a feed reported.
 *
 * @param {object} incident Incident record.
 * @returns {string} A {@link PROVENANCE} value.
 */
export function provenanceOf(incident) {
  // The record's own declaration comes first: the feed that built it knows
  // what kind of statement it is. `detail.provenance` is the older per-record
  // override and still wins over an inference, and the kind-based fallback
  // survives only for records built before either existed.
  if (incident?.detail?.provenance) return incident.detail.provenance;
  if (incident?.sourceType) return incident.sourceType;
  if (incident?.kind === 'WEATHER') return PROVENANCE.MODEL;
  return PROVENANCE.OBSERVED;
}

/**
 * Start Local Intelligence.
 *
 * @param {object} input Input.
 * @returns {object} Frozen controller.
 */
export function startLocalIntelligence({
  viewer,
  deviceLocation,
  incidents,
  locationContext,
  officialAlerts,
  fetchBrief,
  eventFocus,
  document: doc = globalThis.document,
  speak = createSpeaker(),
  onSelectIncident,
  now = () => Date.now(),
}) {
  const root = doc?.getElementById?.('local-panel');
  const consent = doc?.getElementById?.('location-consent');
  let prefs = readPrefs();
  let monitoring = MONITORING.DEVICE;
  let viewedLocation = null;
  let feedSeeded = false;
  let destroyed = false;
  let cardTimer = null;
  // Said once, the first time there is a named place to say it about.
  let monitoringAnnounced = false;
  let marker = null;

  const nodes = {
    place: doc?.getElementById?.('local-place'),
    detail: doc?.getElementById?.('local-place-detail'),
    monitoringLine: doc?.getElementById?.('local-monitoring'),
    notEnabled: doc?.getElementById?.('local-not-enabled'),
    counts: doc?.getElementById?.('local-counts'),
    officialStatus: doc?.getElementById?.('official-alerts-status'),
    voiceToggle: doc?.getElementById?.('voice-alerts-toggle'),
    voiceLevel: doc?.getElementById?.('voice-alert-level'),
    monitorBtn: doc?.getElementById?.('monitor-area-btn'),
    card: doc?.getElementById?.('voice-alert-card'),
    cardLevel: doc?.getElementById?.('voice-alert-card-level'),
    cardTitle: doc?.getElementById?.('voice-alert-title'),
    cardDistance: doc?.getElementById?.('voice-alert-distance'),
    cardMeta: doc?.getElementById?.('voice-alert-meta'),
  };

  const header = root ? bindCommandPanel({ panel: root, document: doc }) : null;

  /** Show the compact alert card. */
  function showCard(announcement) {
    if (!nodes.card) return;
    nodes.card.hidden = false;
    nodes.card.dataset.level = announcement.level;
    if (nodes.cardLevel) nodes.cardLevel.textContent = announcement.level;
    if (nodes.cardTitle) nodes.cardTitle.textContent = announcement.title;
    if (nodes.cardDistance)
      nodes.cardDistance.textContent = announcement.distanceLabel
        ? `${announcement.distanceLabel.toUpperCase()} FROM YOUR LOCATION`
        : '';
    if (nodes.cardMeta)
      nodes.cardMeta.textContent = `${announcement.source} · just now`;
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => {
      if (nodes.card) nodes.card.hidden = true;
    }, CARD_MS);
  }

  // One mouth for the whole console, so two events arriving together are read
  // in turn instead of cancelling each other.
  const voice = createVoiceQueue({
    speaker: (text, options) => speak(text, options),
    muted: !prefs.enabled,
  });

  const feed = createLiveFeed({
    document: doc,
    onSelect: (incidentId) => onSelectIncident?.(incidents.find(incidentId)),
    now,
  });

  // The feed and the voice are two renderings of ONE decision. The announcer
  // has already applied dedup, cooldown, grouping and the user's threshold, so
  // whatever reaches here is worth both a line and a sentence — and the
  // message id is what lets the transcript highlight exactly what is being
  // read aloud.
  function onAnnounce(announcement) {
    showCard(announcement);
    const message = feed?.push({
      kind: kindForAnnouncement(announcement),
      message: announcement.text,
      incidentId: announcement.incidentId,
      level: announcement.level,
      actionLabel:
        announcement.provenance === 'MODEL' ||
        announcement.provenance === 'FORECAST'
          ? 'VIEW ANALYSIS'
          : 'VIEW INCIDENT',
    });
    voice.enqueue({
      text: announcement.text,
      id: message?.id,
      level: announcement.level,
    });
  }

  const announcer = createAnnouncer({
    // Speech is the queue's job now. The announcer decides WHAT is worth
    // saying; handing it a direct line to the synthesiser as well would let it
    // talk over itself.
    speak: undefined,
    onAnnounce,
    now,
    readThreshold: () => prefs.threshold,
    // The feed is never gated on the audio setting: muting silences the voice,
    // it does not stop the console watching or reporting.
    readEnabled: () => true,
  });

  /**
   * Brief the operator on the event they just focused.
   *
   * This is the other half of the dropped-click fix. The focus bus decides
   * WHETHER an inspection deserves an answer — a click always does, a camera
   * drifting past does not — and this composes the answer and sends it through
   * the same queue and the same transcript as every other announcement. It is
   * not a second voice path; it is a second reason to use the one that exists.
   */
  function briefFocusedEvent(focus) {
    if (destroyed || !focus?.speak) return null;
    const event = focus.event;
    const where = event?.location || {
      latitude: event?.latitude,
      longitude: event?.longitude,
    };
    // Measured against the DEVICE, so an Alaskan earthquake inspected from
    // Bengaluru is described as something being viewed rather than as
    // something near the operator.
    const deviceDistance = distanceKm(deviceLocation.get().location, where);
    const text = buildEventBriefing(event, {
      deviceDistanceKm: deviceDistance,
      viewedPlaceName: viewedLocation?.locationName || null,
      now: now(),
    });
    if (!text) return null;

    const message = feed?.push({
      kind: MESSAGE_KINDS.UPDATE,
      message: text,
      incidentId: focus.eventId,
      actionLabel: 'VIEW INCIDENT',
      level: 'NOTICE',
    });
    // A briefing the operator asked for is informational. Looking at something
    // is not an emergency, however large it is, so this never escalates.
    voice.enqueue({ text, id: message?.id, level: 'NOTICE' });
    return message;
  }

  const unsubscribeFocus = eventFocus?.subscribe?.(briefFocusedEvent) || null;

  // Voice state drives the header chip and the speaking highlight.
  const unsubscribeVoice = voice.subscribe((state) => {
    feed?.setState(state.state);
    feed?.setSpeaking(
      state.state === VOICE_STATES.SPEAKING ? state.speakingId : null,
    );
  });

  /** The location alerts are scored against. */
  function monitoredLocation() {
    if (monitoring === MONITORING.VIEWED) return viewedLocation;
    const device = deviceLocation.get();
    return device.location;
  }

  /** The place name for the monitored location. */
  function monitoredPlace() {
    if (monitoring === MONITORING.VIEWED) return viewedLocation;
    const device = deviceLocation.get();
    return {
      locationName: device.locationName,
      region: device.region,
      country: device.country,
    };
  }

  /** Score every incident on the board against the monitored location. */
  function scoreAll() {
    const origin = monitoredLocation();
    return incidents
      .list()
      .filter((incident) => incident.live)
      .map((incident) => ({
        incident,
        relevance: classifyRelevance({
          incident,
          userLocation: origin,
          provenance: provenanceOf(incident),
          now: now(),
        }),
      }))
      .sort((a, b) => compareRelevance(a.relevance, b.relevance));
  }

  /** Repaint the panel. */
  function present() {
    if (destroyed || !root) return;
    const device = deviceLocation.get();
    // "Enabled" means there is somewhere to measure from, whichever mode is
    // active — monitoring an area by hand works without a device fix.
    const origin = monitoredLocation();
    const enabled = Boolean(origin);
    const deviceReady = device.consent === CONSENT.GRANTED && device.location;
    const place = monitoredPlace();
    const scored = scoreAll();

    if (nodes.place)
      nodes.place.textContent = enabled
        ? place?.locationName || 'LOCATING…'
        : 'LOCATION NOT ENABLED';
    if (nodes.detail)
      nodes.detail.textContent = enabled
        ? [place?.region, place?.country].filter(Boolean).join(', ')
        : 'Aegis is running in global mode.';
    if (nodes.monitoringLine)
      nodes.monitoringLine.textContent = enabled
        ? monitoring === MONITORING.DEVICE
          ? 'MONITORING · DEVICE LOCATION'
          : 'MONITORING · VIEWED LOCATION'
        : '';
    // The enable prompt belongs to the DEVICE fix, not to monitoring in
    // general: someone monitoring an area by hand should still be offered it.
    if (nodes.notEnabled) nodes.notEnabled.hidden = Boolean(deviceReady);

    if (nodes.monitorBtn) {
      const canRedirect = Boolean(viewedLocation?.latitude != null);
      nodes.monitorBtn.hidden = !canRedirect;
      nodes.monitorBtn.textContent =
        monitoring === MONITORING.VIEWED
          ? 'MONITOR MY LOCATION'
          : 'MONITOR THIS AREA';
      // Redirecting alerts is never implicit, so the control says which
      // location it is about to point the alert layer at.
      nodes.monitorBtn.title =
        monitoring === MONITORING.VIEWED
          ? 'Return alerting to your device location'
          : `Alert me about ${viewedLocation?.locationName || 'the viewed area'} instead`;
      nodes.monitorBtn.disabled =
        monitoring === MONITORING.VIEWED && !deviceReady;
    }

    const bands = { LOCAL: 0, NEARBY: 0, REGIONAL: 0, GLOBAL: 0 };
    let critical = 0;
    for (const entry of scored) {
      bands[entry.relevance.proximity] += 1;
      if (
        entry.relevance.level === 'URGENT' ||
        entry.relevance.level === 'WARNING'
      )
        critical += 1;
    }

    // The labels carry the radii they are actually counting, so a reader can
    // tell at a glance what "nearby" means here rather than having to assume.
    const sets = partitionByScope(scored);
    renderMetrics(doc, nodes.counts, [
      [`WITHIN ${LOCAL_RADIUS_KM} KM`, enabled ? sets.local.length : null],
      [`NEARBY · ${NEARBY_RADIUS_KM} KM`, enabled ? sets.nearby.length : null],
      [
        `REGIONAL · ${REGIONAL_RADIUS_KM} KM`,
        enabled ? sets.regional.length : null,
      ],
      // Distant events are counted, but only the genuinely major ones: a
      // global tally that included every small tremor on the planet would be
      // a number nobody could act on.
      [
        'GLOBAL SIGNIFICANT',
        enabled ? sets.global.filter(isGloballySignificant).length : null,
      ],
      ['NEEDS ATTENTION', enabled ? critical : null],
    ]);

    header?.setSummary(
      enabled
        ? `${place?.locationName || 'MONITORING'} · ${bands.LOCAL} LOCAL · ${critical} FLAGGED`
        : 'LOCATION NOT ENABLED',
    );
    header?.setStatus({
      label: enabled ? 'MONITORING' : 'GLOBAL',
      tone: enabled ? 'ok' : 'idle',
      // Stated precisely: a web page cannot watch anything once it is closed,
      // and implying otherwise would be the most consequential lie the
      // console could tell.
      message: enabled
        ? 'Monitoring live feeds while Aegis is open in this tab.'
        : 'Running in global mode without a monitored location.',
    });

    if (nodes.officialStatus && officialAlerts) {
      const status = officialAlerts.status();
      nodes.officialStatus.textContent = `OFFICIAL ALERTS · ${status.label}`;
      nodes.officialStatus.dataset.tone = status.configured ? 'ok' : 'idle';
    }

    if (nodes.voiceToggle) {
      const label = doc?.getElementById?.('voice-alerts-label');
      if (label) label.textContent = prefs.enabled ? 'VOICE ON' : 'VOICE MUTED';
      nodes.voiceToggle.setAttribute('aria-pressed', String(prefs.enabled));
      nodes.voiceToggle.dataset.muted = prefs.enabled ? 'false' : 'true';
    }
    if (nodes.voiceLevel) nodes.voiceLevel.value = prefs.threshold;

    renderMarker();
    seedFeed();
    // Once a place has a name, the console says so. Deliberately after the
    // paint: the panel and the globe marker are already showing the location
    // the sentence is about.
    announceMonitoringStarted();
  }

  /**
   * Say, once, that monitoring has begun.
   *
   * An autonomous watcher that starts in total silence is indistinguishable
   * from one that is broken. This is the handshake: it names the place so the
   * user can tell immediately whether Aegis resolved the right one, and it
   * promises only what the relevance layer actually delivers — significant
   * developments, not everything.
   */
  function announceMonitoringStarted() {
    if (monitoringAnnounced || destroyed) return;
    const place = monitoredPlace()?.locationName;
    if (!place) return;
    monitoringAnnounced = true;
    if (!prefs.enabled) return;
    speak(
      `Monitoring ${place}. I'll keep watching for significant disaster developments.`,
    );
  }

  /** Offer every current incident to the announcer. */
  function evaluateAnnouncements() {
    if (destroyed) return;
    // Nothing is announced without a location to be near: a distance the
    // system cannot compute must never become an interruption.
    if (!monitoredLocation()) return;
    // The whole refresh at once, so an aftershock sequence or a spreading fire
    // is heard as one development rather than as a queue of separate ones.
    announcer.considerAll(scoreAll());
  }

  /**
   * Mark the monitored location on the globe.
   *
   * Deliberately quiet: a small ring and a label, not a pin that competes with
   * the incidents. It is drawn at the coarse position, so it marks a
   * neighbourhood rather than a doorstep.
   */
  function renderMarker() {
    const device = deviceLocation.get();
    if (!viewer?.entities) return;
    if (!device.location) {
      if (marker) {
        viewer.entities.remove(marker);
        marker = null;
      }
      return;
    }
    const position = Cesium.Cartesian3.fromDegrees(
      device.location.longitude,
      device.location.latitude,
    );
    if (marker) {
      marker.position = position;
      return;
    }
    marker = viewer.entities.add({
      id: 'aegis-you-are-here',
      position,
      point: {
        pixelSize: 9,
        color: Cesium.Color.fromCssColorString('#4da3ff'),
        outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: 'YOU ARE HERE',
        font: '600 11px "JetBrains Mono", monospace',
        fillColor: Cesium.Color.WHITE.withAlpha(0.9),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        // Hidden when zoomed out: at globe scale the label would sit over half
        // a continent and say nothing useful.
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          2_500_000,
        ),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  /** Fly the globe to the monitored location at a framing its accuracy supports. */
  async function flyToDevice() {
    const device = deviceLocation.get();
    if (!device.location || !viewer?.camera) return false;
    holdContinuousRender(FLIGHT_HOLD);
    const release = () => releaseContinuousRender(FLIGHT_HOLD);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        device.location.longitude,
        device.location.latitude,
        // Never street level: the framing comes from the accuracy band, and
        // the closest band is still city scale.
        device.framing?.altitude ?? 220_000,
      ),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-80),
        roll: 0,
      },
      duration: 3.2,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: release,
      cancel: release,
    });
    setTimeout(release, 6000);
    return true;
  }

  /** Resolve a place name for the device location, from the coarse position. */
  async function resolveDevicePlace() {
    const device = deviceLocation.get();
    if (!device.location || !fetchBrief) return;
    try {
      // The coarse position is what goes to the geocoder — never the exact fix.
      const brief = await fetchBrief(
        device.location.latitude,
        device.location.longitude,
      );
      const place = brief?.place;
      if (!place) return;
      deviceLocation.setPlace({
        locationName: place.locality || place.region || place.country || null,
        region: place.region || null,
        country: place.country || null,
      });
    } catch {
      // A name is a nicety; the coordinates already drive the prioritisation.
    }
  }

  // --- Consent flow --------------------------------------------------------

  async function enableLocation() {
    if (consent) consent.hidden = true;
    const state = await deviceLocation.request();
    if (state.consent === CONSENT.GRANTED) {
      await flyToDevice();
      void resolveDevicePlace();
    }
    present();
  }

  function declineLocation() {
    if (consent) consent.hidden = true;
    deviceLocation.decline();
    present();
  }

  // --- The transcript -----------------------------------------------------

  /**
   * Open the transcript with a statement of what is being watched.
   *
   * Said once, when there is a monitored location to say it about. It reuses
   * the situation briefing rather than composing a second opinion, so the
   * first line of the feed agrees with everything that follows it. Deliberately
   * NOT spoken: the introduction has already greeted the user, and a console
   * that talks the moment it has a fix is a console people mute.
   */
  function seedFeed() {
    if (feedSeeded || !feed || !monitoredLocation()) return;
    feedSeeded = true;
    const briefing = composeSituationBriefing({
      location: monitoredPlace(),
      scored: scoreAll(),
      officialAlerts: officialAlerts?.status(),
    });
    announcer.markBriefed();
    feed.push({
      kind: MESSAGE_KINDS.MONITORING,
      message: briefing.text,
    });
  }

  /**
   * Point monitoring at the viewed location, or back at the device.
   * @param {string} mode A {@link MONITORING} value.
   */
  function setMonitoring(mode) {
    if (mode !== MONITORING.DEVICE && mode !== MONITORING.VIEWED) return;
    if (mode === MONITORING.VIEWED && !viewedLocation?.latitude) return;
    monitoring = mode;
    // The board is scored against somewhere else now, so what has already
    // been said about the old location should not suppress the new one.
    announcer.reset();

    // The transcript records it too. Changing what is being watched is the
    // most consequential state change a user can make here, and a feed that
    // silently kept reading "Monitoring Bengaluru" while scoring Kathmandu
    // would be the most misleading thing on the screen.
    const place = monitoredPlace()?.locationName;
    feed?.push({
      kind: MESSAGE_KINDS.MONITORING,
      message: place
        ? `Now monitoring ${place}${
            mode === MONITORING.DEVICE ? ' — your device location.' : '.'
          }`
        : 'Monitored location changed.',
    });

    present();
    evaluateAnnouncements();
  }

  // --- Listeners -----------------------------------------------------------

  const handlers = [
    [
      doc?.getElementById?.('location-consent-enable'),
      'click',
      () => void enableLocation(),
    ],
    [
      doc?.getElementById?.('location-consent-decline'),
      'click',
      declineLocation,
    ],
    [
      doc?.getElementById?.('local-enable-btn'),
      'click',
      () => void enableLocation(),
    ],
    [
      nodes.monitorBtn,
      'click',
      () =>
        setMonitoring(
          monitoring === MONITORING.VIEWED
            ? MONITORING.DEVICE
            : MONITORING.VIEWED,
        ),
    ],
    [
      nodes.voiceToggle,
      'click',
      () => {
        prefs = { ...prefs, enabled: !prefs.enabled };
        writePrefs(prefs);
        // Silences speech and drops the backlog. Monitoring, scoring and the
        // transcript carry on exactly as before, and unmuting does not replay
        // what was missed.
        voice.setMuted(!prefs.enabled);
        present();
      },
    ],
    [
      nodes.voiceLevel,
      'change',
      (event) => {
        prefs = { ...prefs, threshold: event.target.value };
        writePrefs(prefs);
        present();
      },
    ],
  ];
  for (const [element, event, handler] of handlers)
    element?.addEventListener(event, handler);

  // The consent card is shown once, and only when nothing has been decided.
  if (consent) consent.hidden = !deviceLocation.shouldAsk();

  const unsubscribeDevice = deviceLocation.subscribe(() => present());
  const unsubscribeIncidents = incidents.subscribe(() => {
    present();
    evaluateAnnouncements();
  });
  const unsubscribeViewed =
    locationContext?.subscribe?.((state) => {
      viewedLocation = state;
      if (monitoring === MONITORING.VIEWED) present();
    }) || null;

  present();

  return Object.freeze({
    present,
    flyToDevice,
    enableLocation,
    /** @returns {object[]} Incidents scored against the monitored location. */
    scored: scoreAll,
    /** @returns {string} What is being monitored. */
    monitoring: () => monitoring,
    setMonitoring,
    announcer,
    /**
     * What the status strip shows: where alerting is pointed, how much is near
     * it, and whether the voice layer is on.
     * @returns {object} Frozen summary.
     */
    summary() {
      const origin = monitoredLocation();
      if (!origin)
        return Object.freeze({
          place: null,
          nearby: null,
          voice: prefs.enabled,
        });
      const nearby = scoreAll().filter(
        (entry) =>
          entry.relevance.proximity === PROXIMITY.LOCAL ||
          entry.relevance.proximity === PROXIMITY.NEARBY,
      ).length;
      return Object.freeze({
        place: monitoredPlace()?.locationName || 'MONITORING',
        nearby,
        voice: prefs.enabled,
      });
    },
    destroy() {
      destroyed = true;
      clearTimeout(cardTimer);
      if (marker) viewer?.entities?.remove(marker);
      unsubscribeDevice?.();
      unsubscribeIncidents?.();
      unsubscribeViewed?.();
      unsubscribeVoice?.();
      unsubscribeFocus?.();
      voice.destroy();
      feed?.destroy();
      header?.destroy();
      for (const [element, event, handler] of handlers)
        element?.removeEventListener(event, handler);
    },
  });
}
