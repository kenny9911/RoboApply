// @vitest-environment node
//
// The inventory pipeline's public surface exports the provider call limit
// other areas display (WP-93: the admin "Limits" page reads it from here
// instead of a copy).

//
// MKT-3A: the surface also carries the one budget per metered provider (the
// quota read API and the effective daily limit), and loading it registers the
// quota listener and the call gate with both RapidAPI clients, so callers of
// the clients outside ingest are covered without importing ingest themselves.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import prisma from '../../../lib/prisma.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { quotaObservationFrom } from '../../../roboapply/v2/lib/raExternalJobTypes.js';
import { __test as fantasticTest, isFantasticJobsEnabled, searchFantasticJobs } from '../../../roboapply/v2/lib/raFantasticJobs.js';
import { __test as jsearchTest, isJSearchEnabled } from '../../../roboapply/v2/lib/raRapidApiJobs.js';
import * as config from './config.js';
import * as ingest from './index.js';
import * as quota from './quota.js';
import * as contract from './quotaContract.js';

describe('jobs/ingest/index.ts limit export', () => {
  it('dailyCallLimit is the config module’s own (no second definition)', () => {
    expect(ingest.dailyCallLimit).toBe(config.dailyCallLimit);
  });

  it('reads INGEST_<PROVIDER>_DAILY_CALLS with the default behind it; an unmetered provider has no limit', () => {
    expect(ingest.dailyCallLimit('activejobs', {})).toBe(config.DEFAULT_DAILY_CALLS.activejobs);
    expect(ingest.dailyCallLimit('jsearch', { INGEST_JSEARCH_DAILY_CALLS: '40' })).toBe(40);
    expect(ingest.dailyCallLimit('bank_gohire', {})).toBeNull();
  });
});

describe('jobs/ingest/index.ts quota surface (MKT-3A)', () => {
  afterEach(() => {
    quota.resetProviderQuotaForTests();
    jsearchTest.reset();
    fantasticTest.reset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const key of Object.keys(prisma)) delete (prisma as unknown as Record<string, unknown>)[key];
  });

  it('exports the quota read API and the effective limit as the modules\' own (no second definition)', () => {
    expect(ingest.effectiveDailyLimit).toBe(config.effectiveDailyLimit);
    expect(ingest.quotaAllows).toBe(quota.quotaAllows);
    expect(ingest.quotaSnapshot).toBe(quota.quotaSnapshot);
    expect(ingest.providerQuotaSnapshots).toBe(quota.providerQuotaSnapshots);
    expect(ingest.hydrateProviderQuota).toBe(quota.hydrateProviderQuota);
    expect(ingest.flushProviderQuota).toBe(quota.flushProviderQuota);
    expect(ingest.registerQuotaListeners).toBe(quota.registerQuotaListeners);
    expect(ingest.quotaRetryAt).toBe(quota.quotaRetryAt);
    expect(ingest.quotaParkUntil).toBe(quota.quotaParkUntil);
    expect(ingest.answerForMarket).toBe(quota.answerForMarket);
    expect(ingest.recordQuotaObservation).toBe(quota.recordQuotaObservation);
    // The M1 contract is still exported from here (the admin reader, MKT-3F, imports it from this surface).
    expect(ingest.PROVIDER_QUOTA_CONFIG_KEY).toBe('jobs.providerQuota.v1');
    expect(ingest.parseProviderQuota).toBe(contract.parseProviderQuota);
    expect(ingest.usageKey('activejobs', 'cn')).toBe('activejobs:cn');
  });

  it('loading the surface wires both clients: a reading closes the provider for every caller, and a client\'s own response is recorded', async () => {
    vi.stubEnv('RAPID_API_KEY', 'synthetic-key');
    vi.stubEnv('RA_ONBOARDING_EXTERNAL_JOBS_DISABLED', '');
    vi.stubEnv('RA_ONBOARDING_ACTIVEJOBS_DISABLED', '');
    const now = new Date('2026-10-11T08:00:00.000Z');
    quota.setQuotaDepsForTests({ db: createFakePrisma() as unknown as quota.QuotaDb, now: () => now, env: {}, market: () => 'intl' });
    expect(isJSearchEnabled()).toBe(true);
    // SYNTHETIC reading: JSearch's plan is used up until tomorrow.
    const headers: Record<string, string> = { 'x-ratelimit-requests-limit': '10000', 'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-reset': '86400' };
    quota.recordQuotaObservation(quotaObservationFrom('jsearch', { status: 429, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } }, 'MONTHLY quota exceeded on your current plan, PRO', now));
    expect(isJSearchEnabled()).toBe(false);
    expect(ingest.quotaSnapshot('jsearch', now)).toMatchObject({ state: 'exhausted', plan: 'PRO' });
    // The other client reports through the same listener.
    expect(isFantasticJobsEnabled('activejobs')).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"You are not subscribed to this API."}', { status: 403 })));
    expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' })).toBeNull();
    expect(ingest.quotaSnapshot('activejobs', now)).toMatchObject({ state: 'not_subscribed', lastStatus: 403 });
    await ingest.flushProviderQuota();
  });

  it('ingestForProfile loads the stored quota before it plans or runs anything', async () => {
    const observed = Date.now();
    const stored = contract.serializeProviderQuota([
      { provider: 'activejobs', plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, jobsLimit: null, jobsRemaining: null, resetAt: new Date(observed + 86_400_000).toISOString(), observedAt: new Date(observed).toISOString(), lastStatus: 429, lastCallCost: null, state: 'exhausted' },
    ]);
    const fake = createFakePrisma({ seed: { appConfig: [{ key: contract.PROVIDER_QUOTA_CONFIG_KEY, value: stored }] } });
    Object.assign(prisma as unknown as Record<string, unknown>, { appConfig: fake.appConfig, rASearchProfile: fake.rASearchProfile });
    expect(ingest.quotaAllows('activejobs', 'ingest')).toBe(true);
    expect(await ingest.ingestForProfile('missing-profile', 1_000)).toMatchObject({ planned: 0, deferred: 0, queries: 0 });
    expect(ingest.quotaAllows('activejobs', 'ingest')).toBe(false);
  });
});
