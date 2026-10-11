// @vitest-environment node
// MKT-5A: the licensed feed (Active Jobs DB window sync) behind its quota gate
// (MARKET_STRATEGY M-2, §1.2 tier 1, §1.4 tier 1, §1.5 closure; JI-7, JC-6).
//
//   - closed gate: the adapter is off and builds no request;
//   - one backfill of the seven-day window, paged by offset and resumed from
//     the stored cursor, never run twice;
//   - one slice per UTC hour, always asked by explicit `date_created` bounds
//     (never `time_frame=1h`), paged by offset; a slice is read before the
//     next backfill page; an outage, a drifting tick and a spent day are
//     simply part of the next slice; a page that is not the slice that was
//     asked never moves the cursor;
//   - the day's posting budget (the plan's usage row of the market), held to
//     what the provider says the plan has left, less the reserve kept for
//     people's own searches;
//   - the vendor's expired feed closes our rows by id, by three clocks, and
//     never loses the new rows of the same fetch; a monthly call that fails
//     and a route that refuses the key never stop the other calls for good;
//   - the filters: country names, exclude_source from 200 enabled boards,
//     optional taxonomies; documented parameter names only;
//   - the mainland sync: "China", `activejobs:cn`, rows outside mainland
//     China dropped.
// No network and no database: the transport is a function of this file, the
// database a fake, the clock a value. Every row is SYNTHETIC (built from
// normalize/__fixtures__/fantastic-feed.json).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../../services/LoggerService.js', () => ({ logger: logged }));

import type { EnvSource, Market } from '../../../../platform/brand/index.js';
import { getBrand } from '../../../../platform/brand/index.js';
import type { FeedRequestFn, FeedResponse } from '../../../../roboapply/v2/lib/raFantasticJobs.js';
import { quotaObservationFrom } from '../../../../roboapply/v2/lib/raExternalJobTypes.js';
import { createFakePrisma } from '../../../../test/fakePrisma.js';
import expiredFixture from '../../normalize/__fixtures__/fantastic-expired.json' with { type: 'json' };
import feedFixture from '../../normalize/__fixtures__/fantastic-feed.json' with { type: 'json' };
import { adapterCostModel, adapterEnabledFor, resetSourceAdaptersForTests } from '../../sources/index.js';
import type { JobSourceAdapter, SourceFetchResult, SourceQuery } from '../../sources/index.js';
import type { FeedGate, FeedQuotaReading } from '../config.js';
import type { IngestDb } from '../db.js';
import { runIngestQuery, type LeasedQueryRow, type PipelineContext } from '../pipeline.js';
import { ensureBankSyncQueries } from '../planner.js';
import { adaptersForBrand, knownIngestProvidersForBrand, listEnabledAdaptersFor, resetBuiltinAdaptersForTests, sourcesForBrand } from '../providers.js';
import { feedGateForMarket, flushProviderQuota, hydrateProviderQuota, recordQuotaObservation, resetProviderQuotaForTests, setQuotaDepsForTests } from '../quota.js';
import { adapterRunsInTick } from '../run.js';
import { createIngestFake } from '../testkit.js';
import {
  FEED_BOARD,
  FEED_BOARD_COUNT_TTL_MS,
  FEED_EXPIRED_PASS_THROUGH_MAX,
  FEED_MONTHLY_RETRY_MS,
  FEED_OPEN_ROWS_PAGE,
  FEED_PAGE_LIMIT,
  FEED_PROVIDER,
  FEED_REQUEST_PARAMS,
  FEED_SOURCE_OF_ATS,
  advanceFeedCursor,
  createFantasticFeedAdapter,
  dueExpiredFrames,
  expiredOutage,
  feedExcludedSources,
  feedExternalId,
  feedLocationFilter,
  feedPageParams,
  feedTaxonomyFilter,
  feedWindowEnd,
  formatFeedCursor,
  newFeedCursor,
  parseFeedCursor,
  planFeedPage,
  resetFeedWarningsForTests,
  rowsOutsideSlice,
  stampExpired,
  type FeedCursor,
  type FeedDb,
} from './fantasticFeed.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A Monday morning, a quarter past nine UTC: the newest window the vendor serves is 07:00 to 08:00. */
const T0 = new Date('2026-10-12T09:15:00.000Z');
const at = (iso: string) => new Date(iso);
const OPEN: FeedGate = { open: true, reason: 'ok', monthlyJobs: 100_000 };
const ROBO_ONLY: EnvSource = { ALLOWED_BRANDS: 'roboapply' };
const BOTH: EnvSource = {};

/** `n` synthetic rows with ids from `firstId`, all indexed at `created` (UTC, no zone: the vendor's format). */
function rows(n: number, firstId: number, created = '2026-10-12T07:30:00', base: Record<string, unknown> = feedFixture.us_offered): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ ...base, id: firstId + i, url: `https://jobs.example/postings/${firstId + i}`, date_created: created }));
}

interface Call {
  route: 'active' | 'expired';
  params: Record<string, string>;
}

/** A `date_created` inside the slice a new-jobs request asks: half an hour before its upper edge, in the vendor's format. */
const inSlice = (call: Call): string => new Date(Date.parse(`${call.params.date_created_lt}Z`) - 30 * 60_000).toISOString().slice(0, 19);
/** A fixture row as if the vendor had indexed it in the hour 07:00 to 08:00 of T0's day (the slice most tests ask). */
const indexedAt0730 = <T extends Record<string, unknown>>(row: T): T => ({ ...row, date_created: '2026-10-12T07:30:00' });
/** The bounds every hourly request carries. */
const slice = (gte: string, lt: string) => ({ time_frame: '7d', date_created_gte: gte, date_created_lt: lt });

/** A transport that answers from a function and records what it was asked. */
function transport(answer: (call: Call, index: number) => FeedResponse | unknown[]): { request: FeedRequestFn; calls: Call[]; active: () => Call[]; expired: () => Call[] } {
  const calls: Call[] = [];
  const request: FeedRequestFn = async (route, params) => {
    const call = { route, params: { ...params } };
    calls.push(call);
    const reply = answer(call, calls.length - 1);
    return Array.isArray(reply) ? { ok: true, status: 200, body: reply, called: true } : reply;
  };
  return { request, calls, active: () => calls.filter((c) => c.route === 'active'), expired: () => calls.filter((c) => c.route === 'expired') };
}

const failed = (error: string, called = true): FeedResponse => ({ ok: false, error, status: called ? 500 : null, called });

/**
 * The database as the feed uses it: the day's postings per usage key (read
 * and added to), our enabled boards per ATS, and our open rows of the board.
 */
function feedDb(options: { used?: Record<string, number>; boards?: Record<string, number>; open?: Array<{ id: string; externalId: string }>; failUsageRead?: 'throws' | 'not_rows'; failUsageWrite?: boolean; failBoards?: boolean } = {}) {
  const used: Record<string, number> = { ...(options.used ?? {}) };
  const usageWrites: Array<{ key: string; day: string; calls: number; returned: number }> = [];
  let boardReads = 0;
  let usageReads = 0;
  const fake = createFakePrisma({
    seed: { rAJob: (options.open ?? []).map((r) => ({ ...r, sourceBoard: FEED_BOARD, archivedAt: null, visibility: 'public' })) },
    sql: {
      respond(call) {
        const t = call.text;
        if (t.startsWith('SELECT "jobsReturned" FROM "RAProviderUsage"')) {
          usageReads += 1;
          if (options.failUsageRead === 'throws') throw new Error('connection refused');
          if (options.failUsageRead === 'not_rows') return 0;
          return [{ jobsReturned: used[String(call.values[0])] ?? 0 }];
        }
        if (t.startsWith('INSERT INTO "RAProviderUsage"')) {
          if (options.failUsageWrite) throw new Error('usage row not writable');
          const [key, day, calls, returned] = call.values as [string, string, number, number];
          usageWrites.push({ key, day, calls, returned });
          used[key] = (used[key] ?? 0) + returned;
          return 1;
        }
        if (t.startsWith('SELECT "ats", COUNT(*)')) {
          boardReads += 1;
          if (options.failBoards) throw new Error('no table');
          return Object.entries(options.boards ?? {}).map(([ats, n]) => ({ ats, n }));
        }
        return undefined;
      },
    },
  });
  return { db: fake as unknown as FeedDb, fake, used, usageWrites, boardReads: () => boardReads, usageReads: () => usageReads };
}

function query(market: Market, cursor?: string | FeedCursor): SourceQuery {
  const stored = typeof cursor === 'string' ? cursor : cursor ? formatFeedCursor(cursor) : undefined;
  return { id: `q-${market}`, provider: FEED_PROVIDER, market, origin: 'bank_sync', params: { q: '', country: '*', datePosted: 'all', ...(stored ? { cursor: stored } : {}) } };
}

/** A cursor whose backfill is done and whose last window ended at `until`. */
function hourly(until: string, over: Partial<FeedCursor> = {}): FeedCursor {
  return { ...newFeedCursor(), phase: 'hourly', until, backfillUntil: '2026-10-05T08:00:00.000Z', lastExpiredHourlyAt: T0.toISOString(), lastExpiredDailyAt: T0.toISOString(), lastExpiredMonthlyAt: T0.toISOString(), ...over };
}

interface Rig {
  adapter: JobSourceAdapter;
  t: ReturnType<typeof transport>;
  store: ReturnType<typeof feedDb>;
  /** Runs one fetch at `now` with the cursor the previous fetch stored (or the one given). */
  fetch: (now: Date, cursor?: string | FeedCursor | null, market?: Market, budgetMs?: number) => Promise<SourceFetchResult>;
  cursor: () => FeedCursor;
  stored: () => string | undefined;
}

function rig(options: { answer: (call: Call, index: number) => FeedResponse | unknown[]; env?: EnvSource; gate?: (market: Market, now: Date) => FeedGate; db?: Parameters<typeof feedDb>[0]; quota?: FeedQuotaReading | null; clock?: () => number }): Rig {
  const t = transport(options.answer);
  const store = feedDb(options.db);
  const adapter = createFantasticFeedAdapter({
    request: t.request,
    gate: options.gate ?? (() => OPEN),
    env: options.env ?? ROBO_ONLY,
    db: () => store.db,
    quota: () => options.quota ?? null,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  let last: string | undefined;
  return {
    adapter,
    t,
    store,
    async fetch(now, cursor, market = 'intl', budgetMs) {
      const use = cursor === null ? undefined : (cursor ?? last);
      const result = await adapter.fetch(query(market, use), { now, ...(budgetMs !== undefined ? { budgetMs } : {}) });
      // The pipeline stores the cursor of a result that is not an error (ingest/pipeline.ts).
      if (!result.error && result.cursor) last = result.cursor;
      return result;
    },
    cursor: () => parseFeedCursor(last),
    stored: () => last,
  };
}

beforeEach(() => {
  resetFeedWarningsForTests();
  for (const fn of Object.values(logged)) fn.mockClear();
});

afterEach(() => {
  resetProviderQuotaForTests();
  vi.unstubAllEnvs();
});

// ── The gate ───────────────────────────────────────────────────────────────

describe('behind the quota gate', () => {
  it('declares what it is: a per-job cursor source of both markets that writes the search adapter\'s board', () => {
    const { adapter } = rig({ answer: () => [] });
    expect([adapter.provider, adapter.kind, [...adapter.markets], adapterCostModel(adapter), [...adapter.sourceBoards], adapter.dailyCallLimit(), adapter.ownRun]).toEqual([
      'activejobs_feed',
      'cursor',
      ['intl', 'cn'],
      'per_job',
      ['activejobs'],
      null,
      undefined,
    ]);
    expect(FEED_PROVIDER).toBe('activejobs_feed');
    expect(FEED_BOARD).toBe('activejobs');
    expect(FEED_PAGE_LIMIT).toBe(1000);
  });

  it("closed (today's free plan): off for both markets, reason plan_too_small, and a fetch builds no request", async () => {
    const closed: FeedGate = { open: false, reason: 'plan_too_small', monthlyJobs: 250 };
    const r = rig({ answer: () => rows(5, 1), gate: () => closed });
    expect(r.adapter.isEnabled()).toBe(false);
    expect(adapterEnabledFor(r.adapter, 'intl')).toBe(false);
    expect(adapterEnabledFor(r.adapter, 'cn')).toBe(false);
    expect(r.adapter.disabledReason!()).toBe('plan_too_small');
    // The tick does not lease its query (it is not a metered-by-calls source whose quota parks queries).
    expect(adapterRunsInTick(r.adapter, 'intl', T0, {})).toBe(false);
    // Even when something hands it a query, nothing is asked and nothing is read from the database.
    const result = await r.fetch(T0, null);
    expect(result).toEqual({ jobs: [], calls: 0, exhausted: true, notes: { feed_gate_closed: 1 } });
    expect(r.t.calls).toEqual([]);
    expect(r.store.usageReads()).toBe(0);
  });

  it('each closed reason reads as the code the admin panels know', () => {
    const codes: Array<[FeedGate['reason'], string]> = [
      // Nothing states the plan's size: the gate has a reason of its own; the registry reports it under the one code the
      // System panel knows for a plan gate (any other code on a used-up plan reads there as 'exhausted' and raises an alert).
      ['plan_unknown', 'plan_too_small'],
      ['plan_too_small', 'plan_too_small'],
      ['no_key', 'no_api_key'],
      ['disabled', 'kill_switch'],
      ['exhausted', 'quota'],
    ];
    for (const [reason, code] of codes) {
      const r = rig({ answer: () => [], gate: () => ({ open: false, reason, monthlyJobs: null }) });
      expect(r.adapter.disabledReason!(), reason).toBe(code);
    }
    expect(rig({ answer: () => [] }).adapter.disabledReason!()).toBeNull();
  });

  it('a gate that throws is closed; the adapter never throws', async () => {
    const r = rig({
      answer: () => rows(1, 1),
      gate: () => {
        throw new Error('gate not readable');
      },
    });
    expect(r.adapter.isEnabled()).toBe(false);
    expect((await r.fetch(T0, null)).jobs).toEqual([]);
    expect(r.t.calls).toEqual([]);
  });

  it('the real gate: off on the free plan, on with a paid one, and the mainland switch closes the mainland only', () => {
    const KEY = { RAPID_API_KEY: 'synthetic-rapidapi-key-0004' };
    const response = (headers: Record<string, string>) => ({ status: 200, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } });
    setQuotaDepsForTests({ db: createFakePrisma() as never, now: () => T0, env: KEY });
    // Before any response was read nothing states the plan's size: the gate says so, the registry code is the plan gate's.
    expect(feedGateForMarket('intl', KEY, T0)).toEqual({ open: false, reason: 'plan_unknown', monthlyJobs: null });
    expect(createFantasticFeedAdapter({ env: KEY, now: () => T0 }).disabledReason!()).toBe('plan_too_small');
    recordQuotaObservation(quotaObservationFrom('activejobs', response({ 'x-ratelimit-requests-limit': '25', 'x-ratelimit-requests-remaining': '20', 'x-ratelimit-requests-reset': '864000', 'x-ratelimit-jobs-limit': '250', 'x-ratelimit-jobs-remaining': '200' }), '', T0));
    const free = createFantasticFeedAdapter({ env: KEY, now: () => T0 });
    expect([adapterEnabledFor(free, 'intl'), adapterEnabledFor(free, 'cn'), free.disabledReason!()]).toEqual([false, false, 'plan_too_small']);

    const paidEnv = { ...KEY, FANTASTIC_MONTHLY_JOBS: '100000' };
    setQuotaDepsForTests({ db: createFakePrisma() as never, now: () => T0, env: paidEnv });
    const paid = createFantasticFeedAdapter({ env: paidEnv, now: () => T0 });
    expect([adapterEnabledFor(paid, 'intl'), adapterEnabledFor(paid, 'cn')]).toEqual([true, true]);
    expect(paid.transport!()).toBe('rapidapi');

    const cnOff = createFantasticFeedAdapter({ env: { ...paidEnv, CN_ACTIVEJOBS_ENABLED: 'false' }, now: () => T0 });
    expect([adapterEnabledFor(cnOff, 'intl'), adapterEnabledFor(cnOff, 'cn')]).toEqual([true, false]);
    const feedOff = createFantasticFeedAdapter({ env: { ...paidEnv, FANTASTIC_FEED_DISABLED: 'true' }, now: () => T0 });
    expect([adapterEnabledFor(feedOff, 'intl'), adapterEnabledFor(feedOff, 'cn')]).toEqual([false, false]);
    expect(createFantasticFeedAdapter({ env: { FANTASTIC_TRANSPORT: 'direct' } }).transport!()).toBe('api');
  });
});

// ── The cursor ─────────────────────────────────────────────────────────────

describe('the cursor', () => {
  it('round-trips, and anything unreadable starts a new sync', () => {
    const c: FeedCursor = {
      ...hourly('2026-10-12T08:00:00.000Z'),
      offset: 1000,
      since: '2026-10-12T07:00:00.000Z',
      highWater: '2026-10-12T07:59:58.000Z',
      lastHourlyAt: T0.toISOString(),
      lastExpiredMonthlyTriedAt: '2026-10-11T09:15:00.000Z',
      expiredGap: true,
      expiredRefusedAt: '2026-10-10T03:00:00.000Z',
    };
    expect(parseFeedCursor(formatFeedCursor(c))).toEqual(c);
    expect(JSON.parse(formatFeedCursor(c))).toMatchObject({ v: 1, phase: 'hourly', window: '7d', offset: 1000 });
    // The frame is always the seven-day window: a stored value that says otherwise is not kept.
    expect(parseFeedCursor(JSON.stringify({ ...c, window: '1h' })).window).toBe('7d');
    for (const bad of [undefined, null, '', 'not json', '[]', '{"v":2,"phase":"hourly"}', '"x"', '{}']) expect(parseFeedCursor(bad as never), String(bad)).toEqual(newFeedCursor());
    // A damaged field is "not stated", never a throw.
    expect(parseFeedCursor('{"v":1,"phase":"hourly","offset":-5,"until":"yesterday","backfillOffset":"many"}')).toEqual({ ...newFeedCursor(), phase: 'hourly' });
    expect(newFeedCursor()).toMatchObject({ v: 1, phase: 'backfill', window: '7d', offset: 0, backfillOffset: 0, until: null, highWater: null, lastExpiredMonthlyTriedAt: null, expiredGap: false, expiredRefusedAt: null });
  });

  it('the upper edge at 09:15 UTC is 08:00: the newest full hour that is an hour old (the vendor serves 07:00 to 08:00 at 09:15)', () => {
    expect(new Date(feedWindowEnd(T0)).toISOString()).toBe('2026-10-12T08:00:00.000Z');
    expect(new Date(feedWindowEnd(at('2026-10-12T09:00:00.000Z'))).toISOString()).toBe('2026-10-12T08:00:00.000Z');
    expect(new Date(feedWindowEnd(at('2026-10-12T09:59:59.999Z'))).toISOString()).toBe('2026-10-12T08:00:00.000Z');
    expect(new Date(feedWindowEnd(at('2026-10-12T10:00:00.000Z'))).toISOString()).toBe('2026-10-12T09:00:00.000Z');
  });
});

// ── The backfill ───────────────────────────────────────────────────────────

describe('the backfill: the seven-day window once, paged by offset', () => {
  it('pages of 1,000, 1,000 and 240 rows: three requests with offsets 0, 1000, 2000; full pages answer "more"; the short page ends it', async () => {
    const pages = [rows(1000, 10_000), rows(1000, 11_000), rows(240, 12_000)];
    const r = rig({ answer: (call) => (call.route === 'active' ? pages[Number(call.params.offset) / 1000]! : []) });

    const first = await r.fetch(T0, null);
    expect(r.t.active()[0]!.params).toEqual({
      time_frame: '7d',
      limit: '1000',
      offset: '0',
      description_format: 'text',
      location: '"United States" OR "Canada" OR "United Kingdom" OR "Ireland" OR "Germany" OR "France" OR "Netherlands" OR "Spain" OR "Italy" OR "Sweden" OR "Australia" OR "Singapore" OR "Taiwan"',
      // The hour edge of the first request: the hourly windows start exactly there.
      date_created_lt: '2026-10-12T08:00:00',
    });
    expect([first.jobs.length, first.calls, first.exhausted, first.error]).toEqual([1000, 1, false, undefined]);
    expect(r.cursor()).toMatchObject({ phase: 'backfill', backfillOffset: 1000, backfillUntil: '2026-10-12T08:00:00.000Z', until: '2026-10-12T08:00:00.000Z', offset: 0 });
    // No expired call while pages are waiting.
    expect(r.t.expired()).toEqual([]);

    const second = await r.fetch(at('2026-10-12T09:16:00.000Z'));
    expect(r.t.active()[1]!.params).toMatchObject({ time_frame: '7d', limit: '1000', offset: '1000', date_created_lt: '2026-10-12T08:00:00' });
    expect([second.jobs.length, second.exhausted]).toEqual([1000, false]);

    const third = await r.fetch(at('2026-10-12T09:17:00.000Z'));
    expect(r.t.active()[2]!.params).toMatchObject({ time_frame: '7d', offset: '2000', date_created_lt: '2026-10-12T08:00:00' });
    expect([third.jobs.length, third.exhausted]).toEqual([240, true]);
    expect(r.cursor()).toMatchObject({ phase: 'hourly', backfillOffset: 0, until: '2026-10-12T08:00:00.000Z', highWater: '2026-10-12T07:30:00.000Z' });
    expect(r.t.active()).toHaveLength(3);
    // The rows carry the search adapter's ids.
    expect(third.jobs[0]).toMatchObject({ externalId: 'activejobs:12000', sourceBoard: 'activejobs' });
  });

  it('a run interrupted between two pages resumes at the stored offset, from the serialised cursor alone', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(call.params.offset === '0' ? 1000 : 240, 20_000 + Number(call.params.offset)) : []) });
    await r.fetch(T0, null);
    const serialised = r.stored()!;
    expect(typeof serialised).toBe('string');
    // Another process, another cron run: nothing but the stored text.
    const later = rig({ answer: (call) => (call.route === 'active' ? rows(240, 21_000) : []) });
    const result = await later.fetch(at('2026-10-12T09:40:00.000Z'), serialised);
    expect(later.t.active()).toHaveLength(1);
    expect(later.t.active()[0]!.params).toMatchObject({ time_frame: '7d', offset: '1000', date_created_lt: '2026-10-12T08:00:00' });
    expect(result.exhausted).toBe(true);
    expect(later.cursor().phase).toBe('hourly');
  });

  it('runs once: after the phase switched no request of the backfill is ever built again', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(3, 30_000 + r.t.calls.length, inSlice(call)) : []) });
    await r.fetch(T0, null);
    expect(r.cursor().phase).toBe('hourly');
    // The same hour: nothing is due.
    const again = await r.fetch(at('2026-10-12T09:45:00.000Z'));
    expect(again.jobs).toEqual([]);
    expect(r.t.active()).toHaveLength(1);
    // Every later request is an hour's slice with a lower bound, never the backfill form (seven days up to the first edge).
    for (let h = 1; h <= 30; h += 1) await r.fetch(new Date(T0.getTime() + h * HOUR));
    const later = r.t.active().slice(1);
    expect(later).toHaveLength(30);
    expect(later.every((c) => c.params.time_frame === '7d' && !!c.params.date_created_gte && !!c.params.date_created_lt)).toBe(true);
    // Consecutive slices share an edge: each starts where the one before it ended, from the backfill's edge on.
    expect(later[0]!.params.date_created_gte).toBe('2026-10-12T08:00:00');
    for (let i = 1; i < later.length; i += 1) expect(later[i]!.params.date_created_gte, String(i)).toBe(later[i - 1]!.params.date_created_lt);
    expect(r.cursor().phase).toBe('hourly');
    // A cursor that says 'hourly' never plans a backfill page, whatever else it holds.
    expect(planFeedPage(hourly('2026-10-12T08:00:00.000Z', { backfillOffset: 5000 }), T0)).toBeNull();
    // Even one that lost its edge (a damaged value): the hour before the current edge is read, never the seven days again.
    const damaged = parseFeedCursor('{"v":1,"phase":"hourly","offset":3000,"until":"not a date","backfillOffset":2000}');
    expect(planFeedPage(damaged, T0)).toMatchObject({
      track: 'hourly',
      request: { timeFrame: '7d', offset: 0, createdGte: '2026-10-12T07:00:00', createdLt: '2026-10-12T08:00:00' },
      cursor: { phase: 'hourly', since: '2026-10-12T07:00:00.000Z', until: '2026-10-12T08:00:00.000Z', offset: 0 },
    });
  });

  it('fresh first: an hour that is due is read before the next backfill page, and the backfill goes on afterwards', async () => {
    const r = rig({ answer: (call) => (call.route !== 'active' ? [] : call.params.date_created_gte ? rows(7, 50_000, inSlice(call)) : rows(1000, 40_000 + Number(call.params.offset))) });
    await r.fetch(T0, null);
    await r.fetch(at('2026-10-12T09:50:00.000Z'));
    expect(r.t.active().map((c) => [c.params.time_frame, c.params.offset])).toEqual([
      ['7d', '0'],
      ['7d', '1000'],
    ]);
    // The next UTC hour: the hour 08:00 to 09:00 first, from the backfill's edge.
    const window = await r.fetch(at('2026-10-12T10:02:00.000Z'));
    expect(r.t.active()[2]!.params).toEqual({ ...slice('2026-10-12T08:00:00', '2026-10-12T09:00:00'), limit: '1000', offset: '0', description_format: 'text', location: expect.any(String) });
    expect(window.jobs).toHaveLength(7);
    // Read to its end, and the backfill still has pages: "more", so the pipeline leases the query again at once.
    expect(window.exhausted).toBe(false);
    expect(r.cursor()).toMatchObject({ phase: 'backfill', backfillOffset: 2000, offset: 0, until: '2026-10-12T09:00:00.000Z' });
    await r.fetch(at('2026-10-12T10:03:00.000Z'));
    expect(r.t.active()[3]!.params).toMatchObject({ time_frame: '7d', offset: '2000', date_created_lt: '2026-10-12T08:00:00' });
  });
});

// ── The hourly slices ──────────────────────────────────────────────────────

describe('one slice per UTC hour, asked by explicit bounds and paged by offset', () => {
  it('two pages of 1,000 and 240 rows produce two requests with offset 0 and 1000, the first answering "more"', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(call.params.offset === '0' ? 1000 : 240, 60_000 + Number(call.params.offset), '2026-10-12T07:45:10') : []) });
    const first = await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    // The hour 07:00 to 08:00, named by its own bounds: never `time_frame=1h`, whose window the vendor describes two ways.
    expect(r.t.active()[0]!.params).toEqual({ ...slice('2026-10-12T07:00:00', '2026-10-12T08:00:00'), limit: '1000', offset: '0', description_format: 'text', location: expect.stringContaining('"United States"') });
    expect([first.jobs.length, first.calls, first.exhausted]).toEqual([1000, 1, false]);
    expect(r.cursor()).toMatchObject({ phase: 'hourly', window: '7d', offset: 1000, since: '2026-10-12T07:00:00.000Z', until: '2026-10-12T08:00:00.000Z', lastHourlyAt: T0.toISOString() });

    const second = await r.fetch(at('2026-10-12T09:15:30.000Z'));
    expect(r.t.active()[1]!.params).toEqual({ ...slice('2026-10-12T07:00:00', '2026-10-12T08:00:00'), limit: '1000', offset: '1000', description_format: 'text', location: expect.any(String) });
    expect([second.jobs.length, second.exhausted]).toEqual([240, true]);
    expect(r.cursor()).toMatchObject({ offset: 0, since: null, until: '2026-10-12T08:00:00.000Z', highWater: '2026-10-12T07:45:10.000Z' });
    expect(r.t.active()).toHaveLength(2);
  });

  it('a run interrupted between the pages resumes at offset 1000 from the stored cursor', async () => {
    const first = rig({ answer: (call) => (call.route === 'active' ? rows(1000, 70_000) : []) });
    await first.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    const serialised = first.stored()!;
    const next = rig({ answer: (call) => (call.route === 'active' ? rows(240, 71_000) : []) });
    await next.fetch(at('2026-10-12T09:25:00.000Z'), serialised);
    expect(next.t.active().map((c) => [c.params.time_frame, c.params.offset, c.params.date_created_gte, c.params.date_created_lt])).toEqual([['7d', '1000', '2026-10-12T07:00:00', '2026-10-12T08:00:00']]);
    expect(next.cursor().offset).toBe(0);
  });

  it('a second fetch within the hour makes no request; the first fetch of the next hour asks the next hour', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(12, 80_000 + r.t.calls.length * 100, inSlice(call)) : []) });
    await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(r.t.active()).toHaveLength(1);
    for (const minute of ['09:16', '09:30', '09:45', '09:59']) {
      const idle = await r.fetch(at(`2026-10-12T${minute}:00.000Z`));
      expect([idle.jobs.length, idle.calls, idle.exhausted], minute).toEqual([0, 0, true]);
    }
    expect(r.t.active()).toHaveLength(1);
    expect(r.store.usageReads()).toBe(1);
    // 10:00:00, forty-five minutes after the first request: a new UTC hour, so the hour 08:00 to 09:00 is due.
    await r.fetch(at('2026-10-12T10:00:00.000Z'));
    expect(r.t.active()).toHaveLength(2);
    expect(r.t.active()[1]!.params).toMatchObject(slice('2026-10-12T08:00:00', '2026-10-12T09:00:00'));
    expect(r.cursor().until).toBe('2026-10-12T09:00:00.000Z');
  });

  it('the first fetch seconds after the hour asks the same slice as one at a quarter past: nothing depends on when in the hour the tick runs', () => {
    const cursor = hourly('2026-10-12T07:00:00.000Z');
    const early = planFeedPage(cursor, at('2026-10-12T09:00:02.000Z'))!.request;
    const late = planFeedPage(cursor, at('2026-10-12T09:59:58.000Z'))!.request;
    expect(early).toEqual({ timeFrame: '7d', offset: 0, createdGte: '2026-10-12T07:00:00', createdLt: '2026-10-12T08:00:00' });
    expect(late).toEqual(early);
  });

  it('a tick that drifts never loses an hour: fetches at 09:55 and 11:02 skip the hour in between, and what it held is in the next slice', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(4, 90_000 + r.t.calls.length * 10, inSlice(call)) : []) });
    await r.fetch(at('2026-10-12T09:55:00.000Z'), hourly('2026-10-12T07:00:00.000Z'));
    // Sixty-seven minutes later the hour 10 was passed over without a fetch.
    await r.fetch(at('2026-10-12T11:02:00.000Z'));
    await r.fetch(at('2026-10-12T11:58:00.000Z'));
    expect(r.t.active().map((c) => [c.params.time_frame, c.params.date_created_gte, c.params.date_created_lt])).toEqual([
      ['7d', '2026-10-12T07:00:00', '2026-10-12T08:00:00'],
      // Both hours since, in one slice: from the edge the last one ended at up to the edge of 11:02 (10:00).
      ['7d', '2026-10-12T08:00:00', '2026-10-12T10:00:00'],
    ]);
    expect(r.cursor().until).toBe('2026-10-12T10:00:00.000Z');
  });

  it('a slice whose paging runs past its hour keeps its own bounds, at the stored offset; the hour that became due is asked next', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(call.params.offset === '0' && call.params.date_created_lt === '2026-10-12T08:00:00' ? 1000 : 240, 100_000 + r.t.calls.length * 2000, inSlice(call)) : []) });
    await r.fetch(at('2026-10-12T09:58:00.000Z'), hourly('2026-10-12T07:00:00.000Z'));
    const result = await r.fetch(at('2026-10-12T10:03:00.000Z'));
    // The hour 07:00 to 08:00 still, although the clock moved on.
    expect(r.t.active()[1]!.params).toEqual({ ...slice('2026-10-12T07:00:00', '2026-10-12T08:00:00'), limit: '1000', offset: '1000', description_format: 'text', location: expect.any(String) });
    expect(result.exhausted).toBe(true);
    expect(r.cursor()).toMatchObject({ offset: 0, since: null, until: '2026-10-12T08:00:00.000Z' });
    await r.fetch(at('2026-10-12T10:04:00.000Z'));
    expect(r.t.active()[2]!.params).toMatchObject({ ...slice('2026-10-12T08:00:00', '2026-10-12T09:00:00'), offset: '0' });
  });

  it('after an outage everything since the last edge is one slice: date_created_gte the edge the last slice ended at, _lt the current edge', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(call.params.offset === '0' && call.params.date_created_lt === '2026-10-12T08:00:00' ? 1000 : 3, 110_000 + r.t.calls.length * 2000, inSlice(call)) : []) });
    const before = hourly('2026-10-11T22:00:00.000Z', { highWater: '2026-10-11T21:58:41.000Z', lastHourlyAt: '2026-10-11T23:05:00.000Z' });
    const result = await r.fetch(T0, before);
    // Ten hours were missed. The lower bound is the edge, not the newest posting seen: that row was already bought.
    expect(r.t.active()[0]!.params).toEqual({ ...slice('2026-10-11T22:00:00', '2026-10-12T08:00:00'), limit: '1000', offset: '0', description_format: 'text', location: expect.any(String) });
    expect(result.exhausted).toBe(false);
    // The slice is fixed for the whole run: the mark moves with the rows, the request does not.
    expect(r.cursor()).toMatchObject({ window: '7d', offset: 1000, since: '2026-10-11T22:00:00.000Z', until: '2026-10-12T08:00:00.000Z', highWater: '2026-10-12T07:30:00.000Z' });
    await r.fetch(at('2026-10-12T10:20:00.000Z'));
    expect(r.t.active()[1]!.params).toMatchObject({ ...slice('2026-10-11T22:00:00', '2026-10-12T08:00:00'), offset: '1000' });
    expect(r.cursor()).toMatchObject({ offset: 0, since: null, until: '2026-10-12T08:00:00.000Z' });
    // Then the hour that became due while it caught up (08:00 to 09:00).
    await r.fetch(at('2026-10-12T10:21:00.000Z'));
    expect(r.t.active()[2]!.params).toMatchObject(slice('2026-10-12T08:00:00', '2026-10-12T09:00:00'));
  });

  it('planFeedPage and advanceFeedCursor, as pure rules', () => {
    const done = hourly('2026-10-12T08:00:00.000Z');
    expect(planFeedPage(done, T0)).toBeNull();
    expect(planFeedPage(done, at('2026-10-12T10:00:00.000Z'))).toMatchObject({
      track: 'hourly',
      request: { timeFrame: '7d', offset: 0, createdGte: '2026-10-12T08:00:00', createdLt: '2026-10-12T09:00:00' },
      cursor: { since: '2026-10-12T08:00:00.000Z', until: '2026-10-12T09:00:00.000Z', offset: 0 },
    });
    expect(planFeedPage(hourly('2026-10-12T03:00:00.000Z'), T0)!.request).toEqual({ timeFrame: '7d', offset: 0, createdGte: '2026-10-12T03:00:00', createdLt: '2026-10-12T08:00:00' });
    // The newest posting seen is not a bound: the mark is kept for the record only.
    expect(planFeedPage(hourly('2026-10-12T03:00:00.000Z', { highWater: '2026-10-12T01:10:00.000Z' }), T0)!.request.createdGte).toBe('2026-10-12T03:00:00');
    expect(planFeedPage(newFeedCursor(), T0)).toMatchObject({ track: 'backfill', request: { timeFrame: '7d', offset: 0, createdGte: null, createdLt: '2026-10-12T08:00:00' } });
    // No request is ever planned as `1h`, and every one has an upper edge.
    for (const cursor of [newFeedCursor(), done, hourly('2026-10-12T03:00:00.000Z'), hourly('2026-10-12T08:00:00.000Z', { offset: 1000, since: '2026-10-12T07:00:00.000Z' })]) {
      for (const now of [T0, at('2026-10-12T10:00:00.000Z'), at('2026-10-14T23:59:00.000Z')]) {
        const planned = planFeedPage(cursor, now);
        if (planned) expect([planned.request.timeFrame, typeof planned.request.createdLt]).toEqual(['7d', 'string']);
      }
    }
    const c = hourly('2026-10-12T08:00:00.000Z', { offset: 1000, since: '2026-10-12T07:00:00.000Z' });
    expect(advanceFeedCursor(c, 'hourly', 1000, 1000, Number.NaN)).toEqual({ cursor: { ...c, offset: 2000 }, more: true });
    expect(advanceFeedCursor(c, 'hourly', 999, 1000, Number.NaN)).toEqual({ cursor: { ...c, offset: 0, since: null }, more: false });
    expect(advanceFeedCursor(c, 'hourly', 0, 1000, Number.NaN).more).toBe(false);
    // A page cut to what the day's budget left is full when it returns that many rows.
    expect(advanceFeedCursor(c, 'hourly', 225, 225, Number.NaN)).toMatchObject({ cursor: { offset: 1225 }, more: true });
    // The mark only moves forward.
    const marked = { ...c, highWater: '2026-10-12T07:00:00.000Z' };
    expect(advanceFeedCursor(marked, 'hourly', 5, 1000, Date.parse('2026-10-12T06:00:00Z')).cursor.highWater).toBe('2026-10-12T07:00:00.000Z');
    expect(advanceFeedCursor(marked, 'hourly', 5, 1000, Date.parse('2026-10-12T07:30:00Z')).cursor.highWater).toBe('2026-10-12T07:30:00.000Z');
  });
});

// ── The page must be the slice that was asked ──────────────────────────────

describe('a page that is not the slice that was asked never moves the cursor', () => {
  const asked = { createdGte: '2026-10-12T07:00:00', createdLt: '2026-10-12T08:00:00' };

  it('rowsOutsideSlice: by each row\'s own date_created, inclusive below, exclusive above, to the second', () => {
    const row = (date_created: unknown) => ({ id: 1, date_created });
    expect(rowsOutsideSlice([row('2026-10-12T07:00:00'), row('2026-10-12T07:59:59'), row('2026-10-12T07:30:00Z')], asked)).toEqual({ dated: 3, outside: 0 });
    // The hour before, the hour after, another day.
    expect(rowsOutsideSlice([row('2026-10-12T06:59:58'), row('2026-10-12T08:00:01'), row('2026-10-09T07:30:00'), row('2026-10-12T07:30:00')], asked)).toEqual({ dated: 4, outside: 3 });
    // A timestamp the vendor rounded onto the edge is inside (one second of tolerance).
    expect(rowsOutsideSlice([row('2026-10-12T08:00:00'), row('2026-10-12T06:59:59')], asked)).toEqual({ dated: 2, outside: 0 });
    // A row that does not say when it was indexed is not judged.
    expect(rowsOutsideSlice([row(null), row('soon'), {}, null, row('2026-10-12T07:10:00')], asked)).toEqual({ dated: 1, outside: 0 });
    // The backfill has no lower bound: only what was indexed after its edge is outside.
    expect(rowsOutsideSlice([row('2026-10-05T09:00:00'), row('2026-10-12T08:30:00')], { createdGte: null, createdLt: '2026-10-12T08:00:00' })).toEqual({ dated: 2, outside: 1 });
  });

  it('rows of another hour (the bounds were not applied): an error, nothing written, the cursor where it was, the same slice asked again', async () => {
    let honoured = false;
    // What a rolling hour, or an API that ignores the bounds, would return at 09:15: postings indexed after 08:00.
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(40, 400_000, honoured ? inSlice(call) : '2026-10-12T08:20:00') : [7]) });
    const start = hourly('2026-10-12T07:00:00.000Z');
    const bad = await r.fetch(T0, start);
    expect(bad).toEqual({ jobs: [], calls: 1, error: 'activejobs_feed:window_not_applied', notes: { feed_out_of_window: 40 } });
    // The pipeline stores no cursor for an error: the hour is not marked as read.
    expect(r.stored()).toBeUndefined();
    // The postings were billed all the same, and are counted.
    expect(r.store.usageWrites).toEqual([{ key: 'activejobs', day: '2026-10-12', calls: 0, returned: 40 }]);
    expect(r.t.expired()).toEqual([]);
    const said = logged.error.mock.calls.find((c) => String(c[1]).includes('not the slice that was asked'));
    expect(said?.[2]).toMatchObject({ market: 'intl', track: 'hourly', rows: 40, outside: 40, createdGte: '2026-10-12T07:00:00', createdLt: '2026-10-12T08:00:00' });
    // The next run asks the very same slice; answered properly, it is read and the cursor moves.
    honoured = true;
    const good = await r.fetch(at('2026-10-12T09:45:00.000Z'), start);
    expect(r.t.active()[1]!.params).toEqual(r.t.active()[0]!.params);
    expect(good.jobs).toHaveLength(40);
    expect(r.cursor().until).toBe('2026-10-12T08:00:00.000Z');
  });

  it('FANTASTIC_FEED_SLICE_CHECK_DISABLED=true is the way out: the page is read, the cursor moves, the mismatch is counted and said', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(40, 405_000, '2026-10-12T08:20:00') : []), env: { ...ROBO_ONLY, FANTASTIC_FEED_SLICE_CHECK_DISABLED: 'true' } });
    const result = await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(result.error).toBeUndefined();
    expect(result.jobs).toHaveLength(40);
    expect(result.notes).toMatchObject({ feed_out_of_window: 40 });
    expect(r.cursor().until).toBe('2026-10-12T08:00:00.000Z');
    expect(logged.warn.mock.calls.some((c) => String(c[1]).includes('read all the same'))).toBe(true);
    expect(logged.error).not.toHaveBeenCalled();
  });

  it('the backfill too: a page of postings indexed after its edge does not start the sync', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(10, 410_000, '2026-10-12T08:40:00') : []) });
    expect(await r.fetch(T0, null)).toMatchObject({ jobs: [], error: 'activejobs_feed:window_not_applied' });
    expect(r.stored()).toBeUndefined();
  });

  it('a few stray rows are counted and the page is read: only a page that is mostly outside stops the sync', async () => {
    const page = [...rows(8, 420_000), ...rows(2, 420_100, '2026-10-12T08:10:00')];
    const r = rig({ answer: (call) => (call.route === 'active' ? page : []) });
    const result = await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(result.error).toBeUndefined();
    expect(result.jobs).toHaveLength(10);
    expect(result.notes).toMatchObject({ feed_out_of_window: 2 });
    expect(r.cursor().until).toBe('2026-10-12T08:00:00.000Z');
    // A page in which no row is dated cannot be judged: it is read.
    const undated = rig({ answer: (call) => (call.route === 'active' ? rows(3, 421_000).map(({ date_created: _d, ...row }) => row) : []) });
    expect((await undated.fetch(T0, hourly('2026-10-12T07:00:00.000Z'))).jobs).toHaveLength(3);
  });
});

// ── The day's posting budget ───────────────────────────────────────────────

describe("the day's posting budget (a hard budget, counted under the plan's own usage row)", () => {
  it('what the plan was billed for is added to jobsReturned under activejobs; the requests are the pipeline\'s to count', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? [...rows(5, 120_000), { id: 'no-title' }] : []) });
    const result = await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    // Six rows were billed, five could be mapped.
    expect(r.store.usageWrites).toEqual([{ key: 'activejobs', day: '2026-10-12', calls: 0, returned: 6 }]);
    expect(result.jobs).toHaveLength(5);
    expect(result.notes).toMatchObject({ feed_unmapped: 1 });
    // The pipeline counts this number under the source's own row (`activejobs_feed`), never under the search adapter's.
    expect(result.calls).toBe(1);
  });

  it('refused once the day reaches the budget: no request, the cursor keeps its place, the expired clocks still run', async () => {
    // A plan of 100,000 a month and a deployment that serves RoboApply only: 3,225 postings a day.
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(1000, 130_000) : [9, 8]), db: { used: { activejobs: 3_225 } } });
    const before = hourly('2026-10-12T07:00:00.000Z', { lastExpiredHourlyAt: '2026-10-12T08:00:00.000Z' });
    const result = await r.fetch(T0, before);
    expect(r.t.active()).toEqual([]);
    expect(result).toMatchObject({ jobs: [], exhausted: true, notes: { feed_budget_reached: 1 } });
    expect(result.error).toBeUndefined();
    expect(r.cursor()).toMatchObject({ until: '2026-10-12T07:00:00.000Z', offset: 0 });
    // Expired calls cost requests, not postings.
    expect(r.t.expired().map((c) => c.params.time_frame)).toEqual(['1h']);
    expect(result.closedExternalIds).toEqual(['activejobs:9', 'activejobs:8']);
    expect(r.store.usageWrites).toEqual([]);
  });

  it('the page is cut to what is left of the day; the next fetch is refused; the next day goes on where it stopped', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(Number(call.params.limit), 140_000 + Number(call.params.offset)) : []), db: { used: { activejobs: 3_000 } } });
    const first = await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(r.t.active()[0]!.params).toMatchObject({ ...slice('2026-10-12T07:00:00', '2026-10-12T08:00:00'), limit: '225', offset: '0' });
    expect([first.jobs.length, first.exhausted]).toEqual([225, false]);
    expect(r.store.used.activejobs).toBe(3_225);
    const second = await r.fetch(at('2026-10-12T09:15:20.000Z'));
    expect(second).toMatchObject({ jobs: [], calls: 0, exhausted: true, notes: { feed_budget_reached: 1 } });
    expect(r.t.active()).toHaveLength(1);
    // The next UTC day: a new usage row, and the unfinished hour by its own bounds from offset 225.
    r.store.used.activejobs = 0;
    await r.fetch(at('2026-10-13T00:05:00.000Z'));
    expect(r.t.active()[1]!.params).toMatchObject({ time_frame: '7d', limit: '1000', offset: '225', date_created_gte: '2026-10-12T07:00:00', date_created_lt: '2026-10-12T08:00:00' });
  });

  it('both brands served: the international sync has the day less the mainland\'s 20%', async () => {
    const intl = rig({ answer: (call) => (call.route === 'active' ? rows(Number(call.params.limit), 150_000) : []), env: BOTH, db: { used: { activejobs: 2_500 } } });
    await intl.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    // 3,225 a day, 645 of it the mainland's: 2,580 for this sync, 80 left.
    expect(intl.t.active()[0]!.params.limit).toBe('80');
    const full = rig({ answer: () => [], env: BOTH, db: { used: { activejobs: 2_580 } } });
    expect((await full.fetch(T0, hourly('2026-10-12T07:00:00.000Z'))).notes).toMatchObject({ feed_budget_reached: 1 });
    expect(full.t.active()).toEqual([]);
  });

  it('INGEST_FEED_DAILY_JOBS is the day', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(3, 160_000) : []), env: { ...ROBO_ONLY, INGEST_FEED_DAILY_JOBS: '400' }, db: { used: { activejobs: 100 } } });
    await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(r.t.active()[0]!.params.limit).toBe('300');
  });

  describe('held to what the plan has left, less the reserve for people\'s own searches (carry-over M3.1)', () => {
    const page = (call: Call) => (call.route === 'active' ? rows(Number(call.params.limit), 163_000) : []);
    const inDays = (days: number) => new Date(T0.getTime() + days * DAY).toISOString();
    const start = () => hourly('2026-10-12T07:00:00.000Z');

    it('10 days and 10,000 postings left of a 100,000 plan: 500 a day, not the 3,225 of month / 31', async () => {
      // The reserve is 5% of the plan's postings (5,000); the other 5,000 are spread over the ten days.
      const r = rig({ answer: page, quota: { jobsLimit: 100_000, jobsRemaining: 10_000, resetAt: inDays(10) } });
      await r.fetch(T0, start());
      expect(r.t.active()[0]!.params.limit).toBe('500');
      // What was counted today comes off it.
      const part = rig({ answer: page, quota: { jobsLimit: 100_000, jobsRemaining: 10_000, resetAt: inDays(10) }, db: { used: { activejobs: 420 } } });
      await part.fetch(T0, start());
      expect(part.t.active()[0]!.params.limit).toBe('80');
      const spent = rig({ answer: page, quota: { jobsLimit: 100_000, jobsRemaining: 10_000, resetAt: inDays(10) }, db: { used: { activejobs: 500 } } });
      expect((await spent.fetch(T0, start())).notes).toMatchObject({ feed_budget_reached: 1 });
      expect(spent.t.active()).toEqual([]);
    });

    it('a plan with most of its month left keeps the month / 31 day: the cap only ever lowers it', async () => {
      const r = rig({ answer: page, quota: { jobsLimit: 100_000, jobsRemaining: 99_000, resetAt: inDays(20) }, db: { used: { activejobs: 3_000 } } });
      await r.fetch(T0, start());
      // (99,000 − 5,000) / 20 = 4,700 a day would be allowed; the day stays 3,225.
      expect(r.t.active()[0]!.params.limit).toBe('225');
    });

    it('people\'s own searches are in the provider\'s count: what they were billed for lowers the feed\'s next day', async () => {
      // Same plan, same day of the period, once with 4,000 postings billed to people's searches (the feed counted none
      // of them). A page asks at most 1,000 rows, so the day shows in a day that is nearly used.
      const left = async (remaining: number, used: number) => {
        const r = rig({ answer: page, quota: { jobsLimit: 100_000, jobsRemaining: remaining, resetAt: inDays(10) }, env: { ...ROBO_ONLY, INGEST_FEED_DAILY_JOBS: '5000' }, db: { used: { activejobs: used } } });
        await r.fetch(T0, start());
        return r.t.active()[0]?.params.limit ?? null;
      };
      // (37,000 − 5,000) / 10 = 3,200; (33,000 − 5,000) / 10 = 2,800.
      expect(await left(37_000, 3_000)).toBe('200');
      expect(await left(33_000, 2_700)).toBe('100');
      expect(await left(33_000, 3_000)).toBeNull();
    });

    it('the reserve is never touched: at or under it nothing is asked, whatever the day says', async () => {
      // No reset time stated: no day's cap, but the page is still cut to what is left above the reserve.
      const low = rig({ answer: page, quota: { jobsLimit: 100_000, jobsRemaining: 5_040, resetAt: null } });
      await low.fetch(T0, start());
      expect(low.t.active()[0]!.params.limit).toBe('40');
      for (const jobsRemaining of [5_000, 4_999, 0]) {
        const none = rig({ answer: page, quota: { jobsLimit: 100_000, jobsRemaining, resetAt: inDays(3) } });
        expect((await none.fetch(T0, start())).notes, String(jobsRemaining)).toMatchObject({ feed_budget_reached: 1 });
        expect(none.t.active()).toEqual([]);
      }
      // A limit the provider did not state: the reserve is one page of a person's search (20 postings).
      const unknownLimit = rig({ answer: page, quota: { jobsLimit: null, jobsRemaining: 60, resetAt: null } });
      await unknownLimit.fetch(T0, start());
      expect(unknownLimit.t.active()[0]!.params.limit).toBe('40');
    });

    it('no remaining count stated (none read yet, or the period has just reset): the month / 31 rule alone, as before', async () => {
      for (const quota of [null, { jobsLimit: 100_000, jobsRemaining: null, resetAt: inDays(10) }] as const) {
        const r = rig({ answer: page, quota, db: { used: { activejobs: 3_000 } } });
        await r.fetch(T0, start());
        expect(r.t.active()[0]!.params.limit).toBe('225');
      }
    });

    it('both brands served: the mainland has 20% of the capped day, the international sync the rest', async () => {
      const quota = { jobsLimit: 100_000, jobsRemaining: 10_000, resetAt: inDays(10) };
      const intl = rig({ answer: page, env: BOTH, quota });
      await intl.fetch(T0, start(), 'intl');
      const cn = rig({ answer: () => [], env: BOTH, quota });
      await cn.fetch(T0, start(), 'cn');
      expect([intl.t.active()[0]!.params.limit, cn.t.active()[0]!.params.limit]).toEqual(['400', '100']);
    });

    it('the real reading: the adapter takes the provider\'s own numbers from the quota snapshot', async () => {
      const response = (headers: Record<string, string>) => ({ status: 200, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } });
      setQuotaDepsForTests({ db: createFakePrisma() as never, now: () => T0, env: {} });
      recordQuotaObservation(quotaObservationFrom('activejobs', response({ 'x-ratelimit-requests-limit': '50000', 'x-ratelimit-requests-remaining': '40000', 'x-ratelimit-requests-reset': String(10 * 86_400), 'x-ratelimit-jobs-limit': '100000', 'x-ratelimit-jobs-remaining': '10000' }), '', T0));
      const t = transport(page);
      const store = feedDb();
      const adapter = createFantasticFeedAdapter({ request: t.request, gate: () => OPEN, env: ROBO_ONLY, db: () => store.db });
      await adapter.fetch(query('intl', start()), { now: T0 });
      expect(t.active()[0]!.params.limit).toBe('500');
    });
  });

  it('a day\'s count that cannot be read keeps the budget hard: an error, no request', async () => {
    const r = rig({ answer: () => rows(3, 170_000), db: { failUsageRead: 'not_rows' } });
    const result = await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(result).toEqual({ jobs: [], calls: 0, error: 'activejobs_feed:usage_unreadable' });
    expect(r.t.calls).toEqual([]);
    // A database that fails: the same, and the error text is a short code (never the database's own message).
    const down = rig({ answer: () => rows(3, 171_000), db: { failUsageRead: 'throws' } });
    expect(await down.fetch(T0, hourly('2026-10-12T07:00:00.000Z'))).toEqual({ jobs: [], calls: 0, error: 'activejobs_feed:Error' });
    expect(down.t.calls).toEqual([]);
    expect(down.stored()).toBeUndefined();
  });

  it('a usage row that cannot be written never loses the rows that were billed', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(4, 180_000) : []), db: { failUsageWrite: true } });
    const result = await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(result.jobs).toHaveLength(4);
    expect(result.error).toBeUndefined();
    expect(logged.warn.mock.calls.some((c) => String(c[1]).includes('billed postings not counted'))).toBe(true);
  });

  it('a sync that falls behind while the day is spent says so', async () => {
    const r = rig({ answer: () => [], db: { used: { activejobs: 9_999 } } });
    await r.fetch(T0, hourly('2026-10-11T20:00:00.000Z', { highWater: '2026-10-11T19:59:00.000Z' }));
    const warning = logged.warn.mock.calls.find((c) => String(c[1]).includes('licensed feed is behind'));
    expect(warning?.[2]).toMatchObject({ market: 'intl', budget: 3_225, used: 9_999, behindHours: 13 });
    // An hour or two behind is the vendor's own delay: no warning.
    logged.warn.mockClear();
    await rig({ answer: () => [], db: { used: { activejobs: 9_999 } } }).fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(logged.warn.mock.calls.some((c) => String(c[1]).includes('licensed feed is behind'))).toBe(false);
  });

  it('a failed new-jobs request writes nothing and keeps the cursor: the same page is asked again', async () => {
    let fail = true;
    const r = rig({ answer: (call) => (call.route !== 'active' ? [] : fail ? failed('http_500') : rows(2, 190_000)) });
    const start = hourly('2026-10-12T07:00:00.000Z');
    const bad = await r.fetch(T0, start);
    expect(bad).toEqual({ jobs: [], calls: 1, error: 'activejobs_feed:http_500' });
    expect(r.stored()).toBeUndefined();
    expect(r.store.usageWrites).toEqual([]);
    expect(r.t.expired()).toEqual([]);
    // A refusal that made no upstream call (the breaker, the gate) counts no call.
    const refused = rig({ answer: () => failed('breaker_open', false) });
    expect(await refused.fetch(T0, start)).toEqual({ jobs: [], calls: 0, error: 'activejobs_feed:breaker_open' });
    fail = false;
    const good = await r.fetch(at('2026-10-12T09:20:00.000Z'), start);
    expect(r.t.active()[1]!.params).toEqual(r.t.active()[0]!.params);
    expect(good.jobs).toHaveLength(2);
  });
});

// ── The expired feed ───────────────────────────────────────────────────────

describe("the vendor's expired feed closes our rows by id", () => {
  const drained = (over: Partial<FeedCursor> = {}) => hourly('2026-10-12T08:00:00.000Z', over);

  it('ids become the externalIds the rows were written with; anything that is not an id is ignored', () => {
    expect(feedExternalId(2900000003)).toBe('activejobs:2900000003');
    expect(feedExternalId('1900000001')).toBe('activejobs:1900000001');
    expect(feedExternalId(' 42 ')).toBe('activejobs:42');
    for (const bad of [null, undefined, 1.5, -3, Number.NaN, '', 'a b', {}, [1], true, 'x'.repeat(80)]) expect(feedExternalId(bad), String(bad)).toBeNull();
  });

  it('the fixture: its ids are reported as closed with reason source_removed, in the same fetch as nothing else', async () => {
    const r = rig({ answer: (call) => (call.route === 'expired' ? expiredFixture : []) });
    const result = await r.fetch(T0, drained({ lastExpiredHourlyAt: '2026-10-12T08:10:00.000Z' }));
    expect(r.t.expired()).toEqual([{ route: 'expired', params: { time_frame: '1h' } }]);
    expect(result.closedExternalIds).toEqual(['activejobs:2900000003', 'activejobs:1900000001', 'activejobs:2999999901', 'activejobs:2999999902']);
    expect(result.closeReason).toBe('source_removed');
    expect(result.calls).toBe(1);
    expect(result.notes).toMatchObject({ feed_expired_ids: 4 });
    expect(r.cursor().lastExpiredHourlyAt).toBe(T0.toISOString());
  });

  it('the hourly call runs at most once an hour', async () => {
    const r = rig({ answer: () => [] });
    await r.fetch(T0, drained({ lastExpiredHourlyAt: '2026-10-12T08:15:00.000Z' }));
    expect(r.t.expired()).toHaveLength(1);
    await r.fetch(at('2026-10-12T09:45:00.000Z'));
    await r.fetch(at('2026-10-12T09:59:00.000Z'));
    expect(r.t.expired()).toHaveLength(1);
    // The new hour of 10:15 is read first (one new-jobs request), then the hour's expired call in the same fetch.
    const next = await r.fetch(at('2026-10-12T10:15:00.000Z'));
    expect(r.t.calls.slice(1).map((c) => [c.route, c.params.time_frame])).toEqual([
      ['active', '7d'],
      ['expired', '1h'],
    ]);
    expect(next.calls).toBe(2);
  });

  it('the daily call runs once per UTC day and only after 01:00 UTC', async () => {
    const yesterday = { lastExpiredHourlyAt: '2026-10-12T00:10:00.000Z', lastExpiredDailyAt: '2026-10-11T01:05:00.000Z', lastExpiredMonthlyAt: '2026-10-01T00:00:00.000Z' };
    expect(dueExpiredFrames(drained(yesterday), at('2026-10-12T00:59:00.000Z'))).toEqual([]);
    expect(dueExpiredFrames(drained(yesterday), at('2026-10-12T01:00:00.000Z'))).toEqual(['1d']);
    expect(dueExpiredFrames(drained(yesterday), at('2026-10-12T01:10:00.000Z'))).toEqual(['1h', '1d']);
    const r = rig({ answer: () => [] });
    await r.fetch(at('2026-10-12T01:10:00.000Z'), hourly('2026-10-12T00:00:00.000Z', yesterday));
    expect(r.t.expired().map((c) => c.params.time_frame)).toEqual(['1h', '1d']);
    expect(r.cursor().lastExpiredDailyAt).toBe('2026-10-12T01:10:00.000Z');
    // The rest of the day: hourly calls only.
    for (const hour of ['02', '08', '15', '23']) await r.fetch(at(`2026-10-12T${hour}:20:00.000Z`));
    expect(r.t.expired().filter((c) => c.params.time_frame === '1d')).toHaveLength(1);
    // The next day, after 01:00.
    await r.fetch(at('2026-10-13T00:30:00.000Z'));
    expect(r.t.expired().filter((c) => c.params.time_frame === '1d')).toHaveLength(1);
    await r.fetch(at('2026-10-13T01:30:00.000Z'));
    expect(r.t.expired().filter((c) => c.params.time_frame === '1d')).toHaveLength(2);
  });

  it('the monthly reconciliation runs once in 30 days; a new sync waits 30 days for its first one', async () => {
    const stamped = { lastExpiredHourlyAt: T0.toISOString(), lastExpiredDailyAt: T0.toISOString() };
    expect(dueExpiredFrames(drained({ ...stamped, lastExpiredMonthlyAt: new Date(T0.getTime() - 29 * DAY).toISOString() }), T0)).toEqual([]);
    expect(dueExpiredFrames(drained({ ...stamped, lastExpiredMonthlyAt: new Date(T0.getTime() - 30 * DAY).toISOString() }), T0)).toEqual(['1m']);
    // One answer covers the hour and the day as well: all three clocks move.
    const c = stampExpired(drained(), '1m', T0);
    expect([c.lastExpiredMonthlyAt, c.lastExpiredDailyAt, c.lastExpiredHourlyAt]).toEqual([T0.toISOString(), T0.toISOString(), T0.toISOString()]);
    expect(stampExpired(drained({ lastExpiredDailyAt: null }), '1h', T0).lastExpiredDailyAt).toBeNull();
    // A sync that starts today holds nothing a month of expirations could close.
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(2, 200_000, inSlice(call)) : []) });
    await r.fetch(T0, null);
    expect(r.t.expired().map((c2) => c2.params.time_frame)).toEqual(['1h', '1d']);
    expect(r.cursor().lastExpiredMonthlyAt).toBe(T0.toISOString());
    await r.fetch(new Date(T0.getTime() + 30 * DAY + HOUR));
    // Answered, the monthly call is the only one of the cycle: it covers the hour and the day.
    expect(r.t.expired().map((c2) => c2.params.time_frame)).toEqual(['1h', '1d', '1m']);
  });

  it('after an outage of more than a day the monthly window is read first; answered, it is the only call of the cycle', async () => {
    const before = drained({ lastExpiredHourlyAt: '2026-10-09T09:00:00.000Z', lastExpiredDailyAt: '2026-10-09T01:10:00.000Z', lastExpiredMonthlyAt: '2026-10-01T00:00:00.000Z' });
    expect(expiredOutage(before, T0)).toBe(true);
    expect(dueExpiredFrames(before, T0)).toEqual(['1m', '1h', '1d']);
    const r = rig({ answer: (call) => (call.route === 'expired' ? [5] : []) });
    const result = await r.fetch(T0, before);
    expect(r.t.expired().map((c) => c.params.time_frame)).toEqual(['1m']);
    expect(result.closedExternalIds).toEqual(['activejobs:5']);
    expect(r.cursor()).toMatchObject({ lastExpiredMonthlyAt: T0.toISOString(), lastExpiredHourlyAt: T0.toISOString(), lastExpiredDailyAt: T0.toISOString(), lastExpiredMonthlyTriedAt: T0.toISOString(), expiredGap: false });
    // A gap of a few hours is what the daily snapshot is for.
    const short = drained({ lastExpiredHourlyAt: '2026-10-12T03:00:00.000Z', lastExpiredDailyAt: '2026-10-12T01:05:00.000Z', lastExpiredMonthlyAt: '2026-10-01T00:00:00.000Z' });
    expect([expiredOutage(short, T0), dueExpiredFrames(short, T0)]).toEqual([false, ['1h']]);
    // The outage is counted from the last answer of ANY frame: a daily answer this morning means no outage.
    expect(expiredOutage(drained({ lastExpiredHourlyAt: '2026-10-09T09:00:00.000Z', lastExpiredDailyAt: '2026-10-12T01:10:00.000Z', lastExpiredMonthlyAt: '2026-10-01T00:00:00.000Z' }), T0)).toBe(false);
    // A cursor with no answer at all (never the case after a first fetch) is no outage.
    expect(expiredOutage(drained({ lastExpiredHourlyAt: null, lastExpiredDailyAt: null, lastExpiredMonthlyAt: null }), T0)).toBe(false);
  });

  it('a monthly call that keeps failing never stops the hourly and daily calls: they run in the same cycle, and the monthly one is tried again a day later', async () => {
    // The monthly answer cannot be read (the vendor calls it very large); the two others answer.
    const r = rig({ answer: (call) => (call.route !== 'expired' ? [] : call.params.time_frame === '1m' ? failed('too_large') : call.params.time_frame === '1h' ? [11] : [12]) });
    // Thirty days after the last reconciliation, and an outage of three days on top.
    const before = drained({ lastExpiredHourlyAt: '2026-10-09T09:00:00.000Z', lastExpiredDailyAt: '2026-10-09T01:10:00.000Z', lastExpiredMonthlyAt: '2026-09-10T00:00:00.000Z' });
    const first = await r.fetch(T0, before);
    expect(r.t.expired().map((c) => c.params.time_frame)).toEqual(['1m', '1h', '1d']);
    expect(first.error).toBeUndefined();
    expect(first.closedExternalIds).toEqual(['activejobs:11', 'activejobs:12']);
    expect(first.notes).toMatchObject({ feed_expired_error: 1 });
    // The hourly and daily clocks are stamped; the monthly one is not, only its attempt is; the gap is remembered.
    expect(r.cursor()).toMatchObject({
      lastExpiredHourlyAt: T0.toISOString(),
      lastExpiredDailyAt: T0.toISOString(),
      lastExpiredMonthlyAt: '2026-09-10T00:00:00.000Z',
      lastExpiredMonthlyTriedAt: T0.toISOString(),
      expiredGap: true,
    });
    // Every later cycle of the day: the hourly call as usual, no monthly call.
    for (let h = 1; h <= 23; h += 1) await r.fetch(new Date(T0.getTime() + h * HOUR));
    const sameDay = r.t.expired().slice(3).map((c) => c.params.time_frame);
    expect(sameDay.filter((f) => f === '1m')).toEqual([]);
    expect(sameDay.filter((f) => f === '1h')).toHaveLength(23);
    expect(sameDay.filter((f) => f === '1d')).toHaveLength(1);
    expect(Date.parse(r.cursor().lastExpiredHourlyAt!)).toBe(T0.getTime() + 23 * HOUR);
    // A day after the attempt it is tried once more, and the hourly call still runs behind it.
    const before2 = r.t.expired().length;
    await r.fetch(new Date(T0.getTime() + FEED_MONTHLY_RETRY_MS));
    expect(r.t.expired().slice(before2).map((c) => c.params.time_frame)).toEqual(['1m', '1h']);
    // Three failing weeks, a fetch every hour: one monthly attempt a day, an hourly answer every hour.
    const hours = 21 * 24;
    for (let h = 25; h < hours; h += 1) await r.fetch(new Date(T0.getTime() + h * HOUR));
    const all = r.t.expired().map((c) => c.params.time_frame);
    expect(all.filter((f) => f === '1m')).toHaveLength(21);
    expect(all.filter((f) => f === '1h')).toHaveLength(hours);
    expect(Date.parse(r.cursor().lastExpiredHourlyAt!)).toBe(T0.getTime() + (hours - 1) * HOUR);
  });

  it('the gap an outage left is remembered until a monthly call is answered, although the hourly calls go on', async () => {
    let monthlyFails = true;
    const r = rig({ answer: (call) => (call.route !== 'expired' ? [] : call.params.time_frame === '1m' ? (monthlyFails ? failed('timeout') : [31]) : []) });
    const before = drained({ lastExpiredHourlyAt: '2026-10-10T09:00:00.000Z', lastExpiredDailyAt: '2026-10-10T01:10:00.000Z', lastExpiredMonthlyAt: '2026-10-01T00:00:00.000Z' });
    await r.fetch(T0, before);
    // The hourly answer ended the outage, and does not cover the two days before it.
    expect([expiredOutage(r.cursor(), new Date(T0.getTime() + HOUR)), r.cursor().expiredGap]).toEqual([false, true]);
    expect(dueExpiredFrames(r.cursor(), new Date(T0.getTime() + 2 * HOUR))).toEqual(['1h']);
    expect(dueExpiredFrames(r.cursor(), new Date(T0.getTime() + FEED_MONTHLY_RETRY_MS))).toEqual(['1m', '1h', '1d']);
    monthlyFails = false;
    const result = await r.fetch(new Date(T0.getTime() + FEED_MONTHLY_RETRY_MS));
    expect(result.closedExternalIds).toEqual(['activejobs:31']);
    expect(r.cursor()).toMatchObject({ expiredGap: false, lastExpiredMonthlyAt: new Date(T0.getTime() + FEED_MONTHLY_RETRY_MS).toISOString() });
    // stampExpired, as a pure rule: an hourly or daily answer after more than 25 silent hours opens the gap, a monthly one closes it.
    const silent = drained({ lastExpiredHourlyAt: '2026-10-11T08:00:00.000Z', lastExpiredDailyAt: '2026-10-11T01:10:00.000Z', lastExpiredMonthlyAt: '2026-10-01T00:00:00.000Z' });
    expect(stampExpired(silent, '1h', T0).expiredGap).toBe(true);
    expect(stampExpired(silent, '1d', T0).expiredGap).toBe(true);
    expect(stampExpired(drained(), '1h', new Date(T0.getTime() + HOUR)).expiredGap).toBe(false);
    expect(stampExpired({ ...silent, expiredGap: true }, '1m', T0)).toMatchObject({ expiredGap: false, lastExpiredMonthlyTriedAt: T0.toISOString() });
  });

  it('a monthly call that was not made at all (the breaker, the gate) is no attempt: nothing is stamped and no other call is tried', async () => {
    const r = rig({ answer: (call) => (call.route === 'expired' ? failed('breaker_open', false) : []) });
    const before = drained({ lastExpiredHourlyAt: '2026-10-09T09:00:00.000Z', lastExpiredDailyAt: '2026-10-09T01:10:00.000Z', lastExpiredMonthlyAt: '2026-10-01T00:00:00.000Z' });
    const result = await r.fetch(T0, before);
    expect(r.t.expired().map((c) => c.params.time_frame)).toEqual(['1m']);
    expect(result.calls).toBe(0);
    expect(r.cursor()).toMatchObject({ lastExpiredMonthlyTriedAt: null, lastExpiredHourlyAt: '2026-10-09T09:00:00.000Z' });
  });

  it('a route that refuses the key (401 / 403) is not asked again before the next UTC day, and the new rows of the fetch are kept', async () => {
    let refused = true;
    const refusal: FeedResponse = { ok: false, error: 'refused', status: 403, called: true };
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(3, 430_000, inSlice(call)) : refused ? refusal : [41]) });
    const before = hourly('2026-10-12T07:00:00.000Z', { lastExpiredHourlyAt: '2026-10-12T08:05:00.000Z', lastExpiredDailyAt: '2026-10-11T01:10:00.000Z' });
    const first = await r.fetch(T0, before);
    // One refused call, not one per frame that was due (the hourly and the daily call share the route).
    expect(r.t.expired().map((c) => c.params.time_frame)).toEqual(['1h']);
    expect(first.error).toBeUndefined();
    expect(first.jobs).toHaveLength(3);
    expect(first.notes).toMatchObject({ feed_expired_refused: 1 });
    expect(first.notes).not.toHaveProperty('feed_expired_error');
    expect(r.cursor()).toMatchObject({ expiredRefusedAt: T0.toISOString(), lastExpiredHourlyAt: '2026-10-12T08:05:00.000Z', until: '2026-10-12T08:00:00.000Z' });
    expect(logged.warn.mock.calls.some((c) => String(c[1]).includes('expired feed route refused the request'))).toBe(true);
    // The rest of the UTC day: the new-jobs side goes on every hour, the expired route is left alone.
    for (const hour of ['10', '15', '23']) await r.fetch(at(`2026-10-12T${hour}:20:00.000Z`));
    expect(r.t.active()).toHaveLength(4);
    expect(r.t.expired()).toHaveLength(1);
    expect(dueExpiredFrames(r.cursor(), at('2026-10-12T23:59:59.000Z'))).toEqual([]);
    // The next UTC day it is asked again; still refused, once more and no further.
    await r.fetch(at('2026-10-13T00:20:00.000Z'));
    await r.fetch(at('2026-10-13T01:20:00.000Z'));
    expect(r.t.expired()).toHaveLength(2);
    expect(r.cursor().expiredRefusedAt).toBe('2026-10-13T00:20:00.000Z');
    // Once the route answers (FANTASTIC_EXPIRED_PATH put right, the plan changed), the clocks run as before.
    refused = false;
    const back = await r.fetch(at('2026-10-14T00:20:00.000Z'));
    expect(back.closedExternalIds).toEqual(['activejobs:41']);
    expect(r.cursor().lastExpiredHourlyAt).toBe('2026-10-14T00:20:00.000Z');
  });

  it('a route that is not there (404: the marketplace named it otherwise) is asked once a day too; any other failure is retried on the next cycle', async () => {
    const gone: FeedResponse = { ok: false, error: 'http_404', status: 404, called: true };
    const r = rig({ answer: (call) => (call.route === 'expired' ? gone : []) });
    const before = drained({ lastExpiredHourlyAt: '2026-10-12T08:00:00.000Z', lastExpiredDailyAt: '2026-10-11T01:10:00.000Z' });
    const first = await r.fetch(T0, before);
    expect(first.notes).toMatchObject({ feed_expired_refused: 1 });
    expect(r.cursor().expiredRefusedAt).toBe(T0.toISOString());
    for (const hour of ['10', '11', '12', '13']) await r.fetch(at(`2026-10-12T${hour}:20:00.000Z`));
    expect(r.t.expired()).toHaveLength(1);
    // A server error says nothing about the route: asked again half an hour later.
    const flaky = rig({ answer: (call) => (call.route === 'expired' ? failed('http_503') : []) });
    await flaky.fetch(T0, before);
    await flaky.fetch(at('2026-10-12T09:45:00.000Z'));
    expect(flaky.t.expired()).toHaveLength(2);
    expect(flaky.cursor().expiredRefusedAt).toBeNull();
  });

  it('a transport error on the expired call does not lose the new rows of the same fetch, and is retried on the next cycle', async () => {
    let expiredFails = true;
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(3, 210_000) : expiredFails ? failed('timeout') : [2900000003]) });
    const before = hourly('2026-10-12T07:00:00.000Z', { lastExpiredHourlyAt: '2026-10-12T08:05:00.000Z' });
    const result = await r.fetch(T0, before);
    // The rows are there, the result is not an error, and the window is read.
    expect(result.error).toBeUndefined();
    expect(result.jobs).toHaveLength(3);
    expect(result.closedExternalIds).toBeUndefined();
    expect(result.notes).toMatchObject({ feed_expired_error: 1 });
    expect(result.calls).toBe(2);
    expect(r.cursor()).toMatchObject({ until: '2026-10-12T08:00:00.000Z', lastExpiredHourlyAt: '2026-10-12T08:05:00.000Z' });
    // The next cycle, half an hour later: the same expired window again, no new-jobs request.
    expiredFails = false;
    const retry = await r.fetch(at('2026-10-12T09:45:00.000Z'));
    expect(r.t.calls.slice(2)).toEqual([{ route: 'expired', params: { time_frame: '1h' } }]);
    expect(retry.closedExternalIds).toEqual(['activejobs:2900000003']);
    expect(r.cursor().lastExpiredHourlyAt).toBe('2026-10-12T09:45:00.000Z');
  });

  it('a failed call stops the cycle\'s expired calls: the clocks behind it are not moved either', async () => {
    const r = rig({ answer: (call) => (call.route === 'expired' ? failed('http_503') : []) });
    const before = drained({ lastExpiredHourlyAt: '2026-10-12T08:00:00.000Z', lastExpiredDailyAt: '2026-10-11T01:10:00.000Z' });
    await r.fetch(T0, before);
    expect(r.t.expired()).toHaveLength(1);
    expect(r.cursor()).toMatchObject({ lastExpiredHourlyAt: '2026-10-12T08:00:00.000Z', lastExpiredDailyAt: '2026-10-11T01:10:00.000Z' });
  });

  it('no expired call while new-jobs pages are waiting (the page run goes first)', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(1000, 220_000) : [1]) });
    const result = await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z', { lastExpiredHourlyAt: '2026-10-12T07:00:00.000Z' }));
    expect(result.exhausted).toBe(false);
    expect(r.t.expired()).toEqual([]);
  });

  it('a long list (a day, a month) is cut down to the rows we hold open before it is handed on; a short one goes as it is', async () => {
    const open = Array.from({ length: FEED_OPEN_ROWS_PAGE + 3 }, (_, i) => ({ id: `j${String(i).padStart(6, '0')}`, externalId: `activejobs:${500_000 + i}` }));
    // 12,000 ids, of which the first 4 are rows we hold (one of them on the second page of our rows).
    const ids = [500_000, 500_001, 500_002, 500_000 + FEED_OPEN_ROWS_PAGE + 1, ...Array.from({ length: FEED_EXPIRED_PASS_THROUGH_MAX + 1_996 }, (_, i) => 9_000_000 + i)];
    const r = rig({ answer: (call) => (call.route === 'expired' ? ids : []), db: { open } });
    const result = await r.fetch(at('2026-10-12T09:15:00.000Z'), drained({ lastExpiredHourlyAt: '2026-10-12T08:10:00.000Z' }));
    expect(result.closedExternalIds).toEqual(['activejobs:500000', 'activejobs:500001', 'activejobs:500002', `activejobs:${500_000 + FEED_OPEN_ROWS_PAGE + 1}`]);
    expect(result.notes).toMatchObject({ feed_expired_ids: ids.length });
    // A short list is not looked up: ids we never stored match no row when ingest archives.
    const short = rig({ answer: (call) => (call.route === 'expired' ? [1, 2, 3] : []), db: { open } });
    expect((await short.fetch(T0, drained({ lastExpiredHourlyAt: '2026-10-12T08:10:00.000Z' }))).closedExternalIds).toEqual(['activejobs:1', 'activejobs:2', 'activejobs:3']);
  });

  it('inside the caller\'s time budget: an expired call that would not fit waits for the next cycle', async () => {
    let elapsed = 0;
    const r = rig({
      answer: (call) => {
        // Every request takes twenty seconds.
        elapsed += 20_000;
        return call.route === 'active' ? rows(1, 230_000) : [];
      },
      clock: () => elapsed,
    });
    const before = hourly('2026-10-12T07:00:00.000Z', { lastExpiredHourlyAt: '2026-10-12T08:00:00.000Z', lastExpiredDailyAt: '2026-10-11T01:10:00.000Z' });
    // 60 s for this fetch: the page (20 s), one expired call (27 s reserve fits at 20 s), not a second one (at 40 s).
    const result = await r.fetch(T0, before, 'intl', 60_000);
    expect(r.t.calls.map((c) => [c.route, c.params.time_frame])).toEqual([
      ['active', '7d'],
      ['expired', '1h'],
    ]);
    expect(result.calls).toBe(2);
    expect(r.cursor().lastExpiredDailyAt).toBe('2026-10-11T01:10:00.000Z');
  });
});

// ── End to end through the pipeline ────────────────────────────────────────

describe('through the ingest pipeline', () => {
  const leased = (market: Market, cursor?: FeedCursor): LeasedQueryRow => ({
    id: `q-${market}`,
    market,
    provider: FEED_PROVIDER,
    params: { q: '', country: '*', datePosted: 'all', ...(cursor ? { cursor: formatFeedCursor(cursor) } : {}) },
    origin: 'bank_sync',
    demandScore: 0,
    priority: 5,
    consecutiveEmpty: 0,
  });
  const openRow = (id: string, externalId: string, sourceBoard = 'activejobs') => ({ id, externalId, sourceBoard, market: 'intl', visibility: 'public', archivedAt: null, closedAt: null, closeReason: null });

  it('an expired id of a stored open row archives that row as source_removed and leaves every other row alone', async () => {
    const pipelineDb = createIngestFake({
      seed: {
        rAJob: [
          openRow('job-1', 'activejobs:2900000003'),
          openRow('job-2', 'activejobs:2900000777'),
          // The same id on another board is another posting.
          openRow('job-3', 'activejobs:2900000003', 'jsearch'),
          // A row a user imported is never closed by a feed.
          { ...openRow('job-4', 'activejobs:1900000001'), visibility: 'private' },
        ],
      },
    });
    const r = rig({ answer: (call) => (call.route === 'expired' ? expiredFixture : []) });
    const ctx: PipelineContext = { db: pipelineDb.db, brand: 'roboapply', market: 'intl', now: T0, enqueueMany: async (items) => ({ inserted: items.length }), publicDisplayProviders: [], env: {} };
    const result = await runIngestQuery(ctx, r.adapter, leased('intl', hourly('2026-10-12T08:00:00.000Z', { lastExpiredHourlyAt: '2026-10-12T08:10:00.000Z' })));
    expect(result).toMatchObject({ status: 'ok', calls: 1, closed: 1 });
    const stored = pipelineDb.fake.$rows('rAJob') as Array<Record<string, unknown>>;
    const byId = (id: string) => stored.find((j) => j.id === id)!;
    expect(byId('job-1')).toMatchObject({ closeReason: 'source_removed', archivedAt: T0, closedAt: T0 });
    for (const id of ['job-2', 'job-3', 'job-4']) expect(byId(id), id).toMatchObject({ archivedAt: null, closeReason: null });
    // The cursor of the run is stored on the query.
    const finish = pipelineDb.fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "lastRunAt"'))!;
    expect(parseFeedCursor(finish.values.find((v) => typeof v === 'string' && v.startsWith('{"v":1')) as string).lastExpiredHourlyAt).toBe(T0.toISOString());
  });

  it('a page is normalised and upserted as activejobs rows of the feed provider; the feed\'s requests are counted under its own usage row', async () => {
    const pipelineDb = createIngestFake();
    const r = rig({ answer: (call) => (call.route === 'active' ? [feedFixture.us_offered, feedFixture.no_flag].map(indexedAt0730) : []) });
    const ctx: PipelineContext = { db: pipelineDb.db, brand: 'roboapply', market: 'intl', now: T0, enqueueMany: async (items) => ({ inserted: items.length }), publicDisplayProviders: [], env: {} };
    const result = await runIngestQuery(ctx, r.adapter, leased('intl', hourly('2026-10-12T07:00:00.000Z')));
    expect(result).toMatchObject({ status: 'ok', calls: 1, more: false });
    expect(pipelineDb.written.map((w) => [w.sourceBoard, w.externalId, w.market])).toEqual([
      ['activejobs', 'activejobs:2900000001', 'intl'],
      ['activejobs', 'activejobs:2900000002', 'intl'],
    ]);
    // The provider's reading is stored as a reading, with the feed as its source; a row without the flag has none.
    expect(pipelineDb.written.map((w) => [w.sponsorship, w.sponsorshipSource])).toEqual([
      ['offered', 'provider:activejobs_feed'],
      [null, null],
    ]);
    // Not metered by calls: no reservation in the day's row, and the run's calls go under `activejobs_feed`.
    expect(pipelineDb.reserved).toEqual([]);
    const usage = pipelineDb.fake.$sql.calls.filter((c) => c.text.startsWith('INSERT INTO "RAProviderUsage"')).map((c) => c.values.slice(0, 4));
    expect(usage).toEqual([['activejobs_feed', '2026-10-12', 1, 2]]);
    // The billed postings went to the plan's row, through the adapter's own database handle.
    expect(r.store.usageWrites).toEqual([{ key: 'activejobs', day: '2026-10-12', calls: 0, returned: 2 }]);
  });

  it('closed gate: the pipeline does not fetch (the adapter is off for the market)', async () => {
    const pipelineDb = createIngestFake();
    const r = rig({ answer: () => rows(2, 240_000), gate: () => ({ open: false, reason: 'plan_too_small', monthlyJobs: 250 }) });
    const ctx: PipelineContext = { db: pipelineDb.db, brand: 'roboapply', market: 'intl', now: T0, env: {} };
    expect(await runIngestQuery(ctx, r.adapter, leased('intl'))).toMatchObject({ status: 'disabled', calls: 0 });
    expect(r.t.calls).toEqual([]);
    expect(pipelineDb.written).toEqual([]);
  });
});

// ── Filters ────────────────────────────────────────────────────────────────

describe('the filters that keep the bill down', () => {
  it('the international request names the configured countries by full name, in double quotes, joined by OR', () => {
    expect(feedLocationFilter('intl', {})).toBe(
      '"United States" OR "Canada" OR "United Kingdom" OR "Ireland" OR "Germany" OR "France" OR "Netherlands" OR "Spain" OR "Italy" OR "Sweden" OR "Australia" OR "Singapore" OR "Taiwan"',
    );
    expect(feedLocationFilter('intl', { INGEST_FEED_COUNTRIES: 'us,TW,us' })).toBe('"United States" OR "Taiwan"');
    // Two codes of one country give its name once.
    expect(feedLocationFilter('intl', { INGEST_FEED_COUNTRIES: 'GB,UK' })).toBe('"United Kingdom"');
    // Never a code: every quoted name is a country's full name.
    expect(feedLocationFilter('intl', {})).not.toMatch(/"[A-Za-z]{2,3}"/);
  });

  it('the mainland request names China only, whatever INGEST_FEED_COUNTRIES says', () => {
    expect(feedLocationFilter('cn', {})).toBe('"China"');
    expect(feedLocationFilter('cn', { INGEST_FEED_COUNTRIES: 'US,JP' })).toBe('"China"');
  });

  it('an unknown ISO code is skipped and logged once, never sent as a code', () => {
    const env = { INGEST_FEED_COUNTRIES: 'US,ZZ,XK,DE' };
    expect(feedLocationFilter('intl', env)).toBe('"United States" OR "Germany"');
    expect(feedLocationFilter('intl', env)).toBe('"United States" OR "Germany"');
    const warnings = logged.warn.mock.calls.filter((c) => String(c[1]).includes('has no name for'));
    expect(warnings.map((c) => (c[2] as { code: string }).code).sort()).toEqual(['XK', 'ZZ']);
  });

  it('CN is left to the mainland sync: each row belongs to one market', () => {
    expect(feedLocationFilter('intl', { INGEST_FEED_COUNTRIES: 'US,CN' })).toBe('"United States"');
    expect(logged.warn.mock.calls.some((c) => String(c[1]).includes('mainland sync'))).toBe(true);
  });

  it('no country left: no request at all (a request without a location would buy the whole world)', async () => {
    expect(feedLocationFilter('intl', { INGEST_FEED_COUNTRIES: 'ZZ' })).toBeNull();
    const r = rig({ answer: () => rows(2, 250_000), env: { ...ROBO_ONLY, INGEST_FEED_COUNTRIES: 'ZZ,USA' } });
    const result = await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(result.notes).toMatchObject({ feed_no_countries: 1 });
    expect(r.t.active()).toEqual([]);
  });

  it('exclude_source: an ATS is excluded only from 200 enabled boards of our own (critic C14)', () => {
    expect(feedExcludedSources(new Map([['greenhouse', 180], ['lever', 210]]))).toEqual(['lever.co']);
    expect(feedExcludedSources(new Map([['greenhouse', 199]]))).toEqual([]);
    expect(feedExcludedSources(new Map([['greenhouse', 200]]))).toEqual(['greenhouse']);
    expect(feedExcludedSources(new Map())).toEqual([]);
    // The seed as merged at the M4 gate: 313 Greenhouse, 128 Ashby, 36 Lever, 35 SmartRecruiters.
    expect(feedExcludedSources(new Map([['greenhouse', 313], ['ashby', 128], ['lever', 36], ['smartrecruiters', 35]]))).toEqual(['greenhouse']);
    // The mainland stack's own seed: 28 Greenhouse boards.
    expect(feedExcludedSources(new Map([['greenhouse', 28]]))).toEqual([]);
    // Sorted, so the same counts always give the same request; an ATS the vendor has no name for is never sent.
    expect(feedExcludedSources(new Map([['workable', 900], ['beisen', 900], ['ashby', 900], ['smartrecruiters', 200], ['constructor', 900], ['toString', 900]]))).toEqual(['ashby', 'smartrecruiters', 'workable']);
  });

  it("the name map holds the vendor's own source values for the ATSs we read (its Supported ATS Sources page)", () => {
    expect(FEED_SOURCE_OF_ATS).toEqual({ greenhouse: 'greenhouse', lever: 'lever.co', ashby: 'ashby', smartrecruiters: 'smartrecruiters', workable: 'workable', recruitee: 'recruitee', personio: 'personio' });
  });

  it('the request excludes lever.co and not greenhouse with 180 enabled Greenhouse and 210 enabled Lever boards; nothing with no boards', async () => {
    const page = (call: Call) => (call.route === 'active' ? rows(1, 260_000) : []);
    const r = rig({ answer: page, db: { boards: { greenhouse: 180, lever: 210, ashby: 12 } } });
    await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(r.t.active()[0]!.params.exclude_source).toBe('lever.co');
    // The statement counts enabled rows only, grouped by ATS.
    const sql = r.store.fake.$sql.calls.find((c) => c.text.startsWith('SELECT "ats", COUNT(*)'))!;
    expect(sql.text).toBe('SELECT "ats", COUNT(*)::int AS "n" FROM "RACareerSiteSource" WHERE "enabled" = true GROUP BY "ats"');
    const none = rig({ answer: page });
    await none.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(none.t.active()[0]!.params).not.toHaveProperty('exclude_source');
    // A count that cannot be read excludes nothing (and is said).
    const broken = rig({ answer: page, db: { failBoards: true } });
    await broken.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(broken.t.active()[0]!.params).not.toHaveProperty('exclude_source');
    expect(logged.warn.mock.calls.some((c) => String(c[1]).includes('enabled boards not counted'))).toBe(true);
  });

  it('the board count is one cheap statement, reused for ten minutes', async () => {
    let ms = 0;
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(1000, 270_000 + Number(call.params.offset)) : []), db: { boards: { greenhouse: 313 } }, clock: () => ms });
    await r.fetch(T0, null);
    ms += FEED_BOARD_COUNT_TTL_MS - 1;
    await r.fetch(at('2026-10-12T09:20:00.000Z'));
    expect(r.store.boardReads()).toBe(1);
    ms += 1;
    await r.fetch(at('2026-10-12T09:26:00.000Z'));
    expect(r.store.boardReads()).toBe(2);
    expect(r.t.active().every((c) => c.params.exclude_source === 'greenhouse')).toBe(true);
  });

  it('INGEST_FEED_TAXONOMIES: the documented names as the taxonomy filter; none by default', async () => {
    expect(feedTaxonomyFilter({})).toEqual({ names: [], invalid: false });
    expect(feedTaxonomyFilter({ INGEST_FEED_TAXONOMIES: 'Software, Data & Analytics' })).toEqual({ names: ['Software', 'Data & Analytics'], invalid: false });
    const r = rig({ answer: (call) => (call.route === 'active' ? rows(1, 280_000) : []), env: { ...ROBO_ONLY, INGEST_FEED_TAXONOMIES: 'Software,Healthcare,Underwater Welding' } });
    await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(r.t.active()[0]!.params.ai_taxonomies_a).toBe('Software,Healthcare');
    expect(logged.warn.mock.calls.filter((c) => String(c[1]).includes('does not document'))).toHaveLength(1);
    // No title filter, and no taxonomy filter, by default.
    const plain = rig({ answer: (call) => (call.route === 'active' ? rows(1, 281_000) : []) });
    await plain.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(Object.keys(plain.t.active()[0]!.params)).not.toEqual(expect.arrayContaining(['ai_taxonomies_a']));
    expect(plain.t.active()[0]!.params).not.toHaveProperty('title');
  });

  it('a cap that cannot be applied never becomes "no cap": taxonomies that are all unknown make no request', async () => {
    expect(feedTaxonomyFilter({ INGEST_FEED_TAXONOMIES: 'software,Tech' })).toEqual({ names: [], invalid: true });
    const r = rig({ answer: () => rows(2, 290_000), env: { ...ROBO_ONLY, INGEST_FEED_TAXONOMIES: 'software' } });
    const result = await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'));
    expect(result.notes).toMatchObject({ feed_bad_taxonomies: 1 });
    expect(r.t.active()).toEqual([]);
  });

  it('every request is built from the documented parameter names and nothing else; agencies are not excluded; no organisation details are asked for', async () => {
    const r = rig({
      answer: (call) => (call.route === 'active' ? rows(call.params.offset === '0' && !call.params.date_created_gte ? 1000 : 2, 300_000 + r.t.calls.length * 2000, inSlice(call)) : []),
      env: { ...ROBO_ONLY, INGEST_FEED_TAXONOMIES: 'Software' },
      db: { boards: { greenhouse: 400 } },
    });
    // A backfill page, its second page, an hour's slice, a slice of four hours.
    await r.fetch(T0, null);
    await r.fetch(at('2026-10-12T09:16:00.000Z'));
    await r.fetch(at('2026-10-12T10:16:00.000Z'));
    await r.fetch(at('2026-10-12T14:16:00.000Z'));
    expect(r.t.active().length).toBeGreaterThanOrEqual(4);
    const seen = new Set<string>();
    for (const call of r.t.active()) {
      for (const name of Object.keys(call.params)) {
        expect(FEED_REQUEST_PARAMS, name).toContain(name);
        seen.add(name);
      }
      expect(call.params.description_format).toBe('text');
      expect(call.params).not.toHaveProperty('organization_agency');
      expect(call.params).not.toHaveProperty('include_basic_organization_details');
      expect(call.params).not.toHaveProperty('title');
    }
    // All nine names were exercised.
    expect([...seen].sort()).toEqual([...FEED_REQUEST_PARAMS].sort());
    for (const call of r.t.expired()) expect(Object.keys(call.params)).toEqual(['time_frame']);
    expect(feedPageParams({ request: { timeFrame: '7d', offset: 0, createdGte: null, createdLt: '2026-10-12T08:00:00' }, limit: 1000, location: '"China"', excludeSources: [], taxonomies: [] })).toEqual({
      time_frame: '7d',
      limit: '1000',
      offset: '0',
      description_format: 'text',
      location: '"China"',
      date_created_lt: '2026-10-12T08:00:00',
    });
    // The frame is never the hourly one.
    expect(r.t.active().every((c) => c.params.time_frame === '7d')).toBe(true);
  });
});

// ── The mainland sync ──────────────────────────────────────────────────────

describe('the mainland sync (JC-6)', () => {
  const cnRows = (): Record<string, unknown>[] =>
    [feedFixture.cn_shanghai, feedFixture.cn_hongkong, { ...feedFixture.cn_shanghai, id: 2900000099, url: 'https://career5.successfactors.example/career?career_job_req_id=40999', locations_derived: ['Taipei, Taiwan'], cities_derived: ['Taipei'], countries_derived: ['Taiwan'] }].map(indexedAt0730);

  it('asks for China only, counts under activejobs:cn against the mainland\'s own budget, and sends nothing a person typed', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? cnRows() : []), env: BOTH });
    const result = await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'), 'cn');
    const params = r.t.active()[0]!.params;
    expect(params).toEqual({ ...slice('2026-10-12T07:00:00', '2026-10-12T08:00:00'), limit: '645', offset: '0', description_format: 'text', location: '"China"' });
    // The usage row of the mainland: the three rows the plan was billed for.
    expect(r.store.usageWrites).toEqual([{ key: 'activejobs:cn', day: '2026-10-12', calls: 0, returned: 3 }]);
    expect(r.store.fake.$sql.calls.find((c) => c.text.startsWith('SELECT "jobsReturned"'))!.values).toEqual(['activejobs:cn', '2026-10-12']);
    // Only parameters of the allow-list, whose values are a window, a page, a format and a country name.
    for (const name of Object.keys(params)) expect(FEED_REQUEST_PARAMS).toContain(name);
    expect(result.error).toBeUndefined();
  });

  it('a row the vendor files under China that is in Hong Kong or Taiwan is not written to the mainland index (wrong_market)', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? cnRows() : []), env: BOTH });
    const result = await r.fetch(T0, hourly('2026-10-12T07:00:00.000Z'), 'cn');
    expect(result.jobs.map((j) => j.externalId)).toEqual(['activejobs:2900000003']);
    expect(result.notes).toMatchObject({ wrong_market: 2 });
    // The same rows read by the international sync: the mainland posting is the one left out.
    const intl = rig({ answer: (call) => (call.route === 'active' ? cnRows() : []), env: BOTH });
    const other = await intl.fetch(T0, hourly('2026-10-12T07:00:00.000Z'), 'intl');
    expect(other.jobs.map((j) => j.externalId)).toEqual(['activejobs:2900000004', 'activejobs:2900000099']);
    expect(other.notes).toMatchObject({ wrong_market: 1 });
  });

  it('through the pipeline the mainland row is written in market cn with its employer apply link and its source', async () => {
    const pipelineDb = createIngestFake();
    const r = rig({ answer: (call) => (call.route === 'active' ? cnRows() : []), env: BOTH });
    const ctx: PipelineContext = { db: pipelineDb.db, brand: 'goapply', market: 'cn', now: T0, enqueueMany: async (items) => ({ inserted: items.length }), publicDisplayProviders: [], env: {} };
    const leased: LeasedQueryRow = { id: 'q-cn', market: 'cn', provider: FEED_PROVIDER, params: { q: '', country: '*', datePosted: 'all', cursor: formatFeedCursor(hourly('2026-10-12T07:00:00.000Z')) }, origin: 'bank_sync', demandScore: 0, priority: 5, consecutiveEmpty: 0 };
    const result = await runIngestQuery(ctx, r.adapter, leased);
    expect(result.status).toBe('ok');
    expect(result.notes).toMatchObject({ wrong_market: 2 });
    expect(pipelineDb.written).toHaveLength(1);
    expect(pipelineDb.written[0]).toMatchObject({ market: 'cn', sourceBoard: 'activejobs', externalId: 'activejobs:2900000003', applyUrl: feedFixture.cn_shanghai.url });
    // The pipeline's own count of the run goes under the mainland key of the source.
    expect(pipelineDb.fake.$sql.calls.filter((c) => c.text.startsWith('INSERT INTO "RAProviderUsage"')).map((c) => c.values[0])).toEqual(['activejobs_feed:cn']);
  });

  it('the mainland budget is its own: 20% of the day, or INGEST_FEED_CN_DAILY_JOBS; spent, the mainland sync stops and the international one goes on', async () => {
    const used = { 'activejobs:cn': 645, activejobs: 10 };
    const cn = rig({ answer: () => cnRows(), env: BOTH, db: { used } });
    expect((await cn.fetch(T0, hourly('2026-10-12T07:00:00.000Z'), 'cn')).notes).toMatchObject({ feed_budget_reached: 1 });
    expect(cn.t.active()).toEqual([]);
    const intl = rig({ answer: (call) => (call.route === 'active' ? rows(2, 310_000) : []), env: BOTH, db: { used } });
    expect((await intl.fetch(T0, hourly('2026-10-12T07:00:00.000Z'), 'intl')).jobs).toHaveLength(2);
    const more = rig({ answer: (call) => (call.route === 'active' ? cnRows() : []), env: { INGEST_FEED_CN_DAILY_JOBS: '700' }, db: { used } });
    await more.fetch(T0, hourly('2026-10-12T07:00:00.000Z'), 'cn');
    expect(more.t.active()[0]!.params.limit).toBe('55');
  });

  it('the same slices and expired handling as the international sync', async () => {
    const r = rig({ answer: (call) => (call.route === 'active' ? [] : [2900000003]), env: BOTH });
    const result = await r.fetch(T0, hourly('2026-10-12T04:00:00.000Z', { highWater: '2026-10-12T03:50:00.000Z', lastExpiredHourlyAt: '2026-10-12T08:00:00.000Z' }), 'cn');
    expect(r.t.active()[0]!.params).toMatchObject({ ...slice('2026-10-12T04:00:00', '2026-10-12T08:00:00'), location: '"China"' });
    expect(result.closedExternalIds).toEqual(['activejobs:2900000003']);
    expect(result.closeReason).toBe('source_removed');
  });

  it('the planner gives the feed one standing query per market it is on for', async () => {
    const created: Array<Record<string, unknown>> = [];
    const db = { rAIngestQuery: { createMany: async (args: { data: Array<Record<string, unknown>> }) => (created.push(...args.data), { count: args.data.length }) }, $executeRaw: async () => 0 } as unknown as IngestDb;
    const both = rig({ answer: () => [] }).adapter;
    await ensureBankSyncQueries(db, 'intl', [both]);
    await ensureBankSyncQueries(db, 'cn', [both]);
    expect(created.map((q) => [q.provider, q.market, q.origin])).toEqual([
      ['activejobs_feed', 'intl', 'bank_sync'],
      ['activejobs_feed', 'cn', 'bank_sync'],
    ]);
    // Off for the mainland (CN_ACTIVEJOBS_ENABLED=false): no mainland query.
    created.length = 0;
    const intlOnly = rig({ answer: () => [], gate: (market) => (market === 'cn' ? { open: false, reason: 'disabled', monthlyJobs: 100_000 } : OPEN) }).adapter;
    await ensureBankSyncQueries(db, 'intl', [intlOnly]);
    await ensureBankSyncQueries(db, 'cn', [intlOnly]);
    expect(created.map((q) => q.market)).toEqual(['intl']);
  });
});

// ── The brand lists ────────────────────────────────────────────────────────

describe('the feed in the brand lists (providers.ts)', () => {
  const robo = getBrand('roboapply');
  const go = getBrand('goapply');
  const KEY = 'synthetic-rapidapi-key-0005';

  beforeEach(() => {
    resetSourceAdaptersForTests();
    resetBuiltinAdaptersForTests();
    resetProviderQuotaForTests();
    vi.stubEnv('RAPID_API_KEY', KEY);
    vi.stubEnv('FANTASTIC_MONTHLY_JOBS', '');
    vi.stubEnv('FANTASTIC_FEED_DISABLED', '');
    vi.stubEnv('FANTASTIC_TRANSPORT', '');
    vi.stubEnv('CN_ACTIVEJOBS_ENABLED', '');
    vi.stubEnv('INGEST_ACTIVEJOBS_CN_DAILY_CALLS', '');
    vi.stubEnv('RA_ONBOARDING_EXTERNAL_JOBS_DISABLED', '');
    vi.stubEnv('RA_ONBOARDING_ACTIVEJOBS_DISABLED', '');
  });
  afterEach(() => {
    resetSourceAdaptersForTests();
    resetBuiltinAdaptersForTests();
  });

  it("closed (today's plan): the feed is described as off for both brands, and is no ingest adapter of either", () => {
    const described = sourcesForBrand(robo, {}).find((s) => s.provider === FEED_PROVIDER)!;
    expect(described).toMatchObject({ provider: 'activejobs_feed', kind: 'search', market: 'intl', costModel: 'per_job', sourceBoards: ['activejobs'] });
    // No response was read in this process and no plan size is set: the gate's own reason says so; the registry
    // reports the plan gate's one code either way (the System panel turns it into 'gated').
    expect(feedGateForMarket('intl').reason).toBe('plan_unknown');
    expect(described.status()).toEqual({ enabled: false, transport: 'rapidapi', reason: 'plan_too_small' });
    recordQuotaObservation({ provider: 'activejobs', status: 200, requestsLimit: 25, requestsRemaining: 20, resetSeconds: 864_000, jobsLimit: 250, jobsRemaining: 112, plan: null, reason: null, at: new Date() });
    expect(feedGateForMarket('intl').reason).toBe('plan_too_small');
    expect(described.status()).toEqual({ enabled: false, transport: 'rapidapi', reason: 'plan_too_small' });
    // Directly after the search adapter of the same plan.
    expect(sourcesForBrand(robo, {}).map((s) => s.provider).slice(0, 2)).toEqual(['activejobs', 'activejobs_feed']);
    expect(sourcesForBrand(go, {}).map((s) => s.provider)).toContain('activejobs_feed');
    for (const brand of [robo, go]) {
      expect(adaptersForBrand(brand, {}).map((a) => a.provider), brand.id).not.toContain('activejobs_feed');
      expect(listEnabledAdaptersFor(brand, {}).map((a) => a.provider), brand.id).not.toContain('activejobs_feed');
    }
    // RoboApply's own list is what it was.
    expect(adaptersForBrand(robo, {}).map((a) => a.provider)).toEqual(['activejobs', 'bank_robohire', 'jsearch']);
  });

  it('open (a paid plan): RoboApply runs it after the search adapter, GoApply runs it too', () => {
    vi.stubEnv('FANTASTIC_MONTHLY_JOBS', '100000');
    expect(adaptersForBrand(robo, {}).map((a) => a.provider)).toEqual(['activejobs', 'activejobs_feed', 'bank_robohire', 'jsearch']);
    expect(adaptersForBrand(go, {}).map((a) => a.provider)).toContain('activejobs_feed');
    expect(sourcesForBrand(robo, {}).find((s) => s.provider === FEED_PROVIDER)!.status()).toEqual({ enabled: true, transport: 'rapidapi', reason: null });
    // The feed's own switch takes it out again.
    vi.stubEnv('FANTASTIC_FEED_DISABLED', 'true');
    expect(adaptersForBrand(robo, {}).map((a) => a.provider)).toEqual(['activejobs', 'bank_robohire', 'jsearch']);
    expect(sourcesForBrand(robo, {}).find((s) => s.provider === FEED_PROVIDER)!.status()).toMatchObject({ enabled: false, reason: 'kill_switch' });
  });

  it('JOB_PROVIDERS_<BRAND> narrows it away like any other source', () => {
    vi.stubEnv('FANTASTIC_MONTHLY_JOBS', '100000');
    expect(adaptersForBrand(robo, { JOB_PROVIDERS_ROBOAPPLY: 'activejobs,jsearch' }).map((a) => a.provider)).toEqual(['activejobs', 'jsearch']);
    expect(adaptersForBrand(robo, { JOB_PROVIDERS_ROBOAPPLY: 'activejobs_feed' }).map((a) => a.provider)).toEqual(['activejobs_feed']);
    expect(knownIngestProvidersForBrand(robo, { JOB_PROVIDERS_ROBOAPPLY: 'activejobs,jsearch' })).toEqual(['activejobs', 'jsearch']);
  });

  it('known to the brand on or off: a source behind a closed gate is still one of its sources (the planner retires nothing of it)', () => {
    // Closed: not an ingest adapter of either brand, and known to both.
    expect(knownIngestProvidersForBrand(robo, {})).toEqual(['activejobs', 'activejobs_feed', 'bank_robohire', 'jsearch']);
    expect(knownIngestProvidersForBrand(go, {})).toEqual(['bank_gohire', 'activejobs', 'activejobs_feed']);
    expect(adaptersForBrand(go, {}).map((a) => a.provider)).toEqual(['bank_gohire']);
    // Open: the same list.
    vi.stubEnv('FANTASTIC_MONTHLY_JOBS', '100000');
    expect(knownIngestProvidersForBrand(robo, {})).toEqual(['activejobs', 'activejobs_feed', 'bank_robohire', 'jsearch']);
    expect(knownIngestProvidersForBrand(go, {})).toEqual(['bank_gohire', 'activejobs', 'activejobs_feed']);
    // Never the user's own import, never JSearch or LinkedIn for the mainland.
    for (const brand of [robo, go]) expect(knownIngestProvidersForBrand(brand, {}), brand.id).not.toContain('user_import');
    expect(knownIngestProvidersForBrand(go, { JOB_PROVIDERS_GOAPPLY: 'jsearch,linkedin,bank_gohire' })).toEqual(['bank_gohire']);
  });

  it('the gate reads the reading THIS process holds: a new process lists the feed only once it has loaded the stored reading (load first, then list)', async () => {
    // One process read a paid plan's size from a response and stored it.
    const store = createFakePrisma();
    setQuotaDepsForTests({ db: store as never });
    recordQuotaObservation({ provider: 'activejobs', status: 200, requestsLimit: 50_000, requestsRemaining: 49_000, resetSeconds: 864_000, jobsLimit: 100_000, jobsRemaining: 99_000, plan: null, reason: null, at: new Date() });
    await flushProviderQuota();
    expect(adaptersForBrand(robo, {}).map((a) => a.provider)).toEqual(['activejobs', 'activejobs_feed', 'bank_robohire', 'jsearch']);
    // A new process (a cold function instance): its memory holds no reading yet.
    resetProviderQuotaForTests();
    setQuotaDepsForTests({ db: store as never });
    expect(adaptersForBrand(robo, {}).map((a) => a.provider)).toEqual(['activejobs', 'bank_robohire', 'jsearch']);
    expect(feedGateForMarket('intl').reason).toBe('plan_unknown');
    expect(sourcesForBrand(robo, {}).find((s) => s.provider === FEED_PROVIDER)!.status().enabled).toBe(false);
    // Still a source of the brand: a plan run that was handed the short list switches nothing of the feed off.
    expect(knownIngestProvidersForBrand(robo, {})).toContain('activejobs_feed');
    // The stored reading loaded: the feed is in the list.
    await hydrateProviderQuota(store as never);
    expect(adaptersForBrand(robo, {}).map((a) => a.provider)).toEqual(['activejobs', 'activejobs_feed', 'bank_robohire', 'jsearch']);
    expect(adaptersForBrand(go, {}).map((a) => a.provider)).toEqual(['bank_gohire', 'activejobs', 'activejobs_feed']);
  });
});
