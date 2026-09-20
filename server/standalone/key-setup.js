import {
  admitKeySetupRequest,
  keySetupStatus,
} from '../../src/keySetupCore.mjs';

/**
 * Read-only provider health.
 *
 * This module used to be the back end of the in-app "POWER UP THE GLOBE"
 * dialog: it accepted credentials over HTTP and wrote them into a dotenv file
 * on disk. That whole path is gone. Credentials now come from the environment
 * and nothing else — no browser input, no HTTP write, no application-managed
 * credential store.
 *
 * What remains is the part worth keeping: an answer to "which providers are
 * configured?" that the application can act on. It reports a BOOLEAN per
 * provider and never a value. There is no endpoint here that can be asked for
 * a credential, because there is no code here that reads one:
 * `keySetupStatus()` maps each provider's env vars to `set: true|false` and
 * discards the values before returning.
 *
 * The loopback/origin admission check is kept. The endpoint exposes no secrets,
 * but "which of your providers are unconfigured" is still a small piece of
 * reconnaissance, and it costs nothing to keep answering only the local
 * browser.
 */

/**
 * Serve read-only provider status on the dev server.
 *
 * The name is unchanged because `server/providers/local.js`, the package
 * export map and the import-direction rules all reference it; what it does is
 * now strictly narrower than it was.
 *
 * @returns {object} A Vite plugin.
 */
function keySetupEndpoint() {
  const respond = (res, status, payload) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  };

  const admit = (req) =>
    admitKeySetupRequest({
      method: req.method,
      remoteAddress: req.socket?.remoteAddress,
      hostHeader: req.headers?.host,
      protocol: req.socket?.encrypted ? 'https:' : 'http:',
      origin: req.headers?.origin,
      contentType: req.headers?.['content-type'],
      proxyHeaders: req.headers || {},
      env: process.env,
    });

  return {
    name: 'aegis-provider-status',
    // Serve, and not preview: `vite preview` also resolves with command
    // 'serve', so a bare apply:'serve' would configure under preview too.
    apply: (_config, { command, isPreview }) =>
      command === 'serve' && !isPreview,
    configureServer(server) {
      server.middlewares.use('/api/setup/status', (req, res) => {
        if (req.method !== 'GET')
          return respond(res, 405, { error: 'Method not allowed' });
        const admission = admit(req);
        if (!admission.ok)
          return respond(res, admission.status, { error: admission.error });
        // `keySetupStatus` returns ids, titles, env var NAMES and a boolean —
        // never a credential.
        respond(res, 200, keySetupStatus(process.env));
      });
    },
  };
}

export { keySetupEndpoint };
