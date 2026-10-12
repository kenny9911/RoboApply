// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { Router } from 'express';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { createSqlRecorder, type RecordedSql } from '../../test/sqlSnapshot.js';
import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { runWithBrand } from '../../lib/requestContext.js';
import {
  RATE_LIMITS,
  assertRateLimit,
  consumeRateLimit,
  pruneRateCounters,
  rateLimit,
  rateLimitKey,
  rateLimitWindows,
  windowStartFor,
  type RateLimitDb,
} from './index.js';

/** An in-memory stand-in for the counter table behind the INSERT … ON CONFLICT statement. */
function counterDb() {
  const counts = new Map<string, number>();
  const sql = createSqlRecorder({
    respond: (call: RecordedSql) => {
      if (!call.text.startsWith('INSERT INTO "RARateCounter"')) return undefined;
      const [key, windowStart, cost] = call.values as [string, Date, number];
      const id = `${key}@${windowStart.toISOString()}`;
      const next = (counts.get(id) ?? 0) + cost;
      counts.set(id, next);
      return [{ count: next }];
    },
  });
  return { db: sql.client as unknown as RateLimitDb, sql, counts };
}

const NOW = new Date('2026-10-10T12:00:30.000Z');

describe('consumeRateLimit', () => {
  it('increments atomically with INSERT … ON CONFLICT … RETURNING, one row per window', async () => {
    const { db, sql } = counterDb();
    const r = await consumeRateLimit({ key: 'rl:roboapply:signupPerIp:ip:abc', windows: RATE_LIMITS.signupPerIp, now: NOW, db });
    expect(r).toMatchObject({ allowed: true, retryAfterSec: 0, remaining: 4 });
    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[0]!.text).toBe(
      'INSERT INTO "RARateCounter" ("key", "windowStart", "count", "expiresAt") VALUES ($1, $2, $3, $4) ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "RARateCounter"."count" + EXCLUDED."count" RETURNING "count"',
    );
    expect(sql.calls[0]!.values).toEqual([
      'rl:roboapply:signupPerIp:ip:abc:60',
      new Date('2026-10-10T12:00:00.000Z'),
      1,
      new Date('2026-10-10T12:01:00.000Z'),
    ]);
    expect(sql.calls[1]!.values[0]).toBe('rl:roboapply:signupPerIp:ip:abc:86400');
  });

  it('blocks past the limit with the time until the window resets', async () => {
    const { db } = counterDb();
    const windows = [{ limit: 2, windowSec: 60 }];
    await consumeRateLimit({ key: 'k', windows, now: NOW, db });
    await consumeRateLimit({ key: 'k', windows, now: NOW, db });
    const third = await consumeRateLimit({ key: 'k', windows, now: NOW, db });
    expect(third).toMatchObject({ allowed: false, retryAfterSec: 30, remaining: 0 });
    // A new window starts clean.
    const later = await consumeRateLimit({ key: 'k', windows, now: new Date('2026-10-10T12:01:00.000Z'), db });
    expect(later.allowed).toBe(true);
  });

  it('aligns fixed windows to the epoch', () => {
    expect(windowStartFor(NOW, 3600).toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect(windowStartFor(NOW, 86400).toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });
});

describe('keys', () => {
  it('hash personal identifiers and carry the brand', () => {
    const key = runWithBrand('goapply', () => rateLimitKey('otpPerPhone', 'id', '+8613800000000'));
    expect(key).toMatch(/^rl:goapply:otpPerPhone:id:[0-9a-f]{32}$/);
    expect(key).not.toContain('13800000000');
    expect(rateLimitKey('authenticatedPerUser', 'user', 'user_1', 'roboapply')).toBe('rl:roboapply:authenticatedPerUser:user:user_1');
  });
});

describe('rateLimit middleware', () => {
  let h: RouteHarness;
  let failing: RouteHarness;
  const store = counterDb();
  beforeAll(async () => {
    const r = Router();
    r.post('/login', rateLimit({ name: 'loginPerIp', windows: [{ limit: 2, windowSec: 60 }], db: store.db }), (_req, res) => {
      res.json({ success: true, data: 'ok' });
    });
    r.post(
      '/by-email',
      rateLimit({
        name: 'passwordResetPerEmail',
        key: (req) => (req.body as { email?: string }).email ?? null,
        windows: [{ limit: 1, windowSec: 3600 }],
        db: store.db,
      }),
      (_req, res) => {
        res.json({ success: true, data: 'sent' });
      },
    );
    h = await startRouteHarness({ mounts: [['/r', r]] });

    const broken = { $queryRaw: async () => Promise.reject(new Error('db down')) } as unknown as RateLimitDb;
    const f = Router();
    f.post('/open', rateLimit({ name: 'loginPerIp', db: broken }), (_req, res) => {
      res.json({ success: true });
    });
    f.post('/closed', rateLimit({ name: 'otpPerIp', db: broken, failMode: 'closed' }), (_req, res) => {
      res.json({ success: true });
    });
    failing = await startRouteHarness({ mounts: [['/f', f]] });
  });
  afterAll(async () => {
    await h.close();
    await failing.close();
  });

  it('answers 429 rate_limited with Retry-After once the window is full', async () => {
    expect((await h.request('POST', '/r/login')).status).toBe(200);
    expect((await h.request('POST', '/r/login')).status).toBe(200);
    const blocked = await h.request<{ code: string; details: { retryAfterSec: number } }>('POST', '/r/login');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
    const retry = Number(blocked.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(blocked.body.details.retryAfterSec).toBe(retry);
  });

  it('keys by a custom identifier and skips requests without one', async () => {
    expect((await h.request('POST', '/r/by-email', { body: { email: 'A@x.test' } })).status).toBe(200);
    expect((await h.request('POST', '/r/by-email', { body: { email: 'a@x.test ' } })).status).toBe(429);
    expect((await h.request('POST', '/r/by-email', { body: {} })).status).toBe(200);
    for (const key of store.counts.keys()) expect(key).not.toContain('x.test');
  });

  it('fails open by default and closed when asked', async () => {
    expect((await failing.request('POST', '/f/open')).status).toBe(200);
    const closed = await failing.request('POST', '/f/closed');
    expect(closed.status).toBe(429);
    expect(closed.headers.get('retry-after')).toBe('60');
  });
});

describe('assertRateLimit and defaults', () => {
  it('throws HttpError rate_limited for service-level checks', async () => {
    const { db } = counterDb();
    await assertRateLimit({ name: 'otpPerPhone', id: '+8613800000000', db, now: NOW });
    await expect(assertRateLimit({ name: 'otpPerPhone', id: '+8613800000000', db, now: NOW })).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      details: { retryAfterSec: 30 },
    });
  });

  it('matches ARCHITECTURE.md §3.10 and accepts RATE_LIMITS_JSON overrides', () => {
    expect(RATE_LIMITS.signupPerIp).toEqual([
      { limit: 5, windowSec: 60 },
      { limit: 20, windowSec: 86400 },
    ]);
    expect(RATE_LIMITS.loginPerIp).toEqual([{ limit: 10, windowSec: 60 }]);
    expect(RATE_LIMITS.otpPerPhone).toEqual([
      { limit: 1, windowSec: 60 },
      { limit: 10, windowSec: 86400 },
    ]);
    expect(RATE_LIMITS.otpPerIp).toEqual([{ limit: 30, windowSec: 86400 }]);
    expect(RATE_LIMITS.passwordResetPerEmail).toEqual([{ limit: 5, windowSec: 3600 }]);
    expect(RATE_LIMITS.feedRefresh).toEqual([{ limit: 20, windowSec: 600 }]);
    expect(RATE_LIMITS.visitorCopilotPerIp).toEqual([
      { limit: 10, windowSec: 3600 },
      { limit: 30, windowSec: 86400 },
    ]);
    expect(RATE_LIMITS.publicToolsPerIp).toEqual([{ limit: 3, windowSec: 86400 }]);
    expect(RATE_LIMITS.extensionDevice).toEqual([{ limit: 600, windowSec: 3600 }]);
    expect(RATE_LIMITS.eventsPerAnon).toEqual([{ limit: 120, windowSec: 60 }]);
    expect(RATE_LIMITS.authenticatedPerUser).toEqual([{ limit: 600, windowSec: 60 }]);
    expect(rateLimitWindows('loginPerIp', { RATE_LIMITS_JSON: '{"loginPerIp":[{"limit":20,"windowSec":60}]}' })).toEqual([
      { limit: 20, windowSec: 60 },
    ]);
    expect(rateLimitWindows('loginPerIp', { RATE_LIMITS_JSON: '{"loginPerIp":[{"limit":-1}]}' })).toEqual([
      { limit: 10, windowSec: 60 },
    ]);
    expect(rateLimitWindows('loginPerIp', { RATE_LIMITS_JSON: 'not json' })).toEqual([{ limit: 10, windowSec: 60 }]);
  });

  it('prunes expired counters', async () => {
    const db = createFakePrisma({
      seed: {
        rARateCounter: [
          { key: 'a', expiresAt: new Date('2026-10-10T11:00:00Z') },
          { key: 'b', expiresAt: new Date('2026-10-10T13:00:00Z') },
        ],
      },
    });
    expect(await pruneRateCounters({ db: db as unknown as RateLimitDb, now: NOW })).toEqual({ deleted: 1 });
  });
});
