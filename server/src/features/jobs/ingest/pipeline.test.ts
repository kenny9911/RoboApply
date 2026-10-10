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
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { getBrand } from '../../../platform/brand/index.js';
import { toRecordedSql } from '../../../test/sqlSnapshot.js';
import type { ProviderJobInput } from '../normalize/index.js';
import type { JobSourceAdapter, SourceFetchResult } from '../sources/index.js';
import { createBankAdapter, type BankSyncRow } from './adapters/bank.js';
import {
  buildLeaseSql,
  nextBudgetDay,
  processJobs,
  reserveProviderCall,
  runIngestQuery,
  type LeasedQueryRow,
  type PipelineContext,
} from './pipeline.js';
import { addToSourceStatus, addToTally, emptyTally, runIngestTick } from './run.js';
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

beforeEach(() => hookSpy.mockClear());

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

  it('the tick hands each source what is left of its budget (less the reserve), so a multi-request source stops inside it', async () => {
    const lease = () => leased('bank_gohire', 'qb', { market: 'cn', origin: 'bank_sync', params: { q: '', country: '*', datePosted: 'all' } });
    const { db } = createIngestFake({ due: [lease()] });
    const seen: Array<number | undefined> = [];
    const adapter: JobSourceAdapter = {
      provider: 'bank_gohire', kind: 'cursor', markets: ['cn'], sourceBoards: ['gohire'],
      isEnabled: () => true, supportsCountry: () => true, dailyCallLimit: () => null,
      fetch: async (_query, ctx) => {
        seen.push(ctx.budgetMs);
        return { jobs: [], calls: 1, exhausted: true };
      },
    };
    await runIngestTick({ db, brand: go, adapters: [adapter], budgetMs: 60_000, now: () => NOW, enqueueMany: async () => ({ inserted: 0 }), perQueryTracking: false });
    expect(seen).toHaveLength(1);
    // 60 s budget, 5 s reserve: at most 55 s, and close to it (the lease took almost no time).
    expect(seen[0]).toBeLessThanOrEqual(55_000);
    expect(seen[0]).toBeGreaterThan(50_000);
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
    // limit 10 → seeds may reserve while calls < 5.
    const { db, fake } = createIngestFake({ budget: { jsearch: 0 } });
    const adapter = searchAdapter('jsearch', async () => ({ jobs: [], calls: 1 }));
    const seed = await runIngestQuery(ctxFor(db).ctx, adapter, leased('jsearch', 's1', { origin: 'seo_seed' }));
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
