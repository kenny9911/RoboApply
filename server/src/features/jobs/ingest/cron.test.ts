// @vitest-environment node
// WP-16b: the three crons (idle in < 2 s, reporting; GoApply ingests by default
// and stops only under CN_RECRUITMENT_INFO_MODE=off; the seed boards),
// maintenance SQL (45-day expiry, per-query missed refreshes behind the
// SR-16b-1 probe, dedupe repair), targeted ingest for onboarding and the
// `ingest.query` worker.
// Market wave (MKT-3A): every entry point (jobs-plan, jobs-ingest, the worker)
// first loads what the providers last said about their plans from AppConfig, so
// a process that never called a provider stops for a used-up plan too.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import prisma from '../../../lib/prisma.js';
import { getBrand, runWithBrand } from '../../../platform/brand/index.js';
import { createBudget } from '../../../platform/queue/index.js';
import { toRecordedSql } from '../../../test/sqlSnapshot.js';
import { resetSourceAdaptersForTests, registerSourceAdapter } from '../sources/index.js';
import type { JobSourceAdapter } from '../sources/index.js';
import { ingestAllowed, runJobsIngest, runJobsMaintain, runJobsPlan, setIngestCronDepsForTests } from './cron.js';
import { buildExpireSql, runMaintenance } from './maintain.js';
import { runIngestQuery } from './pipeline.js';
import { paramsHash } from './planner.js';
import { resetBuiltinAdaptersForTests } from './providers.js';
import { QUOTA_PARK_MAX_MS, quotaAllows, quotaSnapshot, resetProviderQuotaForTests } from './quota.js';
import { PROVIDER_QUOTA_CONFIG_KEY, serializeProviderQuota, type ProviderQuotaSnapshot } from './quotaContract.js';
import { buildMissedSql, isMissedTwice, perQueryTrackingAvailable, resetTrackingCacheForTests } from './tracking.js';
import { ingestForProfileWith, INGEST_QUERY_KIND } from './run.js';
import { createIngestFake } from './testkit.js';
import { JOBS_INGEST_WORK_KINDS, workers } from './workers.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const robo = getBrand('roboapply');
const go = getBrand('goapply');
const ctx = (brand = robo) => ({ name: 'jobs-ingest', brand, budget: createBudget(240_000), now: NOW });

function stubAdapter(provider: JobSourceAdapter['provider'], over: Partial<JobSourceAdapter> = {}): JobSourceAdapter {
  return {
    provider,
    kind: 'search',
    markets: ['intl'],
    sourceBoards: [provider],
    isEnabled: () => true,
    supportsCountry: () => true,
    dailyCallLimit: () => 100,
    fetch: vi.fn(async () => ({ jobs: [], calls: 1 })),
    ...over,
  };
}

const BUILTINS = ['activejobs', 'jsearch', 'bank_robohire', 'bank_gohire'] as const;

/** Replace every built-in with a stub (disabled unless given) so no real client is ever reachable. */
function installStubs(list: JobSourceAdapter[]): void {
  resetSourceAdaptersForTests();
  for (const a of list) registerSourceAdapter(a);
  for (const p of BUILTINS) {
    if (list.some((a) => a.provider === p)) continue;
    const cursor = p.startsWith('bank_');
    registerSourceAdapter(
      stubAdapter(p, { isEnabled: () => false, kind: cursor ? 'cursor' : 'search', markets: [p === 'bank_gohire' ? 'cn' : 'intl'], dailyCallLimit: () => (cursor ? null : 100) }),
    );
  }
}

afterEach(() => {
  setIngestCronDepsForTests({});
  resetTrackingCacheForTests();
  resetSourceAdaptersForTests();
  resetBuiltinAdaptersForTests();
  resetProviderQuotaForTests();
  for (const key of Object.keys(prisma)) delete (prisma as unknown as Record<string, unknown>)[key];
});

/**
 * SYNTHETIC stored reading, as another process would have written it after a 429 on a BASIC plan
 * (25 requests a month, none left, reset in 17 days). The tick reads the wall clock, so the times are relative to it.
 */
function storedQuota(over: Partial<ProviderQuotaSnapshot> = {}): { key: string; value: string } {
  const observed = Date.now();
  const snapshot: ProviderQuotaSnapshot = {
    provider: 'activejobs',
    plan: 'BASIC',
    requestsLimit: 25,
    requestsRemaining: 0,
    jobsLimit: 250,
    jobsRemaining: 0,
    resetAt: new Date(observed + 17 * 86_400_000).toISOString(),
    observedAt: new Date(observed).toISOString(),
    lastStatus: 429,
    lastCallCost: null,
    state: 'exhausted',
    ...over,
  };
  return { key: PROVIDER_QUOTA_CONFIG_KEY, value: serializeProviderQuota([snapshot]) };
}

const dueQuery = (id: string, provider: string) => ({ id, market: 'intl', provider, params: { q: 'QA', country: 'US', datePosted: 'week' }, origin: 'demand', demandScore: 1, priority: 50, consecutiveEmpty: 0 });

describe('crons', () => {
  it('jobs-ingest answers no_work fast when nothing is due (one lease statement)', async () => {
    installStubs([stubAdapter('activejobs'), stubAdapter('jsearch'), stubAdapter('bank_robohire', { kind: 'cursor' })]);
    const { db, fake } = createIngestFake();
    setIngestCronDepsForTests({ db, env: {} });
    const started = Date.now();
    expect(await runJobsIngest(ctx())).toEqual({ skipped: 'no_work' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fake.$sql.calls).toHaveLength(1);
    expect(fake.$sql.calls[0]!.text).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('jobs-ingest reports the work done and kicks enrichment', async () => {
    const adapter = stubAdapter('jsearch', {
      fetch: vi.fn(async () => ({
        jobs: [{ externalId: 'jsearch:1', sourceBoard: 'jsearch', title: 'QA Engineer', company: 'Acme', applyUrl: 'https://jobs.lever.co/acme/1', location: 'Austin, TX', postedAt: '2026-10-09T00:00:00Z' }],
        calls: 1,
      })),
    });
    installStubs([stubAdapter('activejobs', { isEnabled: () => false }), adapter]);
    const { db } = createIngestFake({
      due: [{ id: 'q1', market: 'intl', provider: 'jsearch', params: { q: 'QA', country: 'US', datePosted: 'week' }, origin: 'demand', demandScore: 1, priority: 50, consecutiveEmpty: 0 }],
    });
    const kick = vi.fn();
    const enqueueMany = vi.fn(async (items: unknown[]) => ({ inserted: items.length }));
    setIngestCronDepsForTests({ db, env: {}, kick, enqueueMany });
    const res = await runWithBrand('roboapply', () => runJobsIngest(ctx()));
    expect(enqueueMany).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ processed: 1, queries: 1, inserted: 1, calls: 1 });
    expect(kick).toHaveBeenCalledWith(['job.enrich']);
  });

  it('jobs-ingest with a provider whose plan is used up (read from AppConfig): no call to it, its due queries are parked (a day at a time, toward the reset), it is reported under budgetStops', async () => {
    // The real adapter reports itself off while its plan is used up; the stub does the same.
    const activejobs = stubAdapter('activejobs', { isEnabled: () => false });
    const jsearch = stubAdapter('jsearch');
    installStubs([activejobs, jsearch]);
    const stored = storedQuota();
    const resetAt = new Date(JSON.parse(stored.value).providers.activejobs.resetAt);
    const { db, fake } = createIngestFake({ seed: { appConfig: [stored] }, due: [dueQuery('a1', 'activejobs'), dueQuery('j1', 'jsearch')] });
    setIngestCronDepsForTests({ db, env: {}, enqueueMany: async () => ({ inserted: 0 }), perQueryTracking: false });
    // This process has made no provider call: it knows nothing until it reads the stored row.
    expect(quotaSnapshot('activejobs')).toBeNull();

    const startedAt = Date.now();
    const res = await runWithBrand('roboapply', () => runJobsIngest(ctx()));
    const endedAt = Date.now();

    expect(quotaSnapshot('activejobs')).toMatchObject({ state: 'exhausted', plan: 'BASIC', requestsRemaining: 0 });
    expect(activejobs.fetch).not.toHaveBeenCalled();
    expect(jsearch.fetch).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ processed: 2, queries: 2, calls: 1, budgetStops: ['activejobs'] });
    // The lease included the stopped provider (so its queries could be pushed out), then one statement deferred them.
    const lease = fake.$sql.calls.find((c) => c.text.includes('FOR UPDATE SKIP LOCKED'))!;
    expect(lease.values[1]).toEqual(['activejobs', 'jsearch']);
    const defer = fake.$sql.calls.filter((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = $1'));
    expect(defer).toHaveLength(1);
    // Parked for a day (the reset is 17 days away): tomorrow one lease looks again, with no provider call.
    const until = defer[0]!.values[0] as Date;
    expect(defer[0]!.values).toEqual([until, 'intl', 'activejobs', until]);
    expect(until.getTime()).toBeGreaterThanOrEqual(startedAt + QUOTA_PARK_MAX_MS);
    expect(until.getTime()).toBeLessThanOrEqual(endedAt + QUOTA_PARK_MAX_MS);
    expect(until.getTime()).toBeLessThan(resetAt.getTime());
    // No usage row was reserved for it.
    expect(fake.$sql.calls.filter((c) => c.text.includes('RETURNING "calls"')).map((c) => c.values[0])).toEqual(['jsearch']);
  });

  it('jobs-ingest: a used-up provider alone still gets its queries deferred; a provider that is simply off is not leased', async () => {
    installStubs([stubAdapter('activejobs', { isEnabled: () => false })]);
    const quiet = createIngestFake({ due: [dueQuery('a1', 'activejobs')] });
    setIngestCronDepsForTests({ db: quiet.db, env: {} });
    // No reading anywhere: the provider is off (no key, a kill switch) and nothing is leased.
    expect(await runJobsIngest(ctx())).toEqual({ skipped: 'no_providers' });
    expect(quiet.fake.$sql.calls).toHaveLength(0);

    const stopped = createIngestFake({ seed: { appConfig: [storedQuota()] }, due: [dueQuery('a1', 'activejobs')] });
    setIngestCronDepsForTests({ db: stopped.db, env: {}, perQueryTracking: false });
    expect(await runJobsIngest(ctx())).toMatchObject({ processed: 1, calls: 0, budgetStops: ['activejobs'] });
    // The next tick finds nothing due for it (the fake lease is empty now) and makes no call either.
    expect(await runJobsIngest(ctx())).toEqual({ skipped: 'no_work' });
  });

  it('jobs-ingest: a stored reading whose reset has passed stops nothing', async () => {
    const adapter = stubAdapter('activejobs');
    installStubs([adapter]);
    const past = Date.now() - 3_600_000;
    const { db } = createIngestFake({
      seed: { appConfig: [storedQuota({ observedAt: new Date(past - 86_400_000).toISOString(), resetAt: new Date(past).toISOString() })] },
      due: [dueQuery('a1', 'activejobs')],
    });
    setIngestCronDepsForTests({ db, env: {}, enqueueMany: async () => ({ inserted: 0 }), perQueryTracking: false });
    const res = await runJobsIngest(ctx());
    expect(adapter.fetch).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ processed: 1, calls: 1, budgetStops: [] });
    expect(quotaSnapshot('activejobs')).toMatchObject({ state: 'unknown', requestsRemaining: null });
  });

  it('jobs-plan loads the stored quota before it plans (a provider that is out of quota is not planned)', async () => {
    installStubs([stubAdapter('jsearch')]);
    const { db } = createIngestFake({ seed: { appConfig: [storedQuota()] } });
    setIngestCronDepsForTests({ db, env: {} });
    expect(quotaAllows('activejobs', 'ingest')).toBe(true);
    await runJobsPlan({ ...ctx(), name: 'jobs-plan' });
    expect(quotaAllows('activejobs', 'ingest')).toBe(false);
    expect(quotaAllows('jsearch', 'ingest')).toBe(true);
  });

  it('GoApply plans and ingests by default; only CN_RECRUITMENT_INFO_MODE=off stops it', async () => {
    expect(ingestAllowed(go, {})).toBe(true);
    expect(ingestAllowed(go, { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' })).toBe(true);
    expect(ingestAllowed(go, { CN_RECRUITMENT_INFO_MODE: 'licensed' })).toBe(true);
    expect(ingestAllowed(go, { CN_RECRUITMENT_INFO_MODE: 'off' })).toBe(false);
    expect(ingestAllowed(robo, {})).toBe(true);
    expect(ingestAllowed(robo, { CN_RECRUITMENT_INFO_MODE: 'off' })).toBe(true);
    const { db, fake } = createIngestFake();
    setIngestCronDepsForTests({ db, env: { CN_RECRUITMENT_INFO_MODE: 'off' } });
    expect(await runJobsIngest(ctx(go))).toEqual({ skipped: 'disabled' });
    expect(await runJobsPlan({ ...ctx(go), name: 'jobs-plan' })).toEqual({ skipped: 'disabled' });
    expect(fake.$sql.calls).toHaveLength(0);
  });

  it('GoApply by default: the bank and the employer boards are its sources; no_providers only when none is on', async () => {
    const boards = stubAdapter('ats_public', { kind: 'cursor', markets: ['intl', 'cn'], sourceBoards: ['greenhouse'], dailyCallLimit: () => null });
    // The bank is off (no transport) and the boards are on: ingest runs, it does not answer no_providers.
    installStubs([boards]);
    const { db } = createIngestFake();
    setIngestCronDepsForTests({ db, env: {} });
    expect(await runJobsIngest(ctx(go))).toEqual({ skipped: 'no_work' });
    // With the bank's transport enabled (the HTTPS reader) the bank alone is enough.
    installStubs([stubAdapter('bank_gohire', { kind: 'cursor', markets: ['cn'], dailyCallLimit: () => null })]);
    expect(await runJobsIngest(ctx(go))).toEqual({ skipped: 'no_work' });
    // Nothing on at all: no_providers.
    installStubs([]);
    expect(await runJobsIngest(ctx(go))).toEqual({ skipped: 'no_providers' });
    // JOB_PROVIDERS_GOAPPLY narrows the list: with only the (disabled) bank left, no provider is on.
    installStubs([boards]);
    setIngestCronDepsForTests({ db, env: { JOB_PROVIDERS_GOAPPLY: 'bank_gohire' } });
    expect(await runJobsIngest(ctx(go))).toEqual({ skipped: 'no_providers' });
  });

  it('GoApply jobs-plan registers the verified seed boards once, plans no search query and calls no provider', async () => {
    const boards = stubAdapter('ats_public', { kind: 'cursor', markets: ['intl', 'cn'], sourceBoards: ['greenhouse'], dailyCallLimit: () => null });
    const jsearch = stubAdapter('jsearch');
    installStubs([boards, jsearch, stubAdapter('bank_gohire', { kind: 'cursor', markets: ['cn'], dailyCallLimit: () => null })]);
    const { db, fake } = createIngestFake();
    setIngestCronDepsForTests({ db, env: { INGEST_SEED_ROLES: '2', INGEST_SEED_CITIES_PER_COUNTRY: '1', CN_EXTERNAL_PROVIDERS: 'jsearch' } });
    const first = await runJobsPlan({ ...ctx(go), name: 'jobs-plan' });
    // No search adapter serves market cn: nothing is planned for a provider, only the two standing syncs.
    expect(first).toMatchObject({ planned: 0, bankQueries: 2 });
    expect(Number(first.seedBoardsAdded)).toBeGreaterThanOrEqual(10);
    const sources = [...fake.$rows('rACareerSiteSource')];
    expect(sources).toHaveLength(Number(first.seedBoardsAdded));
    expect(sources.every((r) => r.market === 'cn' && r.countryCode === 'CN' && r.enabled === true && String(r.createdBy).startsWith('seed:'))).toBe(true);
    expect(fake.$rows('rAIngestQuery').map((q) => [q.provider, q.market, q.origin]).sort()).toEqual([
      ['ats_public', 'cn', 'bank_sync'],
      ['bank_gohire', 'cn', 'bank_sync'],
    ]);
    // A second run adds nothing (once per seed version), even after an admin removed a board.
    await db.rACareerSiteSource.delete({ where: { id: String(sources[0]!.id) } });
    expect(await runJobsPlan({ ...ctx(go), name: 'jobs-plan' })).toMatchObject({ seedBoardsAdded: 0 });
    expect(fake.$rows('rACareerSiteSource')).toHaveLength(sources.length - 1);
    expect(jsearch.fetch).not.toHaveBeenCalled();
    expect(boards.fetch).not.toHaveBeenCalled();
    // RoboApply ships no seed list in this wave: its plan adds no board.
    expect(await runJobsPlan({ ...ctx(), name: 'jobs-plan' })).toMatchObject({ seedBoardsAdded: 0 });
    expect(fake.$rows('rACareerSiteSource').every((r) => r.market === 'cn')).toBe(true);
  });

  it('jobs-plan writes queries without calling providers', async () => {
    const a = stubAdapter('jsearch');
    installStubs([a]);
    const { db } = createIngestFake();
    setIngestCronDepsForTests({ db, env: { INGEST_SEED_ROLES: '2', INGEST_SEED_CITIES_PER_COUNTRY: '1' } });
    const res = await runJobsPlan({ ...ctx(), name: 'jobs-plan' });
    // 2 seeds × 2 search adapters, activejobs and jsearch (planned even while a key is missing; leases skip disabled providers).
    expect(res).toMatchObject({ seedTuples: 2, planned: 4, bankQueries: 1 });
    expect(a.fetch).not.toHaveBeenCalled();
  });

  it('jobs-maintain without the SR-16b-1 columns: expiry and dedupe repair only, nothing archived as source_removed', async () => {
    installStubs([stubAdapter('jsearch'), stubAdapter('bank_robohire', { kind: 'cursor', dailyCallLimit: () => null })]);
    const { db, fake } = createIngestFake();
    setIngestCronDepsForTests({ db, env: {} });
    const res = await runJobsMaintain({ ...ctx(), name: 'jobs-maintain' });
    expect(res).toMatchObject({ expired: 0, missed: 0, dedupeRepaired: 0, missedRule: false });
    const texts = fake.$sql.texts();
    expect(texts.some((t) => t.includes('information_schema.columns'))).toBe(true);
    expect(texts.some((t) => t.includes(`'source_removed'`))).toBe(false);
    expect(texts.find((t) => t.startsWith('UPDATE "RAJob"'))).toContain(`"closeReason" = 'expired'`);
    expect(texts.some((t) => t.includes('WITH ranked AS'))).toBe(true);
    // Then the enrichment catch-up reads (nothing to queue here), after the dedupe repair.
    expect(res).toMatchObject({ enrichQueued: 0 });
    expect(texts.at(-1)).toContain('"enrichVersion"');
    expect(texts.findIndex((t) => t.includes('WITH ranked AS'))).toBeLessThan(texts.findIndex((t) => t.includes('"enrichVersion" <')));
  });

  it('jobs-maintain queues the enrichment catch-up under the cron’s brand and kicks the drain', async () => {
    installStubs([stubAdapter('jsearch')]);
    const { db } = createIngestFake();
    const stale = [{ id: 'old1' }, { id: 'old2' }];
    const raw = db.$queryRaw.bind(db);
    (db as unknown as { $queryRaw: unknown }).$queryRaw = async (first: unknown, ...rest: unknown[]) => {
      const text = (first as { text?: string; strings?: string[] }).text ?? (first as { strings?: string[] }).strings?.join('?') ?? '';
      if (text.includes('"enrichVersion" <')) return stale;
      return (raw as (...a: unknown[]) => Promise<unknown>)(first, ...rest);
    };
    const queued: Array<{ kind: string; payload: unknown; options?: { brand?: string; dedupeKey?: string } }> = [];
    const kick = vi.fn();
    setIngestCronDepsForTests({
      db,
      env: {},
      kick,
      enqueueMany: async (items) => {
        queued.push(...items);
        return { inserted: items.length };
      },
    });
    const res = await runJobsMaintain({ ...ctx(), name: 'jobs-maintain' });
    expect(res).toMatchObject({ enrichQueued: 2 });
    expect(queued.map((q) => [q.kind, q.payload, q.options?.brand])).toEqual([
      ['job.enrich', { jobId: 'old1' }, 'roboapply'],
      ['job.enrich', { jobId: 'old2' }, 'roboapply'],
    ]);
    expect(kick).toHaveBeenCalledWith(['job.enrich']);
  });

  it('jobs-maintain with the SR-16b-1 columns runs the per-query rule once per metered search provider', async () => {
    installStubs([stubAdapter('jsearch'), stubAdapter('bank_robohire', { kind: 'cursor', dailyCallLimit: () => null })]);
    const { db, fake } = createIngestFake();
    setIngestCronDepsForTests({ db, env: {}, perQueryTracking: true });
    const res = await runJobsMaintain({ ...ctx(), name: 'jobs-maintain' });
    expect(res).toMatchObject({ missedRule: true });
    // activejobs, jsearch — never the bank (it closes its own jobs).
    expect(fake.$sql.texts().filter((t) => t.includes(`'source_removed'`))).toHaveLength(2);
  });
});

describe('maintenance SQL', () => {
  it('expires public postings past their expiry or 45 days old — never a bank job or a public ATS board posting (WP-42)', () => {
    const rec = toRecordedSql('$executeRaw', buildExpireSql('intl'), []);
    expect(rec.text).toMatchSnapshot();
    expect(rec.text).toContain(`"closeReason" = 'expired'`);
    expect(rec.text).toContain('"sourceBoard" <> ALL(');
    // The banks and the ats_public boards: their own sync closes what the source stopped listing.
    expect(rec.values).toEqual(['intl', ['robohire', 'gohire', 'greenhouse', 'lever', 'ashby', 'smartrecruiters'], 45]);
  });

  it('archives a job only after 2 counted runs of the query that last returned it, inside that query\'s date window', () => {
    const rec = toRecordedSql('$executeRaw', buildMissedSql('intl', 'jsearch', ['jsearch']), []);
    expect(rec.text).toMatchSnapshot();
    expect(rec.text).toContain(`"closeReason" = 'source_removed'`);
    expect(rec.text).toContain(`j."lastSeenQueryId" = q."id"`);
    expect(rec.text).toContain(`q."runCount" >= j."lastSeenRun" +`);
    expect(rec.text).toContain(`WHEN 'week' THEN 7`);
    // No provider-wide activity proxy any more.
    expect(rec.text).not.toContain('RAProviderUsage');
    expect(rec.values).toContain(2);
  });

  it('a job last seen 4 days ago stays live while its own query has not re-run, however busy the provider is', () => {
    const now = NOW;
    const day = 86_400_000;
    const job = { lastSeenRun: 7, postedAt: new Date(now.getTime() - 5 * day), firstSeenAt: new Date(now.getTime() - 5 * day) };
    // The provider ran hundreds of OTHER queries since; this query is still at run 7.
    expect(isMissedTwice(job, { runCount: 7, datePosted: 'week' }, now)).toBe(false);
    expect(isMissedTwice(job, { runCount: 8, datePosted: 'week' }, now)).toBe(false);
    // Two later counted runs of its own query did not return it, still inside the week window → archived.
    expect(isMissedTwice(job, { runCount: 9, datePosted: 'week' }, now)).toBe(true);
    // Out of the week window: a 'week' search cannot return it, so missing it proves nothing.
    const old = { ...job, postedAt: new Date(now.getTime() - 10 * day) };
    expect(isMissedTwice(old, { runCount: 20, datePosted: 'week' }, now)).toBe(false);
    expect(isMissedTwice(old, { runCount: 20, datePosted: 'all' }, now)).toBe(true);
    // Never stamped by a counted run → never archived by this rule.
    expect(isMissedTwice({ ...job, lastSeenRun: null }, { runCount: 50, datePosted: 'week' }, now)).toBe(false);
  });

  it('without the SR-16b-1 columns runMaintenance archives nothing as source_removed, even for metered providers', async () => {
    const { db, fake } = createIngestFake();
    const res = await runMaintenance(db, 'intl', [stubAdapter('jsearch'), stubAdapter('activejobs')], { perQueryTracking: false });
    expect(res).toMatchObject({ missed: 0, missedRule: false });
    expect(fake.$sql.texts().some((t) => t.includes('source_removed'))).toBe(false);
  });

  it('skips the missed-refresh rule for unmetered sources (banks close their own jobs)', async () => {
    const { db, fake } = createIngestFake();
    await runMaintenance(db, 'cn', [stubAdapter('bank_gohire', { kind: 'cursor', markets: ['cn'], dailyCallLimit: () => null })], { perQueryTracking: true });
    expect(fake.$sql.texts().some((t) => t.includes('source_removed'))).toBe(false);
  });

  it('probes information_schema for all three SR-16b-1 columns and caches the answer', async () => {
    const absent = createIngestFake();
    expect(await perQueryTrackingAvailable(absent.db, 0)).toBe(false);
    resetTrackingCacheForTests();
    let probes = 0;
    const present = { $queryRaw: async () => (probes++, [{ n: 3 }]) } as unknown as Parameters<typeof perQueryTrackingAvailable>[0];
    expect(await perQueryTrackingAvailable(present, 1_000)).toBe(true);
    expect(await perQueryTrackingAvailable(present, 2_000)).toBe(true);
    expect(probes).toBe(1);
    resetTrackingCacheForTests();
    const partial = { $queryRaw: async () => [{ n: 2 }] } as unknown as Parameters<typeof perQueryTrackingAvailable>[0];
    expect(await perQueryTrackingAvailable(partial, 0)).toBe(false);
    resetTrackingCacheForTests();
    const broken = { $queryRaw: async () => Promise.reject(new Error('denied')) } as unknown as Parameters<typeof perQueryTrackingAvailable>[0];
    expect(await perQueryTrackingAvailable(broken, 0)).toBe(false);
  });

  it('with tracking, a search run that returned postings bumps runCount and stamps them; an empty run does not count', async () => {
    const row = { id: 'q1', market: 'intl', provider: 'jsearch', params: { q: 'QA', country: 'US', datePosted: 'week' }, origin: 'demand', demandScore: 1, priority: 50, consecutiveEmpty: 0 };
    const posting = { externalId: 'jsearch:1', sourceBoard: 'jsearch', title: 'QA Engineer', company: 'Acme', applyUrl: 'https://jobs.lever.co/acme/1', location: 'Austin, TX', postedAt: '2026-10-09T00:00:00Z' };
    const withJobs = createIngestFake();
    const enqueueMany = vi.fn(async (items: unknown[]) => ({ inserted: items.length }));
    const base = { brand: 'roboapply' as const, market: 'intl' as const, now: NOW, enqueueMany, perQueryTracking: true };
    await runIngestQuery({ ...base, db: withJobs.db }, stubAdapter('jsearch', { fetch: vi.fn(async () => ({ jobs: [posting], calls: 1 })) }), row);
    const texts = withJobs.fake.$sql.texts();
    expect(texts.some((t) => t.includes('SET "runCount" = "runCount" + 1'))).toBe(true);
    const stamp = withJobs.fake.$sql.calls.find((c) => c.text.includes('SET "lastSeenQueryId"'))!;
    expect(stamp.values).toEqual(['q1', 8, [withJobs.written[0]!.id]]);
    const empty = createIngestFake();
    await runIngestQuery({ ...base, db: empty.db }, stubAdapter('jsearch'), row);
    expect(empty.fake.$sql.texts().some((t) => t.includes('"runCount"'))).toBe(false);
    const off = createIngestFake();
    await runIngestQuery({ ...base, db: off.db, perQueryTracking: false }, stubAdapter('jsearch', { fetch: vi.fn(async () => ({ jobs: [posting], calls: 1 })) }), row);
    expect(off.fake.$sql.texts().some((t) => t.includes('"runCount"'))).toBe(false);
  });

  it.todo('SR-16b-1 (needs the columns in a real database): the per-query archive and the stamping UPDATEs execute against Postgres and archive exactly the jobs isMissedTwice selects');
});

describe('targeted ingest for onboarding (ingestForProfile)', () => {
  it('plans the profile, runs due queries within the budget and queues the rest', async () => {
    const adapter = stubAdapter('jsearch');
    const { db, fake } = createIngestFake({
      seed: { rASearchProfile: [{ id: 'sp1', userId: 'u1', filters: { taxonomyIds: ['backend_engineer'], country: 'US' } }] },
    });
    const planned = { q: 'Backend engineer', country: 'US', datePosted: 'week', taxonomyId: 'backend_engineer' };
    fake.$rows('rAIngestQuery').push({ id: 'q-new', provider: 'jsearch', paramsHash: paramsHash('intl', planned), enabled: true, nextRunAt: new Date(NOW.getTime() - 1) });
    const enqueueMany = vi.fn(async (items: unknown[]) => ({ inserted: items.length }));
    const result = await ingestForProfileWith({ db, brand: robo, adapters: [adapter], now: () => NOW, enqueueMany, env: {} }, 'sp1', 5_000);
    expect(result.planned).toBe(1);
    // Onboarding only adds demand; it never demotes a shared hot query.
    expect(fake.$sql.texts().find((t) => t.includes('INSERT INTO "RAIngestQuery"'))).toContain('GREATEST("RAIngestQuery"."demandScore"');
    // The fake lease hands out nothing, so the due query is queued for the worker.
    expect(result.deferred).toBe(1);
    const item = (enqueueMany.mock.calls.at(-1)![0] as Array<{ kind: string; payload: unknown; options: { dedupeKey: string; userId: string } }>)[0]!;
    expect(item).toMatchObject({ kind: INGEST_QUERY_KIND, payload: { queryId: 'q-new' }, options: { userId: 'u1', dedupeKey: 'ingest.query:q-new:2026-10-10' } });
    const lease = fake.$sql.calls.find((c) => c.text.includes('FOR UPDATE SKIP LOCKED'))!;
    expect(lease.text).toContain('AND "id" = ANY(');
    expect(adapter.fetch).not.toHaveBeenCalled();
  });

  it('an unknown profile plans nothing', async () => {
    const { db } = createIngestFake();
    expect(await ingestForProfileWith({ db, brand: robo, adapters: [stubAdapter('jsearch')], now: () => NOW }, 'missing', 1_000)).toMatchObject({ planned: 0, queries: 0 });
  });
});

describe('ingest.query worker', () => {
  it('declares its kind and rejects a payload without a query id', async () => {
    expect(workers.map((w) => w.kind)).toEqual([JOBS_INGEST_WORK_KINDS.ingestQuery]);
    const handler = workers[0]!.handler;
    await expect(
      handler(
        { id: 'w', kind: 'ingest.query', brand: 'roboapply', userId: null, payload: {}, attempts: 1, maxAttempts: 5, dedupeKey: null, priority: 100 },
        { budget: createBudget(10_000), leaseOwner: 't' },
      ),
    ).rejects.toThrow(/queryId/);
  });

  it('loads the stored quota first: a queued query of a used-up provider makes no call and is parked until the reset the provider stated', async () => {
    const activejobs = stubAdapter('activejobs', { isEnabled: () => false });
    installStubs([activejobs]);
    // The plan resets in six hours (under a day: the queries wait for exactly that instant).
    const stored = storedQuota({ resetAt: new Date(Date.now() + 6 * 3_600_000).toISOString() });
    const { fake } = createIngestFake({ seed: { appConfig: [stored] }, due: [dueQuery('a1', 'activejobs')] });
    // The worker runs on the process's own client (mocked as an empty object in this file).
    Object.assign(prisma as unknown as Record<string, unknown>, { appConfig: fake.appConfig, $queryRaw: fake.$queryRaw.bind(fake), $executeRaw: fake.$executeRaw.bind(fake) });
    expect(quotaSnapshot('activejobs')).toBeNull();
    await runWithBrand('roboapply', () =>
      workers[0]!.handler(
        { id: 'w', kind: 'ingest.query', brand: 'roboapply', userId: null, payload: { queryId: 'a1' }, attempts: 1, maxAttempts: 5, dedupeKey: null, priority: 100 },
        { budget: createBudget(10_000), leaseOwner: 't' },
      ),
    );
    expect(quotaSnapshot('activejobs')).toMatchObject({ state: 'exhausted' });
    expect(activejobs.fetch).not.toHaveBeenCalled();
    const lease = fake.$sql.calls.find((c) => c.text.includes('FOR UPDATE SKIP LOCKED'))!;
    expect(lease.values).toContainEqual(['a1']);
    const defer = fake.$sql.calls.find((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "nextRunAt" = $1'))!;
    expect(defer.values[0]).toEqual(new Date(JSON.parse(stored.value).providers.activejobs.resetAt));
  });
});
