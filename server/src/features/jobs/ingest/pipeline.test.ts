// @vitest-environment node
// WP-16b acceptance through the pipeline (no network, no database):
//   - GoHire jobs carry market 'cn'; bank jobs are fromRecruiterBank;
//   - a draft / unpublished bank job never syncs; closed ones are archived;
//   - a bank job without recorded syndication consent has publicDisplay=false;
//   - publicDisplay for providers only via PUBLIC_DISPLAY_PROVIDERS (default empty);
//   - the daily budget stops calls; applicantCount never written from linkedin/jsearch;
//   - the lease is FOR UPDATE SKIP LOCKED; enrich is queued for new / changed rows only;
//   - marketHooks.afterNormalize runs before the upsert.
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
import { runIngestTick } from './run.js';
import { createIngestFake } from './testkit.js';
import { contentHash } from './upsert.js';

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
    const adapter = createBankAdapter('gohire', { read, isEnabled: () => true, pageSize: () => 50 });
    const { ctx } = ctxFor(db, 'cn');
    const result = await runIngestQuery(ctx, adapter, leased('bank_gohire', 'qb', { market: 'cn', origin: 'bank_sync', params: { q: '', country: '*', datePosted: 'all' } }));

    expect(result.status).toBe('ok');
    expect(written.map((r) => r.externalId)).toEqual(['gh1']);
    const [row] = written;
    expect(row).toMatchObject({ market: 'cn', sourceBoard: 'gohire', fromRecruiterBank: true, publicDisplay: false, employerVerified: false, sourcePriority: 15, sourceName: 'GoHire' });
    expect(row!.applyUrl).toContain('/jobs/gh1');
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
    const adapter = createBankAdapter('robohire', { read: async () => [consented, bankRow({ id: 'rh2', title: 'QA Engineer', companyName: 'Beta', location: 'Austin, TX' })], isEnabled: () => true });
    const { ctx } = ctxFor(db, 'intl');
    await runIngestQuery(ctx, adapter, leased('bank_robohire', 'qr', { origin: 'bank_sync' }));
    expect(written.find((w) => w.externalId === 'rh1')).toMatchObject({ market: 'intl', publicDisplay: true, employerVerified: true, fromRecruiterBank: true });
    expect(written.find((w) => w.externalId === 'rh2')).toMatchObject({ publicDisplay: false, employerVerified: false });
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
