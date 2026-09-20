import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  // 127.0.0.1, not the string 'localhost'. Node resolves 'localhost' through
  // the OS, and on a dual-stack macOS it binds IPv6 ONLY — the server ends up
  // on [::1]:4173 with nothing on IPv4. Chrome resolves localhost to 127.0.0.1
  // first, so it gets ERR_CONNECTION_REFUSED while tools that happen to prefer
  // IPv6 connect fine, which makes the failure look browser-specific rather
  // than like the binding problem it is. An explicit IPv4 loopback is still
  // loopback: this does not expose the dev server on the network.
  host = '127.0.0.1',
  port = 4173,
} = {}) {
  return {
    plugins: [cesium(), applicationHtmlPlugin(), ...plugins],
    ...(publicDir === undefined ? {} : { publicDir }),
    server: {
      host: host || '127.0.0.1',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
