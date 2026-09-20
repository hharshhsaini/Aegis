import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KEY_SETUP_KEYS,
  admitKeySetupRequest,
  keySetupRequirement,
  keySetupStatus,
  knownKeySetupEnvVars,
} from './keySetupCore.mjs';

test('provider requirements name the registry env vars and next step', () => {
  assert.equal(
    keySetupRequirement('cesium-ion'),
    'Needs CESIUM_ION_TOKEN — set it in the environment (see .env.example)',
  );
  assert.equal(keySetupRequirement('unknown'), '');
});

test('the status payload reports presence without any credential material', () => {
  const env = {
    GOOGLE_MAPS_API_KEY: 'AIzaSyFakeFakeFakeFake1234',
    OPENSKY_CLIENT_ID: 'client-id-abcdef',
    // Secret missing: the OpenSky pair must read as NOT set.
  };
  const status = keySetupStatus(env);
  assert.equal(
    status.total,
    KEY_SETUP_KEYS.filter((key) => !key.hidden).length,
  );
  const google = status.keys.find((key) => key.id === 'google-maps');
  assert.equal(google.set, true);
  const opensky = status.keys.find((key) => key.id === 'opensky');
  assert.equal(opensky.set, false, 'half a credential pair is not configured');
  const serialized = JSON.stringify(status);
  assert.ok(
    !serialized.includes('AIzaSyFakeFakeFakeFake1234'),
    'a value leaked into status',
  );
  assert.ok(
    !serialized.includes('client-id-abcdef'),
    'a value leaked into status',
  );
  assert.ok(
    !serialized.includes('1234'),
    'a credential suffix leaked into status',
  );
  assert.ok(
    !serialized.includes('abcdef'),
    'a credential suffix leaked into status',
  );
  assert.ok(
    !serialized.includes('tails'),
    'status must not expose a credential-tail field',
  );
  assert.equal(status.setCount, 1);
});

test('whitespace-only env values do not count as configured', () => {
  const status = keySetupStatus({ OPENAI_API_KEY: '   ' });
  assert.equal(status.keys.find((key) => key.id === 'openai').set, false);
});

test('the admission gate refuses every non-local shape, one assertion per refusal', async () => {
  const { admitKeySetupRequest } = await import('./keySetupCore.mjs');
  const local = {
    method: 'POST',
    remoteAddress: '127.0.0.1',
    hostHeader: 'localhost:4173',
    origin: 'http://localhost:4173',
    contentType: 'application/json',
    env: {},
  };
  assert.equal(
    admitKeySetupRequest(local).ok,
    true,
    'the honest local request is admitted',
  );
  assert.equal(
    admitKeySetupRequest({ ...local, method: 'GET', contentType: undefined })
      .ok,
    true,
    'local GET needs no content type',
  );
  assert.equal(
    admitKeySetupRequest({ ...local, origin: undefined }).ok,
    false,
    'POST without Origin is refused',
  );
  assert.equal(
    admitKeySetupRequest({
      ...local,
      method: 'GET',
      origin: undefined,
      contentType: undefined,
    }).ok,
    true,
    'local GET may omit Origin',
  );
  assert.equal(
    admitKeySetupRequest({
      ...local,
      remoteAddress: '::ffff:127.0.0.1',
      hostHeader: '[::1]:4173',
      origin: 'http://[::1]:4173',
    }).ok,
    true,
    'IPv6 loopback forms are local',
  );

  // Tunnel/LAN sharing of any kind removes the surface outright — tunnel
  // traffic arrives FROM loopback, so no socket check can carry this boundary.
  assert.equal(
    admitKeySetupRequest({
      ...local,
      env: { PINOKIO_SHARE_CLOUDFLARE: 'true' },
    }).ok,
    false,
    'sharing disables the surface',
  );
  assert.equal(
    admitKeySetupRequest({ ...local, env: { PINOKIO_SHARE_LOCAL: '1' } }).ok,
    false,
    'LAN sharing disables the surface',
  );
  // A LAN peer reaching a wide-bound server.
  assert.equal(
    admitKeySetupRequest({ ...local, remoteAddress: '192.168.1.20' }).ok,
    false,
    'non-loopback socket refused',
  );
  // Tunnel and DNS-rebinding traffic carries a foreign Host over a loopback socket.
  assert.equal(
    admitKeySetupRequest({ ...local, hostHeader: 'abc.trycloudflare.com' }).ok,
    false,
    'foreign Host refused',
  );
  assert.equal(
    admitKeySetupRequest({ ...local, hostHeader: 'workstation.local:4173' }).ok,
    false,
    'non-localhost hostnames refused',
  );
  assert.equal(
    admitKeySetupRequest({ ...local, hostHeader: '' }).ok,
    false,
    'missing Host refused',
  );
  assert.equal(
    admitKeySetupRequest({ ...local, hostHeader: '[::1].evil:4173' }).ok,
    false,
    'malformed bracketed Host refused',
  );
  // A hostile web page POSTing at localhost carries its own Origin.
  assert.equal(
    admitKeySetupRequest({ ...local, origin: 'https://evil.example' }).ok,
    false,
    'cross-origin refused',
  );
  assert.equal(
    admitKeySetupRequest({ ...local, origin: 'not a url' }).ok,
    false,
    'unparseable Origin refused',
  );
  assert.equal(
    admitKeySetupRequest({ ...local, origin: 'http://localhost:4174' }).ok,
    false,
    'cross-port Origin refused',
  );
  assert.equal(
    admitKeySetupRequest({ ...local, origin: 'https://localhost:4173' }).ok,
    false,
    'cross-scheme Origin refused',
  );
  assert.equal(
    admitKeySetupRequest({ ...local, origin: 'http://127.0.0.1:4173' }).ok,
    false,
    'different loopback host Origin refused',
  );
  // A simple-request POST (no JSON content type) is the CSRF write shape.
  const noJson = admitKeySetupRequest({ ...local, contentType: 'text/plain' });
  assert.equal(noJson.ok, false, 'non-JSON POST refused');
  assert.equal(noJson.status, 415);
});

test('the sharing gate treats a real PINOKIO_SHARE_VAR as sharing, but not the empty/sentinel normal state', async () => {
  const { admitKeySetupRequest } = await import('./keySetupCore.mjs');
  const base = {
    method: 'POST',
    remoteAddress: '127.0.0.1',
    hostHeader: 'localhost:4173',
    origin: 'http://localhost:4173',
    contentType: 'application/json',
  };
  // The ordinary launch states: unset, empty, or the explicit disabled sentinel.
  assert.equal(
    admitKeySetupRequest({ ...base, env: {} }).ok,
    true,
    'unset SHARE_VAR is normal',
  );
  assert.equal(
    admitKeySetupRequest({ ...base, env: { PINOKIO_SHARE_VAR: '' } }).ok,
    true,
    'empty SHARE_VAR is normal',
  );
  assert.equal(
    admitKeySetupRequest({
      ...base,
      env: { PINOKIO_SHARE_VAR: '__gev_sharing_disabled__' },
    }).ok,
    true,
    'the disabled sentinel is normal',
  );
  // A real tunnel var disables the surface.
  assert.equal(
    admitKeySetupRequest({
      ...base,
      env: { PINOKIO_SHARE_VAR: 'MY_TUNNEL_TOKEN' },
    }).ok,
    false,
    'a real share var is sharing',
  );
});

test('the gate refuses proxied requests even from a loopback socket with local headers', async () => {
  const { admitKeySetupRequest } = await import('./keySetupCore.mjs');
  const base = {
    method: 'POST',
    remoteAddress: '127.0.0.1',
    hostHeader: 'localhost:4173',
    origin: 'http://localhost:4173',
    contentType: 'application/json',
    env: {},
  };
  assert.equal(
    admitKeySetupRequest(base).ok,
    true,
    'no proxy headers → admitted',
  );
  for (const header of [
    'x-forwarded-for',
    'forwarded',
    'via',
    'cf-connecting-ip',
    'cf-ray',
    'x-real-ip',
    'x-forwarded-host',
    'x-forwarded-port',
    'x-forwarded-proto',
  ]) {
    assert.equal(
      admitKeySetupRequest({ ...base, proxyHeaders: { [header]: 'anything' } })
        .ok,
      false,
      `${header} present → refused`,
    );
  }
  // An empty forwarding header is not a proxy signal.
  assert.equal(
    admitKeySetupRequest({ ...base, proxyHeaders: { 'x-forwarded-for': '' } })
      .ok,
    true,
  );
});

test('the hidden server Google key stays supported but out of the status', () => {
  // It is a real provider the server reads; it is simply not something the
  // status surface counts or reports, so a deployment using one shared key is
  // not told it is missing a credential.
  const secret = 'server-key-fixture';
  const status = keySetupStatus({ GOOGLE_MAPS_SERVER_API_KEY: secret });
  assert.deepEqual(status, keySetupStatus({}));
  assert.equal(
    status.keys.some((key) => key.id === 'google-maps-server'),
    false,
  );
  assert.ok(
    knownKeySetupEnvVars().has('GOOGLE_MAPS_SERVER_API_KEY'),
    'the registry still knows the variable',
  );
  assert.ok(!JSON.stringify(status).includes(secret));
});

test('the registry is read-only: no export can write a credential anywhere', () => {
  // The in-app panel that accepted and persisted credentials is gone. This
  // pins that absence: an export that validates or writes dotenv values would
  // mean the write path had come back.
  const source = readFileSync(
    new URL('./keySetupCore.mjs', import.meta.url),
    'utf8',
  );
  for (const gone of [
    'validateKeySetupUpdates',
    'upsertDotenvValues',
    'KEY_SETUP_APPEND_HEADER',
  ]) {
    assert.ok(!source.includes(`export function ${gone}`), `${gone} returned`);
    assert.ok(!source.includes(`export const ${gone}`), `${gone} returned`);
  }
  assert.ok(!/writeFile|fs\./.test(source), 'the core must not touch the disk');
});

test('the status endpoint serves reads only, and writes nothing', () => {
  const source = readFileSync(
    new URL('../server/standalone/key-setup.js', import.meta.url),
    'utf8',
  );
  assert.ok(source.includes('/api/setup/status'));
  assert.ok(
    !source.includes('/api/setup/keys'),
    'the credential-write endpoint must stay gone',
  );
  assert.ok(
    !/writeFileSync|persistStore|renameSync/.test(source),
    'nothing here may persist a credential',
  );
});
