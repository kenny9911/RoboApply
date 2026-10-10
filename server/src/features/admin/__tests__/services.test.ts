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

import { ALERT_LEVELS, type BrandHealth, type SystemStatusResponse } from '../contract.js';
import { brandHealth, buildSystemStatus, evaluateAlerts, healthWindow } from '../system.js';
import { ADMIN_REVIEW_KIND, KEEP_DECISION_HOLDS, buildItem, clearedRuleSet, createPrismaReportsStore, intlScamFlags, listReports, resolveReport, reviewedElsewhere, type ReportJobRow, type ReportsStore, type DecisionRow } from '../reports.js';
import { costsCsv, getCosts, resolveCostRange } from '../costs.js';
import { listAdminFeedback, type FeedbackStore } from '../feedback.js';
import { AUDIT_PAGE_SIZE, auditDetails, createPrismaAuditStore, listAdminAudit, writeAdminAudit, type AdminAuditRow, type AdminAuditStore, type LegacyAuditStore } from '../audit.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { createAdminHealthTask, parseAdminEmails, alertLine, adminHealthTemplate } from '../healthEmail.js';
import { toSafetyView } from '../safety.js';
import * as limits from '../limits.js';
import { fakeSystemData, fakeSystemStore } from './fakes.js';
import { getBrand } from '../../../platform/brand/index.js';
import { createBudget } from '../../../platform/queue/index.js';
// Parity: the originals the admin mirrors (tests are outside the boundary rule).
import { DEFAULT_SCORE_DAILY_BUDGET, scoreDailyBudget, scoreCounterKeys } from '../../match/config.js';
import { DEFAULT_COPILOT_DAILY_BUDGET_USD, copilotDailyBudgetUsd } from '../../copilot/budget.js';
import { DEFAULT_DAILY_CALLS, dailyCallLimit } from '../../jobs/ingest/config.js';
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

function healthWith(over: Partial<BrandHealth['ingest']> & { precompute?: BrandHealth['precompute']; copilot?: Partial<BrandHealth['copilot']>; emailFailed?: number } = {}): BrandHealth {
  return {
    brand: 'roboapply',
    market: 'intl',
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
        [{ provider: 'jsearch', calls: 180, limit: 200, jobsReturned: 0, jobsNew: 0, errors: 0 }, { provider: 'bank', calls: 9999, limit: null, jobsReturned: 0, jobsNew: 0, errors: 0 }],
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
    expect(s.providers).toEqual([{ provider: 'jsearch', calls: 20, limit: 200, jobsReturned: 400, jobsNew: 50, errors: 0 }]);
    expect(s.asOf).toBe(NOW.toISOString());
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

// ── Limits parity (the J3 copies in limits.ts) ────────────────────────────

describe('limits mirror the owning areas (J3)', () => {
  const envs = [{}, { SCORE_DAILY_BUDGET: '500', CN_SCORE_DAILY_BUDGET: '7', COPILOT_DAILY_BUDGET_USD: '12.5', CN_COPILOT_DAILY_BUDGET_USD: 'x', INGEST_JSEARCH_DAILY_CALLS: '42', INGEST_LINKEDIN_DAILY_CALLS: 'abc', INGEST_BANK_DAILY_CALLS: '9' }];
  it.each(envs)('env %#', (env) => {
    expect(limits.DEFAULT_SCORE_DAILY_BUDGET).toBe(DEFAULT_SCORE_DAILY_BUDGET);
    expect(limits.DEFAULT_COPILOT_DAILY_BUDGET_USD).toBe(DEFAULT_COPILOT_DAILY_BUDGET_USD);
    expect(limits.DEFAULT_DAILY_CALLS).toEqual(DEFAULT_DAILY_CALLS);
    for (const brand of ['roboapply', 'goapply'] as const) {
      expect(limits.scoreDailyBudget(brand, env)).toBe(scoreDailyBudget(brand, env));
      expect(limits.copilotDailyBudgetUsd(brand, env)).toBe(copilotDailyBudgetUsd(brand, env));
      expect(limits.scoreCounterKeys.budget(brand)).toBe(scoreCounterKeys.budget(brand));
      expect(limits.scoreCounterKeys.onDemand(brand, 'u1')).toBe(scoreCounterKeys.onDemand(brand, 'u1'));
      expect(limits.scoreCounterKeys.precompute(brand, 'u1')).toBe(scoreCounterKeys.precompute(brand, 'u1'));
    }
    for (const p of ['activejobs', 'linkedin', 'jsearch', 'bank', 'gohire'] as const) {
      expect(limits.dailyCallLimit(p as never, env)).toBe(dailyCallLimit(p as never, env));
    }
  });

  it('the J3 swap is three export lines: the copies carry the owners\' names', () => {
    const src = readFileSync(new URL('../limits.ts', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('// ── J3 COPIES — BEGIN'), src.indexOf('// ── J3 COPIES — END'));
    for (const name of ['scoreDailyBudget', 'scoreCounterKeys', 'copilotDailyBudgetUsd', 'dailyCallLimit']) {
      expect(block, name).toMatch(new RegExp(`export (function|const) ${name}\\b`));
    }
    // The three lines the join pastes are written out in the header.
    expect(src).toContain("//        export { scoreDailyBudget, scoreCounterKeys } from '../match/index.js';");
    expect(src).toContain("//        export { copilotDailyBudgetUsd } from '../copilot/index.js';");
    expect(src).toContain("//        export { dailyCallLimit } from '../jobs/ingest/index.js';");
    // system.ts uses only those names (plus the enrich readers, which are not copies).
    const system = readFileSync(new URL('../system.ts', import.meta.url), 'utf8');
    expect(system).toContain("import { copilotDailyBudgetUsd, dailyCallLimit, enrichCounterKey, enrichDailyLimit, scoreCounterKeys, scoreDailyBudget } from './limits.js';");
  });
});

describe('enrich counter key', () => {
  it('equals the enrichment budget key of its area', () => {
    for (const market of ['intl', 'cn']) expect(limits.enrichCounterKey(market)).toBe(enrichBudgetKey(market));
  });
});
