import { startApplicationChrome } from '../app/startupChrome.js';

/**
 * Standalone chrome.
 *
 * Previously this also mounted the in-app Provider Settings dialog ("POWER UP
 * THE GLOBE"), which let an operator paste provider credentials into the
 * browser. Credentials now come from the environment only, so there is nothing
 * left to mount and this is a thin pass-through.
 */
export function startStandaloneChrome(options) {
  return startApplicationChrome(options);
}
