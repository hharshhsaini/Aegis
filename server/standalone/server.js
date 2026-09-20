import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localProviderPlugins } from '../providers/local.js';
import { apiNotFoundPlugin } from './api-not-found.js';

/**
 * The production server.
 *
 * Aegis had no such thing. In development the provider proxies mount as VITE
 * PLUGINS — each one exposes `configureServer(server)` and calls
 * `install(server.middlewares)` — and `vite preview` reuses the same hooks.
 * That is fine on a laptop and is not a server you can put on the internet:
 * it ships the dev toolchain, holds the source tree open, and has no lifecycle
 * to speak of.
 *
 * Rather than reimplement twenty-odd routes for production — which would
 * immediately start drifting from the ones under test — this builds the one
 * thing those plugins actually need. Every provider touches exactly
 * `server.middlewares`, and only through `.use(path, handler)`. That is the
 * Connect interface, so a small stack implementing `.use` is enough to run all
 * of them unmodified, with no framework and no new dependency.
 *
 * The result serves two things:
 *   1. `/api/*` — the provider proxies, which is where every credential lives.
 *      The browser never receives one.
 *   2. everything else — the built client from `dist/`, with an SPA fallback.
 */

/** Files served with a long cache. Vite fingerprints these names. */
const IMMUTABLE = /\/assets\/.+\.[0-9a-f]{8}\./;

/** Content types for what the build emits. */
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.geojsonl': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});

/**
 * A minimal Connect-compatible middleware stack.
 *
 * `.use(handler)` or `.use(path, handler)`, matched by prefix, run in
 * registration order, with `next()` carrying an error to the end. This is the
 * whole surface the provider plugins use — deliberately no more, so nothing
 * here can quietly diverge from how they behave in development.
 *
 * @returns {object} The stack, with a `handle` entry point.
 */
export function createMiddlewareStack() {
  const layers = [];
  return {
    use(path, handler) {
      if (typeof path === 'function') layers.push({ path: '/', handler: path });
      else layers.push({ path, handler });
      return this;
    },
    /**
     * Run the stack for one request.
     * @param {object} req Request.
     * @param {object} res Response.
     * @param {Function} done Called when no layer handled it.
     */
    handle(req, res, done) {
      const url = req.url || '/';
      const pathname = url.split('?')[0];
      let index = 0;
      const next = (error) => {
        if (error) return done(error);
        const layer = layers[index++];
        if (!layer) return done();
        const { path, handler } = layer;
        const matches =
          path === '/' ||
          pathname === path ||
          pathname.startsWith(path.endsWith('/') ? path : `${path}/`) ||
          pathname.startsWith(`${path}?`);
        if (!matches) return next();
        try {
          // Connect strips the mount path from req.url; the provider routes
          // parse the full original, so `originalUrl` is preserved for them.
          req.originalUrl = req.originalUrl || url;
          handler(req, res, next);
        } catch (error_) {
          next(error_);
        }
      };
      next();
    },
  };
}

/**
 * Serve one static file from the build.
 *
 * @param {string} root Absolute path to `dist`.
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {boolean} Whether a file was served.
 */
function serveStatic(root, req, res) {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  // Resolved and re-checked against the root: a normalized path is the only
  // thing standing between a static handler and `../../.env`.
  const candidate = resolve(join(root, normalize(pathname)));
  if (!candidate.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }

  let file = candidate;
  if (!existsSync(file) || statSync(file).isDirectory())
    file = join(root, 'index.html');
  if (!existsSync(file)) return false;

  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': IMMUTABLE.test(pathname)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    // The client is same-origin with its own API; nothing here should be
    // framed or sniffed.
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
  createReadStream(file).pipe(res);
  return true;
}

/**
 * Build the Aegis production server.
 *
 * @param {object} [input] Input.
 * @param {string} [input.distDir] Built client directory.
 * @returns {object} A Node HTTP server, not yet listening.
 */
export function createAegisServer({
  distDir = fileURLToPath(new URL('../../dist', import.meta.url)),
} = {}) {
  const root = resolve(distDir);
  const middlewares = createMiddlewareStack();

  // The same plugin objects the dev server uses, mounted through the same
  // `configureServer` hook. They only ever touch `server.middlewares`, so this
  // runs the routes that are actually under test rather than a second copy.
  for (const plugin of [...localProviderPlugins(), apiNotFoundPlugin()]) {
    const install = plugin.configureServer || plugin.configurePreviewServer;
    if (typeof install === 'function') install({ middlewares });
  }

  return createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    // A load balancer needs something cheap that does not touch a provider.
    if (pathname === '/healthz' || pathname === '/healthz/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    middlewares.handle(req, res, (error) => {
      if (error) {
        // Never surface an upstream error body: it can carry a credential the
        // proxy was holding on the client's behalf.
        console.error('[aegis]', error?.message || error);
        if (!res.headersSent)
          res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
        return;
      }
      if (serveStatic(root, req, res)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });
  });
}

// Started directly (`npm start`), rather than imported by a test.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const port = Number(process.env.PORT) || 8080;
  // 0.0.0.0 in a container: binding loopback would make the service
  // unreachable from the load balancer in front of it.
  const host = process.env.HOST || '0.0.0.0';
  const dist = fileURLToPath(new URL('../../dist', import.meta.url));

  if (!existsSync(dist)) {
    console.error('[aegis] dist/ is missing — run `npm run build` first.');
    process.exit(1);
  }

  const server = createAegisServer({ distDir: dist });
  server.listen(port, host, () => {
    console.log(`[aegis] listening on http://${host}:${port}`);
  });

  // Containers are stopped with SIGTERM; draining rather than dying mid-flight
  // is the difference between a clean deploy and dropped requests.
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      console.log(`[aegis] ${signal} — draining`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 10_000).unref();
    });
}
