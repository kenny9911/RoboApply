// @vitest-environment node
//
// Admin console services (WP-74; INT-08): System panel assembly and alert
// levels, "Reports to review" (decisions in RAJobReview, old ones read from
// 'admin_review' interactions), costs, Assistant feedback, the RAAdminAuditLog
// audit (written, listed, never throws), the daily health email, and parity
// of the limits copies with their owning areas (join J3).

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({
  default: new Proxy({}, { get: () => { throw new Error('tests must not reach Prisma'); } }),
}));

import { ALERT_LEVELS, PROVIDER_STATES, type BrandHealth, type ProviderUsageRow, type SystemStatusResponse } from '../contract.js';
import {
  brandHealth,
  buildProviderRows,
  buildSystemStatus,
  createPrismaSystemStore,
  evaluateAlerts,
  healthWindow,
  jobSourcesHealth,
  mainlandCounterSources,
  parseUsageKey,
  providerSources,
  providerState,
  type ProviderSource,
  type SourceLister,
} from '../system.js';
import { ADMIN_REVIEW_KIND, KEEP_DECISION_HOLDS, buildItem, clearedRuleSet, createPrismaReportsStore, intlScamFlags, listReports, resolveReport, reviewedElsewhere, type ReportJobRow, type ReportsStore, type DecisionRow } from '../reports.js';
import { costsCsv, getCosts, resolveCostRange } from '../costs.js';
import { listAdminFeedback, type FeedbackStore } from '../feedback.js';
import { AUDIT_PAGE_SIZE, auditDetails, createPrismaAuditStore, listAdminAudit, writeAdminAudit, type AdminAuditRow, type AdminAuditStore, type LegacyAuditStore } from '../audit.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { createAdminHealthTask, parseAdminEmails, alertLine, adminHealthTemplate } from '../healthEmail.js';
import { toSafetyView } from '../safety.js';
import * as limits from '../limits.js';
import { fakeSystemData, fakeSystemStore, quotaSnapshot } from './fakes.js';
import { getBrand, getCurrentBrandId, runWithBrand } from '../../../platform/brand/index.js';
import { createBudget } from '../../../platform/queue/index.js';
// Parity: the originals the admin mirrors (tests are outside the boundary rule).
import { DEFAULT_SCORE_DAILY_BUDGET, scoreDailyBudget, scoreCounterKeys } from '../../match/config.js';
import { DEFAULT_COPILOT_DAILY_BUDGET_USD, copilotDailyBudgetUsd } from '../../copilot/budget.js';
import { dailyCallLimit } from '../../jobs/ingest/config.js';
import * as ingest from '../../jobs/ingest/index.js';
import { PROVIDER_QUOTA_CONFIG_KEY, serializeProviderQuota } from '../../jobs/ingest/quotaContract.js';
import { enrichBudgetKey } from '../../jobs/enrich/budget.js';

const NOW = new Date('2026-10-10T12:00:00Z');

// ── System ────────────────────────────────────────────────────────────────

describe('brandHealth', () => {
  it('reads today vs the previous 7 full days and the budgets', async () => {
    const byDay = [
      { day: '2026-10-10', count: 30 },
      ...Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${9 - i}`, count: 70 })),
      { day: '2026-10-02', count: 9999 }, // outside the window
    ];
    const store = fakeSystemStore(fakeSystemData({ byDay, counters: { 'budget:llm:enrich:intl': 7200, 'budget:llm:score:roboapply': 100 } }));
    const h = await brandHealth(store, 'roboapply', NOW, { ENRICH_DAILY_JOBS: '8000' });
    expect(h.market).toBe('intl');
    expect(h.ingest.newJobsToday).toBe(30);
    expect(h.ingest.newJobs7dAvg).toBe(70);
    expect(h.ingest.enrichBacklog).toBe(20);
    expect(h.ingest.enrichedShare).toBe(0.8);
    expect(h.ingest.enrichBudget).toEqual({ used: 7200, limit: 8000 });
    expect(h.precompute).toEqual({ used: 100, limit: DEFAULT_SCORE_DAILY_BUDGET });
    expect(h.copilot).toEqual({ turns: 9, guardHits: 1, costUsd: 0.42, budgetUsd: DEFAULT_COPILOT_DAILY_BUDGET_USD });
    expect(h.creditExhaustion).toBeNull();
    expect(store.calls).toEqual(['ingest:intl']);
  });

  it('no open jobs → enrichedShare null (renders —), never 0', async () => {
    const h = await brandHealth(fakeSystemStore(fakeSystemData({ open: { open: 0, enriched: 0 } })), 'goapply', NOW, {});
    expect(h.market).toBe('cn');
    expect(h.ingest.enrichedShare).toBeNull();
  });
});

// ── Job sources per brand (PAR-7) ─────────────────────────────────────────

/** A registry description for the tests (the real registry is tested in jobs/ingest/adapters). */
function fakeSource(provider: string, kind: 'bank' | 'ats' | 'search' | 'import', status: { enabled: boolean; transport: string; reason: string | null }, sourceBoards: string[] = []) {
  return { brand: 'goapply', market: 'cn', provider, kind, transport: status.transport, sourceBoards, adapter: null, enabled: () => status.enabled, status: () => status } as never;
}
const run = (over: Record<string, unknown> = {}) => ({ at: '2026-10-10T11:50:00.000Z', ok: true, error: null, transport: 'api', queries: 1, calls: 4, received: 0, written: 0, inserted: 0, closed: 0, skipped: 0, notes: {}, ...over });

describe('job sources per brand (the admin sources panel)', () => {
  const goSources: SourceLister = () => [
    fakeSource('bank_gohire', 'bank', { enabled: true, transport: 'api', reason: null }, ['gohire']),
    fakeSource('ats_public', 'ats', { enabled: true, transport: 'board_api', reason: null }, ['greenhouse', 'lever', 'ashby', 'smartrecruiters']),
    fakeSource('user_import', 'import', { enabled: true, transport: 'off', reason: null }),
  ];

  it('GoApply: the GoHire bank over the API with its skip tallies and the reason its rows are not listed; the employer boards with real counters', async () => {
    const counted = run({ notes: { bank_synced: 181, bank_no_public_page: 181, bank_unpublished: 1092 } });
    const store = fakeSystemStore(
      fakeSystemData({
        sourceStatuses: {
          bank_gohire: { last: run({ at: '2026-10-10T11:55:00.000Z' }), counted: counted as never } as never,
          ats_public: { last: run({ transport: 'board_api', received: 412, written: 398, inserted: 398, skipped: 14, notes: { boards_read: 26, wrong_market: 9, no_apply_url: 5 } }), counted: null } as never,
        },
        sourceJobs: { gohire: { open: 0, held: 6 }, greenhouse: { open: 120, held: 0 }, smartrecruiters: { open: 278, held: 0 } },
        careerSources: { total: 26, enabled: 26, failing: 1 },
      }),
    );
    const sources = await jobSourcesHealth(store, 'goapply', {}, goSources);
    expect(sources.map((s) => s.provider)).toEqual(['bank_gohire', 'ats_public', 'user_import']);
    const bank = sources[0]!;
    expect(bank).toMatchObject({ kind: 'bank', enabled: true, transport: 'api', reason: null, openJobs: 0, heldJobs: 6, boards: null });
    // No GOHIRE_PUBLIC_JOB_URL_TEMPLATE: the synced rows are held, and the panel names the setting.
    expect(bank.publicPage).toEqual({ configured: false, variable: 'GOHIRE_PUBLIC_JOB_URL_TEMPLATE' });
    expect(bank.lastRun).toMatchObject({ at: '2026-10-10T11:55:00.000Z', ok: true });
    expect(bank.lastCounted!.notes).toEqual({ bank_synced: 181, bank_no_public_page: 181, bank_unpublished: 1092 });
    const boards = sources[1]!;
    expect(boards).toMatchObject({ kind: 'ats', transport: 'board_api', openJobs: 398, heldJobs: 0, publicPage: null, boards: { total: 26, enabled: 26, failing: 1 } });
    expect(boards.lastRun).toMatchObject({ received: 412, written: 398, skipped: 14, notes: { wrong_market: 9, no_apply_url: 5, boards_read: 26 } });
    expect(sources[2]).toMatchObject({ kind: 'import', lastRun: null, lastCounted: null, openJobs: 0, publicPage: null, boards: null });
  });

  it('with the page template set the bank reads as configured; a source that never ran has no run, and an off source says why', async () => {
    const list: SourceLister = () => [fakeSource('bank_gohire', 'bank', { enabled: false, transport: 'off', reason: 'tls_required_no_api_key' }, ['gohire'])];
    const [bank] = await jobSourcesHealth(fakeSystemStore(), 'goapply', { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://example.test/p/{id}' }, list);
    expect(bank).toMatchObject({ enabled: false, transport: 'off', reason: 'tls_required_no_api_key', lastRun: null, lastCounted: null, publicPage: { configured: true, variable: 'GOHIRE_PUBLIC_JOB_URL_TEMPLATE' } });
  });

  it('a brand\u2019s sources answer in that brand\u2019s own context, whichever brand the request or cron runs as', async () => {
    // A source that is on only when it is asked as RoboApply (a provider that is never called for the mainland).
    const asked: Array<string | undefined> = [];
    const status = () => {
      const on = getCurrentBrandId() === 'roboapply';
      return { enabled: on, transport: on ? 'rapidapi' : 'off', reason: on ? null : 'disabled' };
    };
    const list: SourceLister = () => (asked.push(getCurrentBrandId()), [{ brand: 'roboapply', market: 'intl', provider: 'jsearch', kind: 'search', transport: 'rapidapi', sourceBoards: ['jsearch'], adapter: null, enabled: () => status().enabled, status } as never]);
    // The admin is on the GoApply host and looks at RoboApply's sources.
    const [fromGoApply] = await runWithBrand('goapply', () => jobSourcesHealth(fakeSystemStore(), 'roboapply', {}, list));
    expect(fromGoApply).toMatchObject({ provider: 'jsearch', enabled: true, transport: 'rapidapi', reason: null });
    const [fromRoboApply] = await runWithBrand('roboapply', () => jobSourcesHealth(fakeSystemStore(), 'roboapply', {}, list));
    expect(fromRoboApply).toEqual(fromGoApply);
    expect(asked).toEqual(['roboapply', 'roboapply']);
  });

  it('each brand gets its own sources from the registry: RoboApply never lists the GoHire bank and GoApply never lists a search API', async () => {
    const s = await buildSystemStatus(fakeSystemStore(), { brands: ['roboapply', 'goapply'], brandsServed: ['roboapply', 'goapply'], now: NOW, env: {} });
    const of = (brand: string) => s.brands.find((b) => b.brand === brand)!.sources.map((x) => x.provider);
    expect(of('roboapply')).toEqual(expect.arrayContaining(['activejobs', 'bank_robohire', 'jsearch', 'user_import']));
    expect(of('roboapply')).not.toContain('bank_gohire');
    expect(of('roboapply')).not.toContain('linkedin');
    expect(of('goapply')[0]).toBe('bank_gohire');
    expect(of('goapply')).toContain('user_import');
    for (const p of ['jsearch', 'activejobs', 'linkedin', 'bank_robohire']) expect(of('goapply')).not.toContain(p);
    // The RoboHire bank names its own page setting.
    expect(s.brands.find((b) => b.brand === 'roboapply')!.sources.find((x) => x.provider === 'bank_robohire')!.publicPage).toEqual({ configured: false, variable: 'ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE' });
  });
});

function healthWith(over: Partial<BrandHealth['ingest']> & { precompute?: BrandHealth['precompute']; copilot?: Partial<BrandHealth['copilot']>; emailFailed?: number } = {}): BrandHealth {
  return {
    brand: 'roboapply',
    market: 'intl',
    sources: [],
    ingest: {
      due: 0, overdue: 0, failing: 0, newJobsToday: 100, newJobs7dAvg: 100, openJobs: 10, enrichBacklog: 0, enrichedShare: 1,
      enrichBudget: { used: 0, limit: 8000 },
      ...over,
    },
    precompute: over.precompute ?? { used: 0, limit: 20000 },
    alerts: { sent: 0, failed: 0 },
    email: { sent: 0, failed: over.emailFailed ?? 0, failedByTemplate: [] },
    copilot: { turns: 0, guardHits: 0, costUsd: 0, budgetUsd: 50, ...over.copilot },
    creditExhaustion: null,
  };
}

/** A provider row with nothing stated; a test names what it cares about. */
function providerRow(over: Partial<ProviderUsageRow> & { provider: string }): ProviderUsageRow {
  return {
    market: 'intl', calls: 0, limit: null, jobsReturned: 0, jobsNew: 0, errors: 0,
    plan: null, requestsLimit: null, requestsRemaining: null, jobsLimit: null, jobsRemaining: null, resetAt: null, daysToReset: null, observedAt: null,
    costModel: 'free', state: 'ok',
    ...over,
  };
}

/** Registry descriptions for the provider tests: every source on, cost model by provider id. */
const onSource = (brand: 'roboapply' | 'goapply', provider: string, kind: 'bank' | 'ats' | 'search' | 'import') =>
  ({ brand, market: brand === 'goapply' ? 'cn' : 'intl', provider, kind, transport: 'off', sourceBoards: [], adapter: null, enabled: () => true, status: () => ({ enabled: true, transport: 'off', reason: null }) }) as never;
const roboSources: SourceLister = () => [onSource('roboapply', 'activejobs', 'search'), onSource('roboapply', 'bank_robohire', 'bank'), onSource('roboapply', 'jsearch', 'search'), onSource('roboapply', 'user_import', 'import')];
const goProviderSources: SourceLister = () => [onSource('goapply', 'bank_gohire', 'bank'), onSource('goapply', 'activejobs', 'search'), onSource('goapply', 'user_import', 'import')];

describe('healthWindow', () => {
  it('live: today so far, with the elapsed share of the UTC day', () => {
    const w = healthWindow(new Date('2026-10-10T03:30:00Z'));
    expect(w).toMatchObject({ mode: 'live', dayKey: '2026-10-10', elapsedShare: 0.1458 });
    expect(w.start.toISOString()).toBe('2026-10-10T00:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-10T03:30:00.000Z');
  });

  it('last_complete_day: the whole previous UTC day', () => {
    const w = healthWindow(new Date('2026-10-10T03:30:00Z'), 'last_complete_day');
    expect(w).toMatchObject({ mode: 'last_complete_day', dayKey: '2026-10-09', elapsedShare: 1 });
    expect(w.start.toISOString()).toBe('2026-10-09T00:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });
});

describe('evaluateAlerts', () => {
  const base = (brands: BrandHealth[], dead = 0, providers: SystemStatusResponse['providers'] = [], dayElapsedShare = 1) => ({ brands, queue: { kinds: [], deadTotal: dead }, providers, dayElapsedShare });

  it('quiet day → no alerts', () => {
    expect(evaluateAlerts(base([healthWith()]))).toEqual([]);
  });

  it('ingest below half the 7-day average', () => {
    expect(evaluateAlerts(base([healthWith({ newJobsToday: 49, newJobs7dAvg: 100 })]))).toEqual([
      { key: 'ingest_new_low', brand: 'roboapply', subject: null, value: 49, level: 50 },
    ]);
    expect(evaluateAlerts(base([healthWith({ newJobsToday: 50, newJobs7dAvg: 100 })]))).toEqual([]);
  });

  it('live: the ingest level is prorated by the share of the day that has passed', () => {
    // 12:00 UTC: half the day, so the level is 100 × 0.5 × 0.5 = 25.
    expect(evaluateAlerts(base([healthWith({ newJobsToday: 30, newJobs7dAvg: 100 })], 0, [], 0.5))).toEqual([]);
    expect(evaluateAlerts(base([healthWith({ newJobsToday: 24, newJobs7dAvg: 100 })], 0, [], 0.5))).toEqual([
      { key: 'ingest_new_low', brand: 'roboapply', subject: null, value: 24, level: 25 },
    ]);
  });

  it('live: quiet early in the UTC day, even with no new jobs yet', () => {
    expect(evaluateAlerts(base([healthWith({ newJobsToday: 0, newJobs7dAvg: 100 })], 0, [], ALERT_LEVELS.ingestMinDayShare - 0.01))).toEqual([]);
  });

  it('ignores the ingest rule while the average is tiny', () => {
    expect(evaluateAlerts(base([healthWith({ newJobsToday: 0, newJobs7dAvg: ALERT_LEVELS.ingestMinAverage - 1 })]))).toEqual([]);
  });

  it('dead items over the level, provider and budgets at 90%', () => {
    const hits = evaluateAlerts(
      base(
        [healthWith({ enrichBudget: { used: 7200, limit: 8000 }, precompute: { used: 18000, limit: 20000 }, copilot: { costUsd: 45, budgetUsd: 50 }, emailFailed: 51 })],
        101,
        [providerRow({ provider: 'jsearch', calls: 180, limit: 200, costModel: 'per_request' }), providerRow({ provider: 'bank', calls: 9999, limit: null })],
      ),
    );
    expect(hits.map((h) => `${h.key}:${h.subject ?? h.brand ?? ''}`)).toEqual([
      'dead_items:',
      'provider_budget:jsearch',
      'enrich_budget:roboapply',
      'score_budget:roboapply',
      'assistant_budget:roboapply',
      'email_failures:roboapply',
    ]);
  });

  it('a 0 limit (feature off) never alerts', () => {
    expect(evaluateAlerts(base([healthWith({ enrichBudget: { used: 0, limit: 0 } })]))).toEqual([]);
    // A mainland counter with no budget (0) and no calls is quiet too.
    expect(evaluateAlerts(base([healthWith()], 0, [providerRow({ provider: 'activejobs:cn', market: 'cn', limit: 0, costModel: 'per_job', state: 'unknown' })]))).toEqual([]);
  });

  it('provider quota (JI-1): one hit per metered provider that is exhausted, not subscribed, refused or low', () => {
    const metered = (provider: string, over: Partial<ProviderUsageRow>) => providerRow({ provider, costModel: 'per_request', ...over });
    const hits = evaluateAlerts(
      base([healthWith()], 0, [
        metered('activejobs', { costModel: 'per_job', state: 'exhausted', plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, daysToReset: 17 }),
        metered('feed', { state: 'not_subscribed' }),
        metered('jsearch', { state: 'low', requestsLimit: 10_000, requestsRemaining: 412, daysToReset: 3 }),
        metered('keyless', { state: 'unauthorized' }),
      ]),
    );
    expect(hits).toEqual([
      { key: 'provider_quota', brand: null, subject: 'activejobs', value: 0, level: 0, state: 'exhausted', daysToReset: 17 },
      { key: 'provider_quota', brand: null, subject: 'feed', value: 0, level: 0, state: 'not_subscribed', daysToReset: null },
      { key: 'provider_quota', brand: null, subject: 'jsearch', value: 412, level: 1000, state: 'low', daysToReset: 3 },
      { key: 'provider_quota', brand: null, subject: 'keyless', value: 0, level: 0, state: 'unauthorized', daysToReset: null },
    ]);
  });

  it('provider quota: low on postings names the postings left; ok, gated, disabled and unknown providers raise nothing', () => {
    const low = evaluateAlerts(base([healthWith()], 0, [providerRow({ provider: 'activejobs', costModel: 'per_job', state: 'low', requestsLimit: 25, requestsRemaining: 20, jobsLimit: 250, jobsRemaining: 12 })]));
    expect(low).toEqual([{ key: 'provider_quota', brand: null, subject: 'activejobs', value: 12, level: 25, state: 'low', daysToReset: null }]);
    const quiet = (['ok', 'gated', 'disabled', 'unknown'] as const).map((state) => providerRow({ provider: `p_${state}`, costModel: 'per_job', state }));
    expect(evaluateAlerts(base([healthWith()], 0, quiet))).toEqual([]);
    // An unmetered source is never a quota alert, whatever its row says.
    expect(evaluateAlerts(base([healthWith()], 0, [providerRow({ provider: 'bank_gohire:cn', market: 'cn', costModel: 'free', state: 'disabled' })]))).toEqual([]);
  });

  it('the daily call limit and the monthly quota are two rules: a provider can trip both', () => {
    const hits = evaluateAlerts(base([healthWith()], 0, [providerRow({ provider: 'jsearch', costModel: 'per_request', calls: 190, limit: 200, state: 'low', requestsLimit: 10_000, requestsRemaining: 5 })]));
    expect(hits.map((h) => h.key)).toEqual(['provider_budget', 'provider_quota']);
  });
});

// ── Job providers: usage, quota and state (MKT-3F, JI-1) ──────────────────

const src = (provider: string, over: Partial<ProviderSource> = {}): ProviderSource => ({ provider, market: 'intl', enabled: true, reason: null, costModel: 'free', ...over });
/** 2026-10-27T12:00Z is 17 days after NOW. */
const RESET_17D = '2026-10-27T12:00:00.000Z';

describe('providerState', () => {
  const reading = (over: Partial<Parameters<typeof providerState>[0]['reading'] & object> = {}) => ({ state: 'ok' as const, requestsLimit: 10_000, requestsRemaining: 9_773, jobsLimit: null, jobsRemaining: null, ...over });
  const on = { enabled: true, reason: null };
  const off = (reason: string | null = 'no_key') => ({ enabled: false, reason });
  const state = (over: Partial<Parameters<typeof providerState>[0]>) => providerState({ provider: 'jsearch', costModel: 'per_request', source: on, reading: reading(), planJobsLimit: null, ...over });

  it('every state has a case', () => {
    const seen = new Set([
      state({}),
      state({ reading: reading({ requestsRemaining: 999 }) }),
      state({ reading: reading({ state: 'exhausted', requestsRemaining: 0 }) }),
      state({ reading: reading({ state: 'not_subscribed' }) }),
      state({ reading: reading({ state: 'unauthorized' }) }),
      state({ provider: 'activejobs_feed', costModel: 'per_job', source: off('disabled'), planJobsLimit: 250 }),
      state({ source: off() }),
      state({ reading: null }),
    ]);
    expect([...seen]).toEqual(['ok', 'low', 'exhausted', 'not_subscribed', 'unauthorized', 'gated', 'disabled', 'unknown']);
    expect(new Set(seen)).toEqual(new Set(PROVIDER_STATES));
  });

  it('ok: 9,773 of 10,000 requests left', () => {
    expect(state({})).toBe('ok');
    // Limits the provider did not state are not "low".
    expect(state({ reading: reading({ requestsLimit: null, requestsRemaining: null }) })).toBe('ok');
    expect(state({ reading: reading({ requestsLimit: null, requestsRemaining: 5 }) })).toBe('ok');
  });

  it('exhausted: the provider said so (a 429), or it stated that nothing is left after a call it still served', () => {
    expect(state({ reading: reading({ state: 'exhausted', requestsRemaining: 0 }) })).toBe('exhausted');
    // The call that used the last request was served (state ok): 0 of 25 left is used up, not "low".
    expect(state({ reading: reading({ requestsLimit: 25, requestsRemaining: 0 }) })).toBe('exhausted');
    expect(state({ reading: reading({ jobsLimit: 250, jobsRemaining: 0 }) })).toBe('exhausted');
    expect(state({ reading: reading({ requestsLimit: null, requestsRemaining: 0 }) })).toBe('exhausted');
    // The adapter is then off because of it: still "exhausted", never a bare "off".
    expect(state({ source: off('quota'), reading: reading({ requestsLimit: 25, requestsRemaining: 0 }) })).toBe('exhausted');
    // One left is low, not used up; a count nobody stated is neither.
    expect(state({ reading: reading({ requestsLimit: 25, requestsRemaining: 1 }) })).toBe('low');
    expect(state({ reading: reading({ requestsLimit: 25, requestsRemaining: null }) })).toBe('ok');
  });

  it('low: under 10% of the requests or of the postings left, both stated', () => {
    expect(state({ reading: reading({ requestsRemaining: 999 }) })).toBe('low');
    expect(state({ reading: reading({ requestsRemaining: 1000 }) })).toBe('ok');
    expect(state({ reading: reading({ jobsLimit: 250, jobsRemaining: 24 }) })).toBe('low');
    expect(state({ reading: reading({ jobsLimit: 250, jobsRemaining: 25 }) })).toBe('ok');
  });

  it('a closed reading wins over "off": the adapter is off BECAUSE the quota is gone', () => {
    expect(state({ source: off('quota'), reading: reading({ state: 'exhausted', requestsRemaining: 0 }) })).toBe('exhausted');
    expect(state({ source: off(), reading: reading({ state: 'not_subscribed' }) })).toBe('not_subscribed');
    expect(state({ source: off(), reading: reading({ state: 'unauthorized' }) })).toBe('unauthorized');
  });

  it('disabled: off for another reason (no key, a kill switch), with or without a reading', () => {
    expect(state({ source: off('no_key') })).toBe('disabled');
    expect(state({ source: off('kill_switch'), reading: null })).toBe('disabled');
    // A low reading does not turn "no key" into "running low": the adapter said why it is off.
    expect(state({ source: off('no_key'), reading: reading({ requestsRemaining: 400 }) })).toBe('disabled');
    expect(state({ source: off('no_key'), reading: reading({ requestsRemaining: 400 }), atReserve: true })).toBe('disabled');
    // No reason stated and plenty left: off for something else.
    expect(state({ source: off('disabled') })).toBe('disabled');
    expect(state({ source: off(null) })).toBe('disabled');
  });

  it('off because the quota stops ingest is not "off": the reading tells the state', () => {
    // The adapter says the quota is the reason: 400 of 10,000 left is low (and an alert), 9,000 is fine.
    expect(state({ source: off('quota'), reading: reading({ requestsRemaining: 400 }) })).toBe('low');
    expect(state({ source: off('quota'), reading: reading({ requestsRemaining: 9_000 }) })).toBe('ok');
    expect(state({ source: off('quota'), reading: null })).toBe('unknown');
    // The adapter gives no reason, and the reading is at or under the share ingest never spends: same answer.
    expect(state({ source: off('disabled'), reading: reading({ requestsRemaining: 400 }), atReserve: true })).toBe('low');
    expect(state({ source: off(null), reading: reading({ requestsLimit: 25, requestsRemaining: 2 }), atReserve: true })).toBe('low');
    // Low but above the reserve, with no reason stated: ingest would still call, so it is off for something else.
    expect(state({ source: off('disabled'), reading: reading({ requestsRemaining: 900 }) })).toBe('disabled');
  });

  it('unknown: a metered provider that is on with no current reading, or a reading that says nothing', () => {
    expect(state({ reading: null })).toBe('unknown');
    expect(state({ reading: reading({ state: 'unknown' }) })).toBe('unknown');
    // A usage row no served brand lists: nothing says it is off.
    expect(state({ source: null, reading: null })).toBe('unknown');
  });

  it('gated: the licensed feed is off and its stated plan is under 20,000 postings a month (M-2); a refused key still comes first', () => {
    const feed = (over: Partial<Parameters<typeof providerState>[0]>) => state({ provider: 'activejobs_feed', costModel: 'per_job', source: off('disabled'), ...over });
    expect(limits.FEED_MIN_MONTHLY_JOBS).toBe(20_000);
    expect(feed({ planJobsLimit: 250 })).toBe('gated');
    // Today's BASIC plan is also used up: the plan size is what keeps the feed off.
    expect(feed({ planJobsLimit: 250, reading: reading({ state: 'exhausted', requestsRemaining: 0 }) })).toBe('gated');
    expect(feed({ planJobsLimit: 19_999, reading: null })).toBe('gated');
    // A large enough plan, or a plan size nobody stated, is not "gated".
    expect(feed({ planJobsLimit: 20_000 })).toBe('disabled');
    expect(feed({ planJobsLimit: null })).toBe('disabled');
    // On (the plan size was set another way): not gated.
    expect(feed({ planJobsLimit: 250, source: on })).toBe('ok');
    expect(feed({ planJobsLimit: 250, reading: reading({ state: 'unauthorized' }) })).toBe('unauthorized');
    // Another metered source is gated only when its adapter says the plan is the reason.
    expect(state({ provider: 'activejobs', costModel: 'per_job', source: off('disabled'), planJobsLimit: 250 })).toBe('disabled');
    expect(state({ provider: 'activejobs', costModel: 'per_job', source: off('plan_too_small'), planJobsLimit: null })).toBe('gated');
  });

  it('an unmetered source (bank, employer boards, open data) is only on or off', () => {
    expect(state({ provider: 'bank_robohire', costModel: 'free', reading: null })).toBe('ok');
    expect(state({ provider: 'bank_gohire', costModel: 'free', source: off('tls_required'), reading: null })).toBe('disabled');
    expect(state({ provider: 'ats_public', costModel: 'free', source: null, reading: null })).toBe('ok');
  });
});

describe('parseUsageKey', () => {
  it('a ":cn" suffix is the mainland counter', () => {
    expect(parseUsageKey('activejobs')).toEqual({ provider: 'activejobs', market: 'intl' });
    expect(parseUsageKey('activejobs:cn')).toEqual({ provider: 'activejobs', market: 'cn' });
    expect(parseUsageKey(':cn')).toEqual({ provider: ':cn', market: 'intl' });
  });
});

describe('buildProviderRows (registry + usage + quota snapshot)', () => {
  const rows = (input: Partial<Parameters<typeof buildProviderRows>[0]>) => buildProviderRows({ sources: [], usage: [], quota: new Map(), now: NOW, env: {}, ...input });
  const NO_QUOTA = { plan: null, requestsLimit: null, requestsRemaining: null, jobsLimit: null, jobsRemaining: null, resetAt: null, daysToReset: null, observedAt: null };

  it('JI-1: a provider that made no call today is listed with its plan, what is left and the days to its reset', () => {
    const quota = new Map([
      ['activejobs', quotaSnapshot('activejobs', { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, jobsLimit: 250, jobsRemaining: 0, resetAt: RESET_17D, state: 'exhausted', lastStatus: 429 })],
      ['jsearch', quotaSnapshot('jsearch', { requestsLimit: 10_000, requestsRemaining: 9_773, resetAt: '2026-10-25T00:00:00.000Z' })],
    ]);
    const out = rows({
      sources: [src('activejobs', { costModel: 'per_job', enabled: false, reason: 'quota' }), src('bank_robohire'), src('jsearch', { costModel: 'per_request' }), src('ats_public')],
      usage: [{ provider: 'jsearch', calls: 20, jobsReturned: 400, jobsNew: 50, errors: 1 }],
      quota,
    });
    expect(out.map((r) => r.provider)).toEqual(['activejobs', 'ats_public', 'bank_robohire', 'jsearch']);
    expect(out[0]).toEqual({
      // Nothing is left of the plan: ingest may make no call today.
      provider: 'activejobs', market: 'intl', calls: 0, limit: 0, jobsReturned: 0, jobsNew: 0, errors: 0,
      plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, jobsLimit: 250, jobsRemaining: 0, resetAt: RESET_17D, daysToReset: 17, observedAt: '2026-10-10T11:00:00.000Z',
      costModel: 'per_job', state: 'exhausted',
    });
    // (9,773 left − 500 kept back) over the 15 days to the reset.
    expect(out[3]).toMatchObject({ provider: 'jsearch', calls: 20, limit: 618, jobsReturned: 400, jobsNew: 50, errors: 1, plan: null, requestsLimit: 10_000, requestsRemaining: 9_773, daysToReset: 15, costModel: 'per_request', state: 'ok' });
    // Unmetered sources: calls and yields only.
    expect(out[1]).toEqual({ provider: 'ats_public', market: 'intl', calls: 0, limit: null, jobsReturned: 0, jobsNew: 0, errors: 0, ...NO_QUOTA, costModel: 'free', state: 'ok' });
    expect(out[2]).toMatchObject({ provider: 'bank_robohire', ...NO_QUOTA, costModel: 'free', state: 'ok' });
  });

  it('a provider absent from the snapshot shows state unknown and null numbers, never invented ones', () => {
    const [row] = rows({ sources: [src('jsearch', { costModel: 'per_request' })], quota: new Map([['activejobs', quotaSnapshot('activejobs', { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0 })]]) });
    expect(row).toEqual({ provider: 'jsearch', market: 'intl', calls: 0, limit: 200, jobsReturned: 0, jobsNew: 0, errors: 0, ...NO_QUOTA, costModel: 'per_request', state: 'unknown' });
  });

  it('GoApply: "activejobs:cn" is its own row with market cn, its own counters and budget, on the provider\u2019s one plan', () => {
    const quota = new Map([['activejobs', quotaSnapshot('activejobs', { plan: 'PRO', requestsLimit: 5000, requestsRemaining: 4000, jobsLimit: 100_000, jobsRemaining: 90_000, resetAt: RESET_17D })]]);
    const out = rows({
      sources: [src('activejobs', { costModel: 'per_job' }), src('activejobs', { market: 'cn', costModel: 'per_job' }), src('bank_gohire', { market: 'cn' }), src('ats_public'), src('ats_public', { market: 'cn' })],
      usage: [
        { provider: 'activejobs', calls: 40, jobsReturned: 900, jobsNew: 80, errors: 0 },
        { provider: 'activejobs:cn', calls: 6, jobsReturned: 55, jobsNew: 21, errors: 1 },
        { provider: 'bank_gohire:cn', calls: 3, jobsReturned: 181, jobsNew: 0, errors: 0 },
      ],
      quota,
      env: { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '20' },
    });
    expect(out.map((r) => `${r.provider}|${r.market}`)).toEqual(['activejobs|intl', 'activejobs:cn|cn', 'ats_public|intl', 'ats_public:cn|cn', 'bank_gohire:cn|cn']);
    // One plan, one cap for both counters: (4,000 left − 250 kept back) over 17 days = 220; the mainland budget of 20 is under it.
    expect(out[0]).toMatchObject({ calls: 40, limit: 220, plan: 'PRO', requestsRemaining: 4000, state: 'ok' });
    expect(out[1]).toMatchObject({ provider: 'activejobs:cn', market: 'cn', calls: 6, limit: 20, jobsReturned: 55, jobsNew: 21, errors: 1, plan: 'PRO', jobsLimit: 100_000, jobsRemaining: 90_000, daysToReset: 17, costModel: 'per_job', state: 'ok' });
    expect(out[4]).toMatchObject({ provider: 'bank_gohire:cn', market: 'cn', calls: 3, limit: null, jobsReturned: 181, costModel: 'free', state: 'ok' });
    // A reading stored under the mainland key wins for the mainland row.
    const own = new Map([...quota, ['activejobs:cn', quotaSnapshot('activejobs:cn', { plan: 'CN-DIRECT', requestsLimit: 100, requestsRemaining: 3, resetAt: RESET_17D })]]);
    const cn = rows({ sources: [src('activejobs', { market: 'cn', costModel: 'per_job' })], quota: own })[0]!;
    expect(cn).toMatchObject({ provider: 'activejobs:cn', plan: 'CN-DIRECT', requestsRemaining: 3, state: 'low' });
  });

  it('a mainland counter with no budget set is 0 for a metered provider and stays unmetered for a bank', () => {
    const out = rows({ sources: [src('activejobs', { market: 'cn', costModel: 'per_job' }), src('bank_gohire', { market: 'cn' })] });
    expect(out.map((r) => [r.provider, r.limit])).toEqual([['activejobs:cn', 0], ['bank_gohire:cn', null]]);
  });

  it('a usage row no served brand lists is still shown (real calls are never hidden), with the market from its key', () => {
    const out = rows({
      sources: [src('bank_gohire', { market: 'cn' })],
      usage: [{ provider: 'jsearch', calls: 2, jobsReturned: 10, jobsNew: 1, errors: 0 }, { provider: 'activejobs:cn', calls: 1, jobsReturned: 0, jobsNew: 0, errors: 1 }],
    });
    expect(out.map((r) => `${r.provider}|${r.market}|${r.costModel}|${r.state}|${r.calls}`)).toEqual(['activejobs:cn|cn|per_job|unknown|1', 'bank_gohire:cn|cn|free|ok|0', 'jsearch|intl|per_request|unknown|2']);
  });

  it('a reading whose reset time has passed says nothing about this period: plan and limits stay, what was left and the state do not', () => {
    const stale = quotaSnapshot('activejobs', { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, jobsLimit: 250, jobsRemaining: 0, resetAt: '2026-10-10T11:59:00.000Z', state: 'exhausted' });
    const [row] = rows({ sources: [src('activejobs', { costModel: 'per_job' })], quota: new Map([['activejobs', stale]]) });
    expect(row).toMatchObject({ plan: 'BASIC', requestsLimit: 25, requestsRemaining: null, jobsLimit: 250, jobsRemaining: null, resetAt: null, daysToReset: null, observedAt: '2026-10-10T11:00:00.000Z', state: 'unknown' });
    // A closed reading with no reset time stated stands as the provider's last word.
    const noReset = quotaSnapshot('activejobs', { state: 'not_subscribed', lastStatus: 403 });
    expect(rows({ sources: [src('activejobs', { costModel: 'per_job', enabled: false, reason: 'quota' })], quota: new Map([['activejobs', noReset]]) })[0]).toMatchObject({ state: 'not_subscribed', daysToReset: null, plan: null });
  });

  it('the daily limit is what ingest enforces that day, so "calls today" and the budget alert mean what ingest does', () => {
    const alerts = (providers: ProviderUsageRow[]) => evaluateAlerts({ brands: [], queue: { kinds: [], deadTotal: 0 }, providers, dayElapsedShare: 1 }).map((a) => `${a.key}:${a.subject}`);
    // JSearch: 9,773 of 10,000 left, 17 days to the reset. Ingest may make 545 calls a day, not the default 200.
    const jsearch = new Map([['jsearch', quotaSnapshot('jsearch', { requestsLimit: 10_000, requestsRemaining: 9_773, resetAt: RESET_17D })]]);
    const busy = rows({ sources: [src('jsearch', { costModel: 'per_request' })], usage: [{ provider: 'jsearch', calls: 190, jobsReturned: 3000, jobsNew: 200, errors: 0 }], quota: jsearch });
    expect(busy[0]).toMatchObject({ calls: 190, limit: 545, state: 'ok' });
    expect(alerts(busy)).toEqual([]);
    // A bound the operator set still holds under the cap, and is cut by it when the plan allows less.
    expect(rows({ sources: [src('jsearch', { costModel: 'per_request' })], quota: jsearch, env: { INGEST_JSEARCH_DAILY_CALLS: '200' } })[0]!.limit).toBe(200);
    expect(rows({ sources: [src('jsearch', { costModel: 'per_request' })], quota: jsearch, env: { INGEST_JSEARCH_DAILY_CALLS: '900' } })[0]!.limit).toBe(545);
    // Active Jobs DB on BASIC: 23 of 25 left, 17 days. One call a day, and that one call is the day's budget.
    const basic = new Map([['activejobs', quotaSnapshot('activejobs', { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 23, resetAt: RESET_17D })]]);
    const one = rows({ sources: [src('activejobs', { costModel: 'per_job' })], usage: [{ provider: 'activejobs', calls: 1, jobsReturned: 10, jobsNew: 2, errors: 0 }], quota: basic });
    expect(one[0]).toMatchObject({ calls: 1, limit: 1, state: 'ok' });
    expect(alerts(one)).toEqual(['provider_budget:activejobs']);
    // No reading, a reading with no reset time, or one whose period ended: the cap is not known, the configured limit stands.
    const unknownCap = [new Map(), new Map([['jsearch', quotaSnapshot('jsearch', { requestsLimit: 10_000, requestsRemaining: 9_773 })]]), new Map([['jsearch', quotaSnapshot('jsearch', { requestsLimit: 10_000, requestsRemaining: 9_773, resetAt: '2026-10-10T11:59:00.000Z' })]])];
    for (const quota of unknownCap) expect(rows({ sources: [src('jsearch', { costModel: 'per_request' })], quota })[0]!.limit).toBe(200);
  });

  it('a provider at or under ingest\u2019s reserve reads "low" whether or not the adapter is already off for it', () => {
    // 400 of 10,000 left: under the 500 ingest keeps for people's own searches. In a process that holds the
    // reading the adapter is off (it states no reason); in one that does not it is still on. One state for both.
    const quota = new Map([['jsearch', quotaSnapshot('jsearch', { requestsLimit: 10_000, requestsRemaining: 400, resetAt: RESET_17D })]]);
    const warm = rows({ sources: [src('jsearch', { costModel: 'per_request', enabled: false, reason: 'disabled' })], quota })[0]!;
    const cold = rows({ sources: [src('jsearch', { costModel: 'per_request' })], quota })[0]!;
    expect([warm.state, cold.state]).toEqual(['low', 'low']);
    expect(evaluateAlerts({ brands: [], queue: { kinds: [], deadTotal: 0 }, providers: [warm], dayElapsedShare: 1 })).toEqual([
      { key: 'provider_quota', brand: null, subject: 'jsearch', value: 400, level: 1000, state: 'low', daysToReset: 17 },
    ]);
    expect(warm.limit).toBe(0);
    // Active Jobs DB on BASIC keeps 2 back: with 2 left it is low, not "off".
    const basic = new Map([['activejobs', quotaSnapshot('activejobs', { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 2, resetAt: RESET_17D })]]);
    expect(rows({ sources: [src('activejobs', { costModel: 'per_job', enabled: false, reason: 'disabled' })], quota: basic })[0]!.state).toBe('low');
    // 900 left is low and above the reserve: an adapter that is off there is off for something else.
    const above = new Map([['jsearch', quotaSnapshot('jsearch', { requestsLimit: 10_000, requestsRemaining: 900, resetAt: RESET_17D })]]);
    expect(rows({ sources: [src('jsearch', { costModel: 'per_request', enabled: false, reason: 'disabled' })], quota: above })[0]!.state).toBe('disabled');
    // A reason of its own always wins, and the reserve share is the operator's.
    expect(rows({ sources: [src('jsearch', { costModel: 'per_request', enabled: false, reason: 'no_key' })], quota })[0]!.state).toBe('disabled');
    expect(rows({ sources: [src('jsearch', { costModel: 'per_request', enabled: false, reason: 'disabled' })], quota: above, env: { INGEST_QUOTA_RESERVE_SHARE: '0.09' } })[0]!.state).toBe('low');
  });

  it('the licensed feed reads the plan it is billed on and is gated under 20,000 postings a month', () => {
    const basic = new Map([['activejobs', quotaSnapshot('activejobs', { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 11, jobsLimit: 250, jobsRemaining: 120, resetAt: RESET_17D })]]);
    const feed = (quota: Map<string, ReturnType<typeof quotaSnapshot>>, market: 'intl' | 'cn' = 'intl') =>
      rows({ sources: [src('activejobs_feed', { market, costModel: 'per_job', enabled: false, reason: 'disabled' })], quota })[0]!;
    expect(feed(basic)).toMatchObject({ provider: 'activejobs_feed', plan: 'BASIC', jobsLimit: 250, jobsRemaining: 120, daysToReset: 17, state: 'gated' });
    expect(feed(basic, 'cn')).toMatchObject({ provider: 'activejobs_feed:cn', market: 'cn', plan: 'BASIC', state: 'gated' });
    const paid = new Map([['activejobs', quotaSnapshot('activejobs', { plan: 'ULTRA', jobsLimit: 100_000, jobsRemaining: 99_000, resetAt: RESET_17D })]]);
    expect(feed(paid)).toMatchObject({ plan: 'ULTRA', state: 'disabled' });
    // No reading at all: nothing says the plan is too small.
    expect(feed(new Map())).toMatchObject({ plan: null, jobsLimit: null, state: 'disabled' });
    // The plan it is billed on is shown; the search provider's daily budget is not the feed's.
    const search = quotaSnapshot('activejobs', { plan: 'ULTRA', requestsLimit: 10_000, requestsRemaining: 300, jobsLimit: 100_000, jobsRemaining: 99_000, resetAt: RESET_17D });
    expect(feed(new Map([['activejobs', search]]))).toMatchObject({ plan: 'ULTRA', requestsRemaining: 300, limit: null, state: 'disabled' });
  });
});

describe('providerSources (the registry of every served brand)', () => {
  const adapter = (provider: string, over: Record<string, unknown> = {}) => ({ provider, kind: 'search', markets: ['intl', 'cn'], sourceBoards: [], isEnabled: () => true, supportsCountry: () => true, dailyCallLimit: () => null, fetch: async () => ({ jobs: [], calls: 0 }), ...over });
  const described = (market: 'intl' | 'cn', provider: string, kind: string, status: { enabled: boolean; reason: string | null }, a: unknown = null) =>
    ({ brand: market === 'cn' ? 'goapply' : 'roboapply', market, provider, kind, transport: 'off', sourceBoards: [], adapter: a, enabled: () => status.enabled, status: () => ({ ...status, transport: 'off' }) }) as never;
  const list: SourceLister = (brand) =>
    brand.market === 'cn'
      ? [
          described('cn', 'bank_gohire', 'bank', { enabled: false, reason: 'tls_required' }),
          // On in general, off for the mainland (a per-market gate): the row reads as off.
          described('cn', 'activejobs', 'search', { enabled: true, reason: null }, adapter('activejobs', { isEnabledFor: (m: string) => m === 'intl', costModel: 'per_job' })),
          described('cn', 'user_import', 'import', { enabled: true, reason: null }),
        ]
      : [
          described('intl', 'activejobs', 'search', { enabled: true, reason: null }, adapter('activejobs', { isEnabledFor: (m: string) => m === 'intl' })),
          described('intl', 'jsearch', 'search', { enabled: false, reason: 'no_key' }, adapter('jsearch', { isEnabled: () => false })),
          described('intl', 'ats_public', 'ats', { enabled: true, reason: null }),
          described('intl', 'user_import', 'import', { enabled: true, reason: null }),
        ];

  it('one source per provider and market, without user_import; the cost model from the adapter or the provider id', () => {
    expect(providerSources(['roboapply', 'goapply'], {}, list)).toEqual([
      { provider: 'activejobs', market: 'intl', enabled: true, reason: null, costModel: 'per_job' },
      { provider: 'jsearch', market: 'intl', enabled: false, reason: 'no_key', costModel: 'per_request' },
      { provider: 'ats_public', market: 'intl', enabled: true, reason: null, costModel: 'free' },
      { provider: 'bank_gohire', market: 'cn', enabled: false, reason: 'tls_required', costModel: 'free' },
      { provider: 'activejobs', market: 'cn', enabled: false, reason: null, costModel: 'per_job' },
    ]);
    expect(providerSources(['roboapply'], {}, list).map((s) => `${s.provider}:${s.market}`)).toEqual(['activejobs:intl', 'jsearch:intl', 'ats_public:intl']);
  });

  it('on or off is the adapter\u2019s answer for the market, and an adapter that is off for one market says why itself', () => {
    const perMarket = (over: Record<string, unknown>) => adapter('activejobs', { costModel: 'per_job', ...over });
    const one = (a: unknown, status = { enabled: true, reason: null as string | null }): SourceLister => (brand) => (brand.market === 'cn' ? [described('cn', 'activejobs', 'search', status, a)] : []);
    // On in general, off for the mainland until a larger plan exists: the adapter's code is the reason (the row then reads "gated").
    expect(providerSources(['goapply'], {}, one(perMarket({ isEnabledFor: () => false, disabledReason: () => 'plan_too_small' })))).toEqual([
      { provider: 'activejobs', market: 'cn', enabled: false, reason: 'plan_too_small', costModel: 'per_job' },
    ]);
    // The per-market answer decides, as it does for ingest: off in general, on for this market.
    expect(providerSources(['goapply'], {}, one(perMarket({ isEnabled: () => false, isEnabledFor: (m: string) => m === 'cn' }), { enabled: false, reason: 'disabled' }))[0]).toMatchObject({ enabled: true, reason: null });
    // An adapter that throws while answering is off, and a reason that throws is "not stated".
    const broken = perMarket({ isEnabledFor: () => { throw new Error('boom'); }, disabledReason: () => { throw new Error('boom'); } });
    expect(providerSources(['goapply'], {}, one(broken))[0]).toMatchObject({ enabled: false, reason: null });
    // No adapter for the market: the registry's reason.
    expect(providerSources(['goapply'], {}, one(null, { enabled: false, reason: 'wrong_market' }))[0]).toMatchObject({ enabled: false, reason: 'wrong_market', costModel: 'per_job' });
  });

  it('each brand\u2019s sources answer in that brand\u2019s own context: the rows do not depend on the host the admin is on', () => {
    // An adapter that asks which brand the unit of work runs as (a provider that is never called for the mainland).
    const hostBound = adapter('jsearch', { markets: ['intl'], isEnabled: () => getCurrentBrandId() !== 'goapply', disabledReason: () => (getCurrentBrandId() === 'goapply' ? 'wrong_brand' : null) });
    const asked: string[] = [];
    const lister: SourceLister = (brand) => {
      asked.push(`${brand.id}:${getCurrentBrandId()}`);
      if (brand.market !== 'intl') return [];
      const status = () => ({ enabled: hostBound.isEnabled(), transport: 'rapidapi', reason: hostBound.disabledReason() ?? null });
      return [{ brand: brand.id, market: 'intl', provider: 'jsearch', kind: 'search', transport: 'rapidapi', sourceBoards: [], adapter: hostBound, enabled: () => status().enabled, status } as never];
    };
    const want = [{ provider: 'jsearch', market: 'intl', enabled: true, reason: null, costModel: 'per_request' }];
    expect(runWithBrand('goapply', () => providerSources(['roboapply', 'goapply'], {}, lister))).toEqual(want);
    expect(runWithBrand('roboapply', () => providerSources(['roboapply', 'goapply'], {}, lister))).toEqual(want);
    expect(providerSources(['goapply', 'roboapply'], {}, lister)).toEqual(want);
    expect(new Set(asked)).toEqual(new Set(['roboapply:roboapply', 'goapply:goapply']));
    // The caller's own context is untouched afterwards.
    expect(runWithBrand('goapply', () => (providerSources(['roboapply'], {}, lister), getCurrentBrandId()))).toBe('goapply');
  });

  it('the real registry: RoboApply lists its search providers and bank, GoApply its bank, and neither lists user_import', () => {
    const robo = providerSources(['roboapply'], {}).map((s) => s.provider);
    expect(robo).toEqual(expect.arrayContaining(['activejobs', 'bank_robohire', 'jsearch']));
    const both = providerSources(['roboapply', 'goapply'], {});
    expect(both.find((s) => s.provider === 'bank_gohire')).toMatchObject({ market: 'cn', costModel: 'free' });
    expect(both.find((s) => s.provider === 'jsearch')).toMatchObject({ market: 'intl', costModel: 'per_request' });
    expect(both.find((s) => s.provider === 'activejobs' && s.market === 'intl')).toMatchObject({ costModel: 'per_job' });
    expect(both.map((s) => s.provider)).not.toContain('user_import');
    // MARKET_STRATEGY M-6: no RapidAPI search provider is a GoApply source.
    expect(both.filter((s) => s.market === 'cn').map((s) => s.provider)).not.toContain('jsearch');
  });
});

describe('mainlandCounterSources (a mainland counter the operator opened)', () => {
  const quota = new Map([
    ['activejobs', quotaSnapshot('activejobs', { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, resetAt: RESET_17D, state: 'exhausted', lastStatus: 429 })],
    ['jsearch', quotaSnapshot('jsearch', { requestsLimit: 10_000, requestsRemaining: 9_773 })],
  ]);
  const OPEN = { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '20' };
  const counter = { provider: 'activejobs', market: 'cn', enabled: true, reason: null, costModel: 'per_job' };

  it('one source per provider of the snapshot whose mainland budget is above 0, when a mainland brand is served', () => {
    expect(mainlandCounterSources({ brands: ['goapply'], quota, listed: [], env: OPEN })).toEqual([counter]);
    expect(mainlandCounterSources({ brands: ['roboapply', 'goapply'], quota, listed: [src('activejobs', { costModel: 'per_job' })], env: OPEN })).toEqual([counter]);
    // A reading stored under the mainland key names the same counter, once.
    const both = new Map([...quota, ['activejobs:cn', quotaSnapshot('activejobs:cn', { state: 'ok' })]]);
    expect(mainlandCounterSources({ brands: ['goapply'], quota: both, listed: [], env: OPEN })).toEqual([counter]);
  });

  it('the operator’s setting decides: no budget, no mainland brand or no reading means no row', () => {
    expect(mainlandCounterSources({ brands: ['goapply'], quota, listed: [], env: {} })).toEqual([]);
    expect(mainlandCounterSources({ brands: ['goapply'], quota, listed: [], env: { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '0' } })).toEqual([]);
    expect(mainlandCounterSources({ brands: ['roboapply'], quota, listed: [], env: OPEN })).toEqual([]);
    expect(mainlandCounterSources({ brands: ['goapply'], quota: new Map(), listed: [], env: OPEN })).toEqual([]);
    // A source the registry already lists for the mainland keeps the registry's answer.
    expect(mainlandCounterSources({ brands: ['goapply'], quota, listed: [src('activejobs', { market: 'cn', costModel: 'per_job', enabled: false, reason: 'plan_too_small' })], env: OPEN })).toEqual([]);
    // An unmetered provider has no quota to watch, whatever a snapshot says.
    const bank = new Map([['bank_gohire', quotaSnapshot('bank_gohire')]]);
    expect(mainlandCounterSources({ brands: ['goapply'], quota: bank, listed: [], env: { INGEST_BANK_GOHIRE_CN_DAILY_CALLS: '20' } })).toEqual([]);
  });
});

describe('providerDailyLimit', () => {
  const reading = (requestsRemaining: number | null, requestsLimit: number | null = 10_000, resetAt: string | null = RESET_17D) => ({ requestsLimit, requestsRemaining, resetAt });

  it('with no quota reading: the ingest limit (intl), the mainland budget (cn), null when not metered', () => {
    expect(limits.providerDailyLimit('jsearch', 'intl', {})).toBe(dailyCallLimit('jsearch', {}));
    expect(limits.providerDailyLimit('jsearch', 'intl', { INGEST_JSEARCH_DAILY_CALLS: '50' })).toBe(50);
    expect(limits.providerDailyLimit('bank_robohire', 'intl', {})).toBeNull();
    expect(limits.providerDailyLimit('activejobs', 'cn', {})).toBe(0);
    expect(limits.providerDailyLimit('activejobs', 'cn', { INGEST_ACTIVEJOBS_DAILY_CALLS: '500' })).toBe(0);
    expect(limits.providerDailyLimit('activejobs', 'cn', { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '20' })).toBe(20);
    expect(limits.providerDailyLimit('activejobs', 'cn', { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: 'many' })).toBe(0);
    expect(limits.providerDailyLimit('bank_gohire', 'cn', {})).toBeNull();
  });

  it('quotaReserve: the share of the plan ingest never spends, at least 1', () => {
    expect(limits.quotaReserve(10_000, {})).toBe(500);
    expect(limits.quotaReserve(25, {})).toBe(2);
    expect(limits.quotaReserve(null, {})).toBe(1);
    expect(limits.quotaReserve(10_000, { INGEST_QUOTA_RESERVE_SHARE: '0.2' })).toBe(2000);
    expect(limits.quotaReserve(10_000, { INGEST_QUOTA_RESERVE_SHARE: '0' })).toBe(1);
    expect(limits.quotaReserve(10_000, { INGEST_QUOTA_RESERVE_SHARE: '7' })).toBe(10_000);
    expect(limits.quotaReserve(10_000, { INGEST_QUOTA_RESERVE_SHARE: 'half' })).toBe(500);
  });

  it('quotaDailyCap: what is left above the reserve, spread over the days to the reset; null when the provider did not state it', () => {
    expect(limits.quotaDailyCap(reading(9_773), NOW, {})).toBe(545);
    expect(limits.quotaDailyCap(reading(23, 25), NOW, {})).toBe(1);
    expect(limits.quotaDailyCap(reading(0, 25), NOW, {})).toBe(0);
    expect(limits.quotaDailyCap(reading(400), NOW, {})).toBe(0);
    // The last day of the period: everything above the reserve.
    expect(limits.quotaDailyCap(reading(9_773, 10_000, '2026-10-10T18:00:00.000Z'), NOW, {})).toBe(9_273);
    expect(limits.quotaDailyCap(reading(null), NOW, {})).toBeNull();
    expect(limits.quotaDailyCap(reading(9_773, 10_000, null), NOW, {})).toBeNull();
    expect(limits.quotaDailyCap(null, NOW, {})).toBeNull();
  });

  it('intl: a stated quota replaces the default, and a bound the operator set holds under it', () => {
    expect(limits.providerDailyLimit('jsearch', 'intl', {}, reading(9_773), NOW)).toBe(545);
    expect(limits.providerDailyLimit('jsearch', 'intl', { INGEST_JSEARCH_DAILY_CALLS: '200' }, reading(9_773), NOW)).toBe(200);
    expect(limits.providerDailyLimit('jsearch', 'intl', { INGEST_JSEARCH_DAILY_CALLS: '900' }, reading(9_773), NOW)).toBe(545);
    expect(limits.providerDailyLimit('jsearch', 'intl', { INGEST_JSEARCH_DAILY_CALLS: '0' }, reading(9_773), NOW)).toBe(0);
    expect(limits.providerDailyLimit('activejobs', 'intl', {}, reading(23, 25), NOW)).toBe(1);
    expect(limits.providerDailyLimit('activejobs', 'intl', {}, reading(0, 25), NOW)).toBe(0);
    // A reading that states no reset time gives no cap.
    expect(limits.providerDailyLimit('jsearch', 'intl', {}, reading(9_773, 10_000, null), NOW)).toBe(dailyCallLimit('jsearch', {}));
  });

  it('cn: the mainland budget under the same cap', () => {
    const open = { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '20' };
    expect(limits.providerDailyLimit('activejobs', 'cn', open, reading(4_000, 5_000), NOW)).toBe(20);
    expect(limits.providerDailyLimit('activejobs', 'cn', open, reading(23, 25), NOW)).toBe(1);
    expect(limits.providerDailyLimit('activejobs', 'cn', open, reading(0, 25), NOW)).toBe(0);
    expect(limits.providerDailyLimit('activejobs', 'cn', {}, reading(4_000, 5_000), NOW)).toBe(0);
    expect(limits.mainlandCallBudget('activejobs', open)).toBe(20);
    expect(limits.mainlandCallBudget('activejobs', {})).toBe(0);
    expect(limits.mainlandCallBudget('activejobs', { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '-4' })).toBe(0);
  });

  // The rule belongs to the ingest area (jobs/ingest/config.ts `effectiveDailyLimit`, which reads the quota from
  // ingest's in-memory copy). limits.ts states it with the reading as an argument, because the admin process
  // holds the stored reading instead. This test compares the two as soon as the ingest area exports its own.
  const upstream = ingest as unknown as {
    effectiveDailyLimit?: (provider: string, market: 'intl' | 'cn', env: Record<string, string | undefined>, now: Date) => number | null;
    hydrateProviderQuota?: (store: { appConfig: { findUnique: (args: unknown) => Promise<{ value: string } | null> } }) => Promise<void>;
  };
  it.skipIf(typeof upstream.effectiveDailyLimit !== 'function' || typeof upstream.hydrateProviderQuota !== 'function')('the daily limit is the one ingest enforces (same reading, same answer)', async () => {
    const stored = new Map([
      ['activejobs', quotaSnapshot('activejobs', { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 23, resetAt: RESET_17D })],
      ['jsearch', quotaSnapshot('jsearch', { requestsLimit: 10_000, requestsRemaining: 9_773, resetAt: RESET_17D })],
    ]);
    await upstream.hydrateProviderQuota!({ appConfig: { findUnique: async () => ({ value: serializeProviderQuota(stored) }) } });
    const envs: Array<Record<string, string>> = [
      {},
      { INGEST_JSEARCH_DAILY_CALLS: '200', INGEST_ACTIVEJOBS_DAILY_CALLS: '0' },
      { INGEST_JSEARCH_DAILY_CALLS: '900', INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '20', INGEST_JSEARCH_CN_DAILY_CALLS: '5' },
      { INGEST_QUOTA_RESERVE_SHARE: '0.2' },
      // A bound set under a name only the ingest area knows (its deprecated alias) is still the operator's bound.
      { RA_ONBOARDING_JSEARCH_DAILY_BUDGET: '150' },
    ];
    for (const env of envs) {
      // The providers ingest meters by daily calls. (For one it does not meter, the panel shows "no daily limit": null.)
      for (const provider of ['activejobs', 'jsearch']) {
        for (const market of ['intl', 'cn'] as const) {
          const mine = limits.providerDailyLimit(provider, market, env, stored.get(provider) ?? null, NOW);
          expect(mine, `${provider} ${market} ${JSON.stringify(env)}`).toBe(upstream.effectiveDailyLimit!(provider, market, env, NOW));
        }
      }
    }
  });
});

describe('createPrismaSystemStore.providerQuota', () => {
  const dbWith = (value: string | null) => {
    const keys: string[] = [];
    const db = { appConfig: { findUnique: async (args: { where: { key: string } }) => (keys.push(args.where.key), value === null ? null : { value }) } };
    return { keys, store: createPrismaSystemStore(db as never) };
  };

  it('reads the one AppConfig row ingest writes and parses it with the contract\u2019s parser', async () => {
    const stored = serializeProviderQuota([quotaSnapshot('activejobs', { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, resetAt: RESET_17D, state: 'exhausted' }), quotaSnapshot('activejobs:cn', { state: 'ok' })]);
    const { keys, store } = dbWith(stored);
    const quota = await store.providerQuota();
    expect(keys).toEqual([PROVIDER_QUOTA_CONFIG_KEY]);
    expect(PROVIDER_QUOTA_CONFIG_KEY).toBe('jobs.providerQuota.v1');
    expect([...quota.keys()]).toEqual(['activejobs', 'activejobs:cn']);
    expect(quota.get('activejobs')).toMatchObject({ plan: 'BASIC', requestsRemaining: 0, state: 'exhausted' });
  });

  it('no row, or a damaged one, is "nothing recorded" (never an error, never a made-up reading)', async () => {
    expect((await dbWith(null).store.providerQuota()).size).toBe(0);
    expect((await dbWith('{not json').store.providerQuota()).size).toBe(0);
    expect((await dbWith(JSON.stringify({ version: 2, providers: {} })).store.providerQuota()).size).toBe(0);
  });

  it('never writes: the store reads AppConfig with findUnique only', () => {
    const source = readFileSync(new URL('../system.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/appConfig\.(upsert|update|create|delete)/);
  });
});

describe('buildSystemStatus', () => {
  it('sorts the queue by dead items and totals them', async () => {
    const s = await buildSystemStatus(fakeSystemStore(), { brands: ['roboapply'], brandsServed: ['roboapply'], now: NOW, env: {} });
    expect(s.dayKey).toBe('2026-10-10');
    expect(s.dayComplete).toBe(false);
    expect(s.dayElapsedShare).toBe(0.5);
    expect(s.queue.deadTotal).toBe(3);
    expect(s.queue.kinds[0]!.kind).toBe('job.enrich');
    expect(s.asOf).toBe(NOW.toISOString());
  });

  it('providers: every source of the served brands, with or without a call today, merged with usage and the quota snapshot', async () => {
    const store = fakeSystemStore(
      fakeSystemData({
        // Only jsearch made calls today (the default usage row).
        quota: {
          activejobs: { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, resetAt: RESET_17D, state: 'exhausted', lastStatus: 429 },
          jsearch: { requestsLimit: 10_000, requestsRemaining: 9_773 },
        },
      }),
    );
    const s = await buildSystemStatus(store, { brands: ['roboapply'], brandsServed: ['roboapply'], now: NOW, env: {}, listSources: roboSources });
    expect(s.providers.map((p) => `${p.provider}|${p.state}`)).toEqual(['activejobs|exhausted', 'bank_robohire|ok', 'jsearch|ok']);
    expect(s.providers[0]).toMatchObject({ market: 'intl', calls: 0, limit: 0, plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, jobsLimit: null, jobsRemaining: null, daysToReset: 17, costModel: 'per_job' });
    expect(s.providers[2]).toEqual({
      provider: 'jsearch', market: 'intl', calls: 20, limit: 200, jobsReturned: 400, jobsNew: 50, errors: 0,
      plan: null, requestsLimit: 10_000, requestsRemaining: 9_773, jobsLimit: null, jobsRemaining: null, resetAt: null, daysToReset: null, observedAt: '2026-10-10T11:00:00.000Z',
      costModel: 'per_request', state: 'ok',
    });
    // The dead source is an alert the same day, and only that one.
    expect(s.alerts.filter((a) => a.key === 'provider_quota')).toEqual([{ key: 'provider_quota', brand: null, subject: 'activejobs', value: 0, level: 0, state: 'exhausted', daysToReset: 17 }]);
  });

  it('providers are platform-wide: the served brands decide the list, not the brand shown', async () => {
    const store = fakeSystemStore(fakeSystemData({ providers: [{ provider: 'bank_gohire:cn', calls: 3, jobsReturned: 181, jobsNew: 0, errors: 0 }] }));
    const lister: SourceLister = (brand, env) => (brand.id === 'goapply' ? goProviderSources(brand, env) : roboSources(brand, env));
    const shown = await buildSystemStatus(store, { brands: ['roboapply'], brandsServed: ['roboapply', 'goapply'], now: NOW, env: {}, listSources: lister });
    expect(shown.brands.map((b) => b.brand)).toEqual(['roboapply']);
    expect(shown.providers.map((p) => `${p.provider}|${p.market}`)).toEqual(['activejobs|intl', 'activejobs:cn|cn', 'bank_gohire:cn|cn', 'bank_robohire|intl', 'jsearch|intl']);
    expect(shown.providers.find((p) => p.provider === 'bank_gohire:cn')).toMatchObject({ calls: 3, jobsReturned: 181, costModel: 'free', state: 'ok' });
    // A deployment that serves RoboApply only lists no mainland source.
    const intlOnly = await buildSystemStatus(fakeSystemStore(), { brands: ['roboapply'], brandsServed: ['roboapply'], now: NOW, env: {}, listSources: lister });
    expect(intlOnly.providers.every((p) => p.market === 'intl')).toBe(true);
  });

  it('a mainland counter the operator opened is listed on a day without calls, including the day the plan dies', async () => {
    // GoApply's registry lists no search provider; its own searches may call Active Jobs DB once the mainland budget is open.
    const dead = { activejobs: { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, resetAt: RESET_17D, state: 'exhausted' as const, lastStatus: 429 } };
    const store = fakeSystemStore(fakeSystemData({ providers: [], quota: dead }));
    const lister: SourceLister = (brand, env) => (brand.id === 'goapply' ? [onSource('goapply', 'bank_gohire', 'bank'), onSource('goapply', 'user_import', 'import')] : roboSources(brand, env));
    const open = await buildSystemStatus(store, { brands: ['goapply'], brandsServed: ['goapply'], now: NOW, env: { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '20' }, listSources: lister });
    expect(open.providers.map((p) => `${p.provider}|${p.market}|${p.state}`)).toEqual(['activejobs:cn|cn|exhausted', 'bank_gohire:cn|cn|ok']);
    expect(open.providers[0]).toMatchObject({ calls: 0, limit: 0, plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, daysToReset: 17, costModel: 'per_job' });
    expect(open.alerts.filter((a) => a.key === 'provider_quota')).toEqual([{ key: 'provider_quota', brand: null, subject: 'activejobs:cn', value: 0, level: 0, state: 'exhausted', daysToReset: 17 }]);
    // Without the budget the stored reading alone creates no row.
    const closed = await buildSystemStatus(store, { brands: ['goapply'], brandsServed: ['goapply'], now: NOW, env: {}, listSources: lister });
    expect(closed.providers.map((p) => p.provider)).toEqual(['bank_gohire:cn']);
    expect(closed.alerts.filter((a) => a.key === 'provider_quota')).toEqual([]);
    // A deployment that serves RoboApply only has no mainland counter, whatever the setting.
    const intl = await buildSystemStatus(store, { brands: ['roboapply'], brandsServed: ['roboapply'], now: NOW, env: { INGEST_ACTIVEJOBS_CN_DAILY_CALLS: '20' }, listSources: lister });
    expect(intl.providers.map((p) => p.provider)).toEqual(['activejobs', 'bank_robohire', 'jsearch']);
  });

  it('with the real registry and nothing recorded: every source is listed and no quota number is made up', async () => {
    const s = await buildSystemStatus(fakeSystemStore(), { brands: ['roboapply', 'goapply'], brandsServed: ['roboapply', 'goapply'], now: NOW, env: {} });
    const keys = s.providers.map((p) => p.provider);
    expect(keys).toEqual(expect.arrayContaining(['activejobs', 'bank_robohire', 'jsearch', 'bank_gohire:cn']));
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
    for (const p of s.providers) {
      expect([p.plan, p.requestsLimit, p.requestsRemaining, p.jobsLimit, p.jobsRemaining, p.resetAt, p.daysToReset, p.observedAt], p.provider).toEqual([null, null, null, null, null, null, null, null]);
      expect(p.market).toBe(p.provider.endsWith(':cn') ? 'cn' : 'intl');
    }
    expect(s.providers.find((p) => p.provider === 'jsearch')).toMatchObject({ calls: 20, limit: 200, jobsReturned: 400, jobsNew: 50, costModel: 'per_request' });
    expect(s.alerts.filter((a) => a.key === 'provider_quota')).toEqual([]);
  });

  it('live at 03:30 UTC with an even ingest rate: no false ingest alert', async () => {
    const at0330 = new Date('2026-10-10T03:30:00Z');
    // 100 jobs a day, spread evenly: about 15 by 03:30.
    const byDay = [{ day: '2026-10-10', count: 15 }, ...Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${9 - i}`, count: 100 }))];
    const s = await buildSystemStatus(fakeSystemStore(fakeSystemData({ byDay, queue: [] })), { brands: ['roboapply'], brandsServed: ['roboapply'], now: at0330, env: {} });
    expect(s.alerts).toEqual([]);
    // Same even rate at 09:00 (past the quiet hours): 37 so far vs a level of 100 × 0.375 × 0.5 ≈ 19.
    const at0900 = new Date('2026-10-10T09:00:00Z');
    const later = [{ day: '2026-10-10', count: 37 }, ...byDay.slice(1)];
    const s2 = await buildSystemStatus(fakeSystemStore(fakeSystemData({ byDay: later, queue: [] })), { brands: ['roboapply'], brandsServed: ['roboapply'], now: at0900, env: {} });
    expect(s2.alerts).toEqual([]);
  });

  it('last_complete_day reads yesterday: counters, provider day, email and Assistant ranges', async () => {
    const store = fakeSystemStore(fakeSystemData({ queue: [] }));
    const s = await buildSystemStatus(store, { brands: ['roboapply'], brandsServed: ['roboapply'], now: new Date('2026-10-10T03:30:00Z'), env: {}, mode: 'last_complete_day' });
    expect(s).toMatchObject({ dayKey: '2026-10-09', dayComplete: true, dayElapsedShare: 1 });
    expect(new Set(store.reads.counterWindows)).toEqual(new Set(['2026-10-09T00:00:00.000Z']));
    expect(store.reads.providerDays).toEqual(['2026-10-09']);
    const day = '2026-10-09T00:00:00.000Z..2026-10-10T00:00:00.000Z';
    expect(store.reads.ranges.sort()).toEqual([`alertEmails:${day}`, `copilot:${day}`, `email:${day}`, `exhaustion:${day}`]);
  });
});

// ── Reports ───────────────────────────────────────────────────────────────

const job = (over: Partial<ReportJobRow> = {}): ReportJobRow => ({
  id: 'j1', title: 'Analyst', companyName: 'Acme', market: 'intl', visibility: 'public', sourceName: null, applyUrl: null,
  closedAt: null, archivedAt: null, closeReason: null, fraudFlags: null, ...over,
});
const at = (s: string) => new Date(s);

describe('reports helpers', () => {
  it('reads only the international scam rules from fraudFlags', () => {
    const flags = [
      { rule: 'intl_fee_required', evidence: 'Pay a $50 fee', at: '2026-10-09T00:00:00Z' },
      { rule: 'training_loan', evidence: '培训贷', at: '2026-10-09T00:00:00Z' },
      'junk',
    ];
    expect(intlScamFlags(flags)).toEqual([{ rule: 'intl_fee_required', evidence: 'Pay a $50 fee', at: '2026-10-09T00:00:00Z' }]);
    expect(intlScamFlags(null)).toEqual([]);
  });

  it('cn jobs reported only for fraud reasons are decided on /admin/fraud', () => {
    expect(reviewedElsewhere(job({ market: 'cn' }), ['scam', 'training_loan'])).toBe(true);
    expect(reviewedElsewhere(job({ market: 'cn' }), ['scam', 'expired'])).toBe(false);
    expect(reviewedElsewhere(job({ market: 'intl' }), ['scam'])).toBe(false);
  });

  it('reports newer than the last decision reopen the item; older ones stay resolved', () => {
    const decision: DecisionRow = { jobId: 'j1', decision: 'restore', at: at('2026-10-05T00:00:00Z'), by: 'a1', note: null, clearedRules: [] };
    const old = [{ jobId: 'j1', reasonCode: 'expired', note: null, createdAt: at('2026-10-04T00:00:00Z') }];
    expect(buildItem(job(), old, decision).open).toBe(false);
    const fresh = [...old, { jobId: 'j1', reasonCode: 'wrong_info', note: null, createdAt: at('2026-10-06T00:00:00Z') }];
    const b = buildItem(job(), fresh, decision);
    expect(b.open).toBe(true);
    expect(b.item.reportCount).toBe(1);
    expect(b.item.reasons).toEqual([{ reason: 'wrong_info', count: 1 }]);
    expect(b.item.lastDecision).toEqual({ decision: 'restore', at: '2026-10-05T00:00:00.000Z', by: 'a1', note: null });
  });

  it('a job the feed closed after reports is open until someone decides', () => {
    expect(buildItem(job({ closedAt: at('2026-10-05T00:00:00Z'), closeReason: 'reported' }), [], null).open).toBe(true);
  });

  it('keeps at most three notes, redacted and shortened', () => {
    const rows = ['a@b.co one', 'two', 'three', 'four'].map((note, i) => ({ jobId: 'j1', reasonCode: 'other', note, createdAt: at(`2026-10-0${i + 1}T00:00:00Z`) }));
    const { item } = buildItem(job(), rows, null);
    expect(item.notes).toHaveLength(3);
    expect(item.notes.join(' ')).not.toContain('a@b.co');
  });
});

function memoryReports(jobs: ReportJobRow[], reports: Array<{ jobId: string; reasonCode: string | null; note: string | null; createdAt: Date }>) {
  const decisions: DecisionRow[] = [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const store: ReportsStore = {
    reportedJobIds: async () => [...new Set(reports.map((r) => r.jobId))],
    closedReportedJobIds: async () => jobs.filter((j) => j.closeReason === 'reported').map((j) => j.id),
    flaggedIntlJobIds: async () => jobs.filter((j) => j.market === 'intl' && j.fraudFlags).map((j) => j.id),
    jobs: async (ids) => jobs.filter((j) => ids.includes(j.id)),
    reports: async (ids) => reports.filter((r) => ids.includes(r.jobId)),
    decisions: async (ids) => decisions.filter((d) => ids.includes(d.jobId)),
    loadJob: async (id) => jobs.find((j) => j.id === id) ?? null,
    updateJob: async (id, data) => {
      updates.push({ id, data });
      Object.assign(jobs.find((j) => j.id === id)!, data);
    },
    addDecision: async (row) => {
      decisions.push(row);
    },
  };
  return { store, decisions, updates };
}

const auditSink = () => {
  const rows: AdminAuditRow[] = [];
  const store: AdminAuditStore = { record: async (row) => void rows.push(row), list: async () => [] };
  return { store, rows };
};

describe('listReports / resolveReport', () => {
  it('lists open items newest first, filters by market, skips private imports', async () => {
    const { store } = memoryReports(
      [
        job({ id: 'a' }),
        job({ id: 'b', market: 'cn' }),
        job({ id: 'p', visibility: 'private' }),
        job({ id: 'f', fraudFlags: [{ rule: 'intl_pay_to_apply', evidence: 'Pay to apply', at: '2026-10-08T00:00:00Z' }] }),
      ],
      [
        { jobId: 'a', reasonCode: 'expired', note: null, createdAt: at('2026-10-07T00:00:00Z') },
        { jobId: 'b', reasonCode: 'expired', note: null, createdAt: at('2026-10-09T00:00:00Z') },
        { jobId: 'p', reasonCode: 'expired', note: null, createdAt: at('2026-10-09T00:00:00Z') },
      ],
    );
    expect((await listReports(store, {})).items.map((i) => i.id)).toEqual(['b', 'f', 'a']);
    expect((await listReports(store, { market: 'intl' })).items.map((i) => i.id)).toEqual(['f', 'a']);
    expect((await listReports(store, { status: 'resolved' })).items).toEqual([]);
  });

  it('restore reopens a job closed as reported, drops intl scam flags, and moves it to resolved', async () => {
    const flagged = job({ id: 'f', closedAt: at('2026-10-08T00:00:00Z'), closeReason: 'reported', fraudFlags: [{ rule: 'intl_pay_to_apply', evidence: 'Pay to apply', at: '2026-10-08T00:00:00Z' }, { rule: 'mlm', evidence: 'x', at: '2026-10-08T00:00:00Z' }] });
    const { store, updates } = memoryReports([flagged], [{ jobId: 'f', reasonCode: 'scam', note: null, createdAt: at('2026-10-08T00:00:00Z') }]);
    const audit = auditSink();
    const res = await resolveReport({ store, audit: audit.store, now: () => NOW }, 'f', { decision: 'restore', note: ' Looks fine ' }, 'admin1');
    expect(res).toEqual({ id: 'f', state: 'open', decision: 'restore' });
    expect(updates[0]!.data).toEqual({ closedAt: null, closeReason: null, fraudFlags: [{ rule: 'mlm', evidence: 'x', at: '2026-10-08T00:00:00Z' }] });
    expect(audit.rows[0]).toMatchObject({ adminId: 'admin1', subjectUserId: null, eventType: 'admin_report_resolved', payload: { jobId: 'f', decision: 'restore', note: 'Looks fine', clearedRules: ['intl_pay_to_apply'] } });
    expect((await listReports(store, {})).items).toEqual([]);
    expect((await listReports(store, { status: 'resolved' })).items.map((i) => i.id)).toEqual(['f']);
  });

  it('restore leaves archivedAt alone: a reported job that was also archived stays closed', async () => {
    const archived = job({ id: 'ar', closedAt: at('2026-10-08T00:00:00Z'), closeReason: 'reported', archivedAt: at('2026-10-09T00:00:00Z') });
    const { store, updates } = memoryReports([archived], [{ jobId: 'ar', reasonCode: 'scam', note: null, createdAt: at('2026-10-08T00:00:00Z') }]);
    const res = await resolveReport({ store, audit: auditSink().store, now: () => NOW }, 'ar', { decision: 'restore' }, 'admin1');
    expect(res.state).toBe('closed');
    expect(updates[0]!.data).toEqual({ closedAt: null, closeReason: null });
    expect(updates[0]!.data).not.toHaveProperty('archivedAt');
  });

  it('restore does not reopen a job that expired', async () => {
    const { store, updates } = memoryReports([job({ id: 'e', closedAt: at('2026-10-01T00:00:00Z'), closeReason: 'expired' })], [{ jobId: 'e', reasonCode: 'expired', note: null, createdAt: at('2026-10-02T00:00:00Z') }]);
    const res = await resolveReport({ store, audit: auditSink().store, now: () => NOW }, 'e', { decision: 'restore' }, 'admin1');
    expect(res.state).toBe('closed');
    expect(updates).toEqual([]);
  });

  it('close leaves an already-closed job as it is', async () => {
    const { store, updates, decisions } = memoryReports([job({ id: 'c', closedAt: at('2026-10-01T00:00:00Z'), closeReason: 'reported' })], []);
    await resolveReport({ store, audit: auditSink().store, now: () => NOW }, 'c', { decision: 'close' }, 'admin1');
    expect(updates).toEqual([]);
    expect(decisions).toHaveLength(1);
  });

  it('cn fraud reports go to /admin/fraud (409), private jobs are 404', async () => {
    const { store } = memoryReports([job({ id: 'cn', market: 'cn' }), job({ id: 'p', visibility: 'private' })], [{ jobId: 'cn', reasonCode: 'training_loan', note: null, createdAt: at('2026-10-08T00:00:00Z') }]);
    await expect(resolveReport({ store, audit: auditSink().store }, 'cn', { decision: 'close' }, 'admin1')).rejects.toMatchObject({ code: 'conflict' });
    await expect(resolveReport({ store, audit: auditSink().store }, 'p', { decision: 'close' }, 'admin1')).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ── Decisions in RAJobReview (SR-74-2) ────────────────────────────────────

describe('report decisions are RAJobReview rows', () => {
  const FLAG = { rule: 'intl_pay_to_apply', evidence: 'Pay to apply', at: '2026-10-08T00:00:00Z' };
  const jobRow = (over: Record<string, unknown>) => ({
    title: 'Data analyst', companyName: 'Acme', market: 'intl', visibility: 'public', sourceName: null, applyUrl: null, closedAt: null, archivedAt: null, closeReason: null, fraudFlags: null, isCanonical: true,
    ...over,
  });

  function seeded() {
    const fake = createFakePrisma({
      timestampFields: [],
      seed: {
        rAJob: [
          jobRow({ id: 'open1', fraudFlags: [FLAG, { rule: 'intl_fee_required', evidence: 'Fee', at: '2026-10-08T00:00:00Z' }, { rule: 'mlm', evidence: 'x', at: '2026-10-08T00:00:00Z' }] }),
          jobRow({ id: 'bad1' }),
          jobRow({ id: 'shut1', closedAt: at('2026-10-08T00:00:00Z'), closeReason: 'reported', fraudFlags: [FLAG] }),
          jobRow({ id: 'old1' }),
        ],
        rAJobInteraction: [
          { id: 'i1', userId: 'u1', jobId: 'bad1', kind: 'report', reasonCode: 'expired', detail: null, createdAt: at('2026-10-09T00:00:00Z') },
          { id: 'i2', userId: 'u2', jobId: 'shut1', kind: 'report', reasonCode: 'scam', detail: null, createdAt: at('2026-10-08T00:00:00Z') },
          { id: 'i3', userId: 'u3', jobId: 'old1', kind: 'report', reasonCode: 'expired', detail: null, createdAt: at('2026-09-01T00:00:00Z') },
          // A decision made before RAJobReview existed.
          { id: 'i4', userId: 'admin0', jobId: 'old1', kind: ADMIN_REVIEW_KIND, reasonCode: 'restore', detail: { note: 'Checked the posting' }, createdAt: at('2026-09-02T00:00:00Z') },
        ],
        rAJobReview: [],
      },
    });
    // The fake has no groupBy: job ids with reports, most recently reported first.
    Object.assign(fake.rAJobInteraction as object, {
      groupBy: async ({ where, take }: { where: { kind: string }; take: number }) => {
        const latest = new Map<string, number>();
        for (const r of fake.$rows('rAJobInteraction')) {
          if (r.kind !== where.kind) continue;
          latest.set(r.jobId as string, Math.max(latest.get(r.jobId as string) ?? 0, (r.createdAt as Date).getTime()));
        }
        return [...latest.entries()].sort((a, b) => b[1] - a[1]).slice(0, take).map(([jobId]) => ({ jobId }));
      },
    });
    return { fake, store: createPrismaReportsStore(fake as never) };
  }

  it('keep, close and restore write one RAJobReview row each, with the cleared scam rules on restore; no new admin_review interaction', async () => {
    const { fake, store } = seeded();
    const audit = auditSink();
    const deps = { store, audit: audit.store, now: () => NOW };

    // Keep: an open job with scam signs stays open; its international scam flags are cleared.
    expect(await resolveReport(deps, 'open1', { decision: 'restore', note: 'Real employer' }, 'admin1')).toEqual({ id: 'open1', state: 'open', decision: 'restore' });
    // Close.
    expect(await resolveReport(deps, 'bad1', { decision: 'close' }, 'admin1')).toEqual({ id: 'bad1', state: 'closed', decision: 'close' });
    // Restore: a job the feed closed after reports opens again.
    expect(await resolveReport(deps, 'shut1', { decision: 'restore' }, 'admin2')).toEqual({ id: 'shut1', state: 'open', decision: 'restore' });

    const reviews = fake.$rows('rAJobReview').map(({ id: _id, ...r }) => r);
    expect(reviews).toEqual([
      { jobId: 'open1', decision: 'restore', note: 'Real employer', by: 'admin1', at: NOW, clearedRules: ['intl_fee_required', 'intl_pay_to_apply'] },
      { jobId: 'bad1', decision: 'close', note: null, by: 'admin1', at: NOW, clearedRules: [] },
      { jobId: 'shut1', decision: 'restore', note: null, by: 'admin2', at: NOW, clearedRules: ['intl_pay_to_apply'] },
    ]);
    // The interim interaction rows are read-only: none was added.
    expect(fake.$rows('rAJobInteraction').filter((r) => r.kind === ADMIN_REVIEW_KIND).map((r) => r.id)).toEqual(['i4']);
    // The jobs changed as decided; a non-international flag is left alone.
    const jobs = Object.fromEntries(fake.$rows('rAJob').map((r) => [r.id as string, r]));
    expect(jobs.open1!.fraudFlags).toEqual([{ rule: 'mlm', evidence: 'x', at: '2026-10-08T00:00:00Z' }]);
    expect(jobs.bad1).toMatchObject({ closedAt: NOW, closeReason: 'reported' });
    expect(jobs.shut1).toMatchObject({ closedAt: null, closeReason: null });
    // One audit row per decision.
    expect(audit.rows.map((r) => [r.adminId, r.eventType, r.payload.jobId, r.payload.decision])).toEqual([
      ['admin1', 'admin_report_resolved', 'open1', 'restore'],
      ['admin1', 'admin_report_resolved', 'bad1', 'close'],
      ['admin2', 'admin_report_resolved', 'shut1', 'restore'],
    ]);
  });

  it('the list shows the latest decision from either source', async () => {
    const { fake, store } = seeded();
    const deps = { store, audit: auditSink().store, now: () => NOW };
    // old1 has only the pre-RAJobReview decision.
    const before = (await listReports(store, { status: 'resolved' })).items;
    expect(before.map((i) => [i.id, i.lastDecision])).toEqual([['old1', { decision: 'restore', at: '2026-09-02T00:00:00.000Z', by: 'admin0', note: 'Checked the posting' }]]);

    // A newer RAJobReview row wins over the old interaction row.
    await resolveReport(deps, 'old1', { decision: 'close', note: 'Gone now' }, 'admin1');
    const after = (await listReports(store, { status: 'resolved' })).items.find((i) => i.id === 'old1')!;
    expect(after.lastDecision).toEqual({ decision: 'close', at: NOW.toISOString(), by: 'admin1', note: 'Gone now' });
    expect(after.state).toBe('closed');

    // An old interaction row that is newer than the review row wins too (latest by time, not by table).
    fake.$rows('rAJobInteraction').push({ id: 'i5', userId: 'admin0', jobId: 'bad1', kind: ADMIN_REVIEW_KIND, reasonCode: 'close', detail: null, createdAt: at('2026-10-11T00:00:00Z') });
    fake.$rows('rAJobReview').push({ id: 'r9', jobId: 'bad1', decision: 'restore', note: null, by: 'admin1', at: at('2026-10-09T12:00:00Z'), clearedRules: [] });
    const bad = (await listReports(store, { status: 'resolved' })).items.find((i) => i.id === 'bad1')!;
    expect(bad.lastDecision).toMatchObject({ decision: 'close', by: 'admin0', at: '2026-10-11T00:00:00.000Z' });
  });

  it('a report made after a keep reopens the item for review (the decision is not lost)', async () => {
    const { fake, store } = seeded();
    await resolveReport({ store, audit: auditSink().store, now: () => NOW }, 'shut1', { decision: 'restore' }, 'admin1');
    expect((await listReports(store, {})).items.map((i) => i.id)).not.toContain('shut1');
    fake.$rows('rAJobInteraction').push({ id: 'i6', userId: 'u9', jobId: 'shut1', kind: 'report', reasonCode: 'scam', detail: null, createdAt: new Date(NOW.getTime() + 60_000) });
    const open = (await listReports(store, {})).items.find((i) => i.id === 'shut1')!;
    expect(open.reportCount).toBe(1);
    expect(open.lastDecision).toMatchObject({ decision: 'restore', by: 'admin1' });
  });

  it('a second keep on the same job still records the rules the first keep cleared', async () => {
    const { fake, store } = seeded();
    const later = (ms: number) => new Date(NOW.getTime() + ms);
    const restores = () => fake.$rows('rAJobReview').filter((r) => r.jobId === 'open1' && r.decision === 'restore').sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());

    // First keep: both international rules are flagged and cleared.
    await resolveReport({ store, audit: auditSink().store, now: () => NOW }, 'open1', { decision: 'restore' }, 'admin1');
    expect(restores().map((r) => r.clearedRules)).toEqual([['intl_fee_required', 'intl_pay_to_apply']]);
    expect(intlScamFlags(fake.$rows('rAJob').find((r) => r.id === 'open1')!.fraudFlags)).toEqual([]);

    // A new report reopens the item; the job has no scam flags left.
    fake.$rows('rAJobInteraction').push({ id: 'i7', userId: 'u9', jobId: 'open1', kind: 'report', reasonCode: 'scam', detail: null, createdAt: later(60_000) });
    expect((await listReports(store, {})).items.map((i) => i.id)).toContain('open1');

    // Second keep: nothing is flagged now, yet the newest restore row carries the first row's rules.
    const audit = auditSink();
    await resolveReport({ store, audit: audit.store, now: () => later(120_000) }, 'open1', { decision: 'restore' }, 'admin2');
    expect(restores().map((r) => r.clearedRules)).toEqual([['intl_fee_required', 'intl_pay_to_apply'], ['intl_fee_required', 'intl_pay_to_apply']]);
    expect(audit.rows[0]!.payload).toMatchObject({ decision: 'restore', clearedRules: ['intl_fee_required', 'intl_pay_to_apply'] });

    // A close in between does not lose them either, and a close row itself records none.
    await resolveReport({ store, audit: auditSink().store, now: () => later(180_000) }, 'open1', { decision: 'close' }, 'admin1');
    await resolveReport({ store, audit: auditSink().store, now: () => later(240_000) }, 'open1', { decision: 'restore' }, 'admin1');
    const rows = fake.$rows('rAJobReview').filter((r) => r.jobId === 'open1').sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());
    expect(rows.map((r) => [r.decision, r.clearedRules])).toEqual([
      ['restore', ['intl_fee_required', 'intl_pay_to_apply']],
      ['restore', ['intl_fee_required', 'intl_pay_to_apply']],
      ['close', []],
      ['restore', ['intl_fee_required', 'intl_pay_to_apply']],
    ]);
  });

  it('clearedRuleSet: the rules flagged now plus earlier restores, sorted, no repeats; close and old rows add nothing', () => {
    const row = (decision: 'close' | 'restore', clearedRules: string[]): DecisionRow => ({ jobId: 'j', decision, at: NOW, by: 'a', note: null, clearedRules });
    expect(clearedRuleSet([], [])).toEqual([]);
    expect(clearedRuleSet(['intl_pay_to_apply'], [])).toEqual(['intl_pay_to_apply']);
    expect(clearedRuleSet(['intl_pay_to_apply'], [row('restore', ['intl_fee_required', 'intl_pay_to_apply']), row('close', ['x']), row('restore', [])])).toEqual(['intl_fee_required', 'intl_pay_to_apply']);
  });
});

// ── Does "Keep" hold? (INT-08 ↔ INT-05) ───────────────────────────────────

describe('Keep holds only when the feed reads the decisions', () => {
  function feedSources(dir: URL): string {
    return readdirSync(dir, { withFileTypes: true })
      .map((e) => {
        if (e.isDirectory()) return feedSources(new URL(`${e.name}/`, dir));
        return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? readFileSync(new URL(e.name, dir), 'utf8') : '';
      })
      .join('\n');
  }

  it('KEEP_DECISION_HOLDS says what the tree does', () => {
    // The three-report rule lives in features/feed. A kept job stays open only
    // when that code counts reports made after the job's latest RAJobReview row.
    const feedReadsReviews = /rAJobReview|"RAJobReview"/.test(feedSources(new URL('../../feed/', import.meta.url)));
    expect(
      KEEP_DECISION_HOLDS,
      feedReadsReviews
        ? 'features/feed reads RAJobReview now: set KEEP_DECISION_HOLDS = true in features/admin/reports.ts (the console then says a kept job stays open).'
        : 'features/feed does not read RAJobReview: KEEP_DECISION_HOLDS must stay false (one new report can still close a kept job).',
    ).toBe(feedReadsReviews);
  });

  it('the list tells the console', async () => {
    const { store } = memoryReports([], []);
    expect((await listReports(store, {})).keepHolds).toBe(KEEP_DECISION_HOLDS);
  });
});

// ── Costs ─────────────────────────────────────────────────────────────────

describe('costs', () => {
  it('defaults to the last 30 days and caps the span', () => {
    const r = resolveCostRange({}, NOW);
    expect(r.from).toBe('2026-09-11');
    expect(r.to).toBe('2026-10-10');
    expect(r.toExclusive.toISOString()).toBe('2026-10-11T00:00:00.000Z');
    expect(() => resolveCostRange({ from: '2026-10-05', to: '2026-10-01' }, NOW)).toThrow();
    expect(() => resolveCostRange({ from: '2026-01-01', to: '2026-10-01' }, NOW)).toThrow();
  });

  it('marks platform SKUs, sorts newest day first, totals; CSV is formula-safe', async () => {
    const data = await getCosts(
      {
        costRows: async () => [
          { day: '2026-10-08', sku: 'ra_job_enrich', brand: 'roboapply', costUsd: 2, units: 10, rows: 10, unpricedRows: 0 },
          { day: '2026-10-09', sku: '=cmd', brand: 'goapply', costUsd: 0.5, units: 1, rows: 1, unpricedRows: 1 },
        ],
      },
      { from: '2026-10-01', to: '2026-10-09' },
      NOW,
    );
    expect(data.rows.map((r) => [r.day, r.sku, r.platform])).toEqual([
      ['2026-10-09', '=cmd', false],
      ['2026-10-08', 'ra_job_enrich', true],
    ]);
    expect(data.totals).toEqual({ costUsd: 2.5, units: 11, rows: 11 });
    expect(costsCsv(data)).toContain("2026-10-09,'=cmd,goapply,false,0.5,1,1,1");
  });
});

// ── Assistant feedback ────────────────────────────────────────────────────

describe('listAdminFeedback', () => {
  const row = (i: number, value: 'up' | 'down') => ({ messageId: `m${i}`, threadId: 't', userId: 'u1', value, note: null, createdAt: '2026-10-09T00:00:00.000Z' });

  it('filters by value across copilot pages and continues after the last row shown', async () => {
    const pages: Record<string, { items: ReturnType<typeof row>[]; cursor: string | null }> = {
      start: { items: Array.from({ length: 30 }, (_, i) => row(i, i % 2 ? 'down' : 'up')), cursor: 'm29' },
      m29: { items: Array.from({ length: 30 }, (_, i) => row(30 + i, i % 2 ? 'down' : 'up')), cursor: null },
    };
    const store: FeedbackStore = {
      list: async ({ cursor }) => pages[cursor ?? 'start']!,
      context: async () => [],
      guardHits: async () => new Map(),
      userNames: async () => new Map(),
    };
    const res = await listAdminFeedback(store, { value: 'down' });
    expect(res.items).toHaveLength(30);
    expect(res.items.every((i) => i.value === 'down')).toBe(true);
    expect(res.cursor).toBeNull();
    expect(res.items[0]!.guardHits).toBeNull();
  });

  it('redacts the person name and contact details in the excerpt', async () => {
    const store: FeedbackStore = {
      list: async () => ({ items: [{ ...row(1, 'down'), note: 'Mei Lin here, mei@example.com' }], cursor: null }),
      context: async () => [
        { id: 'm0', role: 'user', content: 'I am Mei Lin, email mei@example.com' },
        { id: 'tool', role: 'tool', content: '{"raw":true}' },
        { id: 'm1', role: 'assistant', content: 'x'.repeat(500) },
      ],
      guardHits: async () => new Map([['m1', 2]]),
      userNames: async () => new Map([['u1', 'Mei Lin']]),
    };
    const [item] = (await listAdminFeedback(store, {})).items;
    expect(item!.note).not.toMatch(/Mei Lin|mei@example\.com/);
    expect(item!.excerpt.map((e) => e.role)).toEqual(['user', 'assistant']);
    expect(item!.excerpt[0]!.text).not.toMatch(/Mei Lin|mei@example\.com/);
    expect(item!.excerpt[1]!.text.length).toBeLessThanOrEqual(400);
    expect(item!.guardHits).toBe(2);
  });
});

// ── Audit ─────────────────────────────────────────────────────────────────

describe('writeAdminAudit (RAAdminAuditLog)', () => {
  function table() {
    const fake = createFakePrisma({ seed: { rAAdminAuditLog: [] }, timestampFields: ['createdAt'] });
    return { fake, store: createPrismaAuditStore(fake as never) };
  }

  it('writes one row with the action, the admin, the subject user and the payload', async () => {
    const { fake, store } = table();
    expect(await writeAdminAudit(store, { adminId: 'admin1', subjectUserId: 'u1', eventType: 'admin_override_created', payload: { key: 'bucket:tailor', value: 5, reason: 'beta' } })).toBe('subject');
    expect(await writeAdminAudit(store, { adminId: 'admin1', eventType: 'admin_work_item_retried', payload: { workItemId: 'w1' } })).toBe('admin');
    expect(fake.$rows('rAAdminAuditLog').map(({ id: _id, createdAt: _at, ...r }) => r)).toEqual([
      { adminId: 'admin1', subjectUserId: 'u1', eventType: 'admin_override_created', payload: { key: 'bucket:tailor', value: 5, reason: 'beta' } },
      { adminId: 'admin1', subjectUserId: null, eventType: 'admin_work_item_retried', payload: { workItemId: 'w1' } },
    ]);
  });

  it('needs no seeker profile: an admin or a subject without one is still audited', async () => {
    // The fake has no seekerProfile rows and the store never asks for one.
    const { fake, store } = table();
    expect(await writeAdminAudit(store, { adminId: 'ops_only_admin', subjectUserId: 'deleted_user', eventType: 'e', payload: {} })).toBe('subject');
    expect(fake.$rows('rAAdminAuditLog')).toHaveLength(1);
  });

  it('a store failure is logged and swallowed (never throws, the action stands)', async () => {
    const fake = createFakePrisma({ seed: { rAAdminAuditLog: [] }, failOn: { 'rAAdminAuditLog.create': new Error('relation "RAAdminAuditLog" does not exist') } });
    const { logger } = await import('../../../services/LoggerService.js');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    try {
      await expect(writeAdminAudit(createPrismaAuditStore(fake as never), { adminId: 'a', subjectUserId: 'u1', eventType: 'admin_override_deleted', payload: { overrideId: 'ov1' } })).resolves.toBe('log_only');
      expect(error).toHaveBeenCalledWith('ADMIN', 'audit row failed', expect.objectContaining({ eventType: 'admin_override_deleted', error: expect.stringContaining('RAAdminAuditLog') }));
      // The action is still on record in the server log, with who and about whom.
      expect(warn).toHaveBeenCalledWith('ADMIN', expect.any(String), expect.objectContaining({ eventType: 'admin_override_deleted', adminId: 'a', subjectUserId: 'u1', overrideId: 'ov1' }));
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('still accepts the older profile-keyed store shape (test doubles of other areas)', async () => {
    const writes: Array<[string, Record<string, unknown>]> = [];
    const legacy: LegacyAuditStore = { profileIdFor: async (u) => ({ u1: 'sp_u1', admin1: 'sp_a' } as Record<string, string>)[u] ?? null, write: async (p, _e, payload) => void writes.push([p, payload]) };
    expect(await writeAdminAudit(legacy, { adminId: 'admin1', subjectUserId: 'u1', eventType: 'e', payload: { k: 1 } })).toBe('subject');
    expect(await writeAdminAudit(legacy, { adminId: 'admin1', subjectUserId: 'ghost', eventType: 'e', payload: {} })).toBe('admin');
    expect(await writeAdminAudit(legacy, { adminId: 'nobody', eventType: 'e', payload: {} })).toBe('log_only');
    expect(writes).toEqual([
      ['sp_u1', { k: 1, adminId: 'admin1', subjectUserId: 'u1' }],
      ['sp_a', { adminId: 'admin1', subjectUserId: 'ghost' }],
    ]);
    const failing: LegacyAuditStore = { profileIdFor: async () => 'sp', write: async () => { throw new Error('db down'); } };
    expect(await writeAdminAudit(failing, { adminId: 'a', eventType: 'e', payload: {} })).toBe('log_only');
    expect(await listAdminAudit(legacy, {})).toEqual({ items: [], cursor: null });
  });
});

describe('listAdminAudit (the System panel reads RAAdminAuditLog)', () => {
  it('newest first, in pages, filtered by action, person or admin', async () => {
    const fake = createFakePrisma({ seed: { rAAdminAuditLog: [] } });
    const store = createPrismaAuditStore(fake as never);
    const base = Date.parse('2026-10-01T00:00:00Z');
    for (let i = 0; i < AUDIT_PAGE_SIZE + 5; i++) {
      fake.$rows('rAAdminAuditLog').push({
        id: `al_${String(i).padStart(3, '0')}`,
        adminId: i % 2 ? 'admin2' : 'admin1',
        subjectUserId: i % 5 === 0 ? 'u1' : null,
        eventType: i % 5 === 0 ? 'admin_override_created' : 'admin_report_resolved',
        payload: { n: i },
        // Two rows share each timestamp, so the cursor must break ties on id.
        createdAt: new Date(base + Math.floor(i / 2) * 60_000),
      });
    }
    const first = await listAdminAudit(store, {});
    expect(first.items).toHaveLength(AUDIT_PAGE_SIZE);
    expect(first.items[0]).toEqual({ id: 'al_054', adminId: 'admin1', subjectUserId: null, eventType: 'admin_report_resolved', details: 'n: 54', createdAt: new Date(base + 27 * 60_000).toISOString() });
    expect(first.cursor).not.toBeNull();
    const second = await listAdminAudit(store, { cursor: first.cursor! });
    expect(second.cursor).toBeNull();
    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(ids).toHaveLength(AUDIT_PAGE_SIZE + 5);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort().reverse());

    expect((await listAdminAudit(store, { subjectUserId: 'u1' })).items.every((i) => i.eventType === 'admin_override_created')).toBe(true);
    expect((await listAdminAudit(store, { eventType: 'admin_override_created' })).items).toHaveLength(11);
    expect((await listAdminAudit(store, { adminId: 'admin2', eventType: 'admin_override_created' })).items.map((i) => i.id)).toEqual(['al_045', 'al_035', 'al_025', 'al_015', 'al_005']);
    expect((await listAdminAudit(store, { cursor: 'not-a-cursor' })).items).toHaveLength(AUDIT_PAGE_SIZE);
  });

  it('details: one line, ids of the row left out, contact details redacted, shortened', () => {
    expect(auditDetails({ adminId: 'a', subjectUserId: 'u', jobId: 'j1', decision: 'close', note: null, before: { closedAt: null } })).toBe('jobId: j1 · decision: close · before: {"closedAt":null}');
    expect(auditDetails({ reason: 'asked by jane@example.com' })).not.toContain('jane@example.com');
    expect(auditDetails({ note: 'x'.repeat(900) }).length).toBeLessThanOrEqual(400);
    expect(auditDetails({})).toBe('');
  });
});

// ── Health email ──────────────────────────────────────────────────────────

describe('daily health email', () => {
  const ctx = (brand: 'roboapply' | 'goapply') => ({ name: 'jobs-maintain', brand: getBrand(brand), budget: createBudget(60_000), now: NOW });

  it('parses ADMIN_ALERT_EMAILS', () => {
    expect(parseAdminEmails(' Ops@Example.com, bad, ops@example.com;dev@example.com ')).toEqual(['ops@example.com', 'dev@example.com']);
    expect(parseAdminEmails(undefined)).toEqual([]);
  });

  it('skips with no recipients and sends nothing on a quiet day', async () => {
    const send = vi.fn();
    expect(await createAdminHealthTask({ env: {}, send, store: fakeSystemStore() })(ctx('roboapply'))).toEqual({ skipped: 'no_recipients' });
    const quiet = fakeSystemStore(fakeSystemData({ queue: [] }));
    expect(await createAdminHealthTask({ env: { ADMIN_ALERT_EMAILS: 'ops@example.com' }, send, store: quiet })(ctx('roboapply'))).toEqual({ processed: 0, alerts: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('emails each recipient the brand alerts; platform alerts only from the first served brand', async () => {
    const data = fakeSystemData({
      queue: [{ kind: 'job.enrich', queued: 0, leased: 0, failed: 0, dead: 150, oldestQueuedAt: null }],
      email: { sent: 0, failed: 80 },
    });
    const send = vi.fn(async () => ({ status: 'sent' as const }));
    const env = { ADMIN_ALERT_EMAILS: 'ops@example.com,dev@example.com', ALLOWED_BRANDS: 'roboapply,goapply' };
    const task = createAdminHealthTask({ env, send, store: fakeSystemStore(data), origin: () => 'https://app.example' });

    const first = await task(ctx('roboapply'));
    expect(first).toEqual({ processed: 2, alerts: 2, recipients: 2 });
    const call = send.mock.calls[0]![0] as { to: string; params: { alerts: Array<{ key: string }>; systemUrl: string } };
    expect(call.to).toBe('ops@example.com');
    expect(call.params.alerts.map((a) => a.key)).toEqual(['dead_items', 'email_failures']);
    expect(call.params.systemUrl).toBe('https://app.example/admin/system');

    send.mockClear();
    await task(ctx('goapply'));
    const second = send.mock.calls[0]![0] as { params: { alerts: Array<{ key: string; brand: string | null }> } };
    expect(second.params.alerts.map((a) => a.key)).toEqual(['email_failures']);
  });

  it('at 03:30 UTC it checks the whole of yesterday: an even ingest rate is quiet, a budget used up the evening before is reported', async () => {
    // Yesterday (10-09) and the 7 days before it: 100 a day. Today so far: 15 (would trip a today-vs-average rule).
    const byDay = [
      { day: '2026-10-10', count: 15 },
      { day: '2026-10-09', count: 100 },
      ...Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-0${8 - i}`, count: 100 })),
    ];
    const store = fakeSystemStore(fakeSystemData({ byDay, queue: [], email: { sent: 10, failed: 0 }, counters: { 'budget:llm:enrich:intl': 8000 } }));
    const send = vi.fn(async () => ({ status: 'sent' as const }));
    const task = createAdminHealthTask({ env: { ADMIN_ALERT_EMAILS: 'ops@example.com', ENRICH_DAILY_JOBS: '8000', ALLOWED_BRANDS: 'roboapply' }, send, store, origin: () => 'https://app.example' });
    const res = await task({ ...ctx('roboapply'), now: new Date('2026-10-10T03:30:00Z') });
    expect(res).toEqual({ processed: 1, alerts: 1, recipients: 1 });
    const call = send.mock.calls[0]![0] as { params: { dayKey: string; alerts: Array<{ key: string }> } };
    expect(call.params.dayKey).toBe('2026-10-09');
    expect(call.params.alerts.map((a) => a.key)).toEqual(['enrich_budget']);
    expect(new Set(store.reads.counterWindows)).toEqual(new Set(['2026-10-09T00:00:00.000Z']));
  });

  it('renders counts only, with the alert level, in plain words', () => {
    const body = adminHealthTemplate.render({
      brand: getBrand('roboapply'),
      t: ((k: string) => k) as never,
      origin: 'https://x',
      params: { brandName: 'Brand', dayKey: '2026-10-10', alerts: [{ key: 'dead_items', brand: null, subject: null, value: 150, level: 100 }], systemUrl: 'https://x/admin/system' },
    });
    expect(body.subject).toBe('Brand health, 2026-10-10: 1 metric needs a look');
    expect(body.bodyText).toContain(alertLine({ key: 'dead_items', brand: null, subject: null, value: 150, level: 100 }));
    expect(body.bodyText).not.toMatch(/threshold|pipeline|funnel/i);
  });

  it('provider quota lines: one plain line per state, the reset only when the provider stated it', () => {
    const hit = (state: 'exhausted' | 'not_subscribed' | 'unauthorized' | 'low', daysToReset: number | null = null, subject = 'activejobs') => ({ key: 'provider_quota' as const, brand: null, subject, value: 0, level: 0, state, daysToReset });
    expect(alertLine(hit('exhausted', 17))).toBe('activejobs: monthly quota used up, resets in 17 days');
    expect(alertLine(hit('exhausted', 1))).toBe('activejobs: monthly quota used up, resets in 1 day');
    expect(alertLine(hit('exhausted'))).toBe('activejobs: monthly quota used up');
    expect(alertLine(hit('not_subscribed', 17))).toBe('activejobs: not subscribed');
    expect(alertLine(hit('unauthorized'))).toBe('activejobs: key rejected');
    expect(alertLine(hit('low', 3, 'jsearch'))).toBe('jsearch: under 10% of the monthly quota left');
    expect(alertLine(hit('exhausted', 17, 'activejobs:cn'))).toBe('activejobs:cn: monthly quota used up, resets in 17 days');
    // The other alert lines keep their form.
    expect(alertLine({ key: 'provider_budget', brand: null, subject: 'jsearch', value: 180, level: 180 })).toBe('Job provider calls used most of the daily limit (jsearch): 180 (alert level 180)');
  });

  it('an exhausted provider is one provider_quota alert in the status and one line in that day\u2019s email; an ok provider adds none', async () => {
    const quota = {
      activejobs: { plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, resetAt: RESET_17D, state: 'exhausted' as const },
      jsearch: { requestsLimit: 10_000, requestsRemaining: 9_773 },
    };
    const send = vi.fn(async () => ({ status: 'sent' as const }));
    const env = { ADMIN_ALERT_EMAILS: 'ops@example.com', ALLOWED_BRANDS: 'roboapply,goapply' };
    const task = createAdminHealthTask({ env, send, store: fakeSystemStore(fakeSystemData({ queue: [], quota })), origin: () => 'https://app.example' });
    expect(await task(ctx('roboapply'))).toEqual({ processed: 1, alerts: 1, recipients: 1 });
    const call = send.mock.calls[0]![0] as { params: Parameters<typeof adminHealthTemplate.render>[0]['params'] };
    expect(call.params.alerts).toEqual([{ key: 'provider_quota', brand: null, subject: 'activejobs', value: 0, level: 0, state: 'exhausted', daysToReset: 17 }]);
    const body = adminHealthTemplate.render({ brand: getBrand('roboapply'), t: ((k: string) => k) as never, origin: 'https://x', params: call.params });
    // The email covers the last complete UTC day; the quota line is the provider's reading as it stands now.
    expect(body.subject).toBe('RoboApply health, 2026-10-09: 1 metric needs a look');
    expect(body.bodyText.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- activejobs: monthly quota used up, resets in 17 days']);
    expect(body.bodyHtml).toContain('<li>activejobs: monthly quota used up, resets in 17 days</li>');
    // Provider alerts are platform-wide: the second served brand does not repeat them.
    send.mockClear();
    expect(await task(ctx('goapply'))).toEqual({ processed: 0, alerts: 0 });
    expect(send).not.toHaveBeenCalled();
    // The same day without the dead source: nothing to send.
    const quiet = createAdminHealthTask({ env, send, store: fakeSystemStore(fakeSystemData({ queue: [], quota: { jsearch: quota.jsearch } })) });
    expect(await quiet(ctx('roboapply'))).toEqual({ processed: 0, alerts: 0 });
  });
});

// ── Safety view ───────────────────────────────────────────────────────────

describe('toSafetyView', () => {
  it('shows labels and a re-redacted excerpt, never more than stored', () => {
    const v = toSafetyView({
      id: 's1', brand: 'goapply', surface: 'copilot', direction: 'input', verdict: 'block', provider: 'keyword', createdAt: NOW,
      matched: { reason: 'politics', labels: ['politics', 3], excerpt: 'call 13812345678 now', excerptAnchor: 'hit', finalScan: true, textSha256: 'abc' },
    });
    expect(v.labels).toEqual(['politics']);
    expect(v.excerpt).not.toContain('13812345678');
    expect(v).not.toHaveProperty('textSha256');
    expect(v.finalScan).toBe(true);
  });
});

// ── Limits (join J3: re-exports of the owning areas, no copies) ───────────

describe('limits come from the owning areas (J3)', () => {
  it('re-exports the owners\u2019 readers, so there is one definition per limit', () => {
    expect(limits.scoreDailyBudget).toBe(scoreDailyBudget);
    expect(limits.scoreCounterKeys).toBe(scoreCounterKeys);
    expect(limits.copilotDailyBudgetUsd).toBe(copilotDailyBudgetUsd);
    expect(limits.dailyCallLimit).toBe(dailyCallLimit);
    const src = readFileSync(new URL('../limits.ts', import.meta.url), 'utf8');
    expect(src).toContain("export { scoreDailyBudget, scoreCounterKeys } from '../match/index.js';");
    expect(src).toContain("export { copilotDailyBudgetUsd } from '../copilot/index.js';");
    expect(src).toContain("export { dailyCallLimit } from '../jobs/ingest/index.js';");
    // system.ts uses only those names (plus the enrich readers).
    const system = readFileSync(new URL('../system.ts', import.meta.url), 'utf8');
    expect(system).toContain("import { FEED_MIN_MONTHLY_JOBS, copilotDailyBudgetUsd, enrichCounterKey, enrichDailyLimit, mainlandCallBudget, providerDailyLimit, quotaReserve, scoreCounterKeys, scoreDailyBudget } from './limits.js';");
    // The provider limit is built on the ingest area's readers, not on a copy of its defaults.
    expect(src).toContain("import { dailyCallLimit, daysToReset, type IngestProvider, type ProviderQuotaSnapshot } from '../jobs/ingest/index.js';");
    expect(src).not.toMatch(/DEFAULT_DAILY_CALLS|activejobs: \d|jsearch: \d/);
  });
});

describe('enrich counter key', () => {
  it('equals the enrichment budget key of its area', () => {
    for (const market of ['intl', 'cn']) expect(limits.enrichCounterKey(market)).toBe(enrichBudgetKey(market));
  });
});
