import { initFirstRunExperience } from '../firstRunExperience.js';
import {
  createStartupSequence,
  shouldPlayFullIntro,
} from '../ui/startupSequence.js';

/**
 * Reveal the console once the startup sequence and the bootstrap agree.
 *
 * Two things are racing here and neither is allowed to hold the other up:
 *
 *  - The APPLICATION is loading Cesium, restoring shared state and starting the
 *    live providers. That began before this function was called and is not
 *    touched by anything here.
 *  - The SEQUENCE is playing the Aegis introduction over the top.
 *
 * The overlay lifts when BOTH are done. If the console is ready first the
 * introduction finishes at its own pace; if the introduction finishes first the
 * last frame simply holds — which is why nothing here shows a percentage. There
 * is no number that would be honest, because the two are independent.
 *
 * Skipping resolves the sequence immediately, so a skip is bounded by the
 * bootstrap alone. That is the one wait Aegis cannot shorten.
 */
export function startApplicationChrome({
  loadingScreen,
  styleManager,
  dataManager,
  signal,
  initializeWelcome = initFirstRunExperience,
  startSequence = createStartupSequence,
  playFullIntro = shouldPlayFullIntro,
}) {
  let disposed = false;
  let firstRun;
  let revealTimer;

  // The console's own chrome is suppressed for the duration. The overlay is
  // opaque, so this is not about hiding something the user can see — it is
  // about the HANDOVER. Without it every panel, rail and readout arrives in
  // the same frame the cover clears, which is precisely the jump-cut the
  // sequence exists to avoid. Released after the cover lifts so the console
  // fades up behind it instead.
  const body = loadingScreen?.ownerDocument?.body;
  body?.classList.add('aegis-booting');

  // Started immediately: the first frame of the sequence should be on screen
  // while the providers are still opening their connections.
  const sequence = startSequence({
    root: loadingScreen,
    full: playFullIntro(),
  });

  const revealFirstRun = () => {
    if (disposed || signal.aborted || firstRun) return;
    firstRun = initializeWelcome?.({ styleManager, dataManager });
    clearTimeout(revealTimer);
    loadingScreen.removeEventListener('transitionend', revealFirstRun);
  };

  void Promise.all([
    // A restoration failure must not strand the overlay: the console reports
    // that through its own controls, and the user still needs to reach it.
    styleManager.initialRestorePromise.catch(() => {}),
    sequence.finished,
  ]).then(() => {
    if (disposed || signal.aborted) return;
    loadingScreen.classList.add('hidden');
    body?.classList.remove('aegis-booting');
    loadingScreen.addEventListener('transitionend', revealFirstRun, {
      once: true,
    });
    revealTimer = setTimeout(revealFirstRun, 900);
  });

  return async () => {
    disposed = true;
    clearTimeout(revealTimer);
    // A teardown mid-sequence must not leave the console permanently hidden.
    body?.classList.remove('aegis-booting');
    sequence.destroy();
    loadingScreen.removeEventListener('transitionend', revealFirstRun);
    firstRun?.destroy();
  };
}
