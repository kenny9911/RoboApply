// @vitest-environment node
// INT-13 (wave5 WP-93 #34): proxy trust per deployment and the SIGTERM drain
// of the long-running API host. Pure: fake servers and a fake process; the
// one end-to-end case uses a real Express app on an ephemeral loopback port.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';

// `clientIp` is the rate-limit key source; its module graph reaches Prisma and the logger, which this test never needs.
vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { clientIp } from '../../platform/ratelimit/index.js';
import { installGracefulShutdown, shutdownDrainTimeoutMs, trustProxySetting, type DrainableServer } from './processLifecycle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('trustProxySetting', () => {
  it('defaults: unchanged on Vercel, one hop on every other host', () => {
    expect(trustProxySetting({ VERCEL: '1' })).toBe(true);
    expect(trustProxySetting({})).toBe(1);
    expect(trustProxySetting({ TRUST_PROXY: '   ' })).toBe(1);
  });

  it('TRUST_PROXY wins on both hosts', () => {
    expect(trustProxySetting({ VERCEL: '1', TRUST_PROXY: '1' })).toBe(1);
    expect(trustProxySetting({ TRUST_PROXY: '2' })).toBe(2);
    expect(trustProxySetting({ TRUST_PROXY: '0' })).toBe(0);
    expect(trustProxySetting({ TRUST_PROXY: 'TRUE' })).toBe(true);
    expect(trustProxySetting({ VERCEL: '1', TRUST_PROXY: 'false' })).toBe(false);
    expect(trustProxySetting({ TRUST_PROXY: 'loopback, 100.64.0.0/10' })).toBe('loopback, 100.64.0.0/10');
    expect(trustProxySetting({ TRUST_PROXY: '10.0.0.1,fd00::/8' })).toBe('10.0.0.1, fd00::/8');
  });

  it('an unusable value falls back to the host default, never to "trust everything"', () => {
    for (const bad of ['-1', 'yes', '1.5', 'everything', '10.0.0.0/33', 'loopback,,', '1, 2', 'bad.cafe', '10.0.0.0/8/8']) {
      expect(trustProxySetting({ TRUST_PROXY: bad }), bad).toBe(1);
      expect(trustProxySetting({ VERCEL: '1', TRUST_PROXY: bad }), bad).toBe(true);
    }
  });

  it('every value it returns is one Express accepts', () => {
    for (const env of [{}, { VERCEL: '1' }, { TRUST_PROXY: '2' }, { TRUST_PROXY: 'false' }, { TRUST_PROXY: 'loopback, 100.64.0.0/10' }, { TRUST_PROXY: '10.0.0.1,fd00::/8' }]) {
      const app = express();
      expect(() => app.set('trust proxy', trustProxySetting(env))).not.toThrow();
    }
  });

  it('app.ts uses it (no literal trust-everything setting is left)', () => {
    const source = fs.readFileSync(path.resolve(HERE, '../../app.ts'), 'utf8');
    expect(source).toContain("app.set('trust proxy', trustProxySetting());");
    expect(source).not.toMatch(/app\.set\('trust proxy',\s*true\)/);
    expect(source).toContain('installGracefulShutdown({');
    // Only the listening host drains; a Vercel function never registers signal handlers.
    expect(source.indexOf('installGracefulShutdown({')).toBeGreaterThan(source.indexOf('if (!process.env.VERCEL) {\n  // In-process node-cron'));
  });
});

describe('req.ip and the rate-limit key under each setting', () => {
  async function ipSeen(setting: boolean | number | string, headers: Record<string, string>): Promise<string> {
    const app = express();
    app.set('trust proxy', setting);
    app.get('/ip', (req, res) => {
      res.json({ ip: clientIp(req) });
    });
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/ip`, { headers });
      return ((await res.json()) as { ip: string }).ip;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('one forwarded entry (Vercel edge, the mainland gateway): both settings read the visitor', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.7' };
    expect(await ipSeen(true, headers)).toBe('203.0.113.7');
    expect(await ipSeen(1, headers)).toBe('203.0.113.7');
  });

  it('a client-forged left-most entry wins under `true` and is ignored under one hop', async () => {
    // What a proxy that APPENDS would forward: "<forged by the client>, <address the proxy saw>".
    const headers = { 'x-forwarded-for': '198.51.100.99, 203.0.113.7' };
    expect(await ipSeen(true, headers)).toBe('198.51.100.99');
    expect(await ipSeen(1, headers)).toBe('203.0.113.7');
  });

  it('no forwarded header: the socket address either way', async () => {
    expect(await ipSeen(1, {})).toMatch(/127\.0\.0\.1$/);
    expect(await ipSeen(true, {})).toMatch(/127\.0\.0\.1$/);
  });
});

describe('shutdownDrainTimeoutMs', () => {
  it('covers the longest request in production and stays short in development', () => {
    const vercel = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../../../vercel.json'), 'utf8')) as { functions: Record<string, { maxDuration: number }> };
    const maxRequestMs = vercel.functions['api/index.ts']!.maxDuration * 1000;
    expect(shutdownDrainTimeoutMs({ NODE_ENV: 'production' })).toBeGreaterThan(maxRequestMs);
    // The mainland API pod: SIGTERM arrives after the preStop sleep and must finish inside the grace period.
    const apiManifest = fs.readFileSync(path.resolve(HERE, '../../../../deploy/cn/k8s/api.yaml'), 'utf8');
    const graceMs = Number(/terminationGracePeriodSeconds: (\d+)/.exec(apiManifest)![1]) * 1000;
    const preStopMs = Number(/setTimeout\(\(\) => \{\}, (\d+)\)/.exec(apiManifest)![1]);
    expect(shutdownDrainTimeoutMs({ NODE_ENV: 'production' })).toBeLessThan(graceMs - preStopMs);
    expect(shutdownDrainTimeoutMs({ NODE_ENV: 'development' })).toBe(1_000);
    expect(shutdownDrainTimeoutMs({})).toBe(1_000);
  });

  it('SHUTDOWN_DRAIN_TIMEOUT_MS overrides; a bad value is ignored', () => {
    expect(shutdownDrainTimeoutMs({ NODE_ENV: 'production', SHUTDOWN_DRAIN_TIMEOUT_MS: '1000' })).toBe(1000);
    expect(shutdownDrainTimeoutMs({ SHUTDOWN_DRAIN_TIMEOUT_MS: '0' })).toBe(0);
    expect(shutdownDrainTimeoutMs({ SHUTDOWN_DRAIN_TIMEOUT_MS: 'soon' })).toBe(1_000);
  });
});

function fakeServer(): DrainableServer & { finish(err?: Error): void; calls: string[] } {
  let done: ((err?: Error) => void) | undefined;
  const calls: string[] = [];
  return {
    calls,
    close(cb) {
      calls.push('close');
      done = cb;
    },
    closeIdleConnections() {
      calls.push('closeIdle');
    },
    closeAllConnections() {
      calls.push('closeAll');
    },
    finish(err) {
      done?.(err);
    },
  };
}

describe('installGracefulShutdown', () => {
  it('registers SIGTERM and SIGINT, stops background work, drains, then exits 0', async () => {
    const proc = new EventEmitter();
    const server = fakeServer();
    const order: string[] = [];
    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`);
    });
    const handle = installGracefulShutdown({
      server,
      proc: proc as never,
      exit,
      drainTimeoutMs: 10_000,
      stopBackground: () => order.push('stopBackground'),
      afterDrain: async () => {
        order.push('afterDrain');
      },
    });
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    expect(proc.listenerCount('SIGINT')).toBe(1);
    expect(handle.isDraining()).toBe(false);

    proc.emit('SIGTERM');
    expect(handle.isDraining()).toBe(true);
    await Promise.resolve();
    // No exit while a request is still running.
    expect(exit).not.toHaveBeenCalled();
    expect(server.calls).toEqual(['close', 'closeIdle']);

    server.finish();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(order).toEqual(['stopBackground', 'afterDrain', 'exit:0']);
    expect(server.calls).not.toContain('closeAll');
  });

  it('exits 1 and cuts the remaining connections when the deadline passes', async () => {
    vi.useFakeTimers();
    try {
      const server = fakeServer();
      const exit = vi.fn();
      const warn = vi.fn();
      const handle = installGracefulShutdown({ server, proc: new EventEmitter() as never, exit, drainTimeoutMs: 3_000, idleSweepMs: 1_000, log: { info: vi.fn(), warn } });
      const done = handle.shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(2_500);
      expect(exit).not.toHaveBeenCalled();
      // Idle keep-alive sockets are swept while waiting.
      expect(server.calls.filter((c) => c === 'closeIdle').length).toBeGreaterThanOrEqual(3);
      await vi.advanceTimersByTimeAsync(600);
      await done;
      expect(server.calls).toContain('closeAll');
      expect(exit).toHaveBeenCalledWith(1);
      expect(warn).toHaveBeenCalledWith('drain deadline passed; closing the remaining connections', { drainTimeoutMs: 3_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second signal during the drain exits at once', async () => {
    const proc = new EventEmitter();
    const server = fakeServer();
    const exit = vi.fn();
    installGracefulShutdown({ server, proc: proc as never, exit, drainTimeoutMs: 60_000 });
    proc.emit('SIGINT');
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    proc.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
    server.finish(); // let the pending drain settle so no timer is left behind
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('a failing hook or a server that was never listening still ends in an exit', async () => {
    const exit = vi.fn();
    const warn = vi.fn();
    const server: DrainableServer = {
      close(cb) {
        cb?.(new Error('Server is not running.'));
      },
    };
    const handle = installGracefulShutdown({
      server,
      proc: new EventEmitter() as never,
      exit,
      drainTimeoutMs: 1_000,
      log: { info: vi.fn(), warn },
      stopBackground: () => {
        throw new Error('cron stuck');
      },
      afterDrain: async () => {
        throw new Error('pool gone');
      },
    });
    await handle.shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledWith(0);
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['stopping background work failed', 'server close reported an error', 'after-drain hook failed']);
  });

  it('a real server: the running request finishes, new connections are refused, then exit 0', async () => {
    const app = express();
    let release: (() => void) | undefined;
    app.get('/slow', (_req, res) => {
      release = () => res.json({ ok: true });
    });
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    const exit = vi.fn();
    const handle = installGracefulShutdown({ server, proc: new EventEmitter() as never, exit, drainTimeoutMs: 5_000, idleSweepMs: 20 });

    const slow = fetch(`http://127.0.0.1:${port}/slow`);
    await vi.waitFor(() => expect(release).toBeDefined());
    const done = handle.shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exit).not.toHaveBeenCalled();
    await expect(fetch(`http://127.0.0.1:${port}/slow`)).rejects.toThrow();

    release!();
    expect(await (await slow).json()).toEqual({ ok: true });
    await done;
    expect(exit).toHaveBeenCalledWith(0);
  });
});
