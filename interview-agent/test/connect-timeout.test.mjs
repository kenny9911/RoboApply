import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  installConnectTimeout,
  resolveConnectTimeoutMs,
} from '../dist/connect-timeout.js';

// Accepts TCP and never answers the TLS ClientHello — the same hang a
// black-holed route produces, without depending on the host's network.
async function silentServer(t) {
  const sockets = new Set();
  const server = net.createServer((s) => { sockets.add(s); s.on('error', () => {}); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return server.address().port;
}

test('WORKER_CONNECT_TIMEOUT_MS: default 10s, 0 disables, junk falls back', () => {
  assert.equal(DEFAULT_CONNECT_TIMEOUT_MS, 10_000);
  assert.equal(resolveConnectTimeoutMs(undefined), 10_000);
  assert.equal(resolveConnectTimeoutMs(''), 10_000);
  assert.equal(resolveConnectTimeoutMs('garbage'), 10_000);
  assert.equal(resolveConnectTimeoutMs('-5'), 10_000);
  assert.equal(resolveConnectTimeoutMs('0'), 0);
  assert.equal(resolveConnectTimeoutMs('4000'), 4000);
});

test('a ws:// connect to the LiveKit host that never completes TLS fails fast with ETIMEDOUT', async (t) => {
  const port = await silentServer(t);
  const uninstall = installConnectTimeout('127.0.0.1', 200);
  t.after(uninstall);

  const started = Date.now();
  const err = await new Promise((resolve) => {
    // The SDK's exact call shape: no handshakeTimeout, headers only.
    const ws = new WebSocket(`wss://127.0.0.1:${port}/agent`, { headers: { authorization: 'Bearer x' } });
    ws.on('error', resolve);
  });
  const elapsed = Date.now() - started;

  assert.equal(err.code, 'ETIMEDOUT');
  assert.match(err.message, /timed out after 200ms/);
  assert.ok(elapsed >= 190 && elapsed < 2000, `failed after ${elapsed}ms`);
});

test('connects to other hosts are left alone', async (t) => {
  const port = await silentServer(t);
  const uninstall = installConnectTimeout('lk.example.invalid', 100);
  t.after(uninstall);

  const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(socket.destroyed, false);
});

test('uninstall restores tls.connect, and a disabled timeout installs nothing', () => {
  const original = tls.connect;
  const uninstall = installConnectTimeout('127.0.0.1', 1000);
  assert.notEqual(tls.connect, original);
  uninstall();
  assert.equal(tls.connect, original);

  installConnectTimeout('127.0.0.1', 0)();
  assert.equal(tls.connect, original);
});
