import { SceneDirector } from '../scenes/director.js';
import { createIncidentsBar } from '../ui/incidentsBar.js';
import { createIncidentRegistry } from '../incidents/registry.js';
import {
  earthquakeIncidents,
  fireIncidents,
  scenarioIncidents,
  weatherIncidents,
} from '../incidents/sources.js';
import { focusIncident } from './incidentFocus.js';
import { createIncidentReconstruction } from './incidentReconstruction.js';
import { createLocationContext } from './locationContext.js';
import { createDeviceLocation } from './deviceLocation.js';
import { startLocalIntelligence } from './localIntelligence.js';
import { createOfficialAlerts } from '../alerts/officialAlerts.js';
import { createEventFocus, FOCUS_SOURCES } from '../alerts/eventFocus.js';
import { REGIONAL_RADIUS_KM } from '../alerts/relevance.js';
import { createRegionalPanel } from '../ui/regionalPanel.js';
import { createStatusStrip } from '../ui/statusStrip.js';
import { initAnnotations } from '../annotations/index.js';
import { initDrawTool } from '../annotations/drawTool.js';
import { initGevVoiceCommands } from '../voice/gevRealtime.js';
import { installScopeMask, destroyScopeMask } from '../scopeMask.js';
import { startWeatherIntelligence } from './weatherIntelligence.js';
import { startFireIntelligence } from './fireIntelligence.js';
import { startEarthquakeIntelligence } from './earthquakeIntelligence.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

/** Attach scene tools, rendering listeners and the application debug handle. */
export function createApplicationTools({
  scene,
  controls,
  data,
  loadingScreen,
  placeSearch,
  voice = {},
  startChrome,
  onSceneDirector,
  sceneDataPacks,
  signal,
  defer,
}) {
  const { viewer, tileset, mapStackController, operations } = scene;
  const { styleManager, weatherEffects, cockpitCloudEffects } = controls;
  const { dataManager } = data;
  const sceneDirector = new SceneDirector(viewer, styleManager, dataManager, {
    dataPacks: sceneDataPacks,
    isMapStackAvailable: (id) =>
      mapStackController?.isStackAvailable(id) === true,
  });
  dataManager.layers
    .get('bhote-koshi-2026')
    ?.module.attachSceneController(sceneDirector);
  defer(() => sceneDirector.destroy());
  onSceneDirector?.(sceneDirector);
  const annotations = initAnnotations({
    viewer,
    tileset,
    placeSearch,
    resolver: operations.annotationResolver,
  });
  defer(() => {
    if (window.__gevAnnotations === annotations) delete window.__gevAnnotations;
    annotations.destroy();
  });
  // DISPLAY ▸ Draw: the same whiteboard, drawn by hand. It claims the pointer
  // while a session is open, so its teardown belongs to the application
  // lifetime rather than to whoever last pressed the button.
  const drawTool = initDrawTool({ viewer, annotations });
  defer(() => drawTool?.destroy());
  if (startChrome)
    defer(startChrome({ loadingScreen, styleManager, dataManager, signal }));
  // Idle render governor: flips the scene into requestRenderMode whenever
  // nothing animates per frame. Installed AFTER every module above has had
  // its chance to register pre-install holds. (perf wave 2)
  installRenderGovernor(viewer);

  // Install the explicit scope mask used by the DISPLAY controls.
  installScopeMask(viewer);
  defer(() => destroyScopeMask());

  // One shared answer to "where is the operator looking". Every surface that
  // needs a location subscribes to this rather than asking a geocoder itself,
  // which is what let the status strip, the panels and the search box disagree
  // and leave a stale name on screen after the camera had moved on.
  const locationContext = createLocationContext({
    viewer,
    fetchBrief: (latitude, longitude) =>
      operations.requests.regional.getBrief(latitude, longitude),
  });
  defer(() => locationContext.destroy());

  // Aegis weather intelligence: analyzes the selected location and drives the
  // intelligence panel and the risk overlay. It owns its own polling, so its
  // teardown belongs to the application lifetime.
  const weatherIntelligence = startWeatherIntelligence({
    viewer,
    requests: operations.requests,
  });
  defer(() => weatherIntelligence.destroy());

  const regionalPanel = createRegionalPanel();
  let lastAnalyzedBucket = null;
  const removeLocationSubscription = locationContext.subscribe((state) => {
    regionalPanel?.setLocation(state);
    // Regional Intelligence describes the place being viewed, so the risk
    // engine is asked about that place rather than about wherever the operator
    // last clicked. Keyed on the settled coordinates so a camera that has not
    // really moved does not re-analyze; the weather service caches on top of
    // that, so panning within a region costs nothing.
    if (!Number.isFinite(state.latitude) || !Number.isFinite(state.longitude))
      return;
    const bucket = `${state.latitude.toFixed(2)},${state.longitude.toFixed(2)}`;
    if (bucket === lastAnalyzedBucket) return;
    lastAnalyzedBucket = bucket;
    void weatherIntelligence
      ?.analyzeAt?.(state.latitude, state.longitude)
      .then((record) => regionalPanel?.setAnalysis(record?.analysis || null))
      .catch(() => {
        // The panel already shows the feed state; a failed analysis leaves the
        // hazard rows unscored rather than showing a confident zero.
      });
  });
  defer(() => removeLocationSubscription());
  const regionalTicker = setInterval(() => regionalPanel?.tick(), 15_000);
  defer(() => clearInterval(regionalTicker));

  // Aegis fire intelligence: NASA FIRMS detections for the viewed area,
  // correlated with weather at each cluster.
  // One signal for "the operator is inspecting this". Every path that can
  // mean it — a marker click, a panel row, a feed message — ends here, so the
  // voice and the transcript react to a focus rather than each layer growing
  // its own click handling.
  const eventFocus = createEventFocus();
  defer(() => eventFocus.destroy());

  const fireIntelligence = startFireIntelligence({
    viewer,
    requests: operations.requests,
    setPanelCollapsed: (...args) => styleManager.setPanelCollapsed?.(...args),
    onFocusEvent: (cluster) =>
      eventFocus.focus(
        { ...cluster, kind: 'FIRE' },
        FOCUS_SOURCES.MARKER_CLICK,
      ),
  });
  defer(() => fireIntelligence.destroy());

  // Aegis earthquake intelligence: recent USGS observations, organized into
  // sequences, activity and alert levels for the viewed area.
  const earthquakeIntelligence = startEarthquakeIntelligence({
    viewer,
    requests: operations.requests,
    setPanelCollapsed: (...args) => styleManager.setPanelCollapsed?.(...args),
    onFocusEvent: (event) =>
      eventFocus.focus(
        { ...event, kind: 'EARTHQUAKE' },
        FOCUS_SOURCES.MARKER_CLICK,
      ),
    // Seismicity belongs in the same risk column as the weather hazards, and
    // it is handed across from the one USGS observation rather than fetched a
    // second time.
    onSeismicModule: (module) => {
      weatherIntelligence.panel?.setSeismicModule?.(module);
      regionalPanel?.setSeismic(module);
    },
  });
  defer(() => earthquakeIntelligence.destroy());

  // The incidents board. Every feed that already polls contributes what it has
  // observed; the board merges, orders and shows them. It opens no requests of
  // its own, so an incident can never be newer than the panel behind it.
  const incidents = createIncidentRegistry();

  /**
   * Earthquakes near the MONITORED location, as opposed to on screen.
   *
   * The area feeds are scoped to the camera, which is the right question for
   * drawing the globe and the wrong one for deciding what is near a person:
   * with the camera over Africa and the user in Bengaluru, every event the
   * console knew about was thousands of kilometres away, and the local panel
   * listed them as nearest because they were all there was.
   *
   * This asks the other question. It reads the same server-cached USGS feed,
   * so a second question costs no second upstream fetch, and the registry
   * deduplicates by event id where the two overlap.
   */
  let localQuakeIncidents = [];
  async function refreshLocalQuakes() {
    const origin = deviceLocation.get().location;
    if (!origin) {
      localQuakeIncidents = [];
      return;
    }
    try {
      const record = await operations.requests.earthquakes.observe({
        around: {
          latitude: origin.latitude,
          longitude: origin.longitude,
          // Out to the regional edge, so the board holds everything the
          // relevance engine can still classify as nearer than global.
          radiusKm: REGIONAL_RADIUS_KM,
        },
      });
      localQuakeIncidents = earthquakeIncidents(record?.intelligence);
    } catch {
      // A failed location query leaves the viewport contribution standing
      // rather than emptying the board.
    }
  }

  /** Republish every contributor from the state the controllers already hold. */
  const refreshIncidents = () => {
    incidents.publish(
      'earthquakes',
      earthquakeIncidents(earthquakeIntelligence.getLatest?.()?.intelligence),
    );
    incidents.publish('earthquakes-local', localQuakeIncidents);
    incidents.publish(
      'fires',
      fireIncidents(fireIntelligence.getLatest?.()?.intelligence),
    );
    const active = weatherIntelligence.getActive?.();
    incidents.publish(
      'weather',
      weatherIncidents(active?.analysis, active?.point || active),
    );
    // Authored scenarios come from the director's own project, so renaming or
    // adding one in the scene editor reaches this list without a code change.
    regionalPanel?.setIncidentCount(incidents.list().length);
    incidents.publish(
      'scenarios',
      scenarioIncidents(
        (sceneDirector.listScenes?.() || []).filter((scene) =>
          /nepal|bhote koshi|incident/i.test(scene.title),
        ),
      ),
    );
  };

  // Live incidents get a generated reconstruction built from the primitives
  // the Nepal sequence established. Nepal keeps its own authored 25-shot
  // playback and never routes through here.
  const reconstruction = createIncidentReconstruction({
    viewer,
    onPhase: (state) => incidentsBar?.setReconstruction(state),
  });
  defer(() => reconstruction.destroy());

  // The user's own location, held coarse and kept separate from wherever the
  // camera happens to be pointing.
  const deviceLocation = createDeviceLocation();
  defer(() => deviceLocation.destroy());

  /**
   * Open an incident: its panel, and the reconstruction when it has one.
   *
   * Shared by the incidents bar and the Aegis Live transcript so that clicking
   * a row and clicking the message the voice just read reach exactly the same
   * place. They are the same incident; they must not be two code paths that
   * could drift into behaving differently.
   *
   * @param {object|null} incident The incident.
   */
  function openIncident(incident, source = FOCUS_SOURCES.PANEL_CLICK) {
    if (!incident) return;
    // Opening an incident from a list is the same question as clicking its
    // marker, so it reaches the voice through the same bus.
    eventFocus.focus(incident, source);
    // The panel opens immediately; the camera work belongs to whichever of
    // the two paths applies.
    focusIncident({
      incident,
      viewer,
      setPanelCollapsed: (...args) => styleManager.setPanelCollapsed?.(...args),
      analyzeAt: (latitude, longitude) =>
        weatherIntelligence.analyzeAt?.(latitude, longitude),
      flyCamera: false,
    });
    void reconstruction.play(incident);
  }

  const incidentsBar = createIncidentsBar({
    registry: incidents,
    director: sceneDirector,
    onFocus: openIncident,
    onStopReconstruction: () => reconstruction.stop('operator'),
    // Rows lead with distance once there is a monitored location. The registry
    // is read live so the bar and the local panel can never disagree about how
    // far away something is.
    readUserLocation: () => deviceLocation.get().location,
  });
  defer(() => incidentsBar?.destroy());

  // Official warning feeds. No provider is registered: an authority's name may
  // only be attached to data that authority actually served, so the service
  // reports NOT CONFIGURED and the briefings say so rather than letting an
  // operator assume warnings are being watched.
  const officialAlerts = createOfficialAlerts();

  // Local Intelligence: scores the whole board against the monitored location
  // and decides what is worth interrupting somebody about. Reads the registry
  // and the location contexts; opens no feeds of its own.
  const localIntelligence = startLocalIntelligence({
    viewer,
    deviceLocation,
    incidents,
    locationContext,
    officialAlerts,
    fetchBrief: (latitude, longitude) =>
      operations.requests.regional.getBrief(latitude, longitude),
    onSelectIncident: openIncident,
    eventFocus,
  });
  defer(() => localIntelligence.destroy());

  // The feeds refresh on their own cadences, so the board is rebuilt on a slow
  // tick from whatever they hold. The registry only notifies on real change,
  // so an unchanged board costs one comparison rather than a repaint.
  const incidentTimer = setInterval(refreshIncidents, 5_000);
  defer(() => clearInterval(incidentTimer));

  // The location-scoped query follows the device fix rather than the clock:
  // it only has a question to ask once there is a location to ask about, and
  // it re-asks when that location changes.
  const releaseDeviceQuakes = deviceLocation.subscribe(() => {
    void refreshLocalQuakes().then(refreshIncidents);
  });
  defer(() => releaseDeviceQuakes?.());
  const localQuakeTimer = setInterval(() => {
    void refreshLocalQuakes().then(refreshIncidents);
  }, 120_000);
  defer(() => clearInterval(localQuakeTimer));

  refreshIncidents();

  // The system status strip aggregates the feeds that are already polling. It
  // opens no requests of its own — it only reads what the controllers hold, so
  // a green SYSTEM can never be greener than the panels below it.
  const statusStrip = createStatusStrip({
    readFeeds: () => ({
      'Open-Meteo': weatherIntelligence.panel?.feedState?.(),
      'NASA FIRMS': fireIntelligence.panel?.feedState?.(),
      USGS: earthquakeIntelligence.panel?.feedState?.(),
    }),
    readCamera: () => {
      const carto = viewer?.camera?.positionCartographic;
      if (!carto) return null;
      return {
        latitude: (carto.latitude * 180) / Math.PI,
        longitude: (carto.longitude * 180) / Math.PI,
      };
    },
    // The resolved place name, when there is one. The strip falls back to its
    // own coarse band only while a name is still being resolved, so it can
    // never show a different place from the regional panel beside it.
    readPlaceName: () => locationContext.get().locationName,
    // Where alerting is pointed, which is not the same fact as REGION beside
    // it: that follows the camera, this follows the person.
    readMonitoring: () => localIntelligence?.summary?.() || null,
    readLastSync: () =>
      Math.max(
        fireIntelligence.getLatest?.()?.receivedAt ?? 0,
        earthquakeIntelligence.getLatest?.()?.receivedAt ?? 0,
        Date.parse(
          weatherIntelligence.getActive?.()?.analysis?.generatedAt ?? '',
        ) || 0,
      ) || null,
  });
  defer(() => statusStrip?.destroy());

  // The follow camera recomputes the tracked target's dead-reckon position
  // every frame — tracking anything is a per-frame animation. (perf wave 2)
  const removeTrackingListener = viewer.trackedEntityChanged.addEventListener(
    () => {
      if (viewer.trackedEntity) holdContinuousRender('tracked-entity');
      else releaseContinuousRender('tracked-entity');
    },
  );

  // Hidden-state suspension (perf wave 2): when the window/tab is hidden,
  // stop the default render loop outright — a hidden canvas repaints for
  // nobody, and browser rAF throttling still lets throttled frames burn
  // GPU. Holder/data state is untouched, so return is seamless: restore
  // the loop, refresh the one DOM surface we gated, render a frame.
  const syncVisibilitySuspension = () => {
    const hidden = document.hidden;
    viewer.useDefaultRenderLoop = !hidden;
    cockpitCloudEffects?.setSuspended?.(hidden);
    if (!hidden) {
      data.presentation.flushVisible();
      governorRequestRender('visibility-restore');
    }
  };
  document.addEventListener('visibilitychange', syncVisibilitySuspension);
  defer(() =>
    document.removeEventListener('visibilitychange', syncVisibilitySuspension),
  );
  defer(() => {
    removeTrackingListener();
    releaseContinuousRender('tracked-entity');
  });
  // Apply the CURRENT state too — bootstrap can complete while the tab is
  // already hidden, and waiting for the next transition would leave the
  // loop burning behind a hidden tab. (perf wave 2 fix)
  syncVisibilitySuspension();

  window.__godsEyeView = {
    viewer,
    styleManager,
    tileset,
    dataManager,
    sceneDirector,
    mapStackController,
    annotations,
    weatherEffects,
    cockpitCloudEffects,
    getRenderGovernorDiagnostics,
    surfaceServices: operations.surface,
    requestRender: governorRequestRender,
  };
  // Both intelligence layers are reachable from the debug handle, the way the
  // scene director and voice commands already are: they own polling and map
  // state, and QA needs to drive them without a mouse.
  window.__godsEyeView.weatherIntelligence = weatherIntelligence;
  window.__godsEyeView.fireIntelligence = fireIntelligence;
  window.__godsEyeView.earthquakeIntelligence = earthquakeIntelligence;
  const debug = window.__godsEyeView;
  defer(() => {
    if (window.__godsEyeView === debug) delete window.__godsEyeView;
  });
  const voiceCommands = initGevVoiceCommands({
    ...voice,
    floorServices: operations.surface.groundFloor,
    annotationResolver: operations.annotationResolver,
    searchNavigation: operations.searchAndFlyTo,
    signal,
    placeSearch,
    viewer,
    styleManager,
    dataManager,
    sceneDirector,
    annotations,
  });
  defer(() => {
    voiceCommands.stop({ removeUi: true });
    if (window.__gevVoiceCommands === voiceCommands)
      delete window.__gevVoiceCommands;
  });
  debug.voiceCommands = voiceCommands;
  return { sceneDirector, annotations, voiceCommands };
}
