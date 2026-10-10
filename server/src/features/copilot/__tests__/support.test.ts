// @vitest-environment node
// WP-50 supporting modules: posted-pay aggregate (D3, n ≥ 20), nudges,
// rolling summary, daily budget, the store's pagination, the worker.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getBrand } from '../../../platform/brand/registry.js';
import { budgetKey, copilotDailyBudgetUsd, createCopilotBudget, DEFAULT_COPILOT_DAILY_BUDGET_USD } from '../budget.js';
import { nextNudge, type NudgeSignals } from '../nudges.js';
import { salaryStats, salaryWhere, summarizePay, type PayRow } from '../salaryStats.js';
import { crossedSummaryMark, runThreadSummary } from '../summary.js';
import { COPILOT_WORK_KINDS, workers } from '../workers.js';
import { NOW, USER, fakeAreas, makeFake, makeService } from './testkit.js';
import { createPrismaCopilotStore } from '../store.js';

const row = (min: number | null, max: number | null, currency = 'USD', period = 'year'): PayRow => ({ salaryMin: min, salaryMax: max, salaryCurrency: currency, salaryPeriod: period });

describe('salary aggregate', () => {
  const meta = { totalCount: 100, asOf: NOW, scope: { taxonomyId: null, title: 'analyst', country: 'US', city: null } };

  it('below 20 postings: no aggregate, counts only', () => {
    const r = summarizePay(Array.from({ length: 19 }, (_, i) => row(80_000 + i * 1000, 100_000 + i * 1000)), meta);
    expect(r).toMatchObject({ listedCount: 19, totalCount: 100, median: null, p25: null, p75: null, minSample: 20 });
  });

  it('20+ postings in one currency and period: quartiles with sampleSize and source', () => {
    const rows = [...Array.from({ length: 21 }, (_, i) => row(90_000 + i * 2000, 110_000 + i * 2000)), row(50, 60, 'USD', 'hour'), row(null, null), row(5000, 8000, 'EUR', 'month')];
    const r = summarizePay(rows, meta);
    expect(r).toMatchObject({ currency: 'USD', period: 'year', listedCount: 21 });
    expect(r.median).toEqual({ value: 120_000, source: 'index', sampleSize: 21, asOf: NOW.toISOString(), method: 'computed' });
    expect(r.p25!.value).toBeLessThan(r.median!.value);
    expect(r.p75!.value).toBeGreaterThan(r.median!.value);
  });

  it('only public, canonical, live rows of the brand market (imports never count)', () => {
    const w = salaryWhere({ market: 'intl', taxonomyId: 'data.analyst', country: 'us', now: NOW }) as { AND: Array<Record<string, unknown>> };
    expect(w.AND[0]).toEqual({ market: 'intl', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null });
    expect(w.AND).toContainEqual({ taxonomyIds: { has: 'data.analyst' } });
    expect(w.AND).toContainEqual({ locationCountry: 'US' });
  });

  it('queries rows and the total count with the same filter', async () => {
    const db = { rAJob: { findMany: vi.fn(async () => Array.from({ length: 20 }, () => row(100_000, 120_000))), count: vi.fn(async () => 64) } };
    const r = await salaryStats(db, { market: 'cn', title: '数据分析', now: NOW });
    expect(db.rAJob.findMany.mock.calls[0]![0].where).toEqual(db.rAJob.count.mock.calls[0]![0].where);
    expect(r).toMatchObject({ totalCount: 64, listedCount: 20, median: { value: 110_000, sampleSize: 20 } });
  });
});

describe('nudges', () => {
  const signals = (over: Partial<NudgeSignals> = {}): NudgeSignals => ({ latestRating: async () => null, reportedSince: async () => false, ...over });
  const deps = (over: Record<string, unknown> = {}) => ({
    areas: fakeAreas(),
    signals: signals(),
    market: () => 'intl' as const,
    isEnabled: async () => false,
    now: () => NOW,
    ...over,
  });

  it('agency_report after a recent report while agencies are shown', async () => {
    const n = await nextNudge(USER, deps({ signals: signals({ reportedSince: async () => true }) }));
    expect(n).toMatchObject({ kind: 'agency_report' });
  });

  it('pay_filter only when ≥ 20 jobs list pay, with the count sourced', async () => {
    const few = fakeAreas({ countForFilters: async () => ({ count: 12, capped: false }) });
    expect(await nextNudge(USER, deps({ areas: few }))).toBeNull();
    const n = await nextNudge(USER, deps());
    expect(n).toMatchObject({ kind: 'pay_filter', facts: { jobsListingPay: { value: 120, source: 'index', sampleSize: 120 } } });
  });

  it('nothing when a minimum pay is already set', async () => {
    const areas = fakeAreas({ activeSearchProfile: async () => ({ id: 'sp', name: '', isDefault: true, isActive: true, version: 1, schemaVersion: 1, filters: { salaryMin: { amount: 1, currency: 'USD', period: 'year' } }, alertInstantMax: 1, alertDigest: null, createdAt: '', updatedAt: '' }) });
    expect(await nextNudge(USER, deps({ areas }))).toBeNull();
  });

  it('GoApply: a campus window closing within 7 days comes first; mode off → no posting nudges', async () => {
    const areas = fakeAreas({
      postingsAllowed: () => false,
      campusUpcoming: async () => [{ id: 'ev1', companyName: '示例', title: '2027届校招', applyClosesAt: '2026-10-13T00:00:00.000Z', officialUrl: 'https://example.cn', verifiedAt: NOW.toISOString() } as never],
    });
    const n = await nextNudge(USER, deps({ areas, market: () => 'cn', isEnabled: async (k: string) => k === 'jobs.campusCalendar' }));
    expect(n).toMatchObject({ kind: 'campus_deadline', facts: { eventId: 'ev1' } });
    const none = await nextNudge(USER, deps({ areas: fakeAreas({ postingsAllowed: () => false }), market: () => 'cn' }));
    expect(none).toBeNull();
  });
});

describe('rolling summary', () => {
  it('marks every 10 messages', () => {
    expect([2, 8, 10, 12, 20, 22].map((n) => crossedSummaryMark(n))).toEqual([false, false, true, false, true, false]);
  });

  it('folds everything before the last 12 messages; skips without AI consent', async () => {
    let tick = 0;
    const h = makeService({ rounds: [{ chunks: ['ok.'] }], now: () => new Date(NOW.getTime() + (tick += 1000)) });
    const t = (await h.service.createThread(USER, {})).id;
    for (let i = 0; i < 8; i += 1) {
      const s = await h.service.handleTurn(USER, t, { text: `q${i} mail me at a@b.co` }, { idempotencyKey: `k${i}` });
      for await (const _ of s) void _;
      await s.finished;
    }
    const summarize = vi.fn(async () => 'The user wants analyst roles.');
    expect(await runThreadSummary(t, { store: h.store, aiAllowed: async () => false, summarize })).toBe('skipped');
    expect(summarize).not.toHaveBeenCalled();
    expect(await runThreadSummary(t, { store: h.store, aiAllowed: async () => true, summarize })).toBe('updated');
    const prompt = summarize.mock.calls[0]![0] as Array<{ content: string }>;
    expect(prompt[1]!.content).toContain('q0');
    expect(prompt[1]!.content).not.toContain('q2 ');
    expect(prompt[1]!.content).not.toContain('a@b.co');
    const thread = await h.store.getThread(t);
    expect(thread!.summary).toBe('The user wants analyst roles.');
    expect(thread!.summarizedThroughId).toBeTruthy();
    // nothing new to fold
    expect(await runThreadSummary(t, { store: h.store, aiAllowed: async () => true, summarize })).toBe('skipped');
  });

  it('the worker handles its declared kind', () => {
    expect(workers.map((w) => w.kind)).toEqual([COPILOT_WORK_KINDS.copilotSummary]);
  });
});

describe('daily budget', () => {
  it('per brand, no fallback between brands', () => {
    expect(copilotDailyBudgetUsd('roboapply', { COPILOT_DAILY_BUDGET_USD: '12.5' })).toBe(12.5);
    expect(copilotDailyBudgetUsd('goapply', { COPILOT_DAILY_BUDGET_USD: '12.5' })).toBe(DEFAULT_COPILOT_DAILY_BUDGET_USD);
    expect(copilotDailyBudgetUsd('goapply', { CN_COPILOT_DAILY_BUDGET_USD: '3' })).toBe(3);
    expect(copilotDailyBudgetUsd('roboapply', { COPILOT_DAILY_BUDGET_USD: 'abc' })).toBe(DEFAULT_COPILOT_DAILY_BUDGET_USD);
  });

  it('counts micro-dollars in RARateCounter and reports exhaustion at the cap', async () => {
    const counts = new Map<string, number>();
    const consume = vi.fn(async ({ key, windows, cost = 1 }: { key: string; windows: readonly { limit: number; windowSec: number }[]; cost?: number }) => {
      const c = (counts.get(key) ?? 0) + cost;
      counts.set(key, c);
      return { allowed: c <= windows[0]!.limit, retryAfterSec: 0, remaining: 0, windows: [{ windowSec: windows[0]!.windowSec, limit: windows[0]!.limit, count: c, windowStart: NOW, resetAt: NOW }] };
    });
    const b = createCopilotBudget({ env: { COPILOT_DAILY_BUDGET_USD: '1' }, consume });
    expect(await b.exhausted('roboapply')).toBe(false);
    await b.spend('roboapply', 0.6);
    expect(await b.exhausted('roboapply')).toBe(false);
    await b.spend('roboapply', 0.4);
    expect(await b.exhausted('roboapply')).toBe(true);
    expect(await b.exhausted('goapply')).toBe(false);
    expect(counts.get(budgetKey('roboapply'))).toBe(1_000_000);
  });
});

describe('store', () => {
  it('pages messages newest-first with a cursor and the feedback queue', async () => {
    let tick = 0;
    const h = makeService({ rounds: [{ chunks: ['ok.'] }], now: () => new Date(NOW.getTime() + (tick += 1000)) });
    const t = (await h.service.createThread(USER, {})).id;
    for (let i = 0; i < 3; i += 1) {
      const s = await h.service.handleTurn(USER, t, { text: `q${i}` }, { idempotencyKey: `k${i}` });
      for await (const _ of s) void _;
    }
    const p1 = await h.service.listMessages(USER, t, { limit: 4 });
    expect(p1.items.map((m) => m.content)).toEqual(['q1', 'ok.', 'q2', 'ok.']);
    const p2 = await h.service.listMessages(USER, t, { limit: 4, before: p1.cursor! });
    expect(p2.items.map((m) => m.content)).toEqual(['q0', 'ok.']);
    expect(p2.cursor).toBeNull();
    const assistants = [...p2.items, ...p1.items].filter((m) => m.role === 'assistant');
    for (const m of assistants) await h.service.feedback(USER, m.id, { value: 'up' });
    const f1 = await h.service.listFeedback({ limit: 2 });
    expect(f1.items).toHaveLength(2);
    const f2 = await h.service.listFeedback({ limit: 2, cursor: f1.cursor! });
    expect(f2.items).toHaveLength(1);
    expect(f2.cursor).toBeNull();
  });

  it('primary resume, then the most recently edited', async () => {
    const db = makeFake();
    const store = createPrismaCopilotStore(async () => db as never);
    expect(await store.primaryResumeId(USER)).toBe('res_1');
    expect(await store.primaryResumeId('nobody')).toBeNull();
  });

  it('GoApply brand of a thread is enforced on list', async () => {
    const h = makeService();
    await h.service.createThread(USER, {});
    const ga = makeService({ brand: 'goapply', db: h.db });
    expect((await ga.service.listThreads(USER)).items).toEqual([]);
    expect(getBrand('goapply').market).toBe('cn');
  });
});

describe('system prompt (F-ORION-11 SKIP: no persona)', () => {
  it('has no human name, no emoji, the D1/D3 rules and the content-scope language directive', async () => {
    const { systemPrompt } = await import('../prompt.js');
    const p = systemPrompt({ brand: getBrand('goapply'), locale: 'zh', today: '2026-10-10', scope: 'seeker' });
    expect(p).toMatch(/^You are GoApply's job search assistant\./);
    expect(p).toMatch(/Do not call yourself by a name/);
    expect(p).toMatch(/never say or imply that you did/);
    expect(p).toMatch(/State a number only when it appears in a tool result/);
    expect(p).toMatch(/AUTHORING in/);
    expect(p).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(p).not.toMatch(/Orion/);
  });
});
