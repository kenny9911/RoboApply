// @vitest-environment node
// WP-16b acceptance through the pipeline (no network, no database):
//   - GoHire jobs carry market 'cn'; bank jobs are fromRecruiterBank;
//   - a draft / unpublished bank job never syncs; closed ones are archived;
//   - a bank job without recorded syndication consent has publicDisplay=false;
//   - publicDisplay for providers only via PUBLIC_DISPLAY_PROVIDERS (default empty);
//   - the daily budget stops calls; applicantCount never written from linkedin/jsearch;
//   - the lease is FOR UPDATE SKIP LOCKED; enrich is queued for new / changed rows only;
//   - marketHooks.afterNormalize runs before the upsert.
// Parity wave (PAR-7): a bank row is listed only with a real posting page
// (held as no_apply_target otherwise, revived when the page exists), the
// listing diff, per-source skip tallies and run status, and the market of an
// employer-board posting (its own location; a run writes only its market).
// Market wave (MKT-3A): one budget per provider (the plan's quota stops ingest
// and parks the provider's due queries, a day at a time; the day's usage row is
// keyed per market, `<provider>:cn`; a person's search and an ingest query add
// up in one row), the cursor sources' share of a tick, the country handed to
// the refresh interval, and the page's known employer domains (JI-5 support).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const hookSpy = vi.hoisted(() => vi.fn());
vi.mock('../marketHooks.js', async (orig) => {
  const real = await orig<typeof import('../marketHooks.js')>();
  return {
    ...real,
    afterNormalize: async (job: Record<string, unknown>, ctx: unknown) => {
      hookSpy(job.externalId, ctx);
      return job;
    },
  };
});

// Pass-through spies: what the pipeline hands the normalizer (the page's known employer
// domains) and the planner's refresh rule (the query's country). Behaviour is unchanged.
const normalizeSpy = vi.hoisted(() => vi.fn());
vi.mock('../normalize/index.js', async (orig) => {
  const real = await orig<typeof import('../normalize/index.js')>();
  return {
    ...real,
    normalizeProviderJob: (...args: Parameters<typeof real.normalizeProviderJob>) => {
      normalizeSpy(args[0], args[1], args[2]);
      return real.normalizeProviderJob(...args);
    },
  };
});
const refreshSpy = vi.hoisted(() => vi.fn());
vi.mock('./planner.js', async (orig) => {
  const real = await orig<typeof import('./planner.js')>();
  return {
    ...real,
    nextRunDelayMs: (q: Parameters<typeof real.nextRunDelayMs>[0]) => {
      refreshSpy(q);
      return real.nextRunDelayMs(q);
    },
  };
});

import { getBrand } from '../../../platform/brand/index.js';
import { toRecordedSql } from '../../../test/sqlSnapshot.js';
import { quotaObservationFrom, type ExternalSourceBoard } from '../../../roboapply/v2/lib/raExternalJobTypes.js';
import type { ProviderJobInput } from '../normalize/index.js';
import type { JobSourceAdapter, SourceFetchResult } from '../sources/index.js';
import { createBankAdapter, type BankSyncRow } from './adapters/bank.js';
import {
  buildDeferProviderSql,
  buildLeaseSql,
  companyDomainsForPage,
  nextBudgetDay,
  processJobs,
  reserveProviderCall,
  runIngestQuery,
  type LeasedQueryRow,
  type PipelineContext,
} from './pipeline.js';
import { QUOTA_PARK_MAX_MS, flushProviderQuota, providerCallGate, recordQuotaObservation, resetProviderQuotaForTests, setQuotaDepsForTests, type QuotaDb } from './quota.js';
import { adapterRunsInTick, addToSourceStatus, addToTally, emptyTally, quotaStopsIngest, runIngestTick } from './run.js';
import { createIngestFake } from './testkit.js';
import { emptyRunStatus, parseStatusDoc, SOURCE_STATUS_NOTES, sourceStatusKey } from './status.js';
import { archiveUnlistedJobs, contentHash } from './upsert.js';

/** Both banks have a posting page in these tests unless a test says otherwise. */
const PAGES = { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://example.test/p/{id}', ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://jobs.example.test/r/{id}' };

const NOW = new Date('2026-10-10T08:00:00.000Z');
const robo = getBrand('roboapply');
const go = getBrand('goapply');

function ctxFor(db: PipelineContext['db'], market: 'intl' | 'cn' = 'intl', over: Partial<PipelineContext> = {}) {
  const enqueueMany = vi.fn(async (items: unknown[]) => ({ inserted: items.length }));
  const ctx: PipelineContext = { db, brand: market === 'cn' ? 'goapply' : 'roboapply', market, now: NOW, enqueueMany, publicDisplayProviders: [], ...over };
  return { ctx, enqueueMany };
}

function job(over: Partial<ProviderJobInput> = {}): ProviderJobInput {
  return {
    externalId: 'jsearch:1',
    sourceBoard: 'jsearch',
    title: 'Data Analyst',
    company: 'Acme Inc.',
    applyUrl: 'https://jobs.lever.co/acme/1',
    location: 'Chicago, IL, United States',
    description: 'Analyse data with SQL.',
    postedAt: '2026-10-08T00:00:00Z',
    ...over,
  };
}

function bankRow(over: Partial<BankSyncRow> = {}): BankSyncRow {
  return {
    id: 'gh1',
    status: 'open',
    publishedAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-05T00:00:00Z'),
    title: 'Java后端开发工程师',
    description: '负责后端服务开发。',
    location: '深圳',
    salaryText: '15-25K·14薪',
    companyName: '示例科技有限公司',
    company: { id: 'co1', name: '示例科技有限公司', logoUrl: null, industry: '互联网' },
    ...over,
  };
}

function leased(provider: string, id = `q-${provider}`, over: Partial<LeasedQueryRow> = {}): LeasedQueryRow {
  return {
    id,
    market: 'intl',
    provider,
    params: { q: 'Data analyst', country: 'US', datePosted: 'week' },
    origin: 'demand',
    demandScore: 2,
    priority: 50,
    consecutiveEmpty: 0,
    ...over,
  };
}

function searchAdapter(provider: 'jsearch' | 'linkedin' | 'activejobs', fetchImpl: () => Promise<SourceFetchResult>): JobSourceAdapter {
  return {
    provider,
    kind: 'search',
    markets: ['intl'],
    sourceBoards: [provider],
    isEnabled: () => true,
    supportsCountry: () => true,
    dailyCallLimit: () => 10,
    fetch: vi.fn(fetchImpl),
  };
}

/** SYNTHETIC quota reading: what a provider's response headers said (shape of the 2026-10-11 probes). */
function quotaReading(provider: ExternalSourceBoard, status: number, limit: number, remaining: number, resetSeconds: number, body = '', at: Date = NOW): void {
  const h: Record<string, string> = { 'x-ratelimit-requests-limit': String(limit), 'x-ratelimit-requests-remaining': String(remaining), 'x-ratelimit-requests-reset': String(resetSeconds) };
  recordQuotaObservation(quotaObservationFrom(provider, { status, headers: { get: (name: string) => h[name.toLowerCase()] ?? null } }, body, at));
}

beforeEach(() => {
  hookSpy.mockClear();
  normalizeSpy.mockClear();
  refreshSpy.mockClear();
  resetProviderQuotaForTests();
});
afterEach(() => resetProviderQuotaForTests());

describe('bank sync through the pipeline', () => {
  it('GoHire: market cn, fromRecruiterBank, no consent → publicDisplay=false, employerVerified=false; drafts never sync', async () => {
    const { db, written, fake } = createIngestFake();
    const read = vi.fn(async () => [
      bankRow(),
      bankRow({ id: 'gh-draft', status: 'draft', publishedAt: null }),
      bankRow({ id: 'gh-open-unpublished', status: 'open', publishedAt: null }),
      bankRow({ id: 'gh-closed', status: 'closed' }),
    ]);
    const adapter = createBankAdapter('gohire', { read, isEnabled: () => true, pageSize: () => 50, env: PAGES });
    const { ctx } = ctxFor(db, 'cn');
    const result = await runIngestQuery(ctx, adapter, leased('bank_gohire', 'qb', { market: 'cn', origin: 'bank_sync', params: { q: '', country: '*', datePosted: 'all' } }));

    expect(result.status).toBe('ok');
    expect(written.map((r) => r.externalId)).toEqual(['gh1']);
    const [row] = written;
    expect(row).toMatchObject({ market: 'cn', sourceBoard: 'gohire', fromRecruiterBank: true, publicDisplay: false, employerVerified: false, sourcePriority: 15, sourceName: 'GoHire' });
    // The bank's own posting page (the configured template), and a recruiter posting for a named employer is 代招.
    expect(row).toMatchObject({ applyUrl: 'https://example.test/p/gh1', isAgency: true });
    expect(result.notes).toMatchObject({ bank_synced: 1, bank_unpublished: 1, bank_closed: 2 });
    expect(row!.expiresAt).toBeNull(); // closed by the sync, never by date
    expect(hookSpy).toHaveBeenCalledWith('gh1', { brand: 'goapply', market: 'cn', stage: 'ingest' });
    // Cursor advanced to the last row READ (synced or not).
    const finish = fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "lastRunAt"'))!;
    expect(String(finish.values.find((v) => typeof v === 'string' && v.includes('cursor')))).toContain('2026-10-05T00:00:00.000Z|gh-closed');
  });

  it('archives bank jobs that were closed, paused or unpublished', async () => {
    const { db, fake } = createIngestFake({
      seed: {
        rAJob: [
          { id: 'j-draft', sourceBoard: 'gohire', externalId: 'gh-draft', archivedAt: null, visibility: 'public' },
          { id: 'j-live', sourceBoard: 'gohire', externalId: 'gh-live', archivedAt: null, visibility: 'public' },
        ],
      },
    });
    const adapter = createBankAdapter('gohire', { read: async () => [bankRow({ id: 'gh-draft', status: 'paused' })], isEnabled: () => true });
    const { ctx } = ctxFor(db, 'cn');
    const r = await runIngestQuery(ctx, adapter, leased('bank_gohire', 'qb', { market: 'cn', origin: 'bank_sync' }));
    expect(r.closed).toBe(1);
    const rows = fake.$rows('rAJob');
    expect(rows.find((x) => x.id === 'j-draft')).toMatchObject({ closeReason: 'bank_closed' });
    expect(rows.find((x) => x.id === 'j-live')!.archivedAt).toBeNull();
  });

  it('publicDisplay and employerVerified come only from the bank records', async () => {
    const { db, written } = createIngestFake();
    const consented = bankRow({ id: 'rh1', title: 'Backend Engineer', companyName: 'Acme', location: 'Austin, TX', salaryText: null }) as BankSyncRow & {
      syndicationConsentAt: Date;
      employerVerified: boolean;
    };
    consented.syndicationConsentAt = new Date('2026-09-01');
    consented.employerVerified = true;
    const adapter = createBankAdapter('robohire', { read: async () => [consented, bankRow({ id: 'rh2', title: 'QA Engineer', companyName: 'Beta', location: 'Austin, TX' })], isEnabled: () => true, env: PAGES });
    const { ctx } = ctxFor(db, 'intl');
    await runIngestQuery(ctx, adapter, leased('bank_robohire', 'qr', { origin: 'bank_sync' }));
    expect(written.find((w) => w.externalId === 'rh1')).toMatchObject({ market: 'intl', publicDisplay: true, employerVerified: true, fromRecruiterBank: true });
    expect(written.find((w) => w.externalId === 'rh2')).toMatchObject({ publicDisplay: false, employerVerified: false });
  });
});

describe('a bank row is listed only when its bank has a posting page', () => {
  const bankLease = (provider: 'bank_gohire' | 'bank_robohire', market: 'cn' | 'intl') =>
    leased(provider, 'qb', { market, origin: 'bank_sync', params: { q: '', country: '*', datePosted: 'all' } });

  it.each([
    ['gohire', 'bank_gohire', 'cn'],
    ['robohire', 'bank_robohire', 'intl'],
  ] as const)('%s with no template: nothing is written, the synced row is held, and every open row of the bank in its market is closed as no_apply_target', async (bank, provider, market) => {
    const { db, written, fake } = createIngestFake({
      seed: {
        rAJob: [
          { id: 'j-held', sourceBoard: bank, externalId: 'b1', market, archivedAt: null, visibility: 'public' },
          // Stored before the rule existed, with the dead /jobs/<id> link: it must leave the feed too.
          { id: 'j-legacy', sourceBoard: bank, externalId: 'legacy', market, archivedAt: null, visibility: 'public' },
          { id: 'j-reported', sourceBoard: bank, externalId: 'reported', market, archivedAt: NOW, closeReason: 'reported', visibility: 'public' },
          { id: 'j-private', sourceBoard: bank, externalId: 'mine', market, archivedAt: null, visibility: 'private' },
          { id: 'j-other-board', sourceBoard: 'greenhouse', externalId: 'acme:1', market, archivedAt: null, visibility: 'public' },
        ],
      },
    });
    const adapter = createBankAdapter(bank, { read: async () => [bankRow({ id: 'b1' })], isEnabled: () => true, env: {} });
    const r = await runIngestQuery(ctxFor(db, market).ctx, adapter, bankLease(provider, market));
    expect(written).toHaveLength(0);
    expect(r.notes).toMatchObject({ bank_synced: 1, bank_no_public_page: 1 });
    expect(r.closed).toBe(2);
    const rows = fake.$rows('rAJob');
    expect(rows.find((x) => x.id === 'j-held')).toMatchObject({ closeReason: 'no_apply_target', archivedAt: NOW });
    expect(rows.find((x) => x.id === 'j-legacy')).toMatchObject({ closeReason: 'no_apply_target' });
    expect(rows.find((x) => x.id === 'j-reported')).toMatchObject({ closeReason: 'reported' });
    expect(rows.find((x) => x.id === 'j-private')!.archivedAt).toBeNull();
    expect(rows.find((x) => x.id === 'j-other-board')!.archivedAt).toBeNull();
  });

  it('with GOHIRE_PUBLIC_JOB_URL_TEMPLATE the synced row is written with that apply URL and nothing is closed', async () => {
    const { db, written, fake } = createIngestFake({
      seed: { rAJob: [{ id: 'j-held', sourceBoard: 'gohire', externalId: 'gh1', market: 'cn', archivedAt: NOW, closeReason: 'no_apply_target', visibility: 'public' }] },
    });
    const adapter = createBankAdapter('gohire', { read: async () => [bankRow()], isEnabled: () => true, env: PAGES });
    const r = await runIngestQuery(ctxFor(db, 'cn').ctx, adapter, bankLease('bank_gohire', 'cn'));
    expect(written.map((w) => [w.externalId, w.applyUrl, w.market])).toEqual([['gh1', 'https://example.test/p/gh1', 'cn']]);
    expect(r.closed).toBe(0);
    // The upsert statement itself revives a row archived as no_apply_target (upsert.test.ts pins the SQL).
    const upsert = fake.$sql.calls.find((c) => c.text.includes('INSERT INTO "RAJob"'))!;
    expect(upsert.text).toContain(`IN ('source_removed', 'bank_closed', 'no_apply_target') THEN NULL`);
  });

  it('a market cn row without an apply URL is never written, whatever the provider (every market keeps the rule)', async () => {
    for (const market of ['cn', 'intl'] as const) {
      const { db, written } = createIngestFake();
      const result = await processJobs(ctxFor(db, market).ctx, { provider: market === 'cn' ? 'bank_gohire' : 'jsearch' }, [
        job({ externalId: 'x1', sourceBoard: market === 'cn' ? 'gohire' : 'jsearch', applyUrl: null, sourceUrl: null }),
        job({ externalId: 'x2', sourceBoard: market === 'cn' ? 'gohire' : 'jsearch', applyUrl: 'javascript:alert(1)', sourceUrl: null }),
      ]);
      expect(written).toHaveLength(0);
      expect(result).toMatchObject({ received: 2, written: 0, skipped: 2 });
      expect(result.notes).toMatchObject({ no_apply_url: 2 });
    }
  });
});

describe('the listing diff and closures with their own reason', () => {
  function cursorAdapter(result: SourceFetchResult): JobSourceAdapter {
    return { provider: 'bank_gohire', kind: 'cursor', markets: ['cn'], sourceBoards: ['gohire'], isEnabled: () => true, supportsCountry: () => true, dailyCallLimit: () => null, fetch: vi.fn(async () => result) };
  }
  const seed = () => ({
    rAJob: [
      { id: 'a', sourceBoard: 'gohire', externalId: 'listed', market: 'cn', archivedAt: null, visibility: 'public' },
      { id: 'b', sourceBoard: 'gohire', externalId: 'gone', market: 'cn', archivedAt: null, visibility: 'public' },
      { id: 'c', sourceBoard: 'gohire', externalId: 'held', market: 'cn', archivedAt: null, visibility: 'public' },
      // The legacy rows that sit in the other market are not this run's to close.
      { id: 'd', sourceBoard: 'gohire', externalId: 'other-market', market: 'intl', archivedAt: null, visibility: 'public' },
    ],
  });
  const lease = () => leased('bank_gohire', 'qb', { market: 'cn', origin: 'bank_sync' });

  it('after a complete pass a row missing from the listing is archived as bank_closed; a held row keeps no_apply_target', async () => {
    const { db, fake } = createIngestFake({ seed: seed() });
    const r = await runIngestQuery(
      ctxFor(db, 'cn').ctx,
      cursorAdapter({ jobs: [], calls: 4, closures: [{ externalIds: ['held'], reason: 'no_apply_target' }], listing: { externalIds: ['listed'], reason: 'bank_closed' }, notes: { bank_no_public_page: 1 }, exhausted: true }),
      lease(),
    );
    const rows = fake.$rows('rAJob');
    expect(rows.find((x) => x.id === 'a')!.archivedAt).toBeNull();
    expect(rows.find((x) => x.id === 'b')).toMatchObject({ closeReason: 'bank_closed', archivedAt: NOW });
    expect(rows.find((x) => x.id === 'c')).toMatchObject({ closeReason: 'no_apply_target' });
    expect(rows.find((x) => x.id === 'd')!.archivedAt).toBeNull();
    expect(r).toMatchObject({ status: 'ok', closed: 2, notes: { bank_no_public_page: 1 } });
  });

  it('a pass that failed or was cut short reports no listing and archives nothing', async () => {
    for (const result of [
      { jobs: [], calls: 2, error: 'GoHire bank read failed: http_502' },
      { jobs: [], calls: 3, listing: null, notes: { bank_pass_cut_short: 1 }, exhausted: false },
    ] satisfies SourceFetchResult[]) {
      const { db, fake } = createIngestFake({ seed: seed() });
      const r = await runIngestQuery(ctxFor(db, 'cn').ctx, cursorAdapter(result), lease());
      expect(fake.$rows('rAJob').every((x) => x.archivedAt === null)).toBe(true);
      expect(r.closed ?? 0).toBe(0);
    }
  });

  it('archiveUnlistedJobs compares only open public rows of the board in the market', async () => {
    const { db, fake } = createIngestFake({ seed: seed() });
    expect(await archiveUnlistedJobs(db, 'cn', 'gohire', ['listed', 'held'], NOW, 'bank_closed')).toBe(1);
    expect(fake.$rows('rAJob').filter((x) => x.archivedAt !== null).map((x) => x.id)).toEqual(['b']);
  });
});

describe('an employer-board posting belongs to the market of its own location', () => {
  const board = (over: Partial<ProviderJobInput>) =>
    job({ sourceBoard: 'greenhouse', company: 'Acme', sourcePublisher: 'Acme · Greenhouse', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', locationCountry: 'CN', locationCountryEstimated: true, ...over });

  it('a cn run writes the 上海 posting and skips the Singapore one as wrong_market; an intl run does the reverse', async () => {
    const inputs = [
      board({ externalId: 'acme:sh', title: '数据分析师', location: '上海' }),
      board({ externalId: 'acme:sg', title: 'Data Analyst', location: 'Singapore' }),
      // Not mainland China: Hong Kong, and a location that only the board tag (a weak hint) would place.
      board({ externalId: 'acme:hk', title: 'Data Analyst', location: 'Hong Kong SAR, China' }),
      board({ externalId: 'acme:remote', title: 'Data Analyst', location: 'Remote' }),
    ];
    const cn = createIngestFake();
    const cnResult = await processJobs(ctxFor(cn.db, 'cn').ctx, { provider: 'ats_public' }, inputs);
    expect(cn.written.map((w) => [w.externalId, w.market, w.applyUrl])).toEqual([['acme:sh', 'cn', 'https://boards.greenhouse.io/acme/jobs/1']]);
    expect(cnResult.notes).toMatchObject({ wrong_market: 3 });

    const intl = createIngestFake();
    const intlResult = await processJobs(ctxFor(intl.db, 'intl').ctx, { provider: 'ats_public' }, inputs);
    // The 上海 posting read through an international source is never written to RoboApply's index.
    expect(intl.written.map((w) => w.externalId).sort()).toEqual(['acme:hk', 'acme:remote', 'acme:sg']);
    expect(intl.written.every((w) => w.market === 'intl')).toBe(true);
    expect(intlResult.notes).toMatchObject({ wrong_market: 1 });
  });

  it('other providers keep the market of the run (a bank or search row is not re-routed by location)', async () => {
    const { db, written } = createIngestFake();
    await processJobs(ctxFor(db, 'intl').ctx, { provider: 'jsearch' }, [job({ externalId: 'jsearch:cn', location: 'Shanghai, China' })]);
    expect(written.map((w) => w.market)).toEqual(['intl']);
  });
});

describe('per-source run status (the admin sources panel reads it)', () => {
  it('a tick stores what each source did: counts, skip tallies and transport; an empty incremental run keeps the counted run', async () => {
    const lease = () => leased('bank_gohire', 'qb', { market: 'cn', origin: 'bank_sync', params: { q: '', country: '*', datePosted: 'all' } });
    const { db, fake } = createIngestFake({ due: [lease()] });
    const adapter = createBankAdapter('gohire', { read: async () => [bankRow(), bankRow({ id: 'gh2', publishedAt: null })], isEnabled: () => true, env: {}, pageSize: () => 50 });
    await runIngestTick({ db, brand: go, adapters: [adapter], budgetMs: 60_000, now: () => NOW, enqueueMany: async () => ({ inserted: 0 }), perQueryTracking: false });
    const key = sourceStatusKey('cn', 'bank_gohire');
    const stored = () => parseStatusDoc(String(fake.$rows('appConfig').find((r) => r.key === key)?.value))!;
    expect(stored().last).toMatchObject({ ok: true, transport: 'db', queries: 1, received: 0, written: 0, notes: { bank_synced: 1, bank_no_public_page: 1, bank_unpublished: 1 } });
    expect(stored().counted).toEqual(stored().last);

    // The next run reads nothing new: `last` moves on, `counted` keeps the run that counted the bank.
    const second = createBankAdapter('gohire', { read: async () => [], isEnabled: () => true, env: {}, pageSize: () => 50 });
    const later = new Date(NOW.getTime() + 1_800_000);
    const again = createIngestFake({ due: [lease()], seed: { appConfig: fake.$rows('appConfig') } });
    await runIngestTick({ db: again.db, brand: go, adapters: [second], budgetMs: 60_000, now: () => later, enqueueMany: async () => ({ inserted: 0 }), perQueryTracking: false });
    const doc = parseStatusDoc(String(again.fake.$rows('appConfig').find((r) => r.key === key)?.value))!;
    expect(doc.last).toMatchObject({ at: later.toISOString(), notes: {} });
    expect(doc.counted).toMatchObject({ at: NOW.toISOString(), notes: { bank_no_public_page: 1 } });
  });

  it('only skip reasons and source counts are kept: the normalizer\'s informational notes never reach the stored status (review fix)', () => {
    const status = emptyRunStatus(NOW, 'rapidapi');
    addToSourceStatus(status, {
      queryId: 'q', provider: 'jsearch', status: 'ok', calls: 1,
      notes: {
        // Skips the panel explains.
        no_apply_url: 2, wrong_market: 1, missing_title_or_company: 3, private_row: 1, normalize_failed: 4, no_external_id: 5,
        // Informational notes of the normalizer: not skips.
        salary_currency_from_search_country: 9, apply_url_linkedin_host: 2, linkedin_logo_dropped: 3, linkedin_publisher_dropped: 1, applicant_count_dropped: 6,
      },
    });
    expect(status.notes).toEqual({ no_apply_url: 2, wrong_market: 1, missing_title_or_company: 3, private_row: 1, normalize_failed: 4, no_external_id: 5 });
    // The log tally keeps every note.
    const tally = emptyTally();
    addToTally(tally, { queryId: 'q', provider: 'jsearch', status: 'ok', calls: 1, notes: { linkedin_logo_dropped: 3, no_apply_url: 2 } });
    expect(tally.notes).toEqual({ linkedin_logo_dropped: 3, no_apply_url: 2 });
    // A document stored before the list existed is cleaned when it is read.
    const old = parseStatusDoc(JSON.stringify({ last: { at: NOW.toISOString(), ok: true, notes: { linkedin_logo_dropped: 3, applicant_count_dropped: 2, bank_synced: 7 } }, counted: null }))!;
    expect(old.last.notes).toEqual({ bank_synced: 7 });
    for (const key of SOURCE_STATUS_NOTES) expect(key).toMatch(/^[a-z_]+$/);
  });

  it('the tick hands each source what is left of its budget (less the reserve), a cursor source at most its share of the tick, so a multi-request source stops inside it', async () => {
    const lease = () => leased('bank_gohire', 'qb', { market: 'cn', origin: 'bank_sync', params: { q: '', country: '*', datePosted: 'all' } });
    const seen: Array<number | undefined> = [];
    const adapter: JobSourceAdapter = {
      provider: 'bank_gohire', kind: 'cursor', markets: ['cn'], sourceBoards: ['gohire'],
      isEnabled: () => true, supportsCountry: () => true, dailyCallLimit: () => null,
      fetch: async (_query, ctx) => {
        seen.push(ctx.budgetMs);
        return { jobs: [], calls: 1, exhausted: true };
      },
    };
    // With the share set to the whole tick (INGEST_CURSOR_TICK_SHARE=1): 60 s budget, 5 s reserve,
    // so at most 55 s and close to it (the lease took almost no time).
    await runIngestTick({ db: createIngestFake({ due: [lease()] }).db, brand: go, adapters: [adapter], budgetMs: 60_000, now: () => NOW, enqueueMany: async () => ({ inserted: 0 }), perQueryTracking: false, env: { INGEST_CURSOR_TICK_SHARE: '1' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeLessThanOrEqual(55_000);
    expect(seen[0]).toBeGreaterThan(50_000);
    // By default a cursor source is handed its share of the tick: 40% of 60 s (MKT-3A).
    await runIngestTick({ db: createIngestFake({ due: [lease()] }).db, brand: go, adapters: [adapter], budgetMs: 60_000, now: () => NOW, enqueueMany: async () => ({ inserted: 0 }), perQueryTracking: false, env: {} });
    expect(seen[1]).toBe(24_000);
    // A search source has no share: what is left of the tick.
    const search = searchAdapter('jsearch', async () => ({ jobs: [], calls: 1 }));
    const budgets: Array<number | undefined> = [];
    search.fetch = vi.fn(async (_q, ctx) => {
      budgets.push(ctx.budgetMs);
      return { jobs: [], calls: 1 };
    });
    await runIngestTick({ db: createIngestFake({ due: [leased('jsearch')] }).db, brand: robo, adapters: [search], budgetMs: 60_000, now: () => NOW, enqueueMany: async () => ({ inserted: 0 }), perQueryTracking: false, env: {} });
    expect(budgets[0]).toBeLessThanOrEqual(55_000);
    expect(budgets[0]).toBeGreaterThan(50_000);
  });

  it('a failing source stores its error; a status write that fails never fails the tick', async () => {
    const lease = () => leased('bank_gohire', 'qb', { market: 'cn', origin: 'bank_sync' });
    const { db, fake } = createIngestFake({ due: [lease()] });
    const adapter = createBankAdapter('gohire', { read: async () => null, isEnabled: () => true });
    const tally = await runIngestTick({ db, brand: go, adapters: [adapter], budgetMs: 60_000, now: () => NOW, perQueryTracking: false });
    expect(tally.errors).toBe(1);
    expect(parseStatusDoc(String(fake.$rows('appConfig')[0]!.value))!.last).toMatchObject({ ok: false, error: 'bank_unavailable' });

    const broken = createIngestFake({ due: [lease()] });
    (broken.fake as unknown as { appConfig: { upsert: unknown } }).appConfig.upsert = async () => {
      throw new Error('no table');
    };
    await expect(runIngestTick({ db: broken.db, brand: go, adapters: [adapter], budgetMs: 60_000, now: () => NOW, perQueryTracking: false })).resolves.toMatchObject({ errors: 1 });
  });
});

describe('provider ingest', () => {
  it('publicDisplay only for providers in PUBLIC_DISPLAY_PROVIDERS (default none)', async () => {
    const a = createIngestFake();
    await processJobs(ctxFor(a.db).ctx, { provider: 'activejobs' }, [job({ externalId: 'activejobs:1', sourceBoard: 'activejobs' })]);
    expect(a.written[0]!.publicDisplay).toBe(false);
    const b = createIngestFake();
    await processJobs(ctxFor(b.db, 'intl', { publicDisplayProviders: ['activejobs'] }).ctx, { provider: 'activejobs' }, [job({ externalId: 'activejobs:1', sourceBoard: 'activejobs' })]);
    expect(b.written[0]!.publicDisplay).toBe(true);
  });

  it('never writes an applicant count from linkedin or jsearch', async () => {
    for (const provider of ['linkedin', 'jsearch'] as const) {
      const { db, written } = createIngestFake();
      await processJobs(ctxFor(db).ctx, { provider }, [job({ externalId: `${provider}:9`, sourceBoard: provider, applicantCount: 250, applicantCountSource: 'LinkedIn' })]);
      expect(written[0]).toMatchObject({ applicantCount: null, applicantCountSource: null, applicantCountAt: null });
    }
  });

  it('queues enrichment for new and materially changed rows only; skips rows without an apply link', async () => {
    const unchanged = job({ externalId: 'jsearch:2', title: 'QA Engineer' });
    const { db } = createIngestFake({
      existing: [
        { id: 'old1', externalId: 'jsearch:2', sourceBoard: 'jsearch', firstSeenAt: new Date('2026-09-01'), visibility: 'public', contentHash: contentHash('QA Engineer', 'Analyse data with SQL.') },
        { id: 'old2', externalId: 'jsearch:3', sourceBoard: 'jsearch', firstSeenAt: new Date('2026-09-01'), visibility: 'public', contentHash: 'stale' },
        { id: 'mine', externalId: 'jsearch:4', sourceBoard: 'jsearch', firstSeenAt: new Date('2026-09-01'), visibility: 'private', contentHash: 'x' },
      ],
    });
    const { ctx, enqueueMany } = ctxFor(db);
    const result = await processJobs(ctx, { provider: 'jsearch' }, [
      job(),
      unchanged,
      job({ externalId: 'jsearch:3', title: 'Product Analyst' }),
      job({ externalId: 'jsearch:4' }),
      job({ externalId: 'jsearch:5', applyUrl: null, sourceUrl: null }),
    ]);
    expect(result).toMatchObject({ received: 5, written: 3, inserted: 1, updated: 2, skipped: 2 });
    const items = enqueueMany.mock.calls[0]![0] as Array<{ kind: string; payload: { jobId: string; force?: boolean }; options: { dedupeKey: string } }>;
    expect(items.map((i) => i.payload.jobId).sort()).toEqual(['old2', expect.stringMatching(/^c/)].sort());
    expect(items.every((i) => i.kind === 'job.enrich' && /^job\.enrich:[^:]+:v[0-9a-f]{12}$/.test(i.options.dedupeKey))).toBe(true);
    // A changed row must be re-enriched even though it already carries
    // ENRICH_VERSION (WP-17's enrichJob skips it without `force`); a new row
    // is a plain first enrichment.
    expect(items.find((i) => i.payload.jobId === 'old2')!.payload).toEqual({ jobId: 'old2', force: true });
    expect(items.find((i) => i.payload.jobId !== 'old2')!.payload).not.toHaveProperty('force');
  });
});

describe('education level and enrichment (review fix)', () => {
  it('the text rule fills a new row and a row not enriched yet, and leaves an enriched row\'s level alone', async () => {
    const text = '任职要求：本科及以上学历，3年经验。';
    const { db, written } = createIngestFake({
      existing: [
        { id: 'enriched', externalId: 'jsearch:e', sourceBoard: 'jsearch', firstSeenAt: new Date('2026-09-01'), visibility: 'public', contentHash: 'x', enrichedEducation: true },
        { id: 'plain', externalId: 'jsearch:p', sourceBoard: 'jsearch', firstSeenAt: new Date('2026-09-01'), visibility: 'public', contentHash: 'x', enrichedEducation: false },
      ],
    });
    await processJobs(ctxFor(db).ctx, { provider: 'jsearch' }, [
      job({ externalId: 'jsearch:e', description: text }),
      job({ externalId: 'jsearch:p', description: text }),
      job({ externalId: 'jsearch:n', description: text }),
    ]);
    const level = (ext: string) => written.find((w) => w.externalId === ext)!.educationLevel;
    expect(level('jsearch:e')).toBeNull();
    expect(level('jsearch:p')).toBe('bachelor');
    expect(level('jsearch:n')).toBe('bachelor');
  });

  it('the prefetch reads whether the stored row is enriched and holds a level', async () => {
    const { db, fake } = createIngestFake();
    await processJobs(ctxFor(db).ctx, { provider: 'jsearch' }, [job()]);
    const prefetch = fake.$sql.calls.find((c) => c.text.startsWith('SELECT "id", "externalId", "sourceBoard", "firstSeenAt"'))!;
    expect(prefetch.text).toContain('("enrichedAt" IS NOT NULL AND "educationLevel" IS NOT NULL) AS "enrichedEducation"');
  });
});

describe('leases and budgets', () => {
  it('leases with FOR UPDATE SKIP LOCKED, by priority, for enabled providers of the market', () => {
    const rec = toRecordedSql('$queryRaw', buildLeaseSql('intl', ['jsearch', 'activejobs'], 4), []);
    expect(rec.text).toMatchSnapshot();
    expect(rec.text).toContain('FOR UPDATE SKIP LOCKED');
    expect(rec.text).toContain(`SET "nextRunAt" = now() + interval '15 minutes'`);
    expect(rec.text).toContain('ORDER BY "priority" ASC, "nextRunAt" ASC');
    expect(rec.values).toEqual(['intl', ['jsearch', 'activejobs'], 4]);
  });

  it('a spent daily budget stops calls: no fetch, the query waits for the next UTC day', async () => {
    const { db, fake, reserved } = createIngestFake({
      budget: { jsearch: 1 },
      due: [leased('jsearch', 'q1'), leased('jsearch', 'q2'), leased('jsearch', 'q3')],
    });
    const adapter = searchAdapter('jsearch', async () => ({ jobs: [job()], calls: 1 }));
    const tally = await runIngestTick({ db, brand: robo, adapters: [adapter], budgetMs: 60_000, now: () => NOW, enqueueMany: async () => ({ inserted: 0 }), env: { INGEST_LEASE_BATCH: '3' } });
    expect(adapter.fetch).toHaveBeenCalledTimes(1);
    expect(tally.budgetStops).toEqual(['jsearch']);
    expect(reserved).toEqual(['jsearch', 'jsearch']); // q3 never reserved: the provider left the tick
    const deferred = fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = $1'));
    expect(deferred!.values[0]).toEqual(nextBudgetDay(NOW));
    expect(nextBudgetDay(NOW).toISOString()).toBe('2026-10-11T00:05:00.000Z');
  });

  it('SEO seeds stop at their share of the day; demand keeps the rest', async () => {
    // The operator's bound is 10 a day → seeds may reserve while calls < 5.
    const { db, fake } = createIngestFake({ budget: { jsearch: 0 } });
    const adapter = searchAdapter('jsearch', async () => ({ jobs: [], calls: 1 }));
    const seed = await runIngestQuery(ctxFor(db, 'intl', { env: { INGEST_JSEARCH_DAILY_CALLS: '10' } }).ctx, adapter, leased('jsearch', 's1', { origin: 'seo_seed' }));
    expect(seed.status).toBe('seed_budget');
    expect(adapter.fetch).not.toHaveBeenCalled();
    const reserve = fake.$sql.calls.find((c) => c.text.includes('RETURNING "calls"'))!;
    expect(reserve.values.at(-1)).toBe(5);
    const defer = fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = $1'))!;
    expect(defer.text).toContain('AND "origin" = $');
    expect(defer.values).toEqual([nextBudgetDay(NOW), 'intl', 'jsearch', nextBudgetDay(NOW), 'seo_seed']);
  });

  it('a zero budget never inserts a usage row', async () => {
    const { db, fake } = createIngestFake();
    expect(await reserveProviderCall(db, 'jsearch', '2026-10-10', 0)).toBe(false);
    expect(fake.$sql.calls).toHaveLength(0);
  });

  it('a provider failure writes nothing and retries in an hour', async () => {
    const { db, fake, written } = createIngestFake();
    const adapter = searchAdapter('linkedin', async () => ({ jobs: [], calls: 1, error: 'provider_unavailable' }));
    const r = await runIngestQuery(ctxFor(db).ctx, adapter, leased('linkedin'));
    expect(r.status).toBe('error');
    expect(written).toHaveLength(0);
    const finish = fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "lastRunAt"'))!;
    expect(finish.values[1]).toEqual(new Date(NOW.getTime() + 3_600_000));
  });

  it('an empty run increments consecutiveEmpty; GoApply ingest uses its own market', async () => {
    const { db, fake } = createIngestFake();
    const adapter = searchAdapter('jsearch', async () => ({ jobs: [], calls: 1 }));
    await runIngestQuery(ctxFor(db).ctx, adapter, leased('jsearch', 'q', { consecutiveEmpty: 3 }));
    const finish = fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "lastRunAt"'))!;
    expect(finish.values[4]).toBe(4);
    expect(go.market).toBe('cn');
  });
});

describe('one budget per provider (MKT-3A: JI-1, JC-6)', () => {
  const day = '2026-10-10';
  const usageRows = (fake: { $sql: { calls: Array<{ text: string; values: unknown[] }> } }) => fake.$sql.calls.filter((c) => c.text.startsWith('INSERT INTO "RAProviderUsage"'));

  it('a plan with 25 requests a month and 0 left: the tick makes no Active Jobs DB call, parks its due queries (a day at a time, toward the reset) and reports it under budgetStops', async () => {
    const resetSeconds = Math.round(16.9 * 86_400);
    quotaReading('activejobs', 429, 25, 0, resetSeconds, 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.');
    // The reset is 16.9 days away: the queries are parked for a day, then looked at again (no provider call).
    const parkedUntil = new Date(NOW.getTime() + QUOTA_PARK_MAX_MS);
    const { db, fake, reserved } = createIngestFake({
      due: [leased('activejobs', 'a1'), leased('activejobs', 'a2'), leased('jsearch', 'j1')],
    });
    // The client reports itself off while its plan is used up (its own gate): the tick still leases the provider once.
    const activejobs = { ...searchAdapter('activejobs', async () => ({ jobs: [job({ externalId: 'activejobs:1', sourceBoard: 'activejobs' })], calls: 1 })), isEnabled: () => false };
    const jsearch = searchAdapter('jsearch', async () => ({ jobs: [job()], calls: 1 }));
    expect(quotaStopsIngest(activejobs, NOW, {})).toBe(true);
    expect(adapterRunsInTick(activejobs, 'intl', NOW, {})).toBe(true);
    expect(quotaStopsIngest(jsearch, NOW, {})).toBe(false);

    const tally = await runIngestTick({ db, brand: robo, adapters: [activejobs, jsearch], budgetMs: 60_000, now: () => NOW, enqueueMany: async () => ({ inserted: 0 }), env: { INGEST_LEASE_BATCH: '3' }, perQueryTracking: false });

    expect(activejobs.fetch).not.toHaveBeenCalled();
    expect(jsearch.fetch).toHaveBeenCalledTimes(1);
    expect(tally.budgetStops).toEqual(['activejobs']);
    expect(tally).toMatchObject({ queries: 2, calls: 1, errors: 0 });
    // Nothing was reserved for the stopped provider; a2 was never even looked at.
    expect(reserved).toEqual(['jsearch']);
    // Every due query of the provider is parked in one statement.
    const defers = fake.$sql.calls.filter((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = $1'));
    expect(defers).toHaveLength(1);
    expect(defers[0]!.values).toEqual([parkedUntil, 'intl', 'activejobs', parkedUntil]);
    expect(defers[0]!.text).toBe(toRecordedSql('$executeRaw', buildDeferProviderSql('intl', 'activejobs', parkedUntil, null), []).text);
    expect(defers[0]!.text).not.toContain('"origin"');
  });

  it('parked queries are released when the plan reopens: a day later still used up → parked again without a call; after a reading that reopens it they run (review fix)', async () => {
    const seventeenDays = 17 * 86_400;
    quotaReading('activejobs', 429, 25, 0, seventeenDays, 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.');
    const adapter = searchAdapter('activejobs', async () => ({ jobs: [], calls: 1 }));
    const parkOf = (fake: { $sql: { calls: Array<{ text: string; values: unknown[] }> } }) => fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = $1'))?.values[0];

    // Day 0: q1 is leased, the plan is used up: q1..q3 (every due query of the provider) are parked to day 1.
    const d0 = createIngestFake();
    expect((await runIngestQuery(ctxFor(d0.db).ctx, adapter, leased('activejobs', 'q1'))).status).toBe('quota');
    expect(parkOf(d0.fake)).toEqual(new Date(NOW.getTime() + QUOTA_PARK_MAX_MS));

    // Day 1: they are due, the reading still says used up: one statement, no call, parked to day 2.
    const day1 = new Date(NOW.getTime() + QUOTA_PARK_MAX_MS);
    const d1 = createIngestFake();
    expect((await runIngestQuery(ctxFor(d1.db, 'intl', { now: day1 }).ctx, adapter, leased('activejobs', 'q1'))).status).toBe('quota');
    expect(parkOf(d1.fake)).toEqual(new Date(day1.getTime() + QUOTA_PARK_MAX_MS));
    expect(d1.reserved).toEqual([]);
    expect(adapter.fetch).not.toHaveBeenCalled();

    // The owner buys a plan; a person's search (any process) gets a 200 with 19,999 of 20,000 left.
    quotaReading('activejobs', 200, 20_000, 19_999, 30 * 86_400, '', new Date(day1.getTime() + 3_600_000));
    // Day 2: the parked queries are due and run. Nobody had to release them, and none waits for the old reset.
    const day2 = new Date(day1.getTime() + QUOTA_PARK_MAX_MS);
    for (const id of ['q1', 'q2', 'q3']) {
      const kit = createIngestFake();
      expect((await runIngestQuery(ctxFor(kit.db, 'intl', { now: day2 }).ctx, adapter, leased('activejobs', id))).status).toBe('ok');
      expect(parkOf(kit.fake)).toBeUndefined();
    }
    expect(adapter.fetch).toHaveBeenCalledTimes(3);
  });

  it('INGEST_QUOTA_RECHECK_HOURS brings parked queries back: they are parked to the end of the window, and one call re-reads the plan', async () => {
    const env = { INGEST_QUOTA_RECHECK_HOURS: '6' };
    quotaReading('activejobs', 429, 25, 0, 17 * 86_400, 'MONTHLY quota exceeded on your current plan, BASIC');
    const sixHours = new Date(NOW.getTime() + 6 * 3_600_000);
    // The provider answers 429 again when asked (the fetch reports the reading as the client would).
    const adapter = searchAdapter('activejobs', async () => {
      quotaReading('activejobs', 429, 25, 0, 17 * 86_400 - 6 * 3_600, 'MONTHLY quota exceeded on your current plan, BASIC', sixHours);
      return { jobs: [], calls: 1, error: 'provider_unavailable' };
    });
    const before = createIngestFake();
    expect((await runIngestQuery(ctxFor(before.db, 'intl', { env }).ctx, adapter, leased('activejobs', 'q1'))).status).toBe('quota');
    expect(before.fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = $1'))!.values[0]).toEqual(sixHours);
    // The window opens: q1 makes the one call that re-reads the plan (the old reading's "0 left" does not
    // make the day's limit 0: the call is reserved under the operator's bound or the default)…
    const open = createIngestFake();
    expect((await runIngestQuery(ctxFor(open.db, 'intl', { env, now: sixHours }).ctx, adapter, leased('activejobs', 'q1'))).status).toBe('error');
    expect(adapter.fetch).toHaveBeenCalledTimes(1);
    expect(open.fake.$sql.calls.find((c) => c.text.includes('RETURNING "calls"'))!.values).toEqual(['activejobs', '2026-10-10', 300]);
    // …and q2, leased right after it, finds the plan still used up: parked for another window, no second call.
    const next = createIngestFake();
    expect((await runIngestQuery(ctxFor(next.db, 'intl', { env, now: sixHours }).ctx, adapter, leased('activejobs', 'q2'))).status).toBe('quota');
    expect(next.fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = $1'))!.values[0]).toEqual(new Date(sixHours.getTime() + 6 * 3_600_000));
    expect(adapter.fetch).toHaveBeenCalledTimes(1);
  });

  it('a quota stop ends at the reset the provider stated: before it no call, from it on the query runs again', async () => {
    quotaReading('activejobs', 429, 25, 0, 3_600, 'MONTHLY quota exceeded on your current plan, BASIC');
    const adapter = searchAdapter('activejobs', async () => ({ jobs: [], calls: 1 }));
    const before = await runIngestQuery(ctxFor(createIngestFake().db).ctx, adapter, leased('activejobs'));
    expect(before).toMatchObject({ status: 'quota', calls: 0 });
    expect(adapter.fetch).not.toHaveBeenCalled();
    const later = new Date(NOW.getTime() + 3_600_000);
    const after = await runIngestQuery(ctxFor(createIngestFake().db, 'intl', { now: later }).ctx, adapter, leased('activejobs'));
    expect(after.status).toBe('ok');
    expect(adapter.fetch).toHaveBeenCalledTimes(1);
  });

  it('a refused key waits an hour, with or without a reset in its headers; an unmetered source never asks the quota', async () => {
    recordQuotaObservation(quotaObservationFrom('jsearch', { status: 403, headers: { get: () => null } }, '{"message":"You are not subscribed to this API."}', NOW));
    const { db, fake } = createIngestFake();
    const adapter = searchAdapter('jsearch', async () => ({ jobs: [], calls: 1 }));
    expect((await runIngestQuery(ctxFor(db).ctx, adapter, leased('jsearch'))).status).toBe('quota');
    const defer = fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = $1'))!;
    expect(defer.values[0]).toEqual(new Date(NOW.getTime() + 3_600_000));
    // A 403 that passed the gateway with the plan's headers (reset in 17 days) is still a one-hour stop:
    // two hours later the query runs and the plan is read again (review fix).
    quotaReading('activejobs', 403, 20_000, 19_000, 17 * 86_400, '{"message":"This endpoint is disabled for your subscription"}');
    const gated = searchAdapter('activejobs', async () => ({ jobs: [], calls: 1 }));
    const refused = createIngestFake();
    expect((await runIngestQuery(ctxFor(refused.db).ctx, gated, leased('activejobs'))).status).toBe('quota');
    expect(refused.fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = $1'))!.values[0]).toEqual(new Date(NOW.getTime() + 3_600_000));
    const twoHours = new Date(NOW.getTime() + 2 * 3_600_000);
    expect((await runIngestQuery(ctxFor(createIngestFake().db, 'intl', { now: twoHours }).ctx, gated, leased('activejobs'))).status).toBe('ok');
    expect(gated.fetch).toHaveBeenCalledTimes(1);
    // The same provider id on an adapter that declares no call budget (not metered): the quota is not consulted.
    const unmetered = { ...searchAdapter('jsearch', async () => ({ jobs: [], calls: 1 })), dailyCallLimit: () => null };
    expect((await runIngestQuery(ctxFor(createIngestFake().db).ctx, unmetered, leased('jsearch'))).status).toBe('ok');
  });

  it('ingest stops at the reserve kept for people\'s own searches (5% of the monthly limit)', async () => {
    quotaReading('jsearch', 200, 10_000, 500, 86_400);
    const adapter = searchAdapter('jsearch', async () => ({ jobs: [], calls: 1 }));
    const { db, fake } = createIngestFake();
    expect((await runIngestQuery(ctxFor(db).ctx, adapter, leased('jsearch'))).status).toBe('quota');
    expect(fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = $1'))!.values[0]).toEqual(new Date(NOW.getTime() + 86_400_000));
    // With a smaller reserve the same reading allows the call.
    const allowed = await runIngestQuery(ctxFor(createIngestFake().db, 'intl', { env: { INGEST_QUOTA_RESERVE_SHARE: '0.01' } }).ctx, adapter, leased('jsearch'));
    expect(allowed.status).toBe('ok');
  });

  it('the day\'s limit is what is left of the plan spread over the days to its reset (545 a day), under the operator\'s bound', async () => {
    quotaReading('jsearch', 200, 10_000, 9_773, Math.round(16.9 * 86_400));
    const adapter = searchAdapter('jsearch', async () => ({ jobs: [], calls: 1 }));
    const a = createIngestFake();
    await runIngestQuery(ctxFor(a.db, 'intl', { env: {} }).ctx, adapter, leased('jsearch'));
    const reserveA = a.fake.$sql.calls.find((c) => c.text.includes('RETURNING "calls"'))!;
    expect(reserveA.values).toEqual(['jsearch', day, 545]);
    const b = createIngestFake();
    await runIngestQuery(ctxFor(b.db, 'intl', { env: { INGEST_JSEARCH_DAILY_CALLS: '120' } }).ctx, adapter, leased('jsearch'));
    expect(b.fake.$sql.calls.find((c) => c.text.includes('RETURNING "calls"'))!.values).toEqual(['jsearch', day, 120]);
    // Seeds get their share of that same limit.
    const c = createIngestFake();
    await runIngestQuery(ctxFor(c.db, 'intl', { env: {} }).ctx, adapter, leased('jsearch', 's', { origin: 'seo_seed' }));
    expect(c.fake.$sql.calls.find((x) => x.text.includes('RETURNING "calls"'))!.values).toEqual(['jsearch', day, 272]);
    // Once the headers have shown that one call takes two requests, the day's 545 requests are 272 calls (review fix).
    quotaReading('jsearch', 200, 10_000, 9_771, Math.round(16.9 * 86_400) - 3, '', new Date(NOW.getTime() + 3_000));
    const d = createIngestFake();
    await runIngestQuery(ctxFor(d.db, 'intl', { env: {}, now: new Date(NOW.getTime() + 3_000) }).ctx, adapter, leased('jsearch'));
    expect(d.fake.$sql.calls.find((x) => x.text.includes('RETURNING "calls"'))!.values).toEqual(['jsearch', day, 272]); // floor(floor((9771 − 500) / 17) / 2)
  });

  it('a query run for GoApply is counted under <provider>:cn and refused while INGEST_ACTIVEJOBS_CN_DAILY_CALLS is unset', async () => {
    const adapter = { ...searchAdapter('activejobs', async () => ({ jobs: [], calls: 1 })), markets: ['intl', 'cn'] as const };
    const off = createIngestFake();
    const refused = await runIngestQuery(ctxFor(off.db, 'cn', { env: { INGEST_ACTIVEJOBS_DAILY_CALLS: '300' } }).ctx, adapter, leased('activejobs', 'qc', { market: 'cn' }));
    expect(refused).toMatchObject({ status: 'budget', calls: 0 });
    expect(adapter.fetch).not.toHaveBeenCalled();
    // A zero bound writes no usage row at all; the provider's cn queries wait for the next day.
    expect(usageRows(off.fake)).toHaveLength(0);
    expect(off.fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = $1'))!.values).toEqual([nextBudgetDay(NOW), 'cn', 'activejobs', nextBudgetDay(NOW)]);

    const on = createIngestFake();
    const ran = await runIngestQuery(ctxFor(on.db, 'cn', { env: { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '20' } }).ctx, adapter, leased('activejobs', 'qc', { market: 'cn' }));
    expect(ran.status).toBe('ok');
    expect(on.reserved).toEqual(['activejobs:cn']);
    const rows = usageRows(on.fake);
    expect(rows.map((r) => r.values[0])).toEqual(['activejobs:cn', 'activejobs:cn']);
    expect(rows[0]!.values).toEqual(['activejobs:cn', day, 20]);
    // The international site's row is untouched by a mainland call, and the other way round.
    const intl = createIngestFake();
    await runIngestQuery(ctxFor(intl.db, 'intl', { env: { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '20' } }).ctx, adapter, leased('activejobs'));
    expect(usageRows(intl.fake).map((r) => r.values[0])).toEqual(['activejobs', 'activejobs']);
    expect(usageRows(intl.fake)[0]!.values).toEqual(['activejobs', day, 300]);
  });

  it('a person\'s own search and an ingest query of the same day add up in ONE usage row; the ingest call is counted once', async () => {
    const { db, fake } = createIngestFake();
    setQuotaDepsForTests({ db: db as unknown as QuotaDb, now: () => NOW, env: {}, market: () => 'intl' });
    // The onboarding search: the client asks the gate before its upstream call.
    expect(providerCallGate('jsearch', 'interactive')).toBe(true);
    // The ingest query: the pipeline reserves the call, the adapter fetches with reservedByIngest (the gate counts nothing).
    const adapter = searchAdapter('jsearch', async () => {
      expect(providerCallGate('jsearch', 'ingest')).toBe(true);
      return { jobs: [job()], calls: 1 };
    });
    await runIngestQuery(ctxFor(db).ctx, adapter, leased('jsearch'));
    await flushProviderQuota();
    const rows = usageRows(fake);
    // Three statements, one row: the gate's count (+1), the reservation (+1), the yield counters (+0 calls).
    expect(rows.map((r) => [r.values[0], r.values[1]])).toEqual([
      ['jsearch', day],
      ['jsearch', day],
      ['jsearch', day],
    ]);
    const counted = rows.filter((r) => r.text.includes('RETURNING "calls"')).length + rows.filter((r) => !r.text.includes('RETURNING "calls"')).reduce((n, r) => n + Number(r.values[2]), 0);
    expect(counted).toBe(2);
  });

  it('addToTally lists a quota stop like a spent day; a quota stop is not a run of the source', () => {
    const t = emptyTally();
    addToTally(t, { queryId: 'q', provider: 'activejobs', status: 'quota', calls: 0 });
    addToTally(t, { queryId: 'q2', provider: 'activejobs', status: 'quota', calls: 0 });
    addToTally(t, { queryId: 'q3', provider: 'jsearch', status: 'budget', calls: 0 });
    expect(t.budgetStops).toEqual(['activejobs', 'jsearch']);
    const status = emptyRunStatus(NOW, null);
    addToSourceStatus(status, { queryId: 'q', provider: 'activejobs', status: 'quota', calls: 0 });
    expect(status.queries).toBe(0);
  });
});

describe('a cursor source uses at most its share of a tick (INGEST_CURSOR_TICK_SHARE, default 0.4)', () => {
  function cursorAdapter(provider: JobSourceAdapter['provider'], fetchImpl: JobSourceAdapter['fetch']): JobSourceAdapter {
    return { provider, kind: 'cursor', markets: ['intl'], sourceBoards: [provider], isEnabled: () => true, supportsCountry: () => true, dailyCallLimit: () => null, fetch: vi.fn(fetchImpl) };
  }

  /** A fake that hands the sweep's query out again every time it is due (a cursor query that reports more is due at once). */
  function sweepFake(demand: LeasedQueryRow[]) {
    const queue = [...demand];
    const kit = createIngestFake();
    const inner = kit.fake.$queryRaw.bind(kit.fake);
    const sweep = leased('tw_open_data', 'sweep', { origin: 'bank_sync', priority: 5, params: { q: '', country: 'TW', datePosted: 'all' } });
    const db = new Proxy(kit.db, {
      get(target, key, receiver) {
        if (key !== '$queryRaw') return Reflect.get(target, key, receiver);
        return async (first: unknown, ...rest: unknown[]) => {
          const out = await inner(first as never, ...(rest as never[]));
          const call = kit.fake.$sql.calls.at(-1)!;
          if (!call.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = now() + interval')) return out;
          const providers = call.values.find((v) => Array.isArray(v)) as string[];
          const rows: LeasedQueryRow[] = [];
          if (providers.includes('tw_open_data')) rows.push(sweep);
          if (providers.includes('jsearch')) rows.push(...queue.splice(0, 2));
          return rows;
        };
      },
    }) as typeof kit.db;
    return { ...kit, db };
  }

  it('a sweep that always reports more steps aside after about 40% of the tick while demand is due; the demand queries all run before it goes on', async () => {
    let t = 0;
    const clock = () => t;
    const budgets: Array<number | undefined> = [];
    const order: string[] = [];
    // Each fetch of the sweep takes 10 s of the tick and never finishes.
    const sweep = cursorAdapter('tw_open_data', async (_q, ctx) => {
      budgets.push(ctx.budgetMs);
      order.push('sweep');
      t += 10_000;
      return { jobs: [], calls: 5, cursor: `c${t}`, exhausted: false };
    });
    const demand = searchAdapter('jsearch', async () => {
      order.push('demand');
      t += 1_000;
      return { jobs: [], calls: 1 };
    });
    // Twelve demand queries: two come with each lease, so four are still waiting when the sweep's share is used.
    const { db } = sweepFake(Array.from({ length: 12 }, (_, i) => leased('jsearch', `d${i + 1}`)));
    const tally = await runIngestTick({ db, brand: robo, adapters: [sweep, demand], budgetMs: 100_000, now: () => NOW, clock, enqueueMany: async () => ({ inserted: 0 }), env: {}, perQueryTracking: false });

    // 40% of 100 s at 10 s a fetch: four fetches, each told how much of the share was left, then the
    // sweep steps aside although it has more rows.
    expect(budgets.slice(0, 4)).toEqual([40_000, 30_000, 20_000, 10_000]);
    const fifthSweep = order.map((who, i) => (who === 'sweep' ? i : -1)).filter((i) => i >= 0)[4]!;
    // Every demand query of the tick ran before the sweep's fifth fetch: the last four of them while it stood aside.
    expect(order.slice(0, fifthSweep).filter((who) => who === 'demand')).toHaveLength(12);
    expect(order.slice(fifthSweep - 4, fifthSweep)).toEqual(['demand', 'demand', 'demand', 'demand']);
    expect(demand.fetch).toHaveBeenCalledTimes(12);
    // Nothing else was due after that and the tick had time left: the sweep went on with a new share
    // (52 s were used: 40 by the sweep, 12 by demand), instead of leaving the rest of the tick idle.
    expect(budgets[4]).toBe(40_000);
    expect(order.slice(fifthSweep).every((who) => who === 'sweep')).toBe(true);
    expect(tally.stoppedBy).toBe('budget');
    expect(tally.budgetStops).toEqual([]);
  });

  it('a cursor source alone in a tick runs to the tick\'s end, a share at a time (review fix: nothing else could use the time)', async () => {
    let t = 0;
    const budgets: Array<number | undefined> = [];
    const sweep = cursorAdapter('bank_gohire', async (_q, ctx) => {
      budgets.push(ctx.budgetMs);
      // A source that keeps inside what it is handed (at most 10 s a fetch).
      t += Math.min(10_000, ctx.budgetMs ?? 10_000);
      return { jobs: [], calls: 1, cursor: `c${t}`, exhausted: false };
    });
    const kit = createIngestFake();
    const inner = kit.fake.$queryRaw.bind(kit.fake);
    const backfill = leased('bank_gohire', 'bank', { market: 'cn', origin: 'bank_sync', priority: 5, params: { q: '', country: '*', datePosted: 'all' } });
    let leases = 0;
    // The backfill's query is due again every time it is asked for (it reports more rows each run).
    const db = new Proxy(kit.db, {
      get(target, key, receiver) {
        if (key !== '$queryRaw') return Reflect.get(target, key, receiver);
        return async (first: unknown, ...rest: unknown[]) => {
          const out = await inner(first as never, ...(rest as never[]));
          const call = kit.fake.$sql.calls.at(-1)!;
          if (!call.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = now() + interval')) return out;
          leases += 1;
          return (call.values.find((v) => Array.isArray(v)) as string[]).includes('bank_gohire') ? [backfill] : [];
        };
      },
    }) as typeof kit.db;
    const tally = await runIngestTick({ db, brand: go, adapters: [sweep], budgetMs: 100_000, now: () => NOW, clock: () => t, enqueueMany: async () => ({ inserted: 0 }), env: {}, perQueryTracking: false });

    // 95 s of the 100 s tick (its own 5 s margin is kept): the first share, the second, and what was left.
    expect(t).toBe(95_000);
    expect(budgets).toEqual([40_000, 30_000, 20_000, 10_000, 40_000, 30_000, 20_000, 10_000, 15_000, 5_000]);
    expect(tally.stoppedBy).toBe('budget');
    expect(tally.queries).toBe(10);
    // One lease per fetch: with no other source in the tick the next share costs no statement.
    expect(leases).toBe(10);
  });

  it('a second query of a source whose share is used is handed back, not run with no time left; with nothing else due it runs later in the same tick', async () => {
    let t = 0;
    const budgets: Array<number | undefined> = [];
    // One slow fetch per board that finishes (no more rows) but takes a whole share.
    const fetch = vi.fn(async (_q: unknown, ctx: { budgetMs?: number }) => {
      budgets.push(ctx.budgetMs);
      t += 40_000;
      return { jobs: [], calls: 1, exhausted: true };
    });
    const boards = cursorAdapter('ats_public', fetch);
    const q = (id: string) => leased('ats_public', id, { origin: 'bank_sync', priority: 5, params: { q: '', country: '*', datePosted: 'all' } });
    const kit = createIngestFake();
    const inner = kit.fake.$queryRaw.bind(kit.fake);
    const innerExec = kit.fake.$executeRaw.bind(kit.fake);
    // A lease hands out what is due; a query handed back (nextRunAt = now) is due again.
    const due = [q('b1'), q('b2')];
    const db = new Proxy(kit.db, {
      get(target, key, receiver) {
        if (key === '$queryRaw') {
          return async (first: unknown, ...rest: unknown[]) => {
            const out = await inner(first as never, ...(rest as never[]));
            const call = kit.fake.$sql.calls.at(-1)!;
            if (!call.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = now() + interval')) return out;
            return (call.values.find((v) => Array.isArray(v)) as string[]).includes('ats_public') ? due.splice(0, 2) : [];
          };
        }
        if (key === '$executeRaw') {
          return async (first: unknown, ...rest: unknown[]) => {
            const out = await innerExec(first as never, ...(rest as never[]));
            const call = kit.fake.$sql.calls.at(-1)!;
            if (call.text === 'UPDATE "RAIngestQuery" SET "nextRunAt" = $1::timestamp(3) WHERE "id" = $2') due.push(q(String(call.values[1])));
            return out;
          };
        }
        return Reflect.get(target, key, receiver);
      },
    }) as typeof kit.db;
    const tally = await runIngestTick({ db, brand: robo, adapters: [boards], budgetMs: 100_000, now: () => NOW, clock: () => t, enqueueMany: async () => ({ inserted: 0 }), env: { INGEST_LEASE_BATCH: '2' }, perQueryTracking: false });
    // b2 was leased with b1 (15 minutes ahead) and b1 used the whole share: b2 is made due again at once…
    const handedBack = kit.fake.$sql.calls.filter((c) => c.text === 'UPDATE "RAIngestQuery" SET "nextRunAt" = $1::timestamp(3) WHERE "id" = $2');
    expect(handedBack.map((c) => c.values)).toEqual([[NOW, 'b2']]);
    // …and, nothing else being due, runs in this tick with a share of its own (not with the 0 s that were left of b1's).
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(budgets).toEqual([40_000, 40_000]);
    expect(tally.queries).toBe(2);
  });

  it('while other work is due a handed-back query waits: the source gets no second share before the demand queries have run', async () => {
    let t = 0;
    const order: string[] = [];
    const boards = cursorAdapter('ats_public', async () => {
      order.push('boards');
      t += 40_000;
      return { jobs: [], calls: 1, exhausted: true };
    });
    const demand = searchAdapter('jsearch', async () => {
      order.push('demand');
      t += 1_000;
      return { jobs: [], calls: 1 };
    });
    const q = (id: string) => leased('ats_public', id, { origin: 'bank_sync', priority: 5, params: { q: '', country: '*', datePosted: 'all' } });
    // One lease hands out both board queries; the demand queries come one per later lease.
    const kit = createIngestFake();
    const inner = kit.fake.$queryRaw.bind(kit.fake);
    const boardsDue = [q('b1'), q('b2')];
    const demandDue = [leased('jsearch', 'd1'), leased('jsearch', 'd2'), leased('jsearch', 'd3')];
    const db = new Proxy(kit.db, {
      get(target, key, receiver) {
        if (key !== '$queryRaw') return Reflect.get(target, key, receiver);
        return async (first: unknown, ...rest: unknown[]) => {
          const out = await inner(first as never, ...(rest as never[]));
          const call = kit.fake.$sql.calls.at(-1)!;
          if (!call.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = now() + interval')) return out;
          const providers = call.values.find((v) => Array.isArray(v)) as string[];
          if (providers.includes('ats_public') && boardsDue.length) return boardsDue.splice(0, 2);
          return providers.includes('jsearch') ? demandDue.splice(0, 1) : [];
        };
      },
    }) as typeof kit.db;
    await runIngestTick({ db, brand: robo, adapters: [boards, demand], budgetMs: 100_000, now: () => NOW, clock: () => t, enqueueMany: async () => ({ inserted: 0 }), env: {}, perQueryTracking: false });
    // b1 used the share; the three demand queries ran next. (b2 was handed back; this fake does not hand it out again.)
    expect(order).toEqual(['boards', 'demand', 'demand', 'demand']);
  });

  it('queries leased with the last one a tick had time for are handed back, not left to their 15-minute lease; a parked provider\'s are not touched', async () => {
    let t = 0;
    // The sweep's fetch uses up the tick; two demand queries and one of a used-up provider came in the same lease.
    const sweep = cursorAdapter('tw_open_data', async () => {
      t += 96_000;
      return { jobs: [], calls: 5, cursor: 'c1', exhausted: false };
    });
    const demand = searchAdapter('jsearch', async () => ({ jobs: [], calls: 1 }));
    const spent = searchAdapter('activejobs', async () => ({ jobs: [], calls: 1 }));
    quotaReading('activejobs', 429, 25, 0, 17 * 86_400, 'MONTHLY quota exceeded on your current plan, BASIC');
    const { db, fake } = createIngestFake({
      due: [
        leased('activejobs', 'a1'),
        leased('tw_open_data', 'sweep', { origin: 'bank_sync', priority: 5, params: { q: '', country: 'TW', datePosted: 'all' } }),
        leased('jsearch', 'd1'),
        leased('jsearch', 'd2'),
        leased('activejobs', 'a2'),
      ],
    });
    const tally = await runIngestTick({ db, brand: robo, adapters: [sweep, demand, spent], budgetMs: 100_000, now: () => NOW, clock: () => t, enqueueMany: async () => ({ inserted: 0 }), env: { INGEST_LEASE_BATCH: '5', INGEST_CURSOR_TICK_SHARE: '1' }, perQueryTracking: false });
    expect(tally.stoppedBy).toBe('budget');
    expect(demand.fetch).not.toHaveBeenCalled();
    expect(spent.fetch).not.toHaveBeenCalled();
    // d1 and d2 are due again at once. a2 was parked with a1 by the quota stop and stays parked.
    const handedBack = fake.$sql.calls.filter((c) => c.text === 'UPDATE "RAIngestQuery" SET "nextRunAt" = $1::timestamp(3) WHERE "id" = $2');
    expect(handedBack.map((c) => c.values)).toEqual([
      [NOW, 'd1'],
      [NOW, 'd2'],
    ]);
    expect(tally.budgetStops).toEqual(['activejobs']);
  });

  it('the share is configurable; a cursor source that finishes inside its share is not cut', async () => {
    let t = 0;
    const budgets: Array<number | undefined> = [];
    const sweep = cursorAdapter('tw_open_data', async (_q, ctx) => {
      budgets.push(ctx.budgetMs);
      t += 10_000;
      return { jobs: [], calls: 5, cursor: `c${t}`, exhausted: false };
    });
    const { db } = sweepFake([]);
    await runIngestTick({ db, brand: robo, adapters: [sweep], budgetMs: 100_000, now: () => NOW, clock: () => t, enqueueMany: async () => ({ inserted: 0 }), env: { INGEST_CURSOR_TICK_SHARE: '0.2' }, perQueryTracking: false });
    // A share of 20 s: two fetches, then (nothing else being due) the next share.
    expect(budgets.slice(0, 4)).toEqual([20_000, 10_000, 20_000, 10_000]);

    // A bank sync that is done in one fetch: one fetch, whatever the clock says.
    let t2 = 0;
    const read = vi.fn(async () => [bankRow()]);
    const bank = createBankAdapter('robohire', { read, isEnabled: () => true, pageSize: () => 50, env: PAGES });
    const kit = createIngestFake({ due: [leased('bank_robohire', 'qb', { origin: 'bank_sync', priority: 5, params: { q: '', country: '*', datePosted: 'all' } })] });
    const tally = await runIngestTick({ db: kit.db, brand: robo, adapters: [bank], budgetMs: 100_000, now: () => NOW, clock: () => (t2 += 50_000), enqueueMany: async () => ({ inserted: 0 }), env: {}, perQueryTracking: false });
    expect(read).toHaveBeenCalledTimes(1);
    expect(tally.queries).toBe(1);
  });
});

describe('the refresh interval gets the query\'s country (strategy 1.2 tier 2, 1.3)', () => {
  it('hands origin, demand score, empty runs and the country to nextRunDelayMs; "*" and a missing country are passed as they are', async () => {
    const adapter = searchAdapter('jsearch', async () => ({ jobs: [], calls: 1 }));
    await runIngestQuery(ctxFor(createIngestFake().db).ctx, adapter, leased('jsearch', 'tw', { demandScore: 2, consecutiveEmpty: 1, params: { q: '軟體工程師', country: 'TW', city: 'Taipei', datePosted: 'month' } }));
    expect(refreshSpy).toHaveBeenLastCalledWith({ origin: 'demand', demandScore: 2, consecutiveEmpty: 2, country: 'TW' });
    await runIngestQuery(ctxFor(createIngestFake().db).ctx, adapter, leased('jsearch', 'us', { demandScore: 6, params: { q: 'Data analyst', country: 'US', datePosted: '3days' } }));
    expect(refreshSpy).toHaveBeenLastCalledWith({ origin: 'demand', demandScore: 6, consecutiveEmpty: 1, country: 'US' });
    // A stored query with no country reads as the wildcard, as it always did.
    await runIngestQuery(ctxFor(createIngestFake().db).ctx, adapter, leased('jsearch', 'any', { params: { q: 'Data analyst' } }));
    expect(refreshSpy).toHaveBeenLastCalledWith({ origin: 'demand', demandScore: 2, consecutiveEmpty: 1, country: '*' });
    // A cursor source that reports more is due at once: no interval is computed.
    refreshSpy.mockClear();
    const more: JobSourceAdapter = { ...searchAdapter('jsearch', async () => ({ jobs: [], calls: 1, cursor: 'c', exhausted: false })), kind: 'cursor', dailyCallLimit: () => null };
    const { db, fake } = createIngestFake();
    const r = await runIngestQuery(ctxFor(db).ctx, more, leased('jsearch', 'cur'));
    expect(r.more).toBe(true);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "lastRunAt"'))!.values[1]).toEqual(NOW);
  });
});

describe('known employer domains reach the normalizer, page by page (JI-5 support; strategy 1.5 K3)', () => {
  const COMPANY_QUERY = 'SELECT "nameNormalized", "domain" FROM "RACompany"';

  /** A fake whose RACompany lookup answers with `stored`. */
  function withCompanies(stored: Array<{ nameNormalized: string; domain: string | null }>) {
    const kit = createIngestFake();
    const inner = kit.fake.$queryRaw.bind(kit.fake);
    const db = new Proxy(kit.db, {
      get(target, key, receiver) {
        if (key !== '$queryRaw') return Reflect.get(target, key, receiver);
        return async (first: unknown, ...rest: unknown[]) => {
          const out = await inner(first as never, ...(rest as never[]));
          return kit.fake.$sql.calls.at(-1)!.text.startsWith(COMPANY_QUERY) ? stored : out;
        };
      },
    }) as typeof kit.db;
    const lookups = () => kit.fake.$sql.calls.filter((c) => c.text.startsWith(COMPANY_QUERY));
    return { ...kit, db, lookups };
  }

  const domainsSeen = () => normalizeSpy.mock.calls.map((c) => (c[2] as { companyDomains?: ReadonlyMap<string, string> }).companyDomains);

  it('a domain one row of the page states reaches every row of that company; no lookup is needed', async () => {
    const { db, lookups, written } = withCompanies([]);
    await processJobs(ctxFor(db).ctx, { provider: 'activejobs' }, [
      job({ externalId: 'activejobs:1', sourceBoard: 'activejobs', company: 'Acme Inc.' }),
      job({ externalId: 'activejobs:2', sourceBoard: 'activejobs', company: 'ACME, Inc', title: 'QA Engineer', companyFacts: { source: 'provider:activejobs', website: 'https://www.acme.example/careers' } }),
    ]);
    expect(written).toHaveLength(2);
    const seen = domainsSeen();
    expect(seen).toHaveLength(2);
    // The same map object for the whole page.
    expect(seen[0]).toBe(seen[1]);
    expect([...seen[0]!.entries()]).toEqual([['acme', 'acme.example']]);
    expect(lookups()).toHaveLength(0);
  });

  it('companies the page does not state a domain for are looked up once per page, by market and normalised name', async () => {
    const { db, lookups } = withCompanies([
      { nameNormalized: 'beta', domain: 'beta.example' },
      { nameNormalized: 'gamma', domain: null },
      { nameNormalized: 'delta', domain: '  ' },
    ]);
    const inputs = [
      job({ externalId: 'jsearch:a', company: 'Beta LLC' }),
      job({ externalId: 'jsearch:b', company: 'Beta LLC', title: 'QA Engineer' }),
      job({ externalId: 'jsearch:c', company: 'Gamma Ltd' }),
      job({ externalId: 'jsearch:d', company: 'Delta Corp' }),
      job({ externalId: 'jsearch:e', company: 'Acme Inc.', companyFacts: { source: 'provider:jsearch', domain: 'WWW.Acme.example' } }),
    ];
    await processJobs(ctxFor(db).ctx, { provider: 'jsearch' }, inputs);
    expect(lookups()).toHaveLength(1);
    expect(lookups()[0]!.text).toBe('SELECT "nameNormalized", "domain" FROM "RACompany" WHERE "market" = $1 AND "nameNormalized" = ANY($2::text[]) AND "domain" IS NOT NULL');
    // Only the names still unknown are asked for; the page-stated one is not.
    expect(lookups()[0]!.values).toEqual(['intl', ['beta', 'gamma', 'delta']]);
    const map = domainsSeen()[0]!;
    expect(new Map(map)).toEqual(new Map([['acme', 'acme.example'], ['beta', 'beta.example']]));
    expect(domainsSeen().every((m) => m === map)).toBe(true);
  });

  it('a page of 100 rows makes exactly one extra query; a mainland page asks for market cn', async () => {
    const { db, lookups, fake } = withCompanies([]);
    const page = Array.from({ length: 100 }, (_, i) => job({ externalId: `jsearch:${i}`, company: `Company ${i % 20} Inc.`, title: `Role ${i}` }));
    const result = await processJobs(ctxFor(db).ctx, { provider: 'jsearch' }, page);
    expect(result.written).toBe(100);
    expect(lookups()).toHaveLength(1);
    expect((lookups()[0]!.values[1] as string[]).length).toBe(20);
    // The read is the only statement added before the upsert: prefetch, lookup, then writes.
    expect(fake.$sql.calls.findIndex((c) => c.text.startsWith(COMPANY_QUERY))).toBe(1);

    const cn = withCompanies([]);
    await processJobs(ctxFor(cn.db, 'cn').ctx, { provider: 'bank_gohire' }, [job({ externalId: 'gh9', sourceBoard: 'gohire', company: '示例科技有限公司', location: '深圳', applyUrl: 'https://example.test/p/gh9' })]);
    expect(cn.lookups()[0]!.values[0]).toBe('cn');
  });

  it('with no domain known anywhere the context carries an empty map and the rows are written exactly as without it', async () => {
    const inputs = [job(), job({ externalId: 'jsearch:2', company: 'Beta LLC', title: 'QA Engineer' })];
    const { db, written, lookups } = withCompanies([]);
    await processJobs(ctxFor(db).ctx, { provider: 'jsearch' }, inputs);
    expect(lookups()).toHaveLength(1);
    expect(domainsSeen().map((m) => m!.size)).toEqual([0, 0]);
    // The same page with domains known: nothing in a written row depends on the map in this bundle
    // (the dedupe key reads it in the normalizer, MKT-3C).
    const known = withCompanies([{ nameNormalized: 'acme', domain: 'acme.example' }, { nameNormalized: 'beta', domain: 'beta.example' }]);
    await processJobs(ctxFor(known.db).ctx, { provider: 'jsearch' }, inputs);
    const strip = (rows: typeof written) => rows.map(({ id: _id, companyId: _companyId, ...rest }) => rest);
    expect(strip(known.written)).toEqual(strip(written));
  });

  it('companyDomainsForPage: stated domain before stated website before the stored row; a job board\'s company page is not a domain; empty names are skipped', async () => {
    const queryRaw = vi.fn(async () => [
      { nameNormalized: 'beta', domain: 'stored-beta.example' },
      { nameNormalized: 'acme', domain: 'stored-acme.example' },
      { nameNormalized: 'omega', domain: 'omega.example' },
    ]);
    const db = { $queryRaw: queryRaw } as unknown as PipelineContext['db'];
    const map = await companyDomainsForPage(db, 'intl', [
      job({ company: 'Acme Inc.', companyFacts: { source: 's', domain: 'acme.example', website: 'https://other.example' } }),
      job({ company: 'Acme Inc.', companyFacts: { source: 's', website: 'https://second.example' } }),
      job({ company: 'Beta LLC', companyFacts: { source: 's', website: 'https://www.linkedin.com/company/beta' } }),
      job({ company: 'Omega GmbH' }),
      job({ company: '   ' }),
      job({ company: 'Zeta Co', companyFacts: { source: 's', website: 'not a url' } }),
    ]);
    expect(new Map(map)).toEqual(
      new Map([
        ['acme', 'acme.example'],
        ['beta', 'stored-beta.example'],
        ['omega', 'omega.example'],
      ]),
    );
    expect(queryRaw).toHaveBeenCalledTimes(1);
    // Every name has a stated domain: no read at all.
    queryRaw.mockClear();
    const stated = await companyDomainsForPage(db, 'intl', [job({ company: 'Acme Inc.', companyFacts: { source: 's', domain: 'acme.example' } })]);
    expect([...stated]).toEqual([['acme', 'acme.example']]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
