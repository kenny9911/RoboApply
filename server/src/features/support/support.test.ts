// @vitest-environment node
//
// WP-40 support area: contact form route (validation, 5/day/IP, delivery
// honesty), the public index counts (public-count predicate with planted
// private rows, rounding down, hourly cache, hero floor input) and the
// public credit caps.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { getBrand } from '../../platform/brand/registry.js';
import { DEFAULT_CREDIT_CATALOG } from '../../platform/credits/index.js';
import { getEmailTemplate, type SendEmailInput, type SendEmailResult } from '../../platform/email/index.js';
import { createEmailTranslator } from '../../platform/email/i18n.js';
import { rateLimit } from '../../platform/ratelimit/index.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { HERO_COUNT_MIN, POPULAR_LIST_MIN_JOBS, type IndexStatsResponse } from './contract.js';
import { SUPPORT_CONTACT_TEMPLATE } from './email.js';
import { CREDIT_CAPS_CACHE_CONTROL, INDEX_STATS_CACHE_CONTROL, INDEX_STATS_PARTIAL_CACHE_CONTROL, SUPPORT_CONTACT_WINDOWS, createSupportRouter } from './routes.js';
import { capsFromCatalog, createSupportService, supportAddress } from './service.js';
import { computeIndexStats, createIndexStatsCache, publicCountWhere, roundDownSignificant, type IndexStatsDb } from './stats.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

// ── A tiny RAJob table that evaluates exactly the predicates stats.ts uses ──

interface Row {
  market: string;
  visibility: string;
  isCanonical: boolean;
  archivedAt: Date | null;
  closedAt: Date | null;
  fraudFlags: unknown;
  firstSeenAt: Date;
  publicDisplay: boolean;
  primaryTaxonomyId: string | null;
}

const base: Row = {
  market: 'intl',
  visibility: 'public',
  isCanonical: true,
  archivedAt: null,
  closedAt: null,
  fraudFlags: null,
  firstSeenAt: new Date(NOW.getTime() - 30 * DAY),
  publicDisplay: false,
  primaryTaxonomyId: null,
};

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      // fraudFlags: AnyNull | []
      const flags = row.fraudFlags;
      if (!(flags === null || (Array.isArray(flags) && flags.length === 0))) return false;
      continue;
    }
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond === null) {
      if (value !== null) return false;
    } else if (typeof cond === 'object' && cond !== null && 'gte' in cond) {
      if (!(value instanceof Date) || value.getTime() < (cond.gte as Date).getTime()) return false;
    } else if (typeof cond === 'object' && cond !== null && 'not' in cond) {
      if (value === (cond as { not: unknown }).not) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function fakeJobs(rows: Row[]): IndexStatsDb & { calls: number } {
  const db = {
    calls: 0,
    rAJob: {
      async count({ where }: { where: Record<string, unknown> }) {
        db.calls += 1;
        return rows.filter((r) => matches(r, where)).length;
      },
      async groupBy({ where, having }: { where: Record<string, unknown>; having: { primaryTaxonomyId: { _count: { gte: number } } } }) {
        const counts = new Map<string, number>();
        for (const r of rows.filter((x) => matches(x, where))) counts.set(r.primaryTaxonomyId!, (counts.get(r.primaryTaxonomyId!) ?? 0) + 1);
        return [...counts.entries()]
          .filter(([, n]) => n >= having.primaryTaxonomyId._count.gte)
          .sort((a, b) => b[1] - a[1])
          .map(([primaryTaxonomyId, n]) => ({ primaryTaxonomyId, _count: { _all: n } }));
      },
    },
  };
  return db as unknown as IndexStatsDb & { calls: number };
}

function many(n: number, over: Partial<Row> = {}): Row[] {
  return Array.from({ length: n }, () => ({ ...base, ...over }));
}

describe('roundDownSignificant', () => {
  it.each([
    [0, 0],
    [-4, 0],
    [7, 7],
    [99, 99],
    [950, 950],
    [999, 990],
    [1_999, 1_900],
    [12_345, 12_000],
    [1_000_500, 1_000_000],
    [98_765.4, 98_000],
  ])('%d → %d', (n, out) => {
    expect(roundDownSignificant(n)).toBe(out);
  });

  it('never rounds up', () => {
    for (let n = 1; n < 50_000; n += 37) expect(roundDownSignificant(n)).toBeLessThanOrEqual(n);
  });
});

describe('public index counts (D3 count rule)', () => {
  it('publicCountWhere filters public, canonical, live, not closed, unflagged, this market', () => {
    expect(publicCountWhere('cn')).toMatchObject({ market: 'cn', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null });
    expect(publicCountWhere('intl')).toHaveProperty('OR');
  });

  it('ignores planted private, other-market, archived, closed, duplicate and flagged rows', async () => {
    const rows = [
      ...many(1_234),
      ...many(500, { visibility: 'private' }),
      ...many(400, { market: 'cn' }),
      ...many(300, { archivedAt: NOW }),
      ...many(200, { closedAt: NOW }),
      ...many(100, { isCanonical: false }),
      ...many(50, { fraudFlags: [{ rule: 'fee', evidence: 'x', at: NOW.toISOString() }] }),
      ...many(10, { fraudFlags: [] }),
    ];
    const stats = await computeIndexStats(fakeJobs(rows), 'intl', NOW);
    // 1,234 + 10 (empty flag list) = 1,244 → 1,200 (rounded down).
    expect(stats.openRoles).toEqual({ value: 1_200, source: 'index', method: 'rounded_down_2_significant_figures', asOf: NOW.toISOString() });
    expect(stats.asOf).toBe(NOW.toISOString());
  });

  it('a market below the hero floor stays below it (the page drops the clause)', async () => {
    const stats = await computeIndexStats(fakeJobs([...many(950), ...many(5_000, { visibility: 'private' })]), 'intl', NOW);
    expect(stats.openRoles?.value).toBe(950);
    expect(stats.openRoles!.value).toBeLessThan(HERO_COUNT_MIN);
  });

  it('counts jobs first seen in the last 7 days', async () => {
    const recent = new Date(NOW.getTime() - 2 * DAY);
    const stats = await computeIndexStats(fakeJobs([...many(40), ...many(321, { firstSeenAt: recent }), ...many(9, { firstSeenAt: recent, visibility: 'private' })]), 'intl', NOW);
    expect(stats.addedThisWeek?.value).toBe(320);
    expect(stats.openRoles?.value).toBe(360);
  });

  it('unknown counts are null, never 0', async () => {
    const broken = { rAJob: { count: () => Promise.reject(new Error('db down')), groupBy: () => Promise.reject(new Error('db down')) } };
    const stats = await computeIndexStats(broken as unknown as IndexStatsDb, 'intl', NOW);
    expect(stats.openRoles).toBeNull();
    expect(stats.addedThisWeek).toBeNull();
    expect(stats.popularLists).toEqual([]);
    expect(stats.partial).toBe(true);
  });

  it('a complete result is not partial', async () => {
    const stats = await computeIndexStats(fakeJobs(many(10)), 'intl', NOW);
    expect(stats.partial).toBe(false);
  });

  it('popular lists need publicDisplay jobs at or above the role floor, labelled from the taxonomy', async () => {
    const rows = [
      ...many(POPULAR_LIST_MIN_JOBS + 5, { publicDisplay: true, primaryTaxonomyId: 'backend_engineer' }),
      ...many(POPULAR_LIST_MIN_JOBS - 1, { publicDisplay: true, primaryTaxonomyId: 'data_scientist' }),
      ...many(60, { publicDisplay: false, primaryTaxonomyId: 'frontend_engineer' }),
      ...many(60, { publicDisplay: true, visibility: 'private', primaryTaxonomyId: 'product_manager' }),
      ...many(30, { publicDisplay: true, primaryTaxonomyId: 'not_a_real_role' }),
    ];
    const stats = await computeIndexStats(fakeJobs(rows), 'intl', NOW);
    expect(stats.popularLists.map((l) => l.taxonomyId)).toEqual(['backend_engineer']);
    expect(stats.popularLists[0]!.label).toMatch(/backend/i);
    expect(stats.popularLists[0]!.labelZh).not.toBe('');
  });

  it('caches per market for an hour', async () => {
    const db = fakeJobs(many(1_500));
    const cache = createIndexStatsCache(() => db, 60 * 60 * 1000);
    await cache.get('intl', NOW);
    const callsAfterFirst = db.calls;
    await cache.get('intl', new Date(NOW.getTime() + 59 * 60 * 1000));
    expect(db.calls).toBe(callsAfterFirst);
    await cache.get('cn', NOW);
    expect(db.calls).toBe(callsAfterFirst * 2);
    await cache.get('intl', new Date(NOW.getTime() + 61 * 60 * 1000));
    expect(db.calls).toBe(callsAfterFirst * 3);
  });

  it('keeps a partial result only briefly, then recomputes', async () => {
    let down = true;
    const healthy = fakeJobs(many(1_500));
    const flaky: IndexStatsDb = {
      rAJob: {
        count: (args) => (down ? Promise.reject(new Error('db blip')) : healthy.rAJob.count(args)),
        groupBy: (args) => (down ? Promise.reject(new Error('db blip')) : healthy.rAJob.groupBy(args)),
      },
    };
    const cache = createIndexStatsCache(() => flaky, 60 * 60 * 1000, 60 * 1000);
    const first = await cache.get('intl', NOW);
    expect(first.partial).toBe(true);
    expect(first.openRoles).toBeNull();
    down = false;
    // Still inside the short window: the partial result is served.
    expect((await cache.get('intl', new Date(NOW.getTime() + 30 * 1000))).partial).toBe(true);
    // Past it: recomputed, and the full result is then kept for the hour.
    const second = await cache.get('intl', new Date(NOW.getTime() + 61 * 1000));
    expect(second.partial).toBe(false);
    expect(second.openRoles?.value).toBe(1_500);
    down = true;
    expect((await cache.get('intl', new Date(NOW.getTime() + 30 * 60 * 1000))).openRoles?.value).toBe(1_500);
  });

  it('does not keep a rejected computation', async () => {
    let fail = true;
    const db = fakeJobs(many(10));
    const cache = createIndexStatsCache(() => {
      if (fail) throw new Error('no connection');
      return db;
    });
    await expect(cache.get('intl', NOW)).rejects.toThrow('no connection');
    fail = false;
    expect((await cache.get('intl', NOW)).openRoles?.value).toBe(10);
  });
});

describe('credit caps', () => {
  it('prints the catalog caps per plan, per brand (no "unlimited")', () => {
    const ra = capsFromCatalog(DEFAULT_CREDIT_CATALOG.roboapply);
    const ga = capsFromCatalog(DEFAULT_CREDIT_CATALOG.goapply);
    expect(ra.buckets.find((b) => b.bucket === 'tailor')).toEqual({ bucket: 'tailor', free: { cap: 2, window: 'day' }, pro: { cap: 50, window: 'day' } });
    expect(ga.buckets.find((b) => b.bucket === 'tailor')!.free.cap).toBe(3);
    expect(ra.buckets.find((b) => b.bucket === 'ready_kits')!.free).toEqual({ cap: 3, window: 'week' });
    expect(ra.entitlements).toEqual({ free: { saved_searches: 1, instant_alerts: 1 }, pro: { saved_searches: 10, instant_alerts: 100 } });
    expect(ra.buckets.map((b) => b.bucket)).not.toContain('contact_lookup');
  });
});

describe('support inbox', () => {
  it('uses the brand env name with no fallback across brands, else the registry address', () => {
    const env = { SUPPORT_EMAIL: 'help@roboapply.example' };
    expect(supportAddress(getBrand('roboapply'), env)).toBe('help@roboapply.example');
    expect(supportAddress(getBrand('goapply'), env)).toBe(getBrand('goapply').email.replyTo);
    expect(supportAddress(getBrand('goapply'), { CN_SUPPORT_EMAIL: 'Help <kefu@goapply.example>' })).toBe('kefu@goapply.example');
  });

  it('the support email escapes everything the visitor typed', () => {
    const template = getEmailTemplate(SUPPORT_CONTACT_TEMPLATE)!;
    const brand = getBrand('roboapply');
    const body = template.render({
      brand,
      t: createEmailTranslator(brand, 'en'),
      origin: brand.canonicalOrigin,
      params: { replyEmail: 'a@b.test', name: null, topic: 'bug', message: '<script>x</script> broke', pageUrl: null, locale: 'en', userId: null },
    });
    expect(template.category).toBe('transactional');
    expect(body.bodyHtml).not.toContain('<script>');
    expect(body.bodyHtml).toContain('&lt;script&gt;');
    expect(body.bodyText).toContain('a@b.test');
    // Reply-To is the brand inbox (platform email); the visitor's address leads
    // the subject so staff see whom to answer from the inbox list.
    expect(body.subject).toContain('a@b.test');
  });
});

// ── Routes ───────────────────────────────────────────────────────────────

function fakeRateDb() {
  const counts = new Map<string, number>();
  return {
    $queryRaw: async (_s: TemplateStringsArray, key: string, windowStart: Date, cost: number) => {
      const k = `${key}@${windowStart.toISOString()}`;
      const next = (counts.get(k) ?? 0) + cost;
      counts.set(k, next);
      return [{ count: next }];
    },
    rARateCounter: {},
  };
}

describe('support routes', () => {
  let h: RouteHarness;
  const sent: SendEmailInput<Record<string, unknown>>[] = [];
  let sendResult: SendEmailResult = { status: 'sent', provider: 'fake' };
  const stats: IndexStatsResponse = {
    openRoles: { value: 12_000, source: 'index', method: 'rounded_down_2_significant_figures', asOf: NOW.toISOString() },
    addedThisWeek: null,
    popularLists: [],
    asOf: NOW.toISOString(),
    partial: false,
  };
  const statsMarkets: string[] = [];
  const service = createSupportService({
    env: { SUPPORT_EMAIL: 'support@roboapply.example', CN_SUPPORT_EMAIL: 'kefu@goapply.example' },
    send: async (input) => {
      sent.push(input);
      return sendResult;
    },
    stats: {
      async get(market) {
        statsMarkets.push(market);
        return stats;
      },
      clear() {},
    },
    creditCatalog: async (brand) => DEFAULT_CREDIT_CATALOG[brand.id],
  });
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
  const limited = rateLimit({ name: 'supportContactPerIp', windows: SUPPORT_CONTACT_WINDOWS, by: 'ip', db: fakeRateDb() as never });

  beforeAll(async () => {
    h = await startRouteHarness({
      env: { NODE_ENV: 'development' },
      mounts: [
        ['/api/v1/roboapply/support', createSupportRouter({ optionalAuth: [passThrough as never], service, contactLimit: passThrough as never })],
        ['/signed-in/support', createSupportRouter({ optionalAuth: [fakeAuth({ id: 'u_42' })], service, contactLimit: passThrough as never })],
        ['/limited/support', createSupportRouter({ optionalAuth: [passThrough as never], service, contactLimit: limited })],
      ],
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  const message = { email: 'Visitor@Example.test', topic: 'billing', message: 'I was charged twice this month.' };

  it('POST /contact validates the body (422)', async () => {
    const res = await h.request<{ code: string }>('POST', '/api/v1/roboapply/support/contact', { host: 'localhost:3621', body: { email: 'nope', topic: 'billing', message: 'short' } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_request');
    const extra = await h.request('POST', '/api/v1/roboapply/support/contact', { host: 'localhost:3621', body: { ...message, admin: true } });
    expect(extra.status).toBe(422);
  });

  it('POST /contact delivers to the brand inbox and answers received', async () => {
    sent.length = 0;
    const res = await h.request<{ success: boolean; data: unknown }>('POST', '/api/v1/roboapply/support/contact', {
      host: 'localhost:3621',
      body: { ...message, pageUrl: 'javascript:alert(1)', locale: 'en' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { received: true } });
    expect(sent[0]).toMatchObject({ to: 'support@roboapply.example', userId: null, template: SUPPORT_CONTACT_TEMPLATE });
    expect(sent[0]!.params).toMatchObject({ replyEmail: 'visitor@example.test', topic: 'billing', pageUrl: null });

    const cn = await h.request('POST', '/api/v1/roboapply/support/contact', { host: 'goapply.localhost:3621', body: message });
    expect(cn.status).toBe(200);
    expect(sent[1]).toMatchObject({ to: 'kefu@goapply.example' });
    expect((sent[1]!.brand as { id: string }).id).toBe('goapply');
  });

  it('POST /contact names the signed-in account', async () => {
    sent.length = 0;
    await h.request('POST', '/signed-in/support/contact', { host: 'localhost:3621', body: message });
    expect(sent[0]).toMatchObject({ userId: 'u_42' });
    expect(sent[0]!.params).toMatchObject({ userId: 'u_42' });
  });

  it('POST /contact never claims delivery when the email did not go out', async () => {
    sendResult = { status: 'suppressed', reason: 'transport_not_configured' };
    const off = await h.request<{ code: string; details: { supportEmail: string } }>('POST', '/api/v1/roboapply/support/contact', { host: 'localhost:3621', body: message });
    expect(off.status).toBe(501);
    expect(off.body.code).toBe('provider_not_configured');
    expect(off.body.details.supportEmail).toBe('support@roboapply.example');

    sendResult = { status: 'failed', provider: 'fake', reason: 'boom' };
    const failed = await h.request<{ code: string; details: { supportEmail: string } }>('POST', '/api/v1/roboapply/support/contact', { host: 'localhost:3621', body: message });
    expect(failed.status).toBe(500);
    expect(failed.body.details.supportEmail).toBe('support@roboapply.example');
    sendResult = { status: 'sent', provider: 'fake' };
  });

  it('POST /contact allows 5 a day per IP, then 429 with Retry-After', async () => {
    const statuses: number[] = [];
    let last: Headers | null = null;
    for (let i = 0; i < 6; i += 1) {
      const res = await h.request('POST', '/limited/support/contact', { host: 'localhost:3621', headers: { 'x-forwarded-for': '203.0.113.9' }, body: message });
      statuses.push(res.status);
      last = res.headers;
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(Number(last!.get('retry-after'))).toBeGreaterThan(0);
  });

  it('GET /index-stats is public, per brand market and CDN-cacheable', async () => {
    statsMarkets.length = 0;
    const ra = await h.request<{ data: IndexStatsResponse }>('GET', '/api/v1/roboapply/support/index-stats', { host: 'localhost:3621' });
    expect(ra.status).toBe(200);
    expect(ra.body.data.openRoles?.value).toBe(12_000);
    expect(ra.headers.get('cache-control')).toBe(INDEX_STATS_CACHE_CONTROL);
    await h.request('GET', '/api/v1/roboapply/support/index-stats', { host: 'goapply.localhost:3621' });
    expect(statsMarkets).toEqual(['intl', 'cn']);
  });

  it('GET /index-stats is not CDN-cached when a count is unknown because a query failed', async () => {
    stats.partial = true;
    try {
      const res = await h.request('GET', '/api/v1/roboapply/support/index-stats', { host: 'localhost:3621' });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe(INDEX_STATS_PARTIAL_CACHE_CONTROL);
    } finally {
      stats.partial = false;
    }
  });

  it('GET /credit-caps answers the brand catalog', async () => {
    const res = await h.request<{ data: { buckets: Array<{ bucket: string; free: { cap: number } }> } }>('GET', '/api/v1/roboapply/support/credit-caps', { host: 'goapply.localhost:3621' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CREDIT_CAPS_CACHE_CONTROL);
    expect(res.body.data.buckets.find((b) => b.bucket === 'tailor')!.free.cap).toBe(3);
  });
});
