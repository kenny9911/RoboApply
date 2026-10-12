// @vitest-environment node
// MKT-3A: one budget per metered provider (MARKET_STRATEGY §1.1, §1.2, JI-1, JC-6).
// What every RapidAPI response says about the plan is kept per provider, stored in
// AppConfig `jobs.providerQuota.v1`, and decides who may call: ingest stops while the
// plan is used up, refused or down to its reserve; a person's own search stops only
// at zero or a refused key. A call is counted once, in RAProviderUsage, under
// `<provider>` or `<provider>:cn`.
// No network and no database: a fake AppConfig delegate, a fixed clock, a mocked fetch.
// Every header value and body text below is SYNTHETIC (the shapes are the ones the
// 2026-10-11 probes recorded; no key, no posting text).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: logged }));

import type { EnvSource, Market } from '../../../platform/brand/index.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { QUOTA_LISTENER_WAIT_MS, quotaObservationFrom, settleQuotaListener, type ExternalSourceBoard, type ProviderQuotaObservation } from '../../../roboapply/v2/lib/raExternalJobTypes.js';
import { __test as fantasticTest, activeJobsDbProvider, feedRequest, isFantasticJobsEnabled, searchFantasticJobs } from '../../../roboapply/v2/lib/raFantasticJobs.js';
import { __test as jsearchTest, isJSearchEnabled, searchJSearchJobs } from '../../../roboapply/v2/lib/raRapidApiJobs.js';
import {
  DEFAULT_FEED_COUNTRIES,
  FEED_CN_BUDGET_SHARE,
  FEED_DAYS_PER_MONTH,
  FEED_EXCLUDE_MIN_BOARDS,
  FEED_MIN_MONTHLY_JOBS,
  FEED_RESERVE_MIN_JOBS,
  MAINLAND_ACTIVEJOBS_DAILY_CALLS,
  cursorTickShare,
  dailyCallLimit,
  effectiveDailyLimit,
  effectiveDailyLimitFor,
  feedCountries,
  feedDailyJobs,
  feedDailyJobsFor,
  feedGateFor,
  feedJobsLeft,
  feedJobsReserve,
  feedMonthlyJobs,
  feedQuotaDailyJobs,
  feedTaxonomies,
  mainlandActiveJobsEnabled,
  mainlandOperatorCalls,
  quotaDailyCap,
  quotaRecheckMs,
  quotaReserve,
  quotaReserveShare,
  resetConfigWarningsForTests,
  servesMarket,
} from './config.js';
import {
  FEED_PLAN_PROVIDER,
  QUOTA_PARK_MAX_MS,
  QUOTA_PERSIST_INTERVAL_MS,
  QUOTA_RETRY_MS,
  QUOTA_WRITE_ATTEMPTS,
  answerForMarket,
  feedGate,
  feedGateForMarket,
  flushProviderQuota,
  hydrateProviderQuota,
  mainlandPlanOpen,
  marketOfCall,
  providerCallGate,
  providerJobsToday,
  providerQuotaSnapshots,
  quotaAllows,
  quotaListener,
  quotaParkUntil,
  quotaRetryAt,
  quotaSnapshot,
  recordQuotaObservation,
  registerQuotaListeners,
  resetProviderQuotaForTests,
  setQuotaDepsForTests,
  type QuotaDb,
} from './quota.js';
import { PROVIDER_QUOTA_CONFIG_KEY, parseProviderQuota } from './quotaContract.js';

const T0 = new Date('2026-10-11T08:00:00.000Z');
const DAY = 86_400_000;
/** 16.9 days, as the Active Jobs DB 429 of 2026-10-11 stated its reset. */
const RESET_16_9_DAYS = Math.round(16.9 * 86_400);
const BASIC_429 = 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC. Upgrade your plan at the marketplace page.';
const NOT_SUBSCRIBED_403 = '{"message":"You are not subscribed to this API."}';

let clock = T0;
let env: EnvSource = {};
let market: Market = 'intl';
let store = createFakePrisma();

const at = (ms: number): Date => new Date(T0.getTime() + ms);
const db = (): QuotaDb => store as unknown as QuotaDb;

function install(): void {
  setQuotaDepsForTests({ db: db(), now: () => clock, env, market: () => market });
}

/** A response as the clients see it: status and the rate-limit headers only. */
function response(status: number, headers: Record<string, string | number> = {}): { status: number; headers: { get(name: string): string | null } } {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { status, headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null } };
}

function observe(provider: ExternalSourceBoard, status: number, headers: Record<string, string | number>, body = '', when: Date = clock): ProviderQuotaObservation {
  return quotaObservationFrom(provider, response(status, headers), body, when);
}

const requests = (limit: number, remaining: number, resetSeconds: number) => ({
  'x-ratelimit-requests-limit': limit,
  'x-ratelimit-requests-remaining': remaining,
  'x-ratelimit-requests-reset': resetSeconds,
});

async function storedSnapshots() {
  const row = await store.appConfig.findUnique({ where: { key: PROVIDER_QUOTA_CONFIG_KEY } });
  return parseProviderQuota((row as { value?: string } | null)?.value ?? null);
}

beforeEach(() => {
  clock = T0;
  env = {};
  market = 'intl';
  store = createFakePrisma();
  resetProviderQuotaForTests();
  resetConfigWarningsForTests();
  install();
  for (const fn of Object.values(logged)) fn.mockClear();
});

afterEach(() => {
  resetProviderQuotaForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('reading a response (JI-1)', () => {
  it('a 429 with remaining 0 and a reset in 16.9 days: exhausted, plan BASIC, resetAt; ingest waits for that instant', async () => {
    const headers = { ...requests(25, 0, RESET_16_9_DAYS), 'x-ratelimit-jobs-limit': 250, 'x-ratelimit-jobs-remaining': 0 };
    const snapshot = recordQuotaObservation(observe('activejobs', 429, headers, BASIC_429));
    const resetAt = at(RESET_16_9_DAYS * 1000);
    expect(snapshot).toEqual({
      provider: 'activejobs',
      plan: 'BASIC',
      requestsLimit: 25,
      requestsRemaining: 0,
      jobsLimit: 250,
      jobsRemaining: 0,
      resetAt: resetAt.toISOString(),
      observedAt: T0.toISOString(),
      lastStatus: 429,
      lastCallCost: null,
      state: 'exhausted',
    });
    await flushProviderQuota();
    // Stored at once, in the contract's shape.
    expect((await storedSnapshots()).get('activejobs')).toEqual(snapshot);
    const row = await store.appConfig.findUnique({ where: { key: PROVIDER_QUOTA_CONFIG_KEY } });
    expect(row).toMatchObject({ key: 'jobs.providerQuota.v1', updatedBy: 'jobs-quota' });

    // Refused for ingest and for a person's own search until the reset, allowed from it on.
    expect(quotaAllows('activejobs', 'ingest', T0, env)).toBe(false);
    expect(quotaAllows('activejobs', 'interactive', T0, env)).toBe(false);
    expect(quotaAllows('activejobs', 'ingest', new Date(resetAt.getTime() - 1), env)).toBe(false);
    expect(quotaRetryAt('activejobs', T0, env)).toEqual(resetAt);
    expect(quotaAllows('activejobs', 'ingest', resetAt, env)).toBe(true);
    expect(quotaAllows('activejobs', 'interactive', resetAt, env)).toBe(true);
    expect(quotaRetryAt('activejobs', resetAt, env)).toBeNull();
    // Another provider is not affected, and one nobody has called yet is allowed.
    expect(quotaAllows('jsearch', 'ingest', T0, env)).toBe(true);
    expect(quotaSnapshot('jsearch', T0)).toBeNull();
  });

  it('a 200 with 9,773 of 10,000 left: ok, and the call cost is the drop since the previous response', () => {
    const reset = 17 * 86_400;
    expect(recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_775, reset)))).toMatchObject({ state: 'ok', requestsRemaining: 9_775, lastCallCost: null, plan: null });
    clock = at(4_000);
    // The second page of one search cost a request of its own: the drop is 2.
    expect(recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_773, reset - 4)))).toMatchObject({
      state: 'ok',
      requestsLimit: 10_000,
      requestsRemaining: 9_773,
      jobsLimit: null,
      jobsRemaining: null,
      lastStatus: 200,
      lastCallCost: 2,
    });
    // A reading older than a minute says nothing about what one call cost.
    clock = at(4_000 + 61_000);
    expect(recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_700, reset - 65)))).toMatchObject({ requestsRemaining: 9_700, lastCallCost: null });
    // A count that went up (a new period) is not a cost.
    clock = at(4_000 + 62_000);
    expect(recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_999, reset)))).toMatchObject({ requestsRemaining: 9_999, lastCallCost: null });
  });

  it('403 "not subscribed" → not_subscribed; 401 and any other 403 → unauthorized; both block for an hour, then one call may re-read the plan', () => {
    recordQuotaObservation(observe('linkedin', 403, {}, NOT_SUBSCRIBED_403));
    expect(quotaSnapshot('linkedin', T0)).toMatchObject({ state: 'not_subscribed', lastStatus: 403, requestsLimit: null, requestsRemaining: null, resetAt: null, plan: null });
    expect(quotaAllows('linkedin', 'ingest', T0, env)).toBe(false);
    expect(quotaAllows('linkedin', 'interactive', T0, env)).toBe(false);
    expect(quotaRetryAt('linkedin', T0, env)).toEqual(at(QUOTA_RETRY_MS));
    expect(quotaAllows('linkedin', 'ingest', at(QUOTA_RETRY_MS), env)).toBe(true);

    recordQuotaObservation(observe('jsearch', 401, {}, '{"message":"Invalid API key."}'));
    expect(quotaSnapshot('jsearch', T0)).toMatchObject({ state: 'unauthorized', lastStatus: 401 });
    recordQuotaObservation(observe('activejobs', 403, {}, '{"message":"This endpoint is disabled for your subscription"}'));
    expect(quotaSnapshot('activejobs', T0)).toMatchObject({ state: 'unauthorized', lastStatus: 403 });
    expect(quotaAllows('activejobs', 'interactive', T0, env)).toBe(false);
  });

  it('a refusal that carries the plan\'s quota headers still blocks for an hour only, never until the monthly reset (review fix)', async () => {
    // A 403 that is an origin answer ("endpoint not on plan") passes through the gateway with the plan's
    // headers: limit 20,000, 19,000 left, reset in 17 days. The reset says when the quota refills, not
    // when the subscription is put right.
    const seventeenDays = 17 * 86_400;
    const snapshot = recordQuotaObservation(observe('activejobs', 403, requests(20_000, 19_000, seventeenDays), '{"message":"This endpoint is disabled for your subscription"}'));
    // The reset is kept in the reading (the admin panel shows it); it does not decide the block.
    expect(snapshot).toMatchObject({ state: 'unauthorized', requestsLimit: 20_000, requestsRemaining: 19_000, resetAt: at(seventeenDays * 1000).toISOString() });
    expect(quotaRetryAt('activejobs', T0, env)).toEqual(at(QUOTA_RETRY_MS));
    expect(quotaAllows('activejobs', 'ingest', at(QUOTA_RETRY_MS - 1), env)).toBe(false);
    expect(quotaAllows('activejobs', 'interactive', at(QUOTA_RETRY_MS - 1), env)).toBe(false);
    // Two hours later ingest may ask again; ten days later a person's search is not still refused.
    expect(quotaAllows('activejobs', 'ingest', at(2 * 3_600_000), env)).toBe(true);
    expect(quotaAllows('activejobs', 'interactive', at(10 * DAY), env)).toBe(true);
    expect(quotaParkUntil('activejobs', T0, env)).toEqual(at(QUOTA_RETRY_MS));

    // The same for a 401 with a reset header, and for "not subscribed".
    recordQuotaObservation(observe('jsearch', 401, requests(10_000, 9_000, seventeenDays), '{"message":"Invalid API key."}'));
    expect(quotaSnapshot('jsearch', T0)).toMatchObject({ state: 'unauthorized', resetAt: at(seventeenDays * 1000).toISOString() });
    expect(quotaRetryAt('jsearch', T0, env)).toEqual(at(QUOTA_RETRY_MS));
    expect(quotaAllows('jsearch', 'interactive', at(QUOTA_RETRY_MS), env)).toBe(true);
    recordQuotaObservation(observe('linkedin', 403, requests(100, 100, seventeenDays), NOT_SUBSCRIBED_403));
    expect(quotaRetryAt('linkedin', T0, env)).toEqual(at(QUOTA_RETRY_MS));

    // What is stored is hydrated by every process: a second process answers the same way.
    await flushProviderQuota();
    resetProviderQuotaForTests();
    install();
    await hydrateProviderQuota(db());
    expect(quotaAllows('activejobs', 'ingest', T0, env)).toBe(false);
    expect(quotaAllows('activejobs', 'ingest', at(2 * 3_600_000), env)).toBe(true);
    // The next call is refused again: another hour, counted from that reading.
    clock = at(2 * 3_600_000);
    recordQuotaObservation(observe('activejobs', 403, requests(20_000, 19_000, seventeenDays - 7_200), '{"message":"This endpoint is disabled for your subscription"}'));
    expect(quotaRetryAt('activejobs', clock, env)).toEqual(at(3 * 3_600_000));
    // A used-up plan is another matter: it waits for the reset the provider stated.
    recordQuotaObservation(observe('jsearch', 429, requests(10_000, 0, seventeenDays), BASIC_429));
    expect(quotaRetryAt('jsearch', clock, env)).toEqual(new Date(clock.getTime() + seventeenDays * 1000));
  });

  it('a refused key drops the numbers an earlier plan stated; a per-second 429 keeps the state it found', () => {
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_000, 86_400)));
    clock = at(1_000);
    // A burst limit: the body names no quota and requests remain.
    expect(recordQuotaObservation(observe('jsearch', 429, requests(10_000, 8_999, 86_399), '{"message":"Too many requests"}'))).toMatchObject({ state: 'ok', requestsRemaining: 8_999, lastStatus: 429 });
    expect(quotaAllows('jsearch', 'ingest', clock, env)).toBe(true);
    clock = at(2_000);
    expect(recordQuotaObservation(observe('jsearch', 403, {}, NOT_SUBSCRIBED_403))).toMatchObject({ state: 'not_subscribed', requestsLimit: null, requestsRemaining: null, resetAt: null });
  });

  it('a served call whose headers say nothing is left has used the plan up', () => {
    // The last request of the month was served: 200, remaining 0.
    expect(recordQuotaObservation(observe('jsearch', 200, requests(10_000, 0, 86_400)))).toMatchObject({ state: 'exhausted', lastStatus: 200 });
    expect(quotaAllows('jsearch', 'interactive', T0, env)).toBe(false);
    // A per-job plan: requests remain, the month's postings are spent.
    expect(recordQuotaObservation(observe('activejobs', 200, { ...requests(25, 20, 86_400), 'x-ratelimit-jobs-limit': 250, 'x-ratelimit-jobs-remaining': 0 }))).toMatchObject({ state: 'exhausted', jobsRemaining: 0, requestsRemaining: 20 });
    expect(quotaAllows('activejobs', 'ingest', T0, env)).toBe(false);
    expect(quotaAllows('activejobs', 'ingest', at(86_400_000), env)).toBe(true);
  });

  it('the plan name a 429 stated is kept for later readings of the same plan and dropped once the stated limit changes', () => {
    recordQuotaObservation(observe('activejobs', 429, requests(25, 0, 60), BASIC_429));
    // The new period of the same plan: the limit is the same, the name still holds.
    clock = at(61_000);
    expect(recordQuotaObservation(observe('activejobs', 200, requests(25, 24, 30 * 86_400)))).toMatchObject({ state: 'ok', plan: 'BASIC', requestsLimit: 25 });
    // The owner bought a larger plan: nobody has told us its name, so none is shown.
    clock = at(62_000);
    expect(recordQuotaObservation(observe('activejobs', 200, requests(20_000, 19_999, 30 * 86_400)))).toMatchObject({ state: 'ok', plan: null, requestsLimit: 20_000 });
  });

  it('header values that are not counts were not stated (null); a response with no headers decides nothing', () => {
    const o = observe('jsearch', 200, { 'x-ratelimit-requests-limit': 'unlimited', 'x-ratelimit-requests-remaining': '-3', 'x-ratelimit-requests-reset': '' });
    expect(o).toMatchObject({ requestsLimit: null, requestsRemaining: null, resetSeconds: null, jobsLimit: null, jobsRemaining: null, plan: null, reason: null });
    expect(recordQuotaObservation(o)).toMatchObject({ state: 'ok', requestsRemaining: null, resetAt: null });
    expect(quotaAllows('jsearch', 'ingest', T0, env)).toBe(true);
    expect(quotaAllows('jsearch', 'interactive', T0, env)).toBe(true);
  });

  it('never throws, whatever it is handed', () => {
    expect(recordQuotaObservation(null as unknown as ProviderQuotaObservation)).toBeNull();
    expect(recordQuotaObservation({ provider: 'jsearch' } as unknown as ProviderQuotaObservation)).not.toBeUndefined();
  });
});

describe('the reserve ingest leaves for people (INGEST_QUOTA_RESERVE_SHARE, default 0.05)', () => {
  it('reserve = max(1, ceil(limit × share)); ingest stops at the reserve, a person only at zero', () => {
    expect(quotaReserveShare({})).toBe(0.05);
    expect(quotaReserve(10_000, {})).toBe(500);
    expect(quotaReserve(25, {})).toBe(2);
    expect(quotaReserve(10, {})).toBe(1);
    expect(quotaReserve(null, {})).toBe(1);
    expect(quotaReserve(10_000, { INGEST_QUOTA_RESERVE_SHARE: '0.2' })).toBe(2_000);
    expect(quotaReserve(10_000, { INGEST_QUOTA_RESERVE_SHARE: '0' })).toBe(1);
    expect(quotaReserve(10_000, { INGEST_QUOTA_RESERVE_SHARE: 'half' })).toBe(500);
    expect(quotaReserveShare({ INGEST_QUOTA_RESERVE_SHARE: '7' })).toBe(1);

    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 501, 86_400)));
    expect(quotaAllows('jsearch', 'ingest', T0, env)).toBe(true);
    clock = at(1_000);
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 500, 86_399)));
    expect(quotaSnapshot('jsearch', clock)).toMatchObject({ state: 'ok', requestsRemaining: 500 });
    expect(quotaAllows('jsearch', 'ingest', clock, env)).toBe(false);
    expect(quotaAllows('jsearch', 'interactive', clock, env)).toBe(true);
    // The reserve waits for the reset the provider stated.
    expect(quotaRetryAt('jsearch', clock, env)).toEqual(at(1_000 + 86_399_000));
    // A wider reserve is read from the env of the call.
    expect(quotaAllows('jsearch', 'ingest', T0, { INGEST_QUOTA_RESERVE_SHARE: '0.01' })).toBe(true);
    clock = at(2_000);
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 1, 86_398)));
    expect(quotaAllows('jsearch', 'interactive', clock, env)).toBe(true);
  });

  it('INGEST_QUOTA_RECHECK_HOURS lets one call re-read a used-up plan before its reset (default: never)', () => {
    expect(quotaRecheckMs({})).toBe(0);
    expect(quotaRecheckMs({ INGEST_QUOTA_RECHECK_HOURS: '6' })).toBe(6 * 3_600_000);
    expect(quotaRecheckMs({ INGEST_QUOTA_RECHECK_HOURS: '-1' })).toBe(0);
    recordQuotaObservation(observe('activejobs', 429, requests(25, 0, RESET_16_9_DAYS), BASIC_429));
    const later = at(6 * 3_600_000);
    expect(quotaAllows('activejobs', 'ingest', later, {})).toBe(false);
    expect(quotaAllows('activejobs', 'ingest', new Date(later.getTime() - 1), { INGEST_QUOTA_RECHECK_HOURS: '6' })).toBe(false);
    expect(quotaAllows('activejobs', 'ingest', later, { INGEST_QUOTA_RECHECK_HOURS: '6' })).toBe(true);
    expect(quotaRetryAt('activejobs', T0, { INGEST_QUOTA_RECHECK_HOURS: '6' })).toEqual(later);
  });

  it('quotaParkUntil: a quota stop parks queries until the reading stops blocking, at most a day at a time (review fix)', () => {
    expect(QUOTA_PARK_MAX_MS).toBe(24 * 3_600_000);
    // Used up, reset in 16.9 days: looked at again tomorrow, not in 16.9 days.
    recordQuotaObservation(observe('activejobs', 429, requests(25, 0, RESET_16_9_DAYS), BASIC_429));
    expect(quotaParkUntil('activejobs', T0, env)).toEqual(at(DAY));
    // Day after day, until the last day before the reset: then the reset itself.
    expect(quotaParkUntil('activejobs', at(5 * DAY), env)).toEqual(at(6 * DAY));
    const resetAt = at(RESET_16_9_DAYS * 1000);
    expect(quotaParkUntil('activejobs', at(16.5 * DAY), env)).toEqual(resetAt);
    // The owner bought a plan and set a recheck window: the queries come due when the window opens.
    expect(quotaParkUntil('activejobs', T0, { INGEST_QUOTA_RECHECK_HOURS: '6' })).toEqual(at(6 * 3_600_000));
    // A reset under a day away is the park time itself; the reserve parks the same way.
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 400, 3_600)));
    expect(quotaParkUntil('jsearch', T0, env)).toEqual(at(3_600_000));
    // Nothing known about the provider (or nothing blocks): an hour, the retry interval.
    expect(quotaParkUntil('linkedin', T0, env)).toEqual(at(QUOTA_RETRY_MS));
  });
});

describe('storing the readings (AppConfig jobs.providerQuota.v1)', () => {
  it('an unchanged state is written at most once a minute per provider; a state change is written at once', async () => {
    const create = vi.spyOn(store.appConfig, 'create');
    const update = vi.spyOn(store.appConfig, 'updateMany');
    const writes = () => create.mock.calls.length + update.mock.calls.length;
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_000, 86_400)));
    await flushProviderQuota();
    expect(writes()).toBe(1);
    for (let i = 1; i <= 5; i++) {
      clock = at(i * 10_000);
      recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_000 - i, 86_400 - i * 10)));
    }
    await flushProviderQuota();
    expect(writes()).toBe(1);
    // Memory holds the latest reading all along.
    expect(quotaSnapshot('jsearch', clock)).toMatchObject({ requestsRemaining: 8_995 });
    expect((await storedSnapshots()).get('jsearch')).toMatchObject({ requestsRemaining: 9_000 });

    // Another provider has its own minute.
    recordQuotaObservation(observe('activejobs', 200, requests(25, 20, 86_400)));
    await flushProviderQuota();
    expect(writes()).toBe(2);

    // One minute after the last write the next reading is stored.
    clock = at(QUOTA_PERSIST_INTERVAL_MS);
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 8_990, 86_340)));
    await flushProviderQuota();
    expect(writes()).toBe(3);
    expect((await storedSnapshots()).get('jsearch')).toMatchObject({ requestsRemaining: 8_990 });

    // A state change does not wait.
    clock = at(QUOTA_PERSIST_INTERVAL_MS + 1_000);
    recordQuotaObservation(observe('jsearch', 429, requests(10_000, 0, 86_339), BASIC_429));
    await flushProviderQuota();
    expect(writes()).toBe(4);
    // The row was created once and updated after that, each time only if it still held what was read.
    expect(create).toHaveBeenCalledTimes(1);
    expect(update.mock.calls.every(([args]) => typeof (args as { where: { value?: unknown } }).where.value === 'string')).toBe(true);
    expect((await storedSnapshots()).get('jsearch')).toMatchObject({ state: 'exhausted', plan: 'BASIC' });
    // Counts are stored as numbers (a string would read back as "not stated").
    const raw = JSON.parse(((await store.appConfig.findUnique({ where: { key: PROVIDER_QUOTA_CONFIG_KEY } })) as { value: string }).value);
    expect(raw).toMatchObject({ version: 1, providers: { jsearch: { requestsLimit: 10_000, requestsRemaining: 0 }, activejobs: { requestsRemaining: 20 } } });
  });

  it('a second process that only hydrates gives the same answers, with no provider call', async () => {
    recordQuotaObservation(observe('activejobs', 429, { ...requests(25, 0, RESET_16_9_DAYS), 'x-ratelimit-jobs-limit': 250, 'x-ratelimit-jobs-remaining': 0 }, BASIC_429));
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_773, 17 * 86_400)));
    await flushProviderQuota();
    const first = providerQuotaSnapshots(T0);

    // A new process: nothing in memory, the same database.
    resetProviderQuotaForTests();
    install();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(providerQuotaSnapshots(T0).size).toBe(0);
    expect(quotaAllows('activejobs', 'ingest', T0, env)).toBe(true);
    await hydrateProviderQuota(db());
    expect(providerQuotaSnapshots(T0)).toEqual(first);
    expect(quotaAllows('activejobs', 'ingest', T0, env)).toBe(false);
    expect(quotaSnapshot('activejobs', T0)).toMatchObject({ state: 'exhausted', plan: 'BASIC', requestsRemaining: 0 });
    expect(effectiveDailyLimit('jsearch', 'intl', {}, T0)).toBe(545);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a stored reading whose reset has passed is unknown, with no remaining count, until a new response arrives', async () => {
    recordQuotaObservation(observe('activejobs', 429, { ...requests(25, 0, 3_600), 'x-ratelimit-jobs-limit': 250, 'x-ratelimit-jobs-remaining': 0 }, BASIC_429));
    await flushProviderQuota();
    resetProviderQuotaForTests();
    install();
    await hydrateProviderQuota(db());
    const afterReset = at(3_600_000 + 1);
    expect(quotaSnapshot('activejobs', afterReset)).toMatchObject({ state: 'unknown', requestsRemaining: null, jobsRemaining: null, lastCallCost: null, plan: 'BASIC', requestsLimit: 25, jobsLimit: 250 });
    expect(quotaAllows('activejobs', 'ingest', afterReset, env)).toBe(true);
    expect(quotaAllows('activejobs', 'interactive', afterReset, env)).toBe(true);
    // No stated remaining count: the daily budget falls back to the operator's bound or the default.
    expect(effectiveDailyLimit('activejobs', 'intl', {}, afterReset)).toBe(300);
    // The new period's first response replaces it.
    clock = afterReset;
    expect(recordQuotaObservation(observe('activejobs', 200, requests(25, 24, 30 * 86_400)))).toMatchObject({ state: 'ok', requestsRemaining: 24, lastCallCost: null });
  });

  it('two processes that each called a different provider do not erase each other; the newest reading per provider wins', async () => {
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_000, 86_400)));
    await flushProviderQuota();
    // Process B knows nothing of jsearch and writes its own reading of activejobs.
    resetProviderQuotaForTests();
    install();
    clock = at(5_000);
    recordQuotaObservation(observe('activejobs', 200, requests(25, 20, 86_400)));
    await flushProviderQuota();
    const stored = await storedSnapshots();
    expect([...stored.keys()].sort()).toEqual(['activejobs', 'jsearch']);
    // …and it learned jsearch's reading while writing.
    expect(quotaSnapshot('jsearch', clock)).toMatchObject({ requestsRemaining: 9_000 });
    // An older stored reading never replaces a newer one in memory.
    clock = at(10_000);
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 8_000, 86_390)));
    await hydrateProviderQuota(db());
    expect(quotaSnapshot('jsearch', clock)).toMatchObject({ requestsRemaining: 8_000 });
  });

  it('two processes that write at the same moment: the later write re-reads and merges, so no stored reading is replaced by an older copy (review fix)', async () => {
    // Stored so far: jsearch at 9,000 (process A wrote it and still holds it).
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_000, 86_400)));
    await flushProviderQuota();
    // A takes a new reading of activejobs. Between A's read of the row and A's write, process B stores
    // a NEWER jsearch reading (used up). A plain "read, merge, write" would put A's old jsearch copy back.
    const realFind = store.appConfig.findUnique.bind(store.appConfig);
    const exhausted = { provider: 'jsearch', plan: 'BASIC', requestsLimit: 10_000, requestsRemaining: 0, jobsLimit: null, jobsRemaining: null, resetAt: at(86_400_000).toISOString(), observedAt: at(30_000).toISOString(), lastStatus: 429, lastCallCost: null, state: 'exhausted' };
    let interleaved = 0;
    const find = vi.spyOn(store.appConfig, 'findUnique').mockImplementation(async (args: never) => {
      const row = await realFind(args);
      if (interleaved === 0) {
        interleaved += 1;
        // B's write lands after A's read.
        await store.appConfig.updateMany({ where: { key: PROVIDER_QUOTA_CONFIG_KEY }, data: { value: JSON.stringify({ version: 1, providers: { jsearch: exhausted } }), updatedBy: 'process-b' } });
      }
      return row;
    });
    const update = vi.spyOn(store.appConfig, 'updateMany');
    clock = at(5_000);
    recordQuotaObservation(observe('activejobs', 200, requests(25, 20, 86_400)));
    await flushProviderQuota();
    // A's first write found the row changed and wrote nothing; the second read, merged and wrote.
    expect(find).toHaveBeenCalledTimes(2);
    const mine = update.mock.calls.filter(([args]) => (args as { data: { updatedBy?: string } }).data.updatedBy === 'jobs-quota');
    expect(mine).toHaveLength(2);
    const stored = await storedSnapshots();
    expect(stored.get('jsearch')).toMatchObject({ state: 'exhausted', requestsRemaining: 0 });
    expect(stored.get('activejobs')).toMatchObject({ requestsRemaining: 20 });
    // And A itself now knows what B learned.
    expect(quotaAllows('jsearch', 'interactive', clock, env)).toBe(false);
  });

  it('two processes that both find no row: one creates it, the other merges into it; a row that keeps changing is given up after a few tries', async () => {
    store = createFakePrisma({ uniqueFields: { appConfig: ['key'] } });
    install();
    const realFind = store.appConfig.findUnique.bind(store.appConfig);
    let first = true;
    vi.spyOn(store.appConfig, 'findUnique').mockImplementation(async (args: never) => {
      const row = await realFind(args);
      if (first) {
        first = false;
        // The other process creates the row after this one read "no row".
        await store.appConfig.create({ data: { key: PROVIDER_QUOTA_CONFIG_KEY, value: JSON.stringify({ version: 1, providers: { activejobs: { provider: 'activejobs', observedAt: at(-1_000).toISOString(), requestsLimit: 25, requestsRemaining: 20, state: 'ok' } } }), updatedBy: 'process-b' } });
      }
      return row;
    });
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_000, 86_400)));
    await flushProviderQuota();
    expect([...(await storedSnapshots()).keys()].sort()).toEqual(['activejobs', 'jsearch']);
    expect(await store.appConfig.count()).toBe(1);

    // A row that another writer changes after every read: bounded tries, a warning, no throw.
    vi.restoreAllMocks();
    let n = 0;
    const find = vi.spyOn(store.appConfig, 'findUnique').mockImplementation(async () => ({ value: JSON.stringify({ version: 1, providers: {}, n: (n += 1) }) }) as never);
    clock = at(QUOTA_PERSIST_INTERVAL_MS);
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 8_990, 86_340)));
    await expect(flushProviderQuota()).resolves.toBeUndefined();
    expect(find).toHaveBeenCalledTimes(QUOTA_WRITE_ATTEMPTS);
    expect(logged.warn.mock.calls.some((c) => String(c[1]).includes('quota reading not stored'))).toBe(true);
    expect(quotaSnapshot('jsearch', clock)).toMatchObject({ requestsRemaining: 8_990 });
  });

  it('a reading older than the stored one is not written over it: memory takes the stored reading and the row is left alone', async () => {
    // Process B stored a reading taken at T0 + 10 s.
    clock = at(10_000);
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 8_990, 86_390)));
    await flushProviderQuota();
    const before = await store.appConfig.findUnique({ where: { key: PROVIDER_QUOTA_CONFIG_KEY } });
    // Process A (cold) reports a response that arrived at T0: older than what is stored.
    resetProviderQuotaForTests();
    install();
    const update = vi.spyOn(store.appConfig, 'updateMany');
    const create = vi.spyOn(store.appConfig, 'create');
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_000, 86_400), '', T0));
    await flushProviderQuota();
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await store.appConfig.findUnique({ where: { key: PROVIDER_QUOTA_CONFIG_KEY } })).toEqual(before);
    expect(quotaSnapshot('jsearch', clock)).toMatchObject({ requestsRemaining: 8_990 });
  });

  it('a database that fails never fails the caller: the reading stays in memory', async () => {
    const broken = createFakePrisma({ failOn: { 'appConfig.findUnique': new Error('db down'), 'appConfig.create': new Error('db down'), 'appConfig.updateMany': new Error('db down') } });
    setQuotaDepsForTests({ db: broken as unknown as QuotaDb, now: () => clock, env, market: () => market });
    await expect(hydrateProviderQuota(broken as unknown as QuotaDb)).resolves.toBeUndefined();
    expect(recordQuotaObservation(observe('jsearch', 429, requests(10_000, 0, 86_400), BASIC_429))).toMatchObject({ state: 'exhausted' });
    await expect(flushProviderQuota()).resolves.toBeUndefined();
    expect(quotaAllows('jsearch', 'ingest', T0, env)).toBe(false);
  });
});

describe('the daily budget (config.ts effectiveDailyLimit)', () => {
  it('9,773 of 10,000 left with 17 days to the reset is 545 a day, unless the operator set less', () => {
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_773, RESET_16_9_DAYS)));
    expect(quotaDailyCap(quotaSnapshot('jsearch', T0), T0, {})).toBe(545); // floor((9773 − 500) / 17)
    expect(effectiveDailyLimit('jsearch', 'intl', {}, T0)).toBe(545);
    expect(effectiveDailyLimit('jsearch', 'intl', { INGEST_JSEARCH_DAILY_CALLS: '100' }, T0)).toBe(100);
    expect(effectiveDailyLimit('jsearch', 'intl', { INGEST_JSEARCH_DAILY_CALLS: '900' }, T0)).toBe(545);
    // The reserve share moves it.
    expect(effectiveDailyLimit('jsearch', 'intl', { INGEST_QUOTA_RESERVE_SHARE: '0.5' }, T0)).toBe(280); // floor((9773 − 5000) / 17)
    // The operator's own bound, as the admin "Limits" page shows it, is not the quota's business.
    expect(dailyCallLimit('jsearch', { INGEST_JSEARCH_DAILY_CALLS: '900' })).toBe(900);
    expect(dailyCallLimit('jsearch', {})).toBe(200);
  });

  it('the day\'s share of REQUESTS is divided by what one CALL costs, once the headers have shown it (review fix)', () => {
    const reading = { requestsLimit: 10_000, requestsRemaining: 9_773, resetAt: at(RESET_16_9_DAYS * 1000).toISOString() };
    // Not known, or a reading that says nothing useful: a call counts as one request (545, the ACCEPT number).
    expect(quotaDailyCap(reading, T0, {})).toBe(545);
    expect(quotaDailyCap({ ...reading, lastCallCost: null }, T0, {})).toBe(545);
    expect(quotaDailyCap({ ...reading, lastCallCost: 1 }, T0, {})).toBe(545);
    expect(quotaDailyCap({ ...reading, lastCallCost: 0 }, T0, {})).toBe(545);
    expect(quotaDailyCap({ ...reading, lastCallCost: Number.NaN }, T0, {})).toBe(545);
    // A JSearch call that read two pages took two requests: 545 requests a day are 272 calls.
    expect(quotaDailyCap({ ...reading, lastCallCost: 2 }, T0, {})).toBe(272);
    expect(quotaDailyCap({ ...reading, lastCallCost: 3 }, T0, {})).toBe(181);

    // Through the readings: the second response shows the drop, and the day's limit follows it.
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_775, RESET_16_9_DAYS)));
    expect(effectiveDailyLimit('jsearch', 'intl', {}, T0)).toBe(545); // floor((9775 − 500) / 17), cost not known yet
    clock = at(4_000);
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 9_773, RESET_16_9_DAYS - 4)));
    expect(quotaSnapshot('jsearch', clock)).toMatchObject({ lastCallCost: 2 });
    expect(effectiveDailyLimit('jsearch', 'intl', {}, clock)).toBe(272);
    // The operator's bound is in calls and still wins when it is lower.
    expect(effectiveDailyLimit('jsearch', 'intl', { INGEST_JSEARCH_DAILY_CALLS: '120' }, clock)).toBe(120);
    expect(effectiveDailyLimit('jsearch', 'intl', { INGEST_JSEARCH_DAILY_CALLS: '400' }, clock)).toBe(272);
  });

  it('without a reading: the operator bound, else the old defaults; a used-up plan leaves 0', () => {
    expect(effectiveDailyLimit('jsearch', 'intl', {}, T0)).toBe(200);
    expect(effectiveDailyLimit('activejobs', 'intl', {}, T0)).toBe(300);
    expect(effectiveDailyLimit('activejobs', 'intl', { INGEST_ACTIVEJOBS_DAILY_CALLS: '40' }, T0)).toBe(40);
    expect(effectiveDailyLimit('bank_robohire', 'intl', {}, T0)).toBeNull();
    recordQuotaObservation(observe('activejobs', 429, requests(25, 0, RESET_16_9_DAYS), BASIC_429));
    expect(effectiveDailyLimit('activejobs', 'intl', {}, T0)).toBe(0);
    expect(effectiveDailyLimit('activejobs', 'intl', { INGEST_ACTIVEJOBS_DAILY_CALLS: '40' }, T0)).toBe(0);
    // A reading with no reset time is not spread over a guessed number of days.
    recordQuotaObservation(observe('jsearch', 200, { 'x-ratelimit-requests-limit': 10_000, 'x-ratelimit-requests-remaining': 9_000 }));
    expect(quotaDailyCap(quotaSnapshot('jsearch', T0), T0, {})).toBeNull();
    expect(effectiveDailyLimit('jsearch', 'intl', {}, T0)).toBe(200);
  });

  it('mainland calls have their own bound, INGEST_<PROVIDER>_CN_DAILY_CALLS, default 0', () => {
    expect(effectiveDailyLimit('activejobs', 'cn', {}, T0)).toBe(0);
    expect(effectiveDailyLimit('activejobs', 'cn', { INGEST_ACTIVEJOBS_DAILY_CALLS: '300' }, T0)).toBe(0);
    expect(effectiveDailyLimit('activejobs', 'cn', { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '40' }, T0)).toBe(40);
    // Under the same plan: what is left of it caps the mainland bound too.
    recordQuotaObservation(observe('activejobs', 200, requests(1_000, 250, 10 * 86_400)));
    expect(effectiveDailyLimit('activejobs', 'cn', { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '40' }, T0)).toBe(20); // floor((250 − 50) / 10)
  });

  it('RA_ONBOARDING_<PROVIDER>_DAILY_BUDGET is read as a deprecated alias while the INGEST_ name is unset, and reported once', () => {
    expect(dailyCallLimit('jsearch', { RA_ONBOARDING_JSEARCH_DAILY_BUDGET: '50' })).toBe(50);
    expect(effectiveDailyLimit('jsearch', 'intl', { RA_ONBOARDING_JSEARCH_DAILY_BUDGET: '50' }, T0)).toBe(50);
    expect(dailyCallLimit('activejobs', { RA_ONBOARDING_ACTIVEJOBS_DAILY_BUDGET: '7' })).toBe(7);
    // The LinkedIn client is gone (M3 gate): its old `_JOBS` name is read by nothing.
    expect(dailyCallLimit('linkedin', { RA_ONBOARDING_LINKEDIN_JOBS_DAILY_BUDGET: '9' })).not.toBe(9);
    // The INGEST_ name wins.
    expect(dailyCallLimit('jsearch', { INGEST_JSEARCH_DAILY_CALLS: '120', RA_ONBOARDING_JSEARCH_DAILY_BUDGET: '50' })).toBe(120);
    const reports = logged.warn.mock.calls.filter((c) => String(c[1]).includes('deprecated env name'));
    expect(reports.map((c) => (c[2] as { deprecated: string }).deprecated).sort()).toEqual([
      'RA_ONBOARDING_ACTIVEJOBS_DAILY_BUDGET',
      'RA_ONBOARDING_JSEARCH_DAILY_BUDGET',
    ]);
    expect(reports[0]![2]).toMatchObject({ use: expect.stringMatching(/^INGEST_[A-Z]+_DAILY_CALLS$/) });
  });

  it('INGEST_CURSOR_TICK_SHARE: default 0.4, kept inside 0.05 to 1 (0 must not switch the banks and boards off)', () => {
    expect(cursorTickShare({})).toBe(0.4);
    expect(cursorTickShare({ INGEST_CURSOR_TICK_SHARE: '0.25' })).toBe(0.25);
    expect(cursorTickShare({ INGEST_CURSOR_TICK_SHARE: '3' })).toBe(1);
    expect(cursorTickShare({ INGEST_CURSOR_TICK_SHARE: '0' })).toBe(0.05);
    expect(cursorTickShare({ INGEST_CURSOR_TICK_SHARE: 'most' })).toBe(0.4);
  });
});

describe('the call gate: one counter per provider and market', () => {
  const usageWrites = () => store.$sql.calls.filter((c) => c.text.startsWith('INSERT INTO "RAProviderUsage"'));

  it("a person's own search is counted once in today's usage row; an ingest call and a probe are not", async () => {
    expect(providerCallGate('jsearch', 'interactive')).toBe(true);
    await flushProviderQuota();
    expect(usageWrites()).toHaveLength(1);
    expect(usageWrites()[0]!.values).toEqual(['jsearch', '2026-10-11', 1, 0, 0, 0]);
    // Ingest reserved its call before fetching: counting it here would count it twice.
    expect(providerCallGate('jsearch', 'ingest')).toBe(true);
    // isEnabled() only asks.
    expect(providerCallGate('jsearch', 'interactive', { probe: true })).toBe(true);
    await flushProviderQuota();
    expect(usageWrites()).toHaveLength(1);
  });

  it('answers the quota question for both purposes and counts nothing for a refused call', async () => {
    recordQuotaObservation(observe('jsearch', 200, requests(10_000, 400, 86_400)));
    expect(providerCallGate('jsearch', 'ingest')).toBe(false);
    expect(providerCallGate('jsearch', 'interactive', { probe: true })).toBe(true);
    clock = at(1_000);
    recordQuotaObservation(observe('jsearch', 429, requests(10_000, 0, 86_399), BASIC_429));
    expect(providerCallGate('jsearch', 'interactive')).toBe(false);
    expect(providerCallGate('jsearch', 'ingest')).toBe(false);
    await flushProviderQuota();
    expect(usageWrites()).toHaveLength(0);
  });

  it('a daily bound the operator set to 0 refuses every call (either name)', async () => {
    env = { INGEST_JSEARCH_DAILY_CALLS: '0', RA_ONBOARDING_ACTIVEJOBS_DAILY_BUDGET: '0' };
    install();
    expect(providerCallGate('jsearch', 'interactive')).toBe(false);
    expect(providerCallGate('activejobs', 'interactive', { probe: true })).toBe(false);
    env = { INGEST_JSEARCH_DAILY_CALLS: '1' };
    install();
    expect(providerCallGate('jsearch', 'interactive')).toBe(true);
    await flushProviderQuota();
    expect(usageWrites()).toHaveLength(1);
  });

  it('market cn: no metered provider is called by default; JSearch never; Active Jobs DB only under its own bound, counted under activejobs:cn', async () => {
    market = 'cn';
    expect(providerCallGate('jsearch', 'interactive')).toBe(false);
    expect(providerCallGate('activejobs', 'interactive')).toBe(false);
    expect(providerCallGate('linkedin', 'interactive', { probe: true })).toBe(false);
    env = { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '20', INGEST_JSEARCH_CN_DAILY_CALLS: '20' };
    install();
    expect(providerCallGate('jsearch', 'interactive')).toBe(false);
    expect(providerCallGate('activejobs', 'interactive')).toBe(true);
    await flushProviderQuota();
    expect(usageWrites()).toHaveLength(1);
    expect(usageWrites()[0]!.values[0]).toBe('activejobs:cn');
    // The same day, the international site: its own row.
    market = 'intl';
    expect(providerCallGate('activejobs', 'interactive')).toBe(true);
    await flushProviderQuota();
    expect(usageWrites().map((c) => c.values[0])).toEqual(['activejobs:cn', 'activejobs']);
  });

  it('answerForMarket: a probe can be answered for a source\'s own market, whatever brand the request has (review fix)', async () => {
    market = 'cn';
    // A GoApply request: no mainland call to JSearch, so the plain probe says no.
    expect(providerCallGate('jsearch', 'interactive', { probe: true })).toBe(false);
    // The same process asked about the international source itself: its key, switches and quota decide.
    expect(answerForMarket('intl', () => providerCallGate('jsearch', 'interactive', { probe: true }))).toBe(true);
    expect(answerForMarket('intl', () => answerForMarket('cn', () => providerCallGate('jsearch', 'interactive', { probe: true })))).toBe(false);
    // The market of the request is back afterwards, also when the question throws.
    expect(() => answerForMarket('intl', () => { throw new Error('boom'); })).toThrow('boom');
    expect(providerCallGate('jsearch', 'interactive', { probe: true })).toBe(false);
    // The quota still decides inside it.
    recordQuotaObservation(observe('jsearch', 429, requests(10_000, 0, 86_400), BASIC_429));
    expect(answerForMarket('intl', () => providerCallGate('jsearch', 'interactive', { probe: true }))).toBe(false);
    await flushProviderQuota();
    expect(usageWrites()).toHaveLength(0);
  });

  it('a usage row that cannot be written never refuses or fails the call', async () => {
    setQuotaDepsForTests({ db: {} as unknown as QuotaDb, now: () => clock, env, market: () => market });
    expect(providerCallGate('jsearch', 'interactive')).toBe(true);
    await expect(flushProviderQuota()).resolves.toBeUndefined();
  });
});

describe('no second counter', () => {
  it('neither client holds a daily call counter or reads a budget variable of its own', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    for (const file of ['raRapidApiJobs.ts', 'raFantasticJobs.ts']) {
      const source = await readFile(fileURLToPath(new URL(`../../../roboapply/v2/lib/${file}`, import.meta.url)), 'utf8');
      expect(source, file).not.toMatch(/DAILY_BUDGET|dailyState|claimDailyTicket|dailyUsed|budgetEnv|rollDailyWindow|rollDay\b/);
      expect(source, file).toMatch(/export function setCallGate\(/);
      expect(source, file).toMatch(/export function setQuotaListener\(/);
    }
  });
});

describe('the clients, wired (mocked fetch): one reading, one gate, no key anywhere', () => {
  const KEY = 'synthetic-rapidapi-key-0001';

  function mockFetch(status: number, body: unknown, headers: Record<string, string | number> = {}) {
    const fn = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])) }));
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  beforeEach(() => {
    vi.stubEnv('RAPID_API_KEY', KEY);
    vi.stubEnv('RA_ONBOARDING_EXTERNAL_JOBS_DISABLED', '');
    vi.stubEnv('RA_ONBOARDING_ACTIVEJOBS_DISABLED', '');
    jsearchTest.reset();
    fantasticTest.reset();
    registerQuotaListeners();
  });

  it('Active Jobs DB answers 429 on a BASIC plan: stored as exhausted, then no call is attempted and the provider reports itself off', async () => {
    const fetchMock = mockFetch(429, { message: BASIC_429 }, { ...requests(25, 0, RESET_16_9_DAYS), 'x-ratelimit-jobs-limit': 250, 'x-ratelimit-jobs-remaining': 0 });
    expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us', titleQuery: 'engineer' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flushProviderQuota();
    expect((await storedSnapshots()).get('activejobs')).toMatchObject({ state: 'exhausted', plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, jobsLimit: 250, jobsRemaining: 0, lastStatus: 429 });

    // An hour later the client's own breaker has closed; the quota still refuses until the reset.
    fantasticTest.reset();
    expect(isFantasticJobsEnabled('activejobs')).toBe(false);
    expect(activeJobsDbProvider.isEnabled()).toBe(false);
    expect(await searchFantasticJobs('activejobs', { query: 'designer', country: 'us', titleQuery: 'designer' })).toBeNull();
    expect(await searchFantasticJobs('activejobs', { query: 'designer', country: 'us', titleQuery: 'designer' }, { reservedByIngest: true })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // JSearch has its own plan.
    expect(isJSearchEnabled()).toBe(true);
  });

  it('a 403 on the licensed feed\'s expired route keeps the plan\'s stated size and closes nothing: the gate stays open and a person\'s search is served', async () => {
    const replies: Array<{ status: number; body: unknown; headers?: Record<string, string | number> }> = [];
    const fetchMock = vi.fn(async () => {
      const r = replies.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status, headers: Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k, String(v)])) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const paid = { ...requests(50_000, 49_000, 20 * 86_400), 'x-ratelimit-jobs-limit': 100_000, 'x-ratelimit-jobs-remaining': 99_000 };
    // The plan as its own responses stated it: the gate is open.
    recordQuotaObservation(observe('activejobs', 200, paid));
    expect(feedGate(process.env)).toEqual({ open: true, reason: 'ok', monthlyJobs: 100_000 });
    // The expired route is not part of the plan.
    replies.push({ status: 403, body: { message: 'This endpoint is disabled for your subscription.' } });
    expect(await feedRequest('expired', { time_frame: '1h' })).toEqual({ ok: false, error: 'refused', status: 403, called: true });
    await flushProviderQuota();
    expect(quotaSnapshot('activejobs')).toMatchObject({ state: 'ok', jobsLimit: 100_000, jobsRemaining: 99_000, lastStatus: 200 });
    expect(feedGate(process.env)).toEqual({ open: true, reason: 'ok', monthlyJobs: 100_000 });
    expect(quotaAllows('activejobs', 'ingest')).toBe(true);
    expect(quotaAllows('activejobs', 'interactive')).toBe(true);
    expect(isFantasticJobsEnabled('activejobs')).toBe(true);
    // A person's own search and the feed's next page are served.
    replies.push({ status: 200, body: [], headers: paid }, { status: 200, body: [], headers: paid });
    expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us', titleQuery: 'engineer' })).toEqual([]);
    expect(await feedRequest('active', { time_frame: '7d', limit: '1000', offset: '0' })).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The same 403 on the route the search shares is a refused key: every purpose stops for the hour, and the size is no longer stated.
    replies.push({ status: 403, body: JSON.parse(NOT_SUBSCRIBED_403) });
    expect(await feedRequest('active', { time_frame: '7d', limit: '1000', offset: '0' })).toMatchObject({ ok: false, error: 'refused' });
    expect(quotaSnapshot('activejobs')).toMatchObject({ state: 'not_subscribed', jobsLimit: null });
    expect(feedGate(process.env).reason).toBe('plan_unknown');
  });

  it("JSearch: a person's search is counted in the day's usage row and its reading stored; an ingest call is not counted again", async () => {
    const fetchMock = mockFetch(200, { status: 'OK', data: { jobs: [] } }, requests(10_000, 9_773, 17 * 86_400));
    expect(await searchJSearchJobs({ query: 'data analyst in Austin', country: 'us' })).toEqual([]);
    expect(await searchJSearchJobs({ query: 'nurse in Leeds', country: 'gb' }, { reservedByIngest: true })).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await flushProviderQuota();
    const usage = store.$sql.calls.filter((c) => c.text.startsWith('INSERT INTO "RAProviderUsage"'));
    expect(usage).toHaveLength(1);
    expect(usage[0]!.values.slice(0, 3)).toEqual(['jsearch', '2026-10-11', 1]);
    expect((await storedSnapshots()).get('jsearch')).toMatchObject({ state: 'ok', requestsLimit: 10_000, requestsRemaining: 9_773 });
  });

  it('the listener answers with the write only for a reading that closes or reopens a provider', async () => {
    // First reading, plan open: stored in the background, nothing to wait for.
    expect(quotaListener(observe('jsearch', 200, requests(10_000, 9_000, 86_400)))).toBeUndefined();
    clock = at(1_000);
    expect(quotaListener(observe('jsearch', 200, requests(10_000, 8_998, 86_399)))).toBeUndefined();
    // The plan is used up: every other process must learn it.
    clock = at(2_000);
    const closing = quotaListener(observe('jsearch', 429, requests(10_000, 0, 86_398), BASIC_429));
    expect(closing).toBeInstanceOf(Promise);
    await closing;
    expect((await storedSnapshots()).get('jsearch')).toMatchObject({ state: 'exhausted' });
    // Still closed: nothing new for the others.
    clock = at(3_000);
    expect(quotaListener(observe('jsearch', 429, requests(10_000, 0, 86_397), BASIC_429))).toBeUndefined();
    // Reopened (a bigger plan): stored at once.
    clock = at(4_000);
    const reopening = quotaListener(observe('jsearch', 200, requests(20_000, 19_999, 30 * 86_400)));
    expect(reopening).toBeInstanceOf(Promise);
    await reopening;
    expect((await storedSnapshots()).get('jsearch')).toMatchObject({ state: 'ok', requestsLimit: 20_000 });
    // A cold process whose very first response is a refusal waits too; a reading nobody can use does not.
    expect(quotaListener(observe('activejobs', 403, {}, NOT_SUBSCRIBED_403))).toBeInstanceOf(Promise);
    expect(quotaListener(null as unknown as ProviderQuotaObservation)).toBeUndefined();
    await flushProviderQuota();
  });

  it('settleQuotaListener waits for a promise, at most the bound, and for nothing else', async () => {
    expect(QUOTA_LISTENER_WAIT_MS).toBe(500);
    expect(settleQuotaListener(undefined)).toBeUndefined();
    expect(settleQuotaListener(null)).toBeUndefined();
    expect(settleQuotaListener({ provider: 'jsearch' })).toBeUndefined();
    await expect(settleQuotaListener(Promise.resolve('stored'))).resolves.toBeUndefined();
    await expect(settleQuotaListener(Promise.reject(new Error('db down')))).resolves.toBeUndefined();
    vi.useFakeTimers();
    try {
      let settled = false;
      const never = settleQuotaListener(new Promise(() => undefined))!.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(QUOTA_LISTENER_WAIT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await never;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a person's search that learns the plan is used up returns only once that is stored; an ingest call does not wait (its tick does)", async () => {
    // A slow database: the write of the reading takes a moment.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realCreate = store.appConfig.create.bind(store.appConfig);
    vi.spyOn(store.appConfig, 'create').mockImplementation(async (args: never) => {
      await gate;
      return realCreate(args);
    });
    mockFetch(429, { message: BASIC_429 }, requests(10_000, 0, RESET_16_9_DAYS));
    let done = false;
    const search = searchJSearchJobs({ query: 'data analyst in Austin', country: 'us' }).then((r) => {
      done = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The response arrived and the reading is in memory; the search is still waiting for the write.
    expect(quotaSnapshot('jsearch', clock)).toMatchObject({ state: 'exhausted' });
    expect(done).toBe(false);
    expect(await storedSnapshots()).toEqual(new Map());
    release();
    expect(await search).toBeNull();
    expect((await storedSnapshots()).get('jsearch')).toMatchObject({ state: 'exhausted', plan: 'BASIC' });

    // The same reading on an ingest call: the call returns at once, the write is the tick's to await.
    resetProviderQuotaForTests();
    install();
    registerQuotaListeners();
    jsearchTest.reset();
    store = createFakePrisma();
    install();
    let releaseIngest: () => void = () => undefined;
    const ingestGate = new Promise<void>((resolve) => (releaseIngest = resolve));
    const create2 = store.appConfig.create.bind(store.appConfig);
    vi.spyOn(store.appConfig, 'create').mockImplementation(async (args: never) => {
      await ingestGate;
      return create2(args);
    });
    expect(await searchJSearchJobs({ query: 'nurse in Leeds', country: 'gb' }, { reservedByIngest: true })).toBeNull();
    expect(await storedSnapshots()).toEqual(new Map());
    releaseIngest();
    await flushProviderQuota();
    expect((await storedSnapshots()).get('jsearch')).toMatchObject({ state: 'exhausted' });
  });

  it('the API key is in no snapshot, no stored row and no log line', async () => {
    mockFetch(429, { message: BASIC_429 }, requests(25, 0, RESET_16_9_DAYS));
    await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us', titleQuery: 'engineer' });
    mockFetch(200, { status: 'OK', data: { jobs: [] } }, requests(10_000, 9_773, 17 * 86_400));
    await searchJSearchJobs({ query: 'engineer in Austin', country: 'us' });
    await flushProviderQuota();
    const row = (await store.appConfig.findUnique({ where: { key: PROVIDER_QUOTA_CONFIG_KEY } })) as { value: string };
    expect(Object.keys(JSON.parse(row.value).providers).sort()).toEqual(['activejobs', 'jsearch']);
    const everything = JSON.stringify([row, [...providerQuotaSnapshots(clock).values()], store.$sql.calls, ...Object.values(logged).map((fn) => fn.mock.calls)]);
    expect(everything).not.toContain(KEY);
    expect(everything).toContain('BASIC');
  });
});

// ── MKT-5A: the licensed feed's gate (MARKET_STRATEGY M-2, JI-7, JC-6) ─────

describe("the licensed feed's quota gate (feedGate)", () => {
  const KEY = { RAPID_API_KEY: 'synthetic-rapidapi-key-0002' };
  /** A plan as its own response headers state it (SYNTHETIC values in the shapes of the 2026-10-11 probe). */
  const plan = (jobsLimit: number, jobsRemaining: number, requestsLimit = Math.floor(jobsLimit / 2), requestsRemaining = Math.floor(jobsLimit / 2) - 10) => ({
    ...requests(requestsLimit, requestsRemaining, 20 * 86_400),
    'x-ratelimit-jobs-limit': jobsLimit,
    'x-ratelimit-jobs-remaining': jobsRemaining,
  });
  const withEnv = (next: EnvSource) => {
    env = next;
    install();
  };

  it('the constants of the rule', () => {
    expect(FEED_MIN_MONTHLY_JOBS).toBe(20_000);
    expect(FEED_DAYS_PER_MONTH).toBe(31);
    expect(FEED_CN_BUDGET_SHARE).toBe(0.2);
    expect(FEED_EXCLUDE_MIN_BOARDS).toBe(200);
    expect(MAINLAND_ACTIVEJOBS_DAILY_CALLS).toBe(20);
    expect(FEED_PLAN_PROVIDER).toBe('activejobs');
  });

  it("today's free plan (25 requests, 250 postings a month): closed, plan_too_small, used up or not", () => {
    withEnv(KEY);
    // As the 2026-10-11 probe found it: the month's requests are spent.
    recordQuotaObservation(observe('activejobs', 429, { ...requests(25, 0, RESET_16_9_DAYS), 'x-ratelimit-jobs-limit': 250, 'x-ratelimit-jobs-remaining': 112 }, BASIC_429));
    expect(feedGate()).toEqual({ open: false, reason: 'plan_too_small', monthlyJobs: 250 });
    // After its reset the plan is still the free one: the limit is a plan fact and is kept.
    clock = at((RESET_16_9_DAYS + 60) * 1000);
    expect(quotaSnapshot('activejobs')!.state).toBe('unknown');
    expect(feedGate()).toEqual({ open: false, reason: 'plan_too_small', monthlyJobs: 250 });
    expect(feedGateForMarket('cn')).toEqual({ open: false, reason: 'plan_too_small', monthlyJobs: 250 });
    expect(mainlandPlanOpen('activejobs')).toBe(false);
  });

  it('nothing states the plan: closed with a reason of its own (plan_unknown), with or without a key', () => {
    // Not "too small": no response was read and FANTASTIC_MONTHLY_JOBS is unset, so nothing is known about the plan.
    withEnv(KEY);
    expect(feedGate()).toEqual({ open: false, reason: 'plan_unknown', monthlyJobs: null });
    withEnv({});
    expect(feedGate()).toEqual({ open: false, reason: 'plan_unknown', monthlyJobs: null });
    expect(feedGateForMarket('cn')).toEqual({ open: false, reason: 'plan_unknown', monthlyJobs: null });
    // A refused key states no plan either (its numbers are not carried over): the same reason, until the variable or a response says.
    withEnv(KEY);
    recordQuotaObservation(observe('activejobs', 200, plan(100_000, 99_000)));
    expect(feedGate().open).toBe(true);
    clock = at(1_000);
    recordQuotaObservation(observe('activejobs', 403, {}, NOT_SUBSCRIBED_403));
    expect(feedGate()).toEqual({ open: false, reason: 'plan_unknown', monthlyJobs: null });
    // One number is enough to tell the two apart: a stated small plan is "too small".
    withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '250' });
    expect(feedGate()).toEqual({ open: false, reason: 'plan_too_small', monthlyJobs: 250 });
  });

  describe('a deployment that serves only GoApply never reads the plan by itself', () => {
    const GO_ONLY = { ...KEY, ALLOWED_BRANDS: 'goapply' };
    const hint = () => logged.warn.mock.calls.filter((c) => String(c[1]).includes('nothing states the size of the plan'));

    it('says so once per process when the stored reading is loaded: FANTASTIC_MONTHLY_JOBS is what opens the gate there', async () => {
      withEnv(GO_ONLY);
      expect(servesMarket('intl', GO_ONLY)).toBe(false);
      await hydrateProviderQuota(db());
      expect(hint()).toHaveLength(1);
      expect(hint()[0]![2]).toEqual({ set: 'FANTASTIC_MONTHLY_JOBS', reason: 'plan_unknown' });
      await hydrateProviderQuota(db());
      await hydrateProviderQuota(db());
      expect(hint()).toHaveLength(1);
      // No key value in it.
      expect(JSON.stringify(logged.warn.mock.calls)).not.toContain(KEY.RAPID_API_KEY);
    });

    it('not when the variable is set, when a stored reading states the plan, without a key, or when RoboApply is served too', async () => {
      withEnv({ ...GO_ONLY, FANTASTIC_MONTHLY_JOBS: '100000' });
      await hydrateProviderQuota(db());
      expect(hint()).toEqual([]);
      // No key: the deployment is not trying to use the provider.
      resetProviderQuotaForTests();
      withEnv({ ALLOWED_BRANDS: 'goapply' });
      await hydrateProviderQuota(db());
      expect(hint()).toEqual([]);
      // RoboApply's own search adapter calls on any plan: the first response states the size.
      for (const served of [{}, { ALLOWED_BRANDS: 'roboapply,goapply' }, { BRAND_LOCK: 'roboapply' }]) {
        resetProviderQuotaForTests();
        withEnv({ ...KEY, ...served });
        expect(servesMarket('intl', env)).toBe(true);
        await hydrateProviderQuota(db());
      }
      expect(hint()).toEqual([]);
      // A reading another process stored (a shared database) is loaded first, and states the plan: nothing to say.
      resetProviderQuotaForTests();
      withEnv(KEY);
      recordQuotaObservation(observe('activejobs', 200, plan(250, 200, 25, 20)));
      await flushProviderQuota();
      resetProviderQuotaForTests();
      withEnv(GO_ONLY);
      await hydrateProviderQuota(db());
      expect(feedGate().reason).toBe('plan_too_small');
      expect(hint()).toEqual([]);
    });

    it('the kill switch is a decision, not a missing number: no hint', async () => {
      withEnv({ ...GO_ONLY, FANTASTIC_FEED_DISABLED: 'true' });
      await hydrateProviderQuota(db());
      expect(hint()).toEqual([]);
    });
  });

  it('a plan of 100,000 postings a month stated by the provider: open, and the day is 3,225 postings', () => {
    withEnv(KEY);
    recordQuotaObservation(observe('activejobs', 200, plan(100_000, 99_000)));
    const gate = feedGate();
    expect(gate).toEqual({ open: true, reason: 'ok', monthlyJobs: 100_000 });
    expect(feedDailyJobs(env, gate.monthlyJobs)).toBe(3_225);
    expect(feedGateForMarket('intl')).toEqual(gate);
    expect(feedGateForMarket('cn')).toEqual(gate);
  });

  it('FANTASTIC_MONTHLY_JOBS=100000 and a key: open without any reading; the larger of the two numbers counts', () => {
    withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000' });
    expect(feedGate()).toEqual({ open: true, reason: 'ok', monthlyJobs: 100_000 });
    expect(feedDailyJobs(env, 100_000)).toBe(3_225);
    // A reading that states less than what was bought (an old plan's headers): the owner's number stands.
    recordQuotaObservation(observe('activejobs', 200, plan(250, 200, 25, 20)));
    expect(feedGate().monthlyJobs).toBe(100_000);
    // A reading that states more: the provider's number stands.
    clock = at(1_000);
    recordQuotaObservation(observe('activejobs', 200, plan(250_000, 240_000)));
    expect(feedGate().monthlyJobs).toBe(250_000);
    expect(feedMonthlyJobs({ FANTASTIC_MONTHLY_JOBS: '19999' }, null)).toBe(19_999);
    expect(feedMonthlyJobs({ FANTASTIC_MONTHLY_JOBS: 'lots' }, null)).toBeNull();
    expect(feedMonthlyJobs({ FANTASTIC_MONTHLY_JOBS: '-5' }, 30_000)).toBe(30_000);
  });

  it('exactly 20,000 opens it; 19,999 does not', () => {
    withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '19999' });
    expect(feedGate()).toMatchObject({ open: false, reason: 'plan_too_small' });
    withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '20000' });
    expect(feedGate()).toEqual({ open: true, reason: 'ok', monthlyJobs: 20_000 });
  });

  it('FANTASTIC_FEED_DISABLED=true closes it; so does a kill switch of the provider', () => {
    for (const off of [{ FANTASTIC_FEED_DISABLED: 'true' }, { FANTASTIC_FEED_DISABLED: '1' }, { RA_ONBOARDING_ACTIVEJOBS_DISABLED: 'true' }, { RA_ONBOARDING_EXTERNAL_JOBS_DISABLED: 'true' }]) {
      withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000', ...off });
      expect(feedGate(), JSON.stringify(off)).toEqual({ open: false, reason: 'disabled', monthlyJobs: 100_000 });
    }
    withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000', FANTASTIC_FEED_DISABLED: 'false' });
    expect(feedGate().open).toBe(true);
  });

  it('no key for the chosen transport: no_key (the direct transport needs FANTASTIC_API_KEY, whatever the marketplace key is)', () => {
    withEnv({ FANTASTIC_MONTHLY_JOBS: '100000' });
    expect(feedGate()).toEqual({ open: false, reason: 'no_key', monthlyJobs: 100_000 });
    withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000', FANTASTIC_TRANSPORT: 'direct' });
    expect(feedGate()).toEqual({ open: false, reason: 'no_key', monthlyJobs: 100_000 });
    // The header of the direct key is the documented one, so the key alone opens the transport ...
    withEnv({ FANTASTIC_MONTHLY_JOBS: '100000', FANTASTIC_TRANSPORT: 'direct', FANTASTIC_API_KEY: 'synthetic-direct-key-0003' });
    expect(feedGate()).toEqual({ open: true, reason: 'ok', monthlyJobs: 100_000 });
    // ... and a header name alone opens nothing.
    withEnv({ FANTASTIC_MONTHLY_JOBS: '100000', FANTASTIC_TRANSPORT: 'direct', FANTASTIC_API_KEY_HEADER: 'X-Api-Key' });
    expect(feedGate().reason).toBe('no_key');
  });

  it('a paid plan that is used up, refused or down to its reserve: exhausted, until the reading stops blocking', () => {
    withEnv({ ...KEY });
    // The month's postings are gone (a served call whose own headers say so).
    recordQuotaObservation(observe('activejobs', 200, plan(100_000, 0)));
    expect(feedGate()).toEqual({ open: false, reason: 'exhausted', monthlyJobs: 100_000 });
    // After the reset the old period says nothing: open again.
    clock = at(21 * DAY);
    expect(feedGate()).toEqual({ open: true, reason: 'ok', monthlyJobs: 100_000 });
    // Requests at the reserve ingest keeps for people's searches (5% of 50,000 = 2,500).
    recordQuotaObservation(observe('activejobs', 200, plan(100_000, 60_000, 50_000, 2_500)));
    expect(feedGate().reason).toBe('exhausted');
    clock = at(21 * DAY + 1_000);
    recordQuotaObservation(observe('activejobs', 200, plan(100_000, 60_000, 50_000, 2_501)));
    expect(feedGate().open).toBe(true);
    // The key refused: closed for the hour ingest waits.
    clock = at(21 * DAY + 2_000);
    recordQuotaObservation(observe('activejobs', 403, {}, NOT_SUBSCRIBED_403));
    withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000' });
    expect(feedGate().reason).toBe('exhausted');
  });

  it('the order of the reasons: a switch, then the plan (unknown, or too small), then the key, then the quota', () => {
    const facts = { env: {} as EnvSource, statedJobsLimit: 100_000, keyPresent: true, providerKilled: false, quotaStops: false };
    expect(feedGateFor(facts)).toEqual({ open: true, reason: 'ok', monthlyJobs: 100_000 });
    expect(feedGateFor({ ...facts, quotaStops: true }).reason).toBe('exhausted');
    expect(feedGateFor({ ...facts, quotaStops: true, keyPresent: false }).reason).toBe('no_key');
    expect(feedGateFor({ ...facts, quotaStops: true, keyPresent: false, statedJobsLimit: 250 }).reason).toBe('plan_too_small');
    expect(feedGateFor({ ...facts, quotaStops: true, keyPresent: false, statedJobsLimit: null })).toEqual({ open: false, reason: 'plan_unknown', monthlyJobs: null });
    expect(feedGateFor({ ...facts, statedJobsLimit: null, providerKilled: true }).reason).toBe('disabled');
    expect(feedGateFor({ ...facts, statedJobsLimit: null, env: { FANTASTIC_MONTHLY_JOBS: '19999' } }).reason).toBe('plan_too_small');
    expect(feedGateFor({ ...facts, quotaStops: true, keyPresent: false, statedJobsLimit: 250, providerKilled: true }).reason).toBe('disabled');
    expect(feedGateFor({ ...facts, env: { FANTASTIC_FEED_DISABLED: 'yes' } }).reason).toBe('disabled');
  });

  it('never throws: an unreadable env closes it', () => {
    const boom = new Proxy({}, { get: () => { throw new Error('env not readable'); } }) as EnvSource;
    expect(feedGate(boom)).toEqual({ open: false, reason: 'disabled', monthlyJobs: null });
  });

  it('no key value appears in the gate or in a log line', () => {
    withEnv({ RAPID_API_KEY: 'synthetic-rapidapi-key-0002', FANTASTIC_API_KEY: 'synthetic-direct-key-0003', FANTASTIC_MONTHLY_JOBS: '100000' });
    const text = JSON.stringify([feedGate(), feedGateForMarket('cn'), logged.warn.mock.calls, logged.info.mock.calls]);
    expect(text).not.toContain('synthetic-rapidapi-key-0002');
    expect(text).not.toContain('synthetic-direct-key-0003');
  });

  describe('the mainland (JC-6)', () => {
    it('CN_ACTIVEJOBS_ENABLED=false keeps Active Jobs DB off for the mainland while the gate is open; on by default', () => {
      withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000' });
      expect(feedGateForMarket('cn')).toEqual({ open: true, reason: 'ok', monthlyJobs: 100_000 });
      expect(mainlandPlanOpen('activejobs')).toBe(true);
      expect(mainlandPlanOpen('jsearch')).toBe(false);
      expect(mainlandPlanOpen('linkedin')).toBe(false);
      for (const off of ['false', '0', 'no', 'OFF']) {
        withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000', CN_ACTIVEJOBS_ENABLED: off });
        expect(feedGateForMarket('cn'), off).toEqual({ open: false, reason: 'disabled', monthlyJobs: 100_000 });
        // The international sync is not touched by the mainland switch.
        expect(feedGateForMarket('intl').open, off).toBe(true);
        expect(mainlandPlanOpen('activejobs'), off).toBe(false);
      }
      expect(mainlandActiveJobsEnabled({})).toBe(true);
      expect(mainlandActiveJobsEnabled({ CN_ACTIVEJOBS_ENABLED: 'true' })).toBe(true);
      expect(mainlandActiveJobsEnabled({ CN_ACTIVEJOBS_ENABLED: 'anything else' })).toBe(true);
    });

    it('the mainland call bound: 0 while the gate is closed, 20 a day while it is open, the operator\'s number when set, always under what is left of the plan', () => {
      withEnv(KEY);
      expect(effectiveDailyLimit('activejobs', 'cn', env, clock)).toBe(0);
      withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000' });
      expect(effectiveDailyLimit('activejobs', 'cn', env, clock)).toBe(20);
      // JSearch never gets a mainland call by itself.
      expect(effectiveDailyLimit('jsearch', 'cn', env, clock)).toBe(0);
      withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000', INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '0' });
      expect(effectiveDailyLimit('activejobs', 'cn', env, clock)).toBe(0);
      withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000', INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '75' });
      expect(effectiveDailyLimit('activejobs', 'cn', env, clock)).toBe(75);
      // The switch closes the default, not an operator's own number.
      withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000', CN_ACTIVEJOBS_ENABLED: 'false' });
      expect(effectiveDailyLimit('activejobs', 'cn', env, clock)).toBe(0);
      // Under the plan: 10 days to the reset, 150 requests above the reserve of 50 → 10 a day.
      withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000' });
      recordQuotaObservation(observe('activejobs', 200, requests(1_000, 150, 10 * 86_400)));
      expect(effectiveDailyLimit('activejobs', 'cn', env, clock)).toBe(10);
      // The international bound is what it was.
      expect(effectiveDailyLimit('activejobs', 'intl', env, clock)).toBe(10);
      expect(mainlandOperatorCalls('activejobs', { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '12' })).toBe(12);
      expect(mainlandOperatorCalls('activejobs', { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: 'many' })).toBeNull();
      expect(mainlandOperatorCalls('activejobs', {})).toBeNull();
    });

    it('the rule with the reading as an argument (the admin panel) gives the same mainland number', () => {
      withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000' });
      expect(effectiveDailyLimitFor('activejobs', 'cn', env, null, clock)).toBe(20);
      withEnv(KEY);
      expect(effectiveDailyLimitFor('activejobs', 'cn', env, null, clock)).toBe(0);
    });

    it("a person's own mainland search is still let through only under a bound the OPERATOR set: the gate's 20 calls are ingest's (role text only)", async () => {
      const usageWrites = () => store.$sql.calls.filter((c) => c.text.startsWith('INSERT INTO \"RAProviderUsage\"'));
      market = 'cn';
      withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000' });
      expect(effectiveDailyLimit('activejobs', 'cn', env, clock)).toBe(20);
      // The gate is open and ingest may call; a typed search may not leave for the provider.
      expect(providerCallGate('activejobs', 'interactive')).toBe(false);
      expect(providerCallGate('activejobs', 'interactive', { probe: true })).toBe(false);
      expect(providerCallGate('activejobs', 'ingest')).toBe(true);
      expect(providerCallGate('jsearch', 'interactive')).toBe(false);
      await flushProviderQuota();
      expect(usageWrites()).toHaveLength(0);
      // The operator's own decision opens it, counted under activejobs:cn (as before this bundle).
      withEnv({ ...KEY, FANTASTIC_MONTHLY_JOBS: '100000', INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '5' });
      expect(providerCallGate('activejobs', 'interactive')).toBe(true);
      await flushProviderQuota();
      expect(usageWrites().map((c) => c.values[0])).toEqual(['activejobs:cn']);
      expect(marketOfCall()).toBe('cn');
      expect(answerForMarket('intl', () => marketOfCall())).toBe('intl');
    });
  });

  describe("the day's posting budget", () => {
    it('INGEST_FEED_DAILY_JOBS, else the plan divided by 31; nothing known is 0', () => {
      expect(feedDailyJobs({}, 100_000)).toBe(3_225);
      expect(feedDailyJobs({}, 20_000)).toBe(645);
      expect(feedDailyJobs({}, 250_000)).toBe(8_064);
      expect(feedDailyJobs({}, null)).toBe(0);
      expect(feedDailyJobs({ INGEST_FEED_DAILY_JOBS: '1500' }, 100_000)).toBe(1_500);
      expect(feedDailyJobs({ INGEST_FEED_DAILY_JOBS: '0' }, 100_000)).toBe(0);
      expect(feedDailyJobs({ INGEST_FEED_DAILY_JOBS: 'plenty' }, 100_000)).toBe(3_225);
      expect(feedDailyJobs({ INGEST_FEED_DAILY_JOBS: '-10' }, 100_000)).toBe(0);
    });

    it('the mainland gets 20% of the day and the international sync the rest: together never more than the day', () => {
      expect(feedDailyJobsFor('cn', {}, 100_000)).toBe(645);
      expect(feedDailyJobsFor('intl', {}, 100_000)).toBe(2_580);
      expect(feedDailyJobsFor('cn', {}, 100_000) + feedDailyJobsFor('intl', {}, 100_000)).toBe(3_225);
      // The operator's own mainland number, never above the day.
      expect(feedDailyJobsFor('cn', { INGEST_FEED_CN_DAILY_JOBS: '1000' }, 100_000)).toBe(1_000);
      expect(feedDailyJobsFor('intl', { INGEST_FEED_CN_DAILY_JOBS: '1000' }, 100_000)).toBe(2_225);
      expect(feedDailyJobsFor('cn', { INGEST_FEED_CN_DAILY_JOBS: '99999' }, 100_000)).toBe(3_225);
      expect(feedDailyJobsFor('intl', { INGEST_FEED_CN_DAILY_JOBS: '99999' }, 100_000)).toBe(0);
      expect(feedDailyJobsFor('cn', { INGEST_FEED_CN_DAILY_JOBS: '0' }, 100_000)).toBe(0);
      expect(feedDailyJobsFor('intl', { INGEST_FEED_CN_DAILY_JOBS: '0' }, 100_000)).toBe(3_225);
    });

    it('a market that is not synced here uses none of the day: the mainland switch off, or a deployment that serves one brand', () => {
      const off = { CN_ACTIVEJOBS_ENABLED: 'false' };
      expect([feedDailyJobsFor('intl', off, 100_000), feedDailyJobsFor('cn', off, 100_000)]).toEqual([3_225, 0]);
      const roboOnly = { ALLOWED_BRANDS: 'roboapply' };
      expect([feedDailyJobsFor('intl', roboOnly, 100_000), feedDailyJobsFor('cn', roboOnly, 100_000)]).toEqual([3_225, 0]);
      // The mainland stack: its sync has its share (or the operator's number) and the international one runs nowhere here.
      const goOnly = { ALLOWED_BRANDS: 'goapply' };
      expect([feedDailyJobsFor('intl', goOnly, 100_000), feedDailyJobsFor('cn', goOnly, 100_000)]).toEqual([0, 645]);
      expect(feedDailyJobsFor('cn', { ...goOnly, INGEST_FEED_CN_DAILY_JOBS: '3225' }, 100_000)).toBe(3_225);
      expect(feedDailyJobsFor('cn', { BRAND_LOCK: 'goapply' }, 100_000)).toBe(645);
    });

    describe('held to what the plan has left, less a reserve for people\'s own searches (carry-over M3.1)', () => {
      const inDays = (days: number) => at(days * DAY).toISOString();

      it('the reserve: the share ingest leaves of the plan\'s requests, taken of its postings; never under one search page', () => {
        expect(FEED_RESERVE_MIN_JOBS).toBe(20);
        expect(feedJobsReserve(100_000, {})).toBe(5_000);
        expect(feedJobsReserve(10_000, {})).toBe(500);
        expect(feedJobsReserve(100_000, { INGEST_QUOTA_RESERVE_SHARE: '0.1' })).toBe(10_000);
        expect(feedJobsReserve(100_000, { INGEST_QUOTA_RESERVE_SHARE: '0' })).toBe(20);
        expect(feedJobsReserve(250, {})).toBe(20);
        for (const unknown of [null, undefined, 0, -5, Number.NaN]) expect(feedJobsReserve(unknown, {})).toBe(20);
        // The same share as the request side.
        expect(feedJobsReserve(50_000, {})).toBe(quotaReserve(50_000, {}));
      });

      it('what the feed may still be billed for: the stated remainder less the reserve; nothing stated is null', () => {
        expect(feedJobsLeft({ jobsLimit: 100_000, jobsRemaining: 60_000, resetAt: null }, {})).toBe(55_000);
        expect(feedJobsLeft({ jobsLimit: 100_000, jobsRemaining: 5_000, resetAt: null }, {})).toBe(0);
        expect(feedJobsLeft({ jobsLimit: 100_000, jobsRemaining: 12, resetAt: null }, {})).toBe(0);
        expect(feedJobsLeft({ jobsLimit: null, jobsRemaining: 100, resetAt: null }, {})).toBe(80);
        expect(feedJobsLeft({ jobsLimit: 100_000, jobsRemaining: null, resetAt: inDays(4) }, {})).toBeNull();
        expect(feedJobsLeft(null, {})).toBeNull();
      });

      it('10 days and 10,000 postings left: at most 950 a day on a 10,000 plan, 500 on a 100,000 plan (default reserve)', () => {
        expect(feedQuotaDailyJobs({ jobsLimit: 10_000, jobsRemaining: 10_000, resetAt: inDays(10) }, clock, {})).toBe(950);
        expect(feedQuotaDailyJobs({ jobsLimit: 100_000, jobsRemaining: 10_000, resetAt: inDays(10) }, clock, {})).toBe(500);
        // A fresh month of a 100,000 plan, 31 days to go: 3,064, a little under month / 31 (the reserve).
        expect(feedQuotaDailyJobs({ jobsLimit: 100_000, jobsRemaining: 100_000, resetAt: inDays(31) }, clock, {})).toBe(3_064);
        // The last day: everything above the reserve.
        expect(feedQuotaDailyJobs({ jobsLimit: 100_000, jobsRemaining: 7_300, resetAt: at(5 * 3_600_000).toISOString() }, clock, {})).toBe(2_300);
        // At or under the reserve: nothing.
        expect(feedQuotaDailyJobs({ jobsLimit: 100_000, jobsRemaining: 4_000, resetAt: inDays(3) }, clock, {})).toBe(0);
        // The operator's share.
        expect(feedQuotaDailyJobs({ jobsLimit: 100_000, jobsRemaining: 30_000, resetAt: inDays(10) }, clock, { INGEST_QUOTA_RESERVE_SHARE: '0.2' })).toBe(1_000);
      });

      it('no stated remaining count, or no reset time: null (the month / 31 rule stands alone, never a guess)', () => {
        expect(feedQuotaDailyJobs(null, clock, {})).toBeNull();
        expect(feedQuotaDailyJobs({ jobsLimit: 100_000, jobsRemaining: null, resetAt: inDays(10) }, clock, {})).toBeNull();
        expect(feedQuotaDailyJobs({ jobsLimit: 100_000, jobsRemaining: 60_000, resetAt: null }, clock, {})).toBeNull();
        expect(feedDailyJobs({}, 100_000, null)).toBe(3_225);
        expect(feedDailyJobs({}, 100_000)).toBe(3_225);
      });

      it('the day is the smaller of the two; the operator\'s INGEST_FEED_DAILY_JOBS is held to the remainder too', () => {
        expect(feedDailyJobs({}, 100_000, 500)).toBe(500);
        expect(feedDailyJobs({}, 100_000, 4_700)).toBe(3_225);
        expect(feedDailyJobs({ INGEST_FEED_DAILY_JOBS: '9000' }, 100_000, 500)).toBe(500);
        expect(feedDailyJobs({ INGEST_FEED_DAILY_JOBS: '300' }, 100_000, 500)).toBe(300);
        expect(feedDailyJobs({}, 100_000, 0)).toBe(0);
      });

      it('split between the markets as before: 20% of the capped day for the mainland, the rest for the international sync', () => {
        expect([feedDailyJobsFor('intl', {}, 100_000, 500), feedDailyJobsFor('cn', {}, 100_000, 500)]).toEqual([400, 100]);
        expect([feedDailyJobsFor('intl', { ALLOWED_BRANDS: 'roboapply' }, 100_000, 500), feedDailyJobsFor('cn', { ALLOWED_BRANDS: 'roboapply' }, 100_000, 500)]).toEqual([500, 0]);
        // The operator's mainland number is never above the capped day.
        expect([feedDailyJobsFor('intl', { INGEST_FEED_CN_DAILY_JOBS: '800' }, 100_000, 500), feedDailyJobsFor('cn', { INGEST_FEED_CN_DAILY_JOBS: '800' }, 100_000, 500)]).toEqual([0, 500]);
      });

      it('from the provider\'s own reading: the snapshot of a response gives the cap', () => {
        recordQuotaObservation(observe('activejobs', 200, { ...requests(50_000, 40_000, 10 * 86_400), 'x-ratelimit-jobs-limit': 100_000, 'x-ratelimit-jobs-remaining': 10_000 }));
        expect(feedQuotaDailyJobs(quotaSnapshot('activejobs'), clock, {})).toBe(500);
        // Past the reset the old period's remainder says nothing: no cap until a new response.
        clock = at(10 * DAY + 1_000);
        expect(feedQuotaDailyJobs(quotaSnapshot('activejobs'), clock, {})).toBeNull();
      });
    });

    it("the day's postings are read from the usage row (0 when the day has no row; null when the read gives nothing usable)", async () => {
      const seen: unknown[][] = [];
      const fake = (rows: unknown) => ({ $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => (seen.push(values), rows) }) as never;
      expect(await providerJobsToday(fake([{ jobsReturned: 1_240 }]), 'activejobs', '2026-10-11')).toBe(1_240);
      expect(await providerJobsToday(fake([{ jobsReturned: 7n }]), 'activejobs:cn', '2026-10-11')).toBe(7);
      expect(await providerJobsToday(fake([]), 'activejobs', '2026-10-11')).toBe(0);
      expect(await providerJobsToday(fake(undefined), 'activejobs', '2026-10-11')).toBeNull();
      expect(await providerJobsToday(fake([{ jobsReturned: 'many' }]), 'activejobs', '2026-10-11')).toBeNull();
      expect(seen[0]).toEqual(['activejobs', '2026-10-11']);
      expect(seen[1]).toEqual(['activejobs:cn', '2026-10-11']);
    });
  });

  describe('the filters the operator sets', () => {
    it('INGEST_FEED_COUNTRIES: upper-case ISO codes in the order given, without repeats; the default is the thirteen markets', () => {
      expect(feedCountries({})).toEqual(['US', 'CA', 'GB', 'IE', 'DE', 'FR', 'NL', 'ES', 'IT', 'SE', 'AU', 'SG', 'TW']);
      expect(feedCountries({})).toEqual([...DEFAULT_FEED_COUNTRIES]);
      expect(feedCountries({ INGEST_FEED_COUNTRIES: ' us, gb ,US,tw ' })).toEqual(['US', 'GB', 'TW']);
      // Anything that is not two letters is not a code and is left out (a name is never sent as a code).
      expect(feedCountries({ INGEST_FEED_COUNTRIES: 'USA,United States,1,de' })).toEqual(['DE']);
      expect(feedCountries({ INGEST_FEED_COUNTRIES: 'USA' })).toEqual([]);
      expect(feedCountries({ INGEST_FEED_COUNTRIES: '   ' })).toEqual([...DEFAULT_FEED_COUNTRIES]);
    });

    it('INGEST_FEED_TAXONOMIES: the names as written, unset by default', () => {
      expect(feedTaxonomies({})).toEqual([]);
      expect(feedTaxonomies({ INGEST_FEED_TAXONOMIES: ' Software, Data & Analytics ,Software,' })).toEqual(['Software', 'Data & Analytics']);
    });
  });
});
