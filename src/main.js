import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error('Aegis initialization failed:', error);
  const screen = document.getElementById('loading-screen');
  const loaderStatus = screen?.querySelector('.loader-status');
  if (loaderStatus) {
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    // The status line is invisible during a healthy start — a console that is
    // coming up has nothing to narrate. A failure is the one thing it must
    // say, so it is revealed rather than left behind the sequence, and the
    // sequence is stopped so it cannot keep playing over a dead console.
    loaderStatus.dataset.failed = 'true';
  }
  if (screen) screen.dataset.phase = 'failed';
});

export { application };
