// Bounded connect for the worker's registration WebSocket to LiveKit.
//
// The SDK opens it with `new WebSocket(url, { headers })` and no
// handshakeTimeout, so a connect attempt lasts as long as the OS lets it: ~75s
// on macOS when the SYN is black-holed. That happens when a VPN tunnel rebuilds
// on a new interface (Astrill, observed 2026-10-09: 2 of 9 reconnects sat
// 80–100s offline while the network was already back), and every dispatch in
// that window lands on no worker. Retrying a fresh socket after a few seconds
// picks up the new route.
//
// ws builds its TLS socket with `tls.connect(options)`, looked up on the shared
// `tls` module object at call time, so wrapping that function here reaches it
// without patching node_modules. Scope: only options-object calls whose
// servername/host equals the LiveKit hostname, and only in the launcher
// process — job subprocesses import agent.js, never main.js, so room media
// and inference gateway sockets are untouched. The timer covers DNS + TCP +
// TLS and is cleared on secureConnect.

import tls from 'node:tls';

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** WORKER_CONNECT_TIMEOUT_MS: unset/junk → 10s default, '0' → disabled. */
export function resolveConnectTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONNECT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CONNECT_TIMEOUT_MS;
  return parsed;
}

/** Fail TLS connects to `hostname` that don't finish within `timeoutMs` with
 *  an ETIMEDOUT error (the SDK then logs it and retries with backoff).
 *  Returns an uninstall function. */
export function installConnectTimeout(hostname: string, timeoutMs: number): () => void {
  const original = tls.connect;
  if (!hostname || timeoutMs <= 0) return () => {};

  const bounded = function (this: unknown, ...args: unknown[]): tls.TLSSocket {
    const socket = (original as (...a: unknown[]) => tls.TLSSocket).apply(this, args);
    const opts = typeof args[0] === 'object' && args[0] !== null ? (args[0] as tls.ConnectionOptions) : undefined;
    if (!opts || (opts.servername || opts.host) !== hostname) return socket;

    const timer = setTimeout(() => {
      const err = new Error(`connect to ${hostname} timed out after ${timeoutMs}ms`) as NodeJS.ErrnoException;
      err.code = 'ETIMEDOUT';
      socket.destroy(err);
    }, timeoutMs);
    timer.unref();
    const clear = () => clearTimeout(timer);
    socket.once('secureConnect', clear);
    socket.once('close', clear);
    return socket;
  };

  tls.connect = bounded as typeof tls.connect;
  return () => {
    if (tls.connect === (bounded as typeof tls.connect)) tls.connect = original;
  };
}
