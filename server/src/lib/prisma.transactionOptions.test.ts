// @vitest-environment node
//
// FIX-9: every Prisma client built by lib/prisma.ts carries client-wide
// interactive-transaction limits. Prisma's defaults (maxWait 2 s, timeout 5 s)
// turned ordinary writes into P2028 500s against the remote database; more
// than 30 `$transaction` call sites pass no options, so the client default is
// what they run with. Nothing here opens a connection: pg, the driver adapter
// and the generated client are replaced by recorders.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ clients: [] as Array<Record<string, unknown>>, pools: [] as Array<Record<string, unknown>> }));

vi.mock('pg', () => ({
  Pool: class {
    constructor(options: Record<string, unknown>) {
      seen.pools.push(options);
    }
    on() {}
  },
}));
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
vi.mock('../generated/prisma/client.js', () => ({
  PrismaClient: class {
    constructor(options: Record<string, unknown>) {
      seen.clients.push(options);
    }
    $on() {}
    $extends() {
      return this;
    }
  },
}));

const URL = 'postgresql://ci@127.0.0.1:1/ci';

async function load() {
  vi.resetModules();
  delete (globalThis as { prisma?: unknown }).prisma;
  return import('./prisma.js');
}

beforeEach(() => {
  seen.clients.length = 0;
  seen.pools.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv('DATABASE_URL', URL);
  vi.stubEnv('PRISMA_KEEPALIVE_ENABLED', 'false');
  vi.stubEnv('PRISMA_TX_MAX_WAIT_MS', '');
  vi.stubEnv('PRISMA_TX_TIMEOUT_MS', '');
  vi.stubEnv('PRISMA_POOL_MAX', '');
  vi.stubEnv('VERCEL', '');
});

afterAll(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { prisma?: unknown }).prisma;
});

describe('interactive-transaction limits', () => {
  it('the singleton client is built with limits above the Prisma defaults (2 s / 5 s)', async () => {
    const mod = await load();
    expect(seen.clients).toHaveLength(1);
    const options = seen.clients[0].transactionOptions as { maxWait: number; timeout: number };
    expect(options).toEqual({ maxWait: mod.DEFAULT_TX_MAX_WAIT_MS, timeout: mod.DEFAULT_TX_TIMEOUT_MS });
    expect(options.maxWait).toBeGreaterThan(2_000);
    expect(options.timeout).toBeGreaterThan(5_000);
    // Prisma must give up before the pool's own connect timeout does.
    expect(options.maxWait).toBeLessThan(seen.pools[0].connectionTimeoutMillis as number);
  });

  it('cross-bank clients get the same limits', async () => {
    const mod = await load();
    mod.createPrismaClientForUrl('postgresql://ci@127.0.0.1:1/bank');
    expect(seen.clients).toHaveLength(2);
    expect(seen.clients[1].transactionOptions).toEqual(seen.clients[0].transactionOptions);
  });

  it('env overrides are honoured; junk falls back to the defaults', async () => {
    const mod = await load();
    expect(mod.resolveTransactionOptions({ PRISMA_TX_MAX_WAIT_MS: '4000', PRISMA_TX_TIMEOUT_MS: '45000' })).toEqual({ maxWait: 4000, timeout: 45000 });
    for (const junk of ['', '0', '-5', 'abc', '1.5', '12s']) {
      expect(mod.resolveTransactionOptions({ PRISMA_TX_MAX_WAIT_MS: junk, PRISMA_TX_TIMEOUT_MS: junk })).toEqual({
        maxWait: mod.DEFAULT_TX_MAX_WAIT_MS,
        timeout: mod.DEFAULT_TX_TIMEOUT_MS,
      });
    }
  });

  it('pool size: 10 on a long-lived process, 1 on Vercel, PRISMA_POOL_MAX wins', async () => {
    const mod = await load();
    expect(seen.pools[0].max).toBe(10);
    expect(mod.resolvePoolMax({})).toBe(10);
    expect(mod.resolvePoolMax({ VERCEL: '1' })).toBe(1);
    expect(mod.resolvePoolMax({ VERCEL: '1', PRISMA_POOL_MAX: '5' })).toBe(5);
    expect(mod.resolvePoolMax({ PRISMA_POOL_MAX: 'many' })).toBe(10);
  });
});
