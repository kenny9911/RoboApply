// @vitest-environment node
//
// server/src/features/jobs/ingest/tracking.test.ts — which sources the
// "missed twice" archive is for (MKT-5C; JI-10; MARKET_STRATEGY 1.5 "Closure").
//
// The rule archives a row as 'source_removed' when two later counted runs of
// the query that last returned it did not return it. It is for a metered
// search provider whose counted run is the query's whole answer, and for
// nothing else: an employer board, a recruiter bank, an open-data or
// government source and the licensed feed close their rows themselves, and a
// JSearch call answers the first pages of a ranked search (requests/
// waveM3-carryover.md, "The missed twice archive no longer runs for JSearch").
// No database, no network: the statements are played over an in-memory table.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../../platform/brand/index.js';
import { normalizeSql } from '../../../test/sqlSnapshot.js';
import { PROVIDER_META } from '../normalize/index.js';
import { PUBLIC_ATS } from '../sources/atsPublic/contract.js';
import { adapterCostModel, type JobSourceAdapter } from '../sources/index.js';
import type { IngestDb } from './db.js';
import { BANK_BOARDS, runMaintenance } from './maintain.js';
import { adaptersForBrand } from './providers.js';
import { DATE_POSTED_WINDOW_DAYS, MISSED_RUNS, buildMissedSql, isMissedTwice, missedRuleApplies, perQueryTrackingAvailable, resetTrackingCacheForTests } from './tracking.js';

const NOW = new Date('2026-10-12T08:00:00.000Z');
const DAY = 86_400_000;

type AdapterShape = Pick<JobSourceAdapter, 'provider' | 'kind' | 'sourceBoards'> & { costModel?: JobSourceAdapter['costModel']; limit: number | null };
const adapter = (a: AdapterShape): JobSourceAdapter =>
  ({
    provider: a.provider,
    kind: a.kind,
    markets: ['intl', 'cn'],
    sourceBoards: a.sourceBoards,
    ...(a.costModel ? { costModel: a.costModel } : {}),
    isEnabled: () => true,
    supportsCountry: () => true,
    dailyCallLimit: () => a.limit,
    fetch: async () => ({ jobs: [], calls: 0 }),
  }) as unknown as JobSourceAdapter;

/** One adapter per kind of source the pipeline knows, as each declares itself. */
const SOURCES = {
  activejobs: adapter({ provider: 'activejobs', kind: 'search', sourceBoards: ['activejobs'], limit: 300 }),
  jsearch: adapter({ provider: 'jsearch', kind: 'search', sourceBoards: ['jsearch'], limit: 300 }),
  ats_public: adapter({ provider: 'ats_public', kind: 'cursor', sourceBoards: [...PUBLIC_ATS], costModel: 'free', limit: null }),
  bank_robohire: adapter({ provider: 'bank_robohire', kind: 'cursor', sourceBoards: ['robohire'], limit: null }),
  bank_gohire: adapter({ provider: 'bank_gohire', kind: 'cursor', sourceBoards: ['gohire'], limit: null }),
  tw_open_data: adapter({ provider: 'tw_open_data', kind: 'cursor', sourceBoards: ['tw_open_data'], costModel: 'free', limit: null }),
  tw_gov_jobs: adapter({ provider: 'tw_gov_jobs', kind: 'cursor', sourceBoards: ['tw_gov_jobs'], costModel: 'free', limit: null }),
  usajobs: adapter({ provider: 'usajobs', kind: 'cursor', sourceBoards: ['usajobs'], costModel: 'free', limit: null }),
  activejobs_feed: adapter({ provider: 'activejobs_feed', kind: 'cursor', sourceBoards: ['activejobs'], limit: 300 }),
} as const;

/** Sources whose rows the rule must never select, with the boards their rows are stored under. */
const NEVER: ReadonlyArray<[keyof typeof SOURCES, readonly string[]]> = [
  ['ats_public', PUBLIC_ATS],
  ['bank_robohire', ['robohire']],
  ['bank_gohire', ['gohire']],
  ['tw_open_data', ['tw_open_data']],
  ['tw_gov_jobs', ['tw_gov_jobs']],
  ['usajobs', ['usajobs']],
];

interface Row {
  id: string;
  market: string;
  visibility: string;
  sourceBoard: string;
  archivedAt: Date | null;
  closeReason: string | null;
  lastSeenQueryId: string | null;
  lastSeenRun: number | null;
  postedAt: Date | null;
  firstSeenAt: Date;
}
interface Query {
  id: string;
  provider: string;
  market: string;
  runCount: number;
  datePosted: string;
}

/**
 * Plays `buildMissedSql` over rows and queries, reading the statement's own
 * parameters (market, boards, provider, market, the missed-run count). Every
 * other statement of a maintenance run answers 0 / [].
 */
function tableDb(rows: Row[], queries: Query[]): { db: IngestDb; missed: Array<{ provider: string; boards: string[] }> } {
  const missed: Array<{ provider: string; boards: string[] }> = [];
  const db = {
    rAJob: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    async $queryRaw() {
      return [];
    },
    async $executeRaw(stmt: { text: string; values: unknown[] }) {
      const text = normalizeSql(stmt.text);
      if (!text.includes(`"closeReason" = 'source_removed'`)) return 0;
      const [market, boards, provider, queryMarket, runs] = stmt.values as [string, string[], string, string, number];
      missed.push({ provider, boards });
      let n = 0;
      for (const r of rows) {
        if (r.market !== market || r.visibility !== 'public' || r.archivedAt || !boards.includes(r.sourceBoard)) continue;
        const q = queries.find((x) => x.id === r.lastSeenQueryId && x.provider === provider && x.market === queryMarket);
        if (!q || r.lastSeenRun === null || q.runCount < r.lastSeenRun + runs) continue;
        const window = DATE_POSTED_WINDOW_DAYS[q.datePosted];
        const posted = (r.postedAt ?? r.firstSeenAt).getTime();
        if (window !== undefined && posted <= NOW.getTime() - (window - 1) * DAY) continue;
        r.archivedAt = NOW;
        r.closeReason = 'source_removed';
        n += 1;
      }
      return n;
    },
  };
  return { db: db as unknown as IngestDb, missed };
}

const row = (over: Partial<Row> & { id: string; sourceBoard: string }): Row => ({
  market: 'intl',
  visibility: 'public',
  archivedAt: null,
  closeReason: null,
  lastSeenQueryId: 'q1',
  lastSeenRun: 3,
  postedAt: new Date(NOW.getTime() - 2 * DAY),
  firstSeenAt: new Date(NOW.getTime() - 2 * DAY),
  ...over,
});

/** The banks have a posting page and are passed as running, so the bank step of the run closes nothing. */
const RUN = { perQueryTracking: true, deadBankLinks: { env: { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://example.test/p/{id}', ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://example.test/r/{id}' } } } as const;

describe('which sources the "missed twice" archive is for', () => {
  it('a metered search provider whose answer is complete, and nothing else', () => {
    expect(missedRuleApplies(SOURCES.activejobs)).toBe(true);
    for (const id of ['jsearch', 'ats_public', 'bank_robohire', 'bank_gohire', 'tw_open_data', 'tw_gov_jobs', 'usajobs', 'activejobs_feed'] as const) {
      expect(missedRuleApplies(SOURCES[id]), id).toBe(false);
    }
    // Why each is out: JSearch answers the first pages of a ranked search; the rest run no planned query.
    expect(adapterCostModel(SOURCES.jsearch)).toBe('per_request');
    expect(SOURCES.ats_public.kind).toBe('cursor');
    // An unmetered search source (no daily limit) is out too: nothing counts its runs against a budget.
    expect(missedRuleApplies(adapter({ provider: 'activejobs', kind: 'search', sourceBoards: ['activejobs'], limit: null }))).toBe(false);
    // The cost model an adapter declares wins over its provider's default.
    expect(missedRuleApplies(adapter({ provider: 'activejobs', kind: 'search', sourceBoards: ['activejobs'], costModel: 'per_request', limit: 300 }))).toBe(false);
  });

  it('ACCEPT: an aggregator row missed by two later counted runs inside its window is archived as source_removed; a board row never is', async () => {
    const rows = [
      row({ id: 'feed_missed', sourceBoard: 'activejobs' }),
      row({ id: 'feed_missed_once', sourceBoard: 'activejobs', lastSeenRun: 4 }),
      row({ id: 'feed_outside_window', sourceBoard: 'activejobs', postedAt: new Date(NOW.getTime() - 10 * DAY) }),
      // Rows of every source the rule is not for, each stamped as if a query had missed it twice.
      ...NEVER.flatMap(([provider, boards]) => boards.map((b) => row({ id: `${provider}:${b}`, sourceBoard: b }))),
      row({ id: 'jsearch_missed', sourceBoard: 'jsearch', lastSeenQueryId: 'qj' }),
      row({ id: 'import', sourceBoard: 'user_import', visibility: 'private' }),
    ];
    const queries: Query[] = [
      { id: 'q1', provider: 'activejobs', market: 'intl', runCount: 5, datePosted: 'week' },
      { id: 'qj', provider: 'jsearch', market: 'intl', runCount: 9, datePosted: 'month' },
    ];
    const { db, missed } = tableDb(rows, queries);
    const res = await runMaintenance(db, 'intl', Object.values(SOURCES), RUN);
    expect(res).toMatchObject({ missed: 1, missedRule: true });
    expect(rows.filter((r) => r.closeReason === 'source_removed').map((r) => r.id)).toEqual(['feed_missed']);
    // The statement was built for the one provider the rule is for, and names only that provider's own board.
    expect(missed).toEqual([{ provider: 'activejobs', boards: ['activejobs'] }]);
    for (const r of rows.filter((x) => x.id !== 'feed_missed')) expect(r, r.id).toMatchObject({ archivedAt: null, closeReason: null });
  });

  it('even a statement built for a search provider cannot reach a row of a board, a bank or an open-data source: it names its own boards and its own queries', () => {
    const stmt = buildMissedSql('intl', 'activejobs', ['activejobs']);
    expect(normalizeSql(stmt.text)).toContain(`j."sourceBoard" = ANY($2::text[])`);
    expect(normalizeSql(stmt.text)).toContain(`j."lastSeenQueryId" = q."id" AND q."provider" = $3 AND q."market" = $4`);
    expect(stmt.values.slice(0, 5)).toEqual(['intl', ['activejobs'], 'activejobs', 'intl', MISSED_RUNS]);
    const selectable = stmt.values[1] as string[];
    for (const [, boards] of NEVER) for (const b of boards) expect(selectable).not.toContain(b);
    for (const b of [...BANK_BOARDS, 'jsearch', 'user_import']) expect(selectable).not.toContain(b);
  });

  it('the adapters each brand really has: none the rule accepts stores its rows under a board, bank, open-data or government board', () => {
    const closedElsewhere = new Set<string>([...PUBLIC_ATS, ...BANK_BOARDS, 'tw_open_data', 'tw_gov_jobs', 'usajobs', 'jsearch', 'user_import']);
    const providersClosedElsewhere = new Set<string>(['ats_public', 'bank_robohire', 'bank_gohire', 'tw_open_data', 'tw_gov_jobs', 'usajobs', 'activejobs_feed', 'jsearch', 'user_import']);
    const accepted: Record<string, string[]> = {};
    for (const brandId of ['roboapply', 'goapply'] as const) {
      // Every adapter the brand has, on or off (the list maintenance is handed).
      const adapters = adaptersForBrand(getBrand(brandId), {});
      accepted[brandId] = adapters.filter((a) => missedRuleApplies(a)).map((a) => a.provider);
      for (const a of adapters) {
        if (!missedRuleApplies(a)) continue;
        expect(providersClosedElsewhere.has(a.provider), `${brandId}:${a.provider}`).toBe(false);
        for (const b of a.sourceBoards) expect(closedElsewhere.has(b), `${brandId}:${a.provider}:${b}`).toBe(false);
        // The board such a provider writes is its own in the provider registry.
        expect(a.sourceBoards).toContain(PROVIDER_META[a.provider as keyof typeof PROVIDER_META].sourceBoard);
      }
      // The brand's banks and JSearch are among its adapters and are never accepted.
      for (const a of adapters.filter((x) => x.provider.startsWith('bank_') || x.provider === 'jsearch')) expect(missedRuleApplies(a), `${brandId}:${a.provider}`).toBe(false);
    }
    // Not vacuous: the international brand has the one search provider the rule is for.
    expect(accepted.roboapply).toEqual(['activejobs']);
  });

  it('with the columns missing (a database before the M0 push) the step does not run at all', async () => {
    const rows = [row({ id: 'feed_missed', sourceBoard: 'activejobs' })];
    const { db, missed } = tableDb(rows, [{ id: 'q1', provider: 'activejobs', market: 'intl', runCount: 9, datePosted: 'week' }]);
    const res = await runMaintenance(db, 'intl', Object.values(SOURCES), { ...RUN, perQueryTracking: false });
    expect(res).toMatchObject({ missed: 0, missedRule: false });
    expect(missed).toEqual([]);
    expect(rows[0]).toMatchObject({ archivedAt: null });
  });
});

describe('the pure mirror and the probe', () => {
  beforeEach(() => resetTrackingCacheForTests());

  it('isMissedTwice: two later counted runs, and only inside the query\'s datePosted window', () => {
    const job = { lastSeenRun: 3, postedAt: new Date(NOW.getTime() - 2 * DAY), firstSeenAt: new Date(NOW.getTime() - 2 * DAY) };
    expect(isMissedTwice(job, { runCount: 4, datePosted: 'week' }, NOW)).toBe(false);
    expect(isMissedTwice(job, { runCount: 5, datePosted: 'week' }, NOW)).toBe(true);
    // A 'week' search can never return a posting older than 7 days: dropping out of the window is not "removed".
    expect(isMissedTwice({ ...job, postedAt: new Date(NOW.getTime() - 10 * DAY) }, { runCount: 9, datePosted: 'week' }, NOW)).toBe(false);
    expect(isMissedTwice({ ...job, postedAt: new Date(NOW.getTime() - 10 * DAY) }, { runCount: 9, datePosted: 'all' }, NOW)).toBe(true);
    // A row no counted run ever stamped is never missed. The planner may set a query's count back to 0: then nothing is missed either.
    expect(isMissedTwice({ ...job, lastSeenRun: null }, { runCount: 9, datePosted: 'week' }, NOW)).toBe(false);
    expect(isMissedTwice(job, { runCount: 0, datePosted: 'week' }, NOW)).toBe(false);
  });

  it('the probe answers true when the three SR-16b-1 columns exist (every database that took the M0 push) and false on any failure', async () => {
    const having = (n: number) => ({ $queryRaw: async () => [{ n }] }) as unknown as Pick<IngestDb, '$queryRaw'>;
    expect(await perQueryTrackingAvailable(having(3), 1)).toBe(true);
    resetTrackingCacheForTests();
    expect(await perQueryTrackingAvailable(having(2), 1)).toBe(false);
    resetTrackingCacheForTests();
    expect(await perQueryTrackingAvailable({ $queryRaw: async () => Promise.reject(new Error('down')) } as unknown as Pick<IngestDb, '$queryRaw'>, 1)).toBe(false);
    // Cached for an hour: the answer above is reused, then asked again.
    expect(await perQueryTrackingAvailable(having(3), 2)).toBe(false);
    expect(await perQueryTrackingAvailable(having(3), 1 + 60 * 60_000)).toBe(true);
  });
});
