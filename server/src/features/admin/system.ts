// server/src/features/admin/system.ts — the System panel (ARCHITECTURE.md §10.4
// "Pipeline health"): ingest, queue, provider calls, enrichment, AI scores,
// alert and email sends, Assistant turns/guard hits/cost and credit
// exhaustion, read live per brand, plus the alert-level check the daily
// health email uses.
//
// Data access sits behind `SystemStore` (Prisma implementation below) so the
// assembly and the alert rules are tested without a database.
//
// Two day windows (finding: a partial UTC day must not be compared with
// full-day averages and budgets):
//   - 'live' (the System panel): today so far. The ingest rule is prorated by
//     the share of the UTC day that has passed; budget rules compare today's
//     usage with the whole daily budget ("close to the limit already").
//   - 'last_complete_day' (the daily health email, run at 03:30 UTC by
//     jobs-maintain): the whole previous UTC day against the 7 days before it,
//     so a budget used up at 20:00 is still reported the next morning.
// Queue depth, due/overdue queries and open jobs are read as they are now in
// both modes.

import prisma from '../../lib/prisma.js';
import { getBrand, type BrandId, type EnvSource } from '../../platform/brand/index.js';
import { DAY, windowStartFor } from '../../platform/ratelimit/index.js';
import { NOTIFY_TEMPLATES } from '../alerts/index.js';
import {
  ALERT_LEVELS,
  type AlertHit,
  type BrandHealth,
  type ProviderUsageRow,
  type QueueKindRow,
  type SystemStatusResponse,
} from './contract.js';
import { BUDGET_COUNTER_KEYS, copilotDailyBudgetUsd, enrichDailyLimit, providerDailyCallLimit, scoreDailyBudget } from './limits.js';

const DAY_MS = DAY * 1000;
const COPILOT_SKU = 'ra_copilot_turn';
export const JOB_ALERT_TEMPLATES: readonly string[] = [NOTIFY_TEMPLATES.jobAlertInstant, NOTIFY_TEMPLATES.jobAlertDigest];

/** A [since, until) time range. */
export interface TimeRange {
  since: Date;
  until: Date;
}

export interface SystemStore {
  ingestCounts(market: string, now: Date, overdueBefore: Date): Promise<{ due: number; overdue: number; failing: number }>;
  /** Public canonical jobs first seen per UTC day since `since` (missing days = 0). */
  newJobsByDay(market: string, since: Date): Promise<Array<{ day: string; count: number }>>;
  openJobCounts(market: string): Promise<{ open: number; enriched: number }>;
  rateCounter(key: string, windowStart: Date): Promise<number>;
  queueByKind(): Promise<QueueKindRow[]>;
  providerUsage(dayKey: string): Promise<Array<Omit<ProviderUsageRow, 'limit'>>>;
  /** Email sends per status in `range`, optionally only these templates. */
  emailStatus(brand: string, range: TimeRange, templates?: readonly string[]): Promise<{ sent: number; failed: number }>;
  emailFailuresByTemplate(brand: string, range: TimeRange, limit: number): Promise<Array<{ template: string; count: number }>>;
  copilotStats(brand: string, range: TimeRange): Promise<{ turns: number; guardHits: number; costUsd: number }>;
  /** Distinct people per bucket in `range`; null when no out-of-credits event was ever recorded for the brand. */
  creditExhaustion(brand: string, range: TimeRange): Promise<Array<{ bucket: string; count: number }> | null>;
}

export type HealthMode = 'live' | 'last_complete_day';

export interface HealthWindow {
  mode: HealthMode;
  /** Start of the UTC day covered. */
  start: Date;
  /** End of the range read: now (live) or the end of that day. */
  end: Date;
  dayKey: string;
  /** Share of the UTC day the range covers (0–1); 1 for a complete day. */
  elapsedShare: number;
}

export function dayKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const n = (v: unknown): number => {
  const x = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/** The UTC day a health read covers. */
export function healthWindow(now: Date, mode: HealthMode = 'live'): HealthWindow {
  const todayStart = windowStartFor(now, DAY);
  if (mode === 'last_complete_day') {
    const start = new Date(todayStart.getTime() - DAY_MS);
    return { mode, start, end: todayStart, dayKey: dayKeyOf(start), elapsedShare: 1 };
  }
  const elapsedShare = Math.min(1, Math.max(0, (now.getTime() - todayStart.getTime()) / DAY_MS));
  return { mode, start: todayStart, end: now, dayKey: dayKeyOf(todayStart), elapsedShare: Math.round(elapsedShare * 1e4) / 1e4 };
}

/** Brand health for one brand over `window` (default: live, today so far). */
export async function brandHealth(
  store: SystemStore,
  brandId: BrandId,
  now: Date,
  env: EnvSource = process.env,
  window: HealthWindow = healthWindow(now),
): Promise<BrandHealth> {
  const brand = getBrand(brandId);
  const market = brand.market;
  const dayStart = window.start;
  const day: TimeRange = { since: window.start, until: window.end };
  const weekStart = new Date(dayStart.getTime() - 7 * DAY_MS);
  // Email failures: the 24 hours ending at the end of the range (live: the last 24 h; email: the whole day).
  const emailRange: TimeRange = { since: new Date(window.end.getTime() - DAY_MS), until: window.end };
  const overdueBefore = new Date(now.getTime() - ALERT_LEVELS.overdueMinutes * 60_000);

  const [ingest, byDay, open, enrichUsed, scoreUsed, alerts, email, failedByTemplate, copilot, exhaustion] = await Promise.all([
    store.ingestCounts(market, now, overdueBefore),
    store.newJobsByDay(market, weekStart),
    store.openJobCounts(market),
    store.rateCounter(BUDGET_COUNTER_KEYS.enrich(market), dayStart),
    store.rateCounter(BUDGET_COUNTER_KEYS.score(brandId), dayStart),
    store.emailStatus(brandId, day, JOB_ALERT_TEMPLATES),
    store.emailStatus(brandId, emailRange),
    store.emailFailuresByTemplate(brandId, emailRange, 10),
    store.copilotStats(brandId, day),
    store.creditExhaustion(brandId, day),
  ]);

  const today = window.dayKey;
  const counts = new Map(byDay.map((r) => [r.day, r.count]));
  let prior = 0;
  for (let i = 1; i <= 7; i += 1) prior += counts.get(dayKeyOf(new Date(dayStart.getTime() - i * DAY_MS))) ?? 0;

  return {
    brand: brandId,
    market,
    ingest: {
      due: ingest.due,
      overdue: ingest.overdue,
      failing: ingest.failing,
      newJobsToday: counts.get(today) ?? 0,
      newJobs7dAvg: Math.round((prior / 7) * 10) / 10,
      openJobs: open.open,
      enrichBacklog: Math.max(0, open.open - open.enriched),
      enrichedShare: open.open > 0 ? Math.round((open.enriched / open.open) * 1000) / 1000 : null,
      enrichBudget: { used: enrichUsed, limit: enrichDailyLimit(env) },
    },
    precompute: { used: scoreUsed, limit: scoreDailyBudget(brandId, env) },
    alerts,
    email: { ...email, failedByTemplate },
    copilot: { ...copilot, costUsd: Math.round(copilot.costUsd * 1e4) / 1e4, budgetUsd: copilotDailyBudgetUsd(brandId, env) },
    creditExhaustion: exhaustion,
  };
}

const overShare = (used: number, limit: number | null) => limit !== null && limit > 0 && used >= limit * ALERT_LEVELS.budgetShare;

/**
 * Metrics past their alert level (ARCH §10.4 "Alerting"). Pure.
 *
 * The ingest rule compares the new jobs in the day so far with the 7-day
 * average prorated by `dayElapsedShare` (1 for a complete day), and stays
 * quiet early in the UTC day (`ingestMinDayShare`) and while the prorated
 * level is under one job.
 */
export function evaluateAlerts(status: Pick<SystemStatusResponse, 'brands' | 'queue' | 'providers' | 'dayElapsedShare'>): AlertHit[] {
  const hits: AlertHit[] = [];
  const dayShare = status.dayElapsedShare;
  if (status.queue.deadTotal > ALERT_LEVELS.deadItems) {
    hits.push({ key: 'dead_items', brand: null, subject: null, value: status.queue.deadTotal, level: ALERT_LEVELS.deadItems });
  }
  for (const p of status.providers) {
    if (overShare(p.calls, p.limit)) {
      hits.push({ key: 'provider_budget', brand: null, subject: p.provider, value: p.calls, level: Math.ceil(p.limit! * ALERT_LEVELS.budgetShare) });
    }
  }
  for (const b of status.brands) {
    const avg = b.ingest.newJobs7dAvg;
    const ingestLevel = avg * dayShare * ALERT_LEVELS.ingestNewShare;
    if (avg >= ALERT_LEVELS.ingestMinAverage && dayShare >= ALERT_LEVELS.ingestMinDayShare && ingestLevel >= 1 && b.ingest.newJobsToday < ingestLevel) {
      hits.push({ key: 'ingest_new_low', brand: b.brand, subject: null, value: b.ingest.newJobsToday, level: Math.ceil(ingestLevel) });
    }
    if (overShare(b.ingest.enrichBudget.used, b.ingest.enrichBudget.limit)) {
      hits.push({ key: 'enrich_budget', brand: b.brand, subject: null, value: b.ingest.enrichBudget.used, level: Math.ceil(b.ingest.enrichBudget.limit! * ALERT_LEVELS.budgetShare) });
    }
    if (overShare(b.precompute.used, b.precompute.limit)) {
      hits.push({ key: 'score_budget', brand: b.brand, subject: null, value: b.precompute.used, level: Math.ceil(b.precompute.limit! * ALERT_LEVELS.budgetShare) });
    }
    if (overShare(b.copilot.costUsd, b.copilot.budgetUsd)) {
      hits.push({ key: 'assistant_budget', brand: b.brand, subject: null, value: b.copilot.costUsd, level: Math.round(b.copilot.budgetUsd * ALERT_LEVELS.budgetShare * 100) / 100 });
    }
    if (b.email.failed > ALERT_LEVELS.emailFailures) {
      hits.push({ key: 'email_failures', brand: b.brand, subject: null, value: b.email.failed, level: ALERT_LEVELS.emailFailures });
    }
  }
  return hits;
}

/** GET /admin/system for the given brands ('live'), or the last complete UTC day for the health email. */
export async function buildSystemStatus(
  store: SystemStore,
  options: { brands: BrandId[]; brandsServed: BrandId[]; now?: Date; env?: EnvSource; mode?: HealthMode },
): Promise<SystemStatusResponse> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const window = healthWindow(now, options.mode ?? 'live');
  const dayKey = window.dayKey;
  const [brands, kinds, usage] = await Promise.all([
    Promise.all(options.brands.map((b) => brandHealth(store, b, now, env, window))),
    store.queueByKind(),
    store.providerUsage(dayKey),
  ]);
  const providers: ProviderUsageRow[] = usage
    .map((u) => ({ ...u, limit: providerDailyCallLimit(u.provider, env) }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
  const queue = { kinds: [...kinds].sort((a, b) => b.dead - a.dead || b.queued - a.queued || a.kind.localeCompare(b.kind)), deadTotal: kinds.reduce((s, k) => s + k.dead, 0) };
  const partial = { brands, queue, providers, dayElapsedShare: window.elapsedShare };
  return {
    asOf: now.toISOString(),
    dayKey,
    dayComplete: window.mode === 'last_complete_day',
    ...partial,
    alerts: evaluateAlerts(partial),
    brandsServed: options.brandsServed,
  };
}

// ── Prisma implementation ────────────────────────────────────────────────

type Db = Pick<
  typeof prisma,
  'rAIngestQuery' | 'rAJob' | 'rARateCounter' | 'rAWorkItem' | 'rAProviderUsage' | 'rAEmailLog' | '$queryRaw'
>;

export function createPrismaSystemStore(db: Db = prisma): SystemStore {
  return {
    async ingestCounts(market, now, overdueBefore) {
      const base = { market, enabled: true };
      const [due, overdue, failing] = await Promise.all([
        db.rAIngestQuery.count({ where: { ...base, nextRunAt: { lte: now } } }),
        db.rAIngestQuery.count({ where: { ...base, nextRunAt: { lte: overdueBefore } } }),
        db.rAIngestQuery.count({ where: { ...base, lastError: { not: null } } }),
      ]);
      return { due, overdue, failing };
    },
    async newJobsByDay(market, since) {
      const rows = await db.$queryRaw<Array<{ day: string; n: number | bigint }>>`
        SELECT to_char("firstSeenAt", 'YYYY-MM-DD') AS day, COUNT(*) AS n
        FROM "RAJob"
        WHERE "market" = ${market} AND "visibility" = 'public' AND "isCanonical" = true AND "firstSeenAt" >= ${since}
        GROUP BY 1`;
      return rows.map((r) => ({ day: r.day, count: n(r.n) }));
    },
    async openJobCounts(market) {
      const where = { market, visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null };
      const [open, enriched] = await Promise.all([
        db.rAJob.count({ where }),
        db.rAJob.count({ where: { ...where, enrichedAt: { not: null } } }),
      ]);
      return { open, enriched };
    },
    async rateCounter(key, windowStart) {
      const row = await db.rARateCounter.findUnique({ where: { key_windowStart: { key, windowStart } }, select: { count: true } });
      return row?.count ?? 0;
    },
    async queueByKind() {
      const rows = await db.rAWorkItem.groupBy({
        by: ['kind', 'status'],
        where: { status: { in: ['queued', 'leased', 'failed', 'dead'] } },
        _count: { _all: true },
        _min: { createdAt: true },
      });
      const out = new Map<string, QueueKindRow>();
      for (const r of rows) {
        const row = out.get(r.kind) ?? { kind: r.kind, queued: 0, leased: 0, failed: 0, dead: 0, oldestQueuedAt: null };
        const count = r._count._all;
        if (r.status === 'queued') {
          row.queued = count;
          row.oldestQueuedAt = r._min.createdAt ? r._min.createdAt.toISOString() : null;
        } else if (r.status === 'leased') row.leased = count;
        else if (r.status === 'failed') row.failed = count;
        else if (r.status === 'dead') row.dead = count;
        out.set(r.kind, row);
      }
      return [...out.values()];
    },
    async providerUsage(dayKey) {
      const rows = await db.rAProviderUsage.findMany({ where: { dayKey } });
      return rows.map((r) => ({ provider: r.provider, calls: r.calls, jobsReturned: r.jobsReturned, jobsNew: r.jobsNew, errors: r.errors }));
    },
    async emailStatus(brand, range, templates) {
      const rows = await db.rAEmailLog.groupBy({
        by: ['status'],
        where: { brand, createdAt: { gte: range.since, lt: range.until }, ...(templates ? { template: { in: [...templates] } } : {}) },
        _count: { _all: true },
      });
      const of = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
      return { sent: of('sent'), failed: of('failed') };
    },
    async emailFailuresByTemplate(brand, range, limit) {
      const rows = await db.rAEmailLog.groupBy({
        by: ['template'],
        where: { brand, status: 'failed', createdAt: { gte: range.since, lt: range.until } },
        _count: { _all: true },
      });
      return rows
        .map((r) => ({ template: r.template, count: r._count._all }))
        .sort((a, b) => b.count - a.count || a.template.localeCompare(b.template))
        .slice(0, limit);
    },
    async copilotStats(brand, range) {
      const rows = await db.$queryRaw<Array<{ turns: number | bigint; guard: number | bigint | null; cost: number | null }>>`
        SELECT COUNT(*) AS turns,
          COALESCE(SUM(CASE WHEN jsonb_typeof(d."metadata"->'guardHits') = 'number' THEN (d."metadata"->>'guardHits')::numeric ELSE 0 END), 0) AS guard,
          COALESCE(SUM(d."platformCostUsd"), 0)::float8 AS cost
        FROM "UsageDeductionLog" d
        JOIN "User" u ON u."id" = d."userId"
        WHERE d."sku" = ${COPILOT_SKU} AND d."metadata"->>'kind' = 'cost' AND d."createdAt" >= ${range.since} AND d."createdAt" < ${range.until} AND u."brand" = ${brand}`;
      const r = rows[0];
      return { turns: n(r?.turns), guardHits: n(r?.guard), costUsd: n(r?.cost) };
    },
    async creditExhaustion(brand, range) {
      const ever = await db.$queryRaw<Array<{ one: number }>>`
        SELECT 1 AS one FROM "RAProductEvent"
        WHERE "brand" = ${brand} AND "name" = 'upgrade_viewed' AND "props"->>'from' = 'out_of_credits'
        LIMIT 1`;
      if (ever.length === 0) return null;
      // People, not sheet openings: one person who opens the sheet three times counts once.
      // Signed-out viewers have no userId and are not counted.
      const rows = await db.$queryRaw<Array<{ bucket: string; n: number | bigint }>>`
        SELECT COALESCE("props"->>'bucket', 'unknown') AS bucket, COUNT(DISTINCT "userId") AS n
        FROM "RAProductEvent"
        WHERE "brand" = ${brand} AND "name" = 'upgrade_viewed' AND "props"->>'from' = 'out_of_credits'
          AND "userId" IS NOT NULL AND "createdAt" >= ${range.since} AND "createdAt" < ${range.until}
        GROUP BY 1`;
      return rows.map((r) => ({ bucket: r.bucket, count: n(r.n) })).sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket));
    },
  };
}
