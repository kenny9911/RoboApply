// backend/src/roboapply/v2/services/RAAdminAnalyticsService.ts
//
// RoboApply admin analytics + profitability aggregation. Read-only over the
// canonical ledger (UsageDeductionLog.platformCostUsd — see
// docs/roboapply-admin-billing/technical-design.md §1.6) plus InterviewSession
// (modality split + session detail) and SeekerSubscription (revenue / MRR).
//
// Cost rule: cost = SUM(platformCostUsd). The mock_interview ledger row carries
// the whole interview cost, so we NEVER also add InterviewSession.costUsd into
// money totals (that would double-count). InterviewSession is read only for the
// per-stage modality split + the sessions table.
//
// Shared-resource (cron) cost is attributed to SHARED_COST_USER_ID; per-user
// queries exclude it automatically (it never matches a real user id), and the
// overview surfaces it as a distinct "shared platform" line.

import prisma from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';
import { resolveTimeZone, sqlLocalTime } from '../../../lib/timeBuckets.js';
import { getRateCard, tierPriceUsd, tierDailyCap, type RateCard } from '../../../lib/rateCard.js';
import { featureForSku, SHARED_COST_USER_ID } from '../lib/raFeatureCatalog.js';

const MAX_USERS = 5000; // admin table hard cap; logged when exceeded

export interface Range {
  from: Date;
  to: Date;
  tz: string;
}

export function resolveRange(fromRaw?: string, toRaw?: string, tzRaw?: string): Range {
  const tz = resolveTimeZone(tzRaw);
  const to = toRaw ? new Date(toRaw) : new Date();
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to, tz };
}

function n(v: unknown): number {
  const num = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(num) ? num : 0;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

// ─── Interview cost-breakdown stage helpers ───────────────────────────────────

interface InterviewBreakdownStages {
  llm: number;
  stt: number;
  tts: number;
  recording: number;
  total: number;
}

function stagesFromBreakdown(breakdown: unknown): InterviewBreakdownStages {
  const b = (breakdown ?? {}) as Record<string, any>;
  const blueprint = n(b.blueprint?.usd);
  const liveLlm = n(b.live?.llm?.usd);
  const evaluation = n(b.evaluation?.usd);
  const coach = n(b.coach?.usd);
  const stt = n(b.live?.stt?.usd);
  const tts = n(b.live?.tts?.usd);
  const recording = n(b.recording?.usd);
  const llm = blueprint + liveLlm + evaluation + coach;
  return { llm, stt, tts, recording, total: llm + stt + tts + recording };
}

// ─── Revenue (MRR) ─────────────────────────────────────────────────────────────

interface MrrResult {
  mrrUsd: number;
  byTier: Record<string, { count: number; mrrUsd: number }>;
  payingUsers: number;
}

async function getActiveMrr(card: RateCard): Promise<MrrResult> {
  const rows = await prisma.$queryRawUnsafe<{ tier: string; amountMinor: number | null; currency: string | null }[]>(
    `SELECT ss."tier"::text AS tier, ss."amountMinor" AS "amountMinor", ss."currency" AS currency
       FROM "SeekerSubscription" ss
      WHERE ss."status" = 'active'`,
  );
  const byTier: Record<string, { count: number; mrrUsd: number }> = {};
  let mrrUsd = 0;
  let payingUsers = 0;
  for (const r of rows) {
    const price = r.amountMinor != null ? n(r.amountMinor) / 100 : tierPriceUsd(card, r.tier);
    // Non-USD amounts are recorded as-is; treated as USD for the headline (the
    // detail view shows the original currency). Most RoboApply subs are USD.
    if (!byTier[r.tier]) byTier[r.tier] = { count: 0, mrrUsd: 0 };
    byTier[r.tier].count += 1;
    byTier[r.tier].mrrUsd += price;
    mrrUsd += price;
    if (price > 0) payingUsers += 1;
  }
  return { mrrUsd: round2(mrrUsd), byTier, payingUsers };
}

// ─── Overview ────────────────────────────────────────────────────────────────

export async function getOverview(range: Range) {
  const card = await getRateCard();
  const params = [range.from, range.to];

  // Totals + active users (exclude the shared/cron sentinel from active-user count).
  const totalsRows = await prisma.$queryRawUnsafe<
    { active_users: number; total_cost: number; shared_cost: number }[]
  >(
    `SELECT
        COUNT(DISTINCT "userId") FILTER (WHERE "userId" <> '${SHARED_COST_USER_ID}') AS active_users,
        COALESCE(SUM("platformCostUsd"), 0) AS total_cost,
        COALESCE(SUM("platformCostUsd") FILTER (WHERE "userId" = '${SHARED_COST_USER_ID}'), 0) AS shared_cost
       FROM "UsageDeductionLog"
      WHERE "createdAt" >= $1 AND "createdAt" < $2`,
    ...params,
  );
  const totals = totalsRows[0] ?? { active_users: 0, total_cost: 0, shared_cost: 0 };

  // Cost by SKU → fold into feature keys.
  const skuRows = await prisma.$queryRawUnsafe<{ sku: string; cost: number; units: number }[]>(
    `SELECT "sku", COALESCE(SUM("platformCostUsd"),0) AS cost, COALESCE(SUM("units"),0) AS units
       FROM "UsageDeductionLog"
      WHERE "createdAt" >= $1 AND "createdAt" < $2
      GROUP BY "sku"`,
    ...params,
  );
  const featureMap = new Map<string, { key: string; label: string; costUsd: number; units: number }>();
  for (const r of skuRows) {
    const f = featureForSku(r.sku);
    const cur = featureMap.get(f.key) ?? { key: f.key, label: f.label, costUsd: 0, units: 0 };
    cur.costUsd += n(r.cost);
    cur.units += n(r.units);
    featureMap.set(f.key, cur);
  }
  const costByFeature = Array.from(featureMap.values())
    .map((f) => ({ ...f, costUsd: round4(f.costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd);

  // Modality split: non-interview ledger cost is all LLM; interview modality
  // comes from costBreakdown stages (window-bounded fetch, summed in JS).
  const nonInterviewLlmRow = await prisma.$queryRawUnsafe<{ cost: number }[]>(
    `SELECT COALESCE(SUM("platformCostUsd"),0) AS cost
       FROM "UsageDeductionLog"
      WHERE "createdAt" >= $1 AND "createdAt" < $2 AND "sku" <> 'mock_interview'`,
    ...params,
  );
  const interviewRows = await prisma.$queryRawUnsafe<{ costBreakdown: unknown }[]>(
    `SELECT "costBreakdown" FROM "InterviewSession"
      WHERE "createdAt" >= $1 AND "createdAt" < $2 AND "source" = 'roboapply'`,
    ...params,
  );
  const modality = { llm: n(nonInterviewLlmRow[0]?.cost), stt: 0, tts: 0, recording: 0 };
  for (const row of interviewRows) {
    const s = stagesFromBreakdown(row.costBreakdown);
    modality.llm += s.llm;
    modality.stt += s.stt;
    modality.tts += s.tts;
    modality.recording += s.recording;
  }
  const costByModality = [
    { modality: 'llm', label: 'LLM tokens', costUsd: round4(modality.llm) },
    { modality: 'stt', label: 'Speech-to-text', costUsd: round4(modality.stt) },
    { modality: 'tts', label: 'Text-to-speech', costUsd: round4(modality.tts) },
    { modality: 'recording', label: 'Recording / egress', costUsd: round4(modality.recording) },
  ];

  // Sessions count (real-time mock interviews in window).
  const sessionsRow = await prisma.$queryRawUnsafe<{ c: number }[]>(
    `SELECT COUNT(*) AS c FROM "InterviewSession"
      WHERE "createdAt" >= $1 AND "createdAt" < $2 AND "source" = 'roboapply'`,
    ...params,
  );

  // Daily cost series (viewer-local buckets).
  const dateExpr = sqlLocalTime('"createdAt"', '$3');
  const seriesRows = await prisma.$queryRawUnsafe<{ day: string; cost: number }[]>(
    `SELECT ${dateExpr}::date::text AS day, COALESCE(SUM("platformCostUsd"),0) AS cost
       FROM "UsageDeductionLog"
      WHERE "createdAt" >= $1 AND "createdAt" < $2
      GROUP BY day ORDER BY day ASC`,
    range.from,
    range.to,
    range.tz,
  );

  const mrr = await getActiveMrr(card);
  const totalCost = round4(n(totals.total_cost));
  const activeUsers = n(totals.active_users);

  // Margin headline: compare MRR (monthly) to the window cost normalized to a
  // 30-day run-rate so the % is apples-to-apples regardless of window length.
  const windowDays = Math.max(1, (range.to.getTime() - range.from.getTime()) / 86_400_000);
  const monthlyCostRunRate = round2((totalCost / windowDays) * 30);
  const grossMarginUsd = round2(mrr.mrrUsd - monthlyCostRunRate);
  const grossMarginPct = mrr.mrrUsd > 0 ? round2((grossMarginUsd / mrr.mrrUsd) * 100) : null;

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString(), tz: range.tz },
    kpis: {
      activeUsers,
      sessions: n(sessionsRow[0]?.c),
      totalCostUsd: totalCost,
      sharedCostUsd: round4(n(totals.shared_cost)),
      mrrUsd: mrr.mrrUsd,
      monthlyCostRunRateUsd: monthlyCostRunRate,
      grossMarginUsd,
      grossMarginPct,
      costPerActiveUserUsd: activeUsers > 0 ? round4(totalCost / activeUsers) : 0,
      payingUsers: mrr.payingUsers,
    },
    mrrByTier: mrr.byTier,
    costByFeature,
    costByModality,
    costSeries: seriesRows.map((r) => ({
      day: r.day,
      costUsd: round4(n(r.cost)),
      revenueRunRateUsd: round2(mrr.mrrUsd / 30),
    })),
  };
}

// ─── Users table ────────────────────────────────────────────────────────────

export interface UsersQuery {
  range: Range;
  q?: string;
  sort?: string; // marginUsd | periodCostUsd | mrrUsd | sessions | lastActiveAt | email
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export async function getUsers(opts: UsersQuery) {
  const card = await getRateCard();
  const { from, to } = opts.range;

  // Per-user cost + sessions + last active in window (exclude shared sentinel).
  const costRows = await prisma.$queryRawUnsafe<
    { userId: string; cost: number; ic: number; last: Date | null }[]
  >(
    `SELECT "userId",
            COALESCE(SUM("platformCostUsd"),0) AS cost,
            COUNT(*) FILTER (WHERE "sku" = 'mock_interview') AS ic,
            MAX("createdAt") AS last
       FROM "UsageDeductionLog"
      WHERE "createdAt" >= $1 AND "createdAt" < $2 AND "userId" <> '${SHARED_COST_USER_ID}'
      GROUP BY "userId"`,
    from,
    to,
  );
  const costByUser = new Map(costRows.map((r) => [r.userId, r]));

  const sessionRows = await prisma.$queryRawUnsafe<{ userId: string; c: number }[]>(
    `SELECT "userId", COUNT(*) AS c FROM "InterviewSession"
      WHERE "createdAt" >= $1 AND "createdAt" < $2 AND "source" = 'roboapply'
      GROUP BY "userId"`,
    from,
    to,
  );
  const sessionsByUser = new Map(sessionRows.map((r) => [r.userId, n(r.c)]));

  // Active paying-subscription users (so they appear even with zero activity).
  const subUserRows = await prisma.$queryRawUnsafe<{ userId: string }[]>(
    `SELECT sp."userId" AS "userId"
       FROM "SeekerSubscription" ss
       JOIN "SeekerProfile" sp ON sp."id" = ss."seekerProfileId"
      WHERE ss."status" = 'active' AND (ss."amountMinor" > 0 OR ss."tier" <> 'free')`,
  );

  const ids = new Set<string>([...costByUser.keys(), ...subUserRows.map((r) => r.userId)]);
  let truncated = false;
  let idList = Array.from(ids);
  if (idList.length > MAX_USERS) {
    truncated = true;
    logger.warn('RA_ADMIN', 'users set exceeds cap; truncating', { total: idList.length, cap: MAX_USERS });
    idList = idList.slice(0, MAX_USERS);
  }
  if (idList.length === 0) {
    return { rows: [], total: 0, page: opts.page ?? 1, pageSize: opts.pageSize ?? 25, truncated };
  }

  const infoRows = await prisma.$queryRawUnsafe<
    {
      id: string; email: string; name: string | null; role: string; createdAt: Date;
      tier: string | null; status: string | null; amountMinor: number | null; currency: string | null;
      stripeCustomerId: string | null; currentPeriodEnd: Date | null;
    }[]
  >(
    `SELECT u."id" AS id, u."email" AS email, u."name" AS name, u."role" AS role, u."createdAt" AS "createdAt",
            ss."tier"::text AS tier, ss."status" AS status, ss."amountMinor" AS "amountMinor",
            ss."currency" AS currency, ss."stripeCustomerId" AS "stripeCustomerId",
            ss."currentPeriodEnd" AS "currentPeriodEnd"
       FROM "User" u
       LEFT JOIN "SeekerProfile" sp ON sp."userId" = u."id"
       LEFT JOIN "SeekerSubscription" ss ON ss."seekerProfileId" = sp."id"
      WHERE u."id" = ANY($1::text[])`,
    idList,
  );

  let rows = infoRows.map((u) => {
    const cost = n(costByUser.get(u.id)?.cost);
    const tier = u.tier ?? 'free';
    const mrr = u.amountMinor != null ? n(u.amountMinor) / 100 : tierPriceUsd(card, tier);
    const periodCost = round4(cost);
    const marginUsd = round2(mrr - periodCost);
    return {
      userId: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      tier,
      status: u.status ?? 'active',
      mrrUsd: round2(mrr),
      periodCostUsd: periodCost,
      marginUsd,
      marginPct: mrr > 0 ? round2((marginUsd / mrr) * 100) : null,
      profitable: mrr > 0 ? marginUsd >= 0 : null,
      sessions: sessionsByUser.get(u.id) ?? 0,
      interviewDebits: n(costByUser.get(u.id)?.ic),
      lastActiveAt: costByUser.get(u.id)?.last?.toISOString() ?? null,
      hasStripeCustomer: !!u.stripeCustomerId,
      currentPeriodEnd: u.currentPeriodEnd?.toISOString() ?? null,
    };
  });

  // Search by email/name.
  const q = (opts.q ?? '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => r.email.toLowerCase().includes(q) || (r.name ?? '').toLowerCase().includes(q));
  }

  // Sort (JS-side — margin needs the resolved price). Default: margin ascending
  // (most-unprofitable first — the operator's first concern).
  const sort = opts.sort ?? 'marginUsd';
  const dir = opts.dir === 'desc' ? -1 : opts.sort ? (opts.dir === 'asc' ? 1 : -1) : 1;
  const cmp = (a: any, b: any): number => {
    const av = a[sort];
    const bv = b[sort];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  };
  rows.sort(cmp);

  const total = rows.length;
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 25));
  const paged = rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

  return { rows: paged, total, page, pageSize, truncated };
}

// ─── User detail ──────────────────────────────────────────────────────────────

export async function getUserDetail(userId: string, range: Range) {
  const card = await getRateCard();

  const userRows = await prisma.$queryRawUnsafe<
    {
      id: string; email: string; name: string | null; role: string; createdAt: Date; provider: string | null;
      tier: string | null; status: string | null; amountMinor: number | null; currency: string | null;
      stripeCustomerId: string | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean | null;
    }[]
  >(
    `SELECT u."id" AS id, u."email" AS email, u."name" AS name, u."role" AS role, u."createdAt" AS "createdAt",
            u."provider" AS provider,
            ss."tier"::text AS tier, ss."status" AS status, ss."amountMinor" AS "amountMinor",
            ss."currency" AS currency, ss."stripeCustomerId" AS "stripeCustomerId",
            ss."currentPeriodEnd" AS "currentPeriodEnd", ss."cancelAtPeriodEnd" AS "cancelAtPeriodEnd"
       FROM "User" u
       LEFT JOIN "SeekerProfile" sp ON sp."userId" = u."id"
       LEFT JOIN "SeekerSubscription" ss ON ss."seekerProfileId" = sp."id"
      WHERE u."id" = $1`,
    userId,
  );
  const u = userRows[0];
  if (!u) return null;
  const tier = u.tier ?? 'free';
  const mrrUsd = u.amountMinor != null ? n(u.amountMinor) / 100 : tierPriceUsd(card, tier);

  const [lifetimeRow, periodSkuRows, dailyRows, sessions] = await Promise.all([
    prisma.$queryRawUnsafe<{ cost: number }[]>(
      `SELECT COALESCE(SUM("platformCostUsd"),0) AS cost FROM "UsageDeductionLog" WHERE "userId" = $1`,
      userId,
    ),
    prisma.$queryRawUnsafe<{ sku: string; cost: number; units: number }[]>(
      `SELECT "sku", COALESCE(SUM("platformCostUsd"),0) AS cost, COALESCE(SUM("units"),0) AS units
         FROM "UsageDeductionLog"
        WHERE "userId" = $1 AND "createdAt" >= $2 AND "createdAt" < $3
        GROUP BY "sku"`,
      userId,
      range.from,
      range.to,
    ),
    prisma.$queryRawUnsafe<{ day: string; cost: number; count: number }[]>(
      `SELECT ${sqlLocalTime('"createdAt"', '$4')}::date::text AS day,
              COALESCE(SUM("platformCostUsd"),0) AS cost, COUNT(*) AS count
         FROM "UsageDeductionLog"
        WHERE "userId" = $1 AND "createdAt" >= $2 AND "createdAt" < $3
        GROUP BY day ORDER BY day ASC`,
      userId,
      range.from,
      range.to,
      range.tz,
    ),
    prisma.interviewSession.findMany({
      where: { userId, source: 'roboapply' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, role: true, status: true, durationSec: true, costUsd: true, costBreakdown: true, createdAt: true },
    }),
  ]);

  const featureMap = new Map<string, { key: string; label: string; costUsd: number; units: number }>();
  for (const r of periodSkuRows) {
    const f = featureForSku(r.sku);
    const cur = featureMap.get(f.key) ?? { key: f.key, label: f.label, costUsd: 0, units: 0 };
    cur.costUsd += n(r.cost);
    cur.units += n(r.units);
    featureMap.set(f.key, cur);
  }
  const periodCostUsd = round4(periodSkuRows.reduce((s, r) => s + n(r.cost), 0));
  const marginUsd = round2(mrrUsd - periodCostUsd);

  return {
    user: {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      provider: u.provider,
      createdAt: u.createdAt.toISOString(),
    },
    subscription: {
      tier,
      status: u.status ?? 'active',
      mrrUsd: round2(mrrUsd),
      amountMinor: u.amountMinor,
      currency: u.currency ?? 'usd',
      dailyCap: tierDailyCap(card, tier),
      stripeCustomerId: u.stripeCustomerId,
      currentPeriodEnd: u.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: u.cancelAtPeriodEnd ?? false,
    },
    profitability: {
      lifetimeCostUsd: round4(n(lifetimeRow[0]?.cost)),
      periodCostUsd,
      mrrUsd: round2(mrrUsd),
      marginUsd,
      marginPct: mrrUsd > 0 ? round2((marginUsd / mrrUsd) * 100) : null,
      profitable: mrrUsd > 0 ? marginUsd >= 0 : null,
    },
    costByFeature: Array.from(featureMap.values())
      .map((f) => ({ ...f, costUsd: round4(f.costUsd) }))
      .sort((a, b) => b.costUsd - a.costUsd),
    dailyUsage: dailyRows.map((r) => ({ day: r.day, costUsd: round4(n(r.cost)), count: n(r.count) })),
    interviewSessions: sessions.map((s) => {
      const st = stagesFromBreakdown(s.costBreakdown);
      return {
        id: s.id,
        role: s.role,
        status: s.status,
        durationSec: s.durationSec ?? 0,
        costUsd: round4(n(s.costUsd)),
        createdAt: s.createdAt.toISOString(),
        cost: { llm: round4(st.llm), stt: round4(st.stt), tts: round4(st.tts), recording: round4(st.recording) },
      };
    }),
  };
}

// ─── Interview sessions table ─────────────────────────────────────────────────

export interface SessionsQuery {
  range: Range;
  userId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export async function getSessions(opts: SessionsQuery) {
  const { from, to } = opts.range;
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 25));

  const where: string[] = [`s."createdAt" >= $1`, `s."createdAt" < $2`, `s."source" = 'roboapply'`];
  const params: unknown[] = [from, to];
  if (opts.userId) {
    params.push(opts.userId);
    where.push(`s."userId" = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`s."status" = $${params.length}`);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const rows = await prisma.$queryRawUnsafe<
    {
      id: string; userId: string; email: string | null; role: string; status: string;
      durationSec: number | null; costUsd: number | null; costBreakdown: unknown; createdAt: Date; total: number;
    }[]
  >(
    `SELECT s."id" AS id, s."userId" AS "userId", u."email" AS email, s."role" AS role, s."status" AS status,
            s."durationSec" AS "durationSec", s."costUsd" AS "costUsd", s."costBreakdown" AS "costBreakdown",
            s."createdAt" AS "createdAt", COUNT(*) OVER() AS total
       FROM "InterviewSession" s
       LEFT JOIN "User" u ON u."id" = s."userId"
      WHERE ${where.join(' AND ')}
      ORDER BY s."createdAt" DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    ...params,
  );

  const total = rows.length > 0 ? n(rows[0].total) : 0;
  return {
    rows: rows.map((s) => {
      const st = stagesFromBreakdown(s.costBreakdown);
      const b = (s.costBreakdown ?? {}) as Record<string, any>;
      return {
        id: s.id,
        userId: s.userId,
        email: s.email,
        role: s.role,
        status: s.status,
        durationSec: s.durationSec ?? 0,
        costUsd: round4(n(s.costUsd)),
        createdAt: s.createdAt.toISOString(),
        cost: {
          blueprint: round4(n(b.blueprint?.usd)),
          liveLlm: round4(n(b.live?.llm?.usd)),
          stt: round4(st.stt),
          tts: round4(st.tts),
          evaluation: round4(n(b.evaluation?.usd)),
          coach: round4(n(b.coach?.usd)),
          recording: round4(st.recording),
          total: round4(n(s.costUsd)),
        },
      };
    }),
    total,
    page,
    pageSize,
  };
}

export async function getSessionDetail(id: string) {
  const s = await prisma.interviewSession.findUnique({
    where: { id },
    select: {
      id: true, userId: true, role: true, interviewType: true, mode: true, language: true, status: true,
      durationSec: true, recordingDurationSec: true, recordingBytes: true, costUsd: true, costBreakdown: true,
      promptTokens: true, completionTokens: true, totalTokens: true, overall: true, createdAt: true, endedAt: true,
      user: { select: { email: true, name: true } },
    },
  });
  if (!s) return null;
  return {
    ...s,
    createdAt: s.createdAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
  };
}

// ─── Set plan (admin override) ─────────────────────────────────────────────────

export interface SetPlanInput {
  userId: string;
  tier: 'free' | 'premium' | 'premium_plus';
  amountMinor?: number | null;
  currency?: string | null;
  reason: string;
  adminId: string;
}

export async function setUserPlan(input: SetPlanInput) {
  const profile = await prisma.seekerProfile.findUnique({ where: { userId: input.userId }, select: { id: true } });
  if (!profile) {
    const e = new Error('User has no seeker profile');
    (e as any).code = 'no_profile';
    throw e;
  }
  const card = await getRateCard();
  const existing = await prisma.seekerSubscription.findUnique({ where: { seekerProfileId: profile.id } });
  const amountMinor =
    input.amountMinor != null ? input.amountMinor : Math.round(tierPriceUsd(card, input.tier) * 100);

  const before = existing
    ? { tier: existing.tier, status: existing.status, amountMinor: existing.amountMinor }
    : null;

  await prisma.seekerSubscription.upsert({
    where: { seekerProfileId: profile.id },
    update: {
      tier: input.tier as any,
      amountMinor,
      currency: input.currency ?? existing?.currency ?? 'usd',
      status: 'active',
    },
    create: {
      seekerProfileId: profile.id,
      tier: input.tier as any,
      amountMinor,
      currency: input.currency ?? 'usd',
      status: 'active',
    },
  });

  // Keep the mission tier + dailyCap consistent with the subscription tier.
  await prisma.roboApplyMission
    .update({
      where: { userId: input.userId },
      data: { tier: input.tier as any, dailyCap: tierDailyCap(card, input.tier) },
    })
    .catch(() => {
      /* mission may not exist for a brand-new user — non-fatal */
    });

  await prisma.adminAdjustment.create({
    data: {
      userId: input.userId,
      adminId: input.adminId,
      type: 'subscription',
      oldValue: before ? JSON.stringify(before) : null,
      newValue: JSON.stringify({ tier: input.tier, amountMinor, source: 'roboapply_admin' }),
      reason: input.reason,
    },
  });

  logger.info('RA_ADMIN', 'set user plan', {
    userId: input.userId,
    adminId: input.adminId,
    tier: input.tier,
    amountMinor,
  });

  return { ok: true, tier: input.tier, amountMinor };
}
