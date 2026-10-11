import prisma from '../../../lib/prisma.js';
import { getStripe } from '../../../platform/billing/stripeClient.js';
import { formatDateKey, sqlLocalTime } from '../../../lib/timeBuckets.js';
import { featureForSku, SHARED_COST_USER_ID } from '../lib/raFeatureCatalog.js';
import type { Range } from './RAAdminAnalyticsService.js';

export interface OperationsQuery {
  range: Range; q?: string; userId?: string; region?: string; provider?: string;
  type?: string; status?: string; currency?: string; page?: number; pageSize?: number;
}
interface PaymentRow {
  id: string; userId: string; email: string; name: string | null; provider: 'alipay' | 'stripe';
  type: string; status: string; region: string; amountMinor: number; currency: string;
  reference: string; tier: string | null; createdAt: string; paidAt: string | null;
}
type StripeCoverage = 'complete' | 'partial' | 'unavailable' | 'not_configured';
const num = (value: unknown): number => Number(value) || 0;
const iso = (value: Date | string | null): string | null => value == null ? null : new Date(value).toISOString();
const roundCost = (value: unknown): number => Math.round(num(value) * 1e6) / 1e6;
const REGION = `COALESCE(NULLIF(ss."market", ''), NULLIF(sp."market", ''), NULLIF(u."market", ''), 'unknown')`;
const USER_JOINS = `FROM "User" u LEFT JOIN "SeekerProfile" sp ON sp."userId" = u."id"
  LEFT JOIN "SeekerSubscription" ss ON ss."seekerProfileId" = sp."id"`;
// The database is shared with the recruiting product. Never include unrelated accounts.
const USER_SCOPE = `(sp."id" IS NOT NULL OR u."role" = 'admin' OR 'admin' = ANY(u."roles")
  OR EXISTS (SELECT 1 FROM "RoboApplyMission" m WHERE m."userId" = u."id"))`;

function userCte(opts: OperationsQuery, params: unknown[]) {
  const where = [USER_SCOPE, `u."id" <> '${SHARED_COST_USER_ID}'`];
  if (params.length === 2) where.push('$1::timestamp < $2::timestamp');
  const add = (value: string | undefined, condition: (parameter: string) => string) => {
    if (value) { params.push(value); where.push(condition(`$${params.length}`)); }
  };
  add(opts.userId, (p) => `u."id" = ${p}`);
  add(opts.region, (p) => `${REGION} = ${p}`);
  add(opts.q, (p) => `(u."id" ILIKE '%' || ${p} || '%' OR u."email" ILIKE '%' || ${p} || '%' OR COALESCE(u."name", '') ILIKE '%' || ${p} || '%')`);
  return `scoped_users AS (SELECT u."id", u."email", u."name", u."role", u."isActive", u."createdAt",
    ${REGION} AS region, COALESCE(ss."tier"::text, 'free') AS tier, COALESCE(ss."status", 'active') AS status,
    UPPER(ss."currency") AS currency, ss."amountMinor", ss."stripeCustomerId"
    ${USER_JOINS} WHERE ${where.join(' AND ')})`;
}

function pageOpts(opts: OperationsQuery, exporting = false) {
  return { page: Math.max(1, Math.floor(opts.page ?? 1)), pageSize: Math.min(exporting ? 10000 : 200, Math.max(1, Math.floor(opts.pageSize ?? 25))) };
}

/** Currency amounts are immutable original minor units. Never aggregate unlike currencies. */
export function summarizePayments(rows: PaymentRow[]) {
  const currencies = new Map<string, { currency: string; paidMinor: number; paidCount: number }>();
  for (const row of rows) {
    if (row.status !== 'paid') continue;
    const currency = row.currency.toUpperCase();
    const entry = currencies.get(currency) ?? { currency, paidMinor: 0, paidCount: 0 };
    entry.paidMinor += row.amountMinor;
    entry.paidCount += 1;
    currencies.set(currency, entry);
  }
  return [...currencies.values()].sort((a, b) => a.currency === 'CNY' ? -1 : b.currency === 'CNY' ? 1 : a.currency.localeCompare(b.currency));
}

/** Per-request options of the invoice scan: a short timeout and no retry, so the scan budget holds. */
const STRIPE_SCAN_REQUEST_OPTIONS = { timeout: 6000, maxNetworkRetries: 0 } as const;

/** A short in-flight cache avoids duplicate Stripe scans for summary + history. */
const paymentCache = new Map<string, { expires: number; data: Promise<{ rows: PaymentRow[]; coverage: { stripe: StripeCoverage; refundsIncluded: false } }> }>();

async function loadPaymentRows(opts: OperationsQuery) {
  const params: unknown[] = [];
  const cte = userCte(opts, params);
  const users = await prisma.$queryRawUnsafe<{ id: string; email: string; name: string | null; region: string; tier: string; stripeCustomerId: string | null }[]>(
    `WITH ${cte} SELECT * FROM scoped_users`, ...params,
  );
  const userById = new Map(users.map((u) => [u.id, u]));
  const stripeUsers = new Map(users.filter((u) => u.stripeCustomerId).map((u) => [u.stripeCustomerId!, u]));
  const orders = await prisma.alipayOrder.findMany({
    where: { userId: { in: users.map((u) => u.id) }, tier: { startsWith: 'ra_' },
      OR: [
        { completedAt: { gte: opts.range.from, lt: opts.range.to } },
        { completedAt: null, createdAt: { gte: opts.range.from, lt: opts.range.to } },
      ] },
    select: { id: true, userId: true, outTradeNo: true, tier: true, amount: true, status: true, createdAt: true, completedAt: true },
  });
  const rows: PaymentRow[] = orders.map((order) => {
    const user = userById.get(order.userId)!;
    return { id: order.id, userId: user.id, email: user.email, name: user.name,
      provider: 'alipay', type: 'plan_purchase', status: order.status === 'completed' ? 'paid' : order.status,
      // Alipay orders explicitly settle in China/CNY, independent of a later profile edit.
      region: 'cn', currency: 'CNY', amountMinor: Math.round(order.amount * 100),
      reference: order.outTradeNo, tier: order.tier.replace(/^ra_/, ''),
      createdAt: order.createdAt.toISOString(), paidAt: iso(order.completedAt) };
  });
  let stripeCoverage: StripeCoverage = stripeUsers.size === 0 ? 'complete' : 'not_configured';
  // The shared client factory decides whether Stripe may be called at all (no
  // key, or a live key outside production: null, and coverage stays
  // 'not_configured'). This scan keeps its own short timeout and no retries
  // per request, so ten pages fit the 20-second budget.
  const stripe = stripeUsers.size > 0 ? getStripe() : null;
  if (stripe) {
    stripeCoverage = 'partial';
    try {
      let after: string | undefined;
      const deadline = Date.now() + 20_000;
      // Scan older invoices too: an old invoice can be paid in the selected period.
      for (let page = 0; page < 10 && Date.now() < deadline; page++) {
        const invoices = await stripe.invoices.list(
          { limit: 100, created: { lt: Math.ceil(opts.range.to.getTime() / 1000) }, ...(after ? { starting_after: after } : {}) },
          STRIPE_SCAN_REQUEST_OPTIONS,
        );
        for (const invoice of invoices.data) {
          const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
          const user = customerId ? stripeUsers.get(customerId) : undefined;
          if (!user) continue;
          const paidAt = invoice.status_transitions.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : null;
          const createdAt = new Date(invoice.created * 1000);
          const at = paidAt ?? createdAt;
          if (at < opts.range.from || at >= opts.range.to) continue;
          const country = invoice.customer_address?.country?.toLowerCase();
          rows.push({ id: invoice.id, userId: user.id, email: user.email, name: user.name,
            provider: 'stripe', type: invoice.billing_reason === 'subscription_cycle' ? 'renewal' : 'plan_purchase',
            status: invoice.status ?? 'draft', region: country ?? user.region,
            amountMinor: invoice.status === 'paid' ? invoice.amount_paid : invoice.amount_due,
            currency: invoice.currency.toUpperCase(), reference: invoice.number ?? invoice.id,
            tier: null, createdAt: createdAt.toISOString(), paidAt: paidAt?.toISOString() ?? null });
        }
        if (!invoices.has_more) { stripeCoverage = 'complete'; break; }
        after = invoices.data.at(-1)?.id;
        if (!after) break;
      }
    } catch {
      stripeCoverage = rows.some((r) => r.provider === 'stripe') ? 'partial' : 'unavailable';
    }
  }
  return { rows, coverage: { stripe: stripeCoverage, refundsIncluded: false as const } };
}

async function filteredPayments(opts: OperationsQuery) {
  // Region applies to the payment's recorded billing region, not today's user region.
  const scope = { ...opts, region: undefined };
  const key = JSON.stringify([scope.range.from, scope.range.to, scope.userId, scope.q]);
  const cached = paymentCache.get(key);
  let data = cached && cached.expires > Date.now() ? cached.data : undefined;
  if (!data) {
    data = loadPaymentRows(scope);
    paymentCache.set(key, { expires: Date.now() + 20_000, data });
    if (paymentCache.size > 20) paymentCache.delete(paymentCache.keys().next().value!);
    data.catch(() => paymentCache.delete(key));
  }
  const result = await data;
  const rows = result.rows.filter((r) => (!opts.region || r.region === opts.region)
    && (!opts.provider || r.provider === opts.provider) && (!opts.type || r.type === opts.type)
    && (!opts.status || r.status === opts.status) && (!opts.currency || r.currency === opts.currency.toUpperCase()))
    .sort((a, b) => (b.paidAt ?? b.createdAt).localeCompare(a.paidAt ?? a.createdAt) || b.id.localeCompare(a.id));
  return { rows, coverage: result.coverage };
}

export async function getOperationsPayments(opts: OperationsQuery, exporting = false) {
  const { rows, coverage } = await filteredPayments(opts);
  const { page, pageSize } = pageOpts(opts, exporting);
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize,
    currencies: summarizePayments(rows), coverage };
}

export async function getOperationsUsers(opts: OperationsQuery, exporting = false) {
  const { page, pageSize } = pageOpts(opts, exporting);
  const params: unknown[] = [opts.range.from, opts.range.to];
  const cte = userCte(opts, params);
  const statusClause = opts.status ? `WHERE u.status = $${params.push(opts.status)}` : '';
  const totals = await prisma.$queryRawUnsafe<{ total: number }[]>(`WITH ${cte} SELECT COUNT(*) AS total FROM scoped_users u ${statusClause}`, ...params);
  const rows = await prisma.$queryRawUnsafe<Record<string, any>[]>(`WITH ${cte},
    events AS (SELECT a."userId", COUNT(*) FILTER (WHERE a."eventType" = 'login') AS logins,
      COUNT(*) FILTER (WHERE a."eventType" = 'feature_use') AS features,
      MAX(a."timestamp") AS last FROM "UserActivity" a JOIN scoped_users u ON u.id = a."userId"
      WHERE a."timestamp" >= $1 AND a."timestamp" < $2 AND a."eventType" IN ('login','signup','feature_use') GROUP BY a."userId"),
    last_login AS (SELECT a."userId", MAX(a."timestamp") AS last FROM "UserActivity" a JOIN scoped_users u ON u.id = a."userId"
      WHERE a."eventType" = 'login' GROUP BY a."userId"),
    usage AS (SELECT l."userId", SUM(l.units) AS units, SUM(l."platformCostUsd") AS cost, MAX(l."createdAt") AS last
      FROM "UsageDeductionLog" l JOIN scoped_users u ON u.id = l."userId"
      WHERE l."createdAt" >= $1 AND l."createdAt" < $2 GROUP BY l."userId")
    SELECT u.*, COALESCE(e.logins,0) AS logins, COALESCE(e.features,0) AS features,
      COALESCE(l.units,0) AS units, COALESCE(l.cost,0) AS cost, last_login.last AS "lastLoginAt", GREATEST(e.last,l.last) AS "lastActiveAt"
    FROM scoped_users u LEFT JOIN events e ON e."userId"=u.id LEFT JOIN usage l ON l."userId"=u.id
    LEFT JOIN last_login ON last_login."userId"=u.id ${statusClause}
    ORDER BY "lastActiveAt" DESC NULLS LAST, u."createdAt" DESC, u.id
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, ...params, pageSize, (page - 1) * pageSize);
  return { rows: rows.map((r) => ({ userId: r.id, email: r.email, name: r.name, role: r.role, isActive: r.isActive,
    region: r.region, tier: r.tier, status: r.status, createdAt: iso(r.createdAt),
    subscription: { currency: r.currency, amountMinor: r.amountMinor }, loginEvents: num(r.logins), featureEvents: num(r.features),
    usageUnits: num(r.units), periodCostUsd: roundCost(r.cost), lastLoginAt: iso(r.lastLoginAt), lastActiveAt: iso(r.lastActiveAt) })),
    total: num(totals[0]?.total), page, pageSize };
}

function activityCte(opts: OperationsQuery, params: unknown[]) {
  const cte = userCte(opts, params);
  return `${cte}, activity AS (
    SELECT 'activity:' || a.id AS id, a."userId", a."eventType" AS type, a.element AS feature, a.path,
      NULL::int AS units, NULL::double precision AS "costUsd", 'activity' AS source, a.timestamp AS "createdAt"
    FROM "UserActivity" a JOIN scoped_users u ON u.id = a."userId"
    WHERE a.timestamp >= $1 AND a.timestamp < $2 AND a."eventType" IN ('login', 'signup', 'feature_use')
    UNION ALL
    SELECT 'usage:' || l.id, l."userId", 'usage_debit', l.sku, NULL::text, l.units, l."platformCostUsd", 'usage_ledger', l."createdAt"
    FROM "UsageDeductionLog" l JOIN scoped_users u ON u.id = l."userId"
    WHERE l."createdAt" >= $1 AND l."createdAt" < $2)`;
}

export async function getOperationsActivity(opts: OperationsQuery, exporting = false) {
  const { page, pageSize } = pageOpts(opts, exporting);
  const params: unknown[] = [opts.range.from, opts.range.to];
  const cte = activityCte(opts, params);
  const where = opts.type ? `WHERE a.type = $${params.push(opts.type)}` : '';
  const totals = await prisma.$queryRawUnsafe<{ total: number }[]>(`WITH ${cte} SELECT COUNT(*) AS total FROM activity a ${where}`, ...params);
  const rows = await prisma.$queryRawUnsafe<Record<string, any>[]>(`WITH ${cte}
    SELECT a.*, u.email, u.name, u.region FROM activity a JOIN scoped_users u ON u.id = a."userId" ${where}
    ORDER BY a."createdAt" DESC, a.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    ...params, pageSize, (page - 1) * pageSize);
  return { rows: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt), units: r.units == null ? null : num(r.units),
    costUsd: r.costUsd == null ? null : roundCost(r.costUsd) })), total: num(totals[0]?.total), page, pageSize };
}

export async function getOperationsOverview(opts: OperationsQuery) {
  const params: unknown[] = [opts.range.from, opts.range.to];
  const cte = activityCte(opts, params);
  const [counts, series, features, regions, payments, tracking, shared] = await Promise.all([
    prisma.$queryRawUnsafe<Record<string, any>[]>(`WITH ${cte} SELECT
      (SELECT COUNT(*) FROM scoped_users) AS total,
      (SELECT COUNT(*) FROM scoped_users WHERE "createdAt" >= $1 AND "createdAt" < $2) AS new,
      COUNT(DISTINCT "userId") FILTER (WHERE type <> 'signup') AS active,
      COUNT(DISTINCT "userId") FILTER (WHERE type='login') AS "loginUsers",
      COUNT(*) FILTER (WHERE type='login') AS "loginEvents",
      COUNT(*) FILTER (WHERE type='feature_use') AS "featureEvents",
      COALESCE(SUM("costUsd"),0) AS cost FROM activity`, ...params),
    prisma.$queryRawUnsafe<Record<string, any>[]>(`WITH ${cte} SELECT ${sqlLocalTime('a."createdAt"', `$${params.length + 1}`)}::date::text AS day,
      COUNT(*) FILTER (WHERE type='login') AS logins, COUNT(*) FILTER (WHERE type='feature_use') AS features,
      COUNT(DISTINCT "userId") FILTER (WHERE type <> 'signup') AS active FROM activity a GROUP BY day ORDER BY day`, ...params, opts.range.tz),
    prisma.$queryRawUnsafe<Record<string, any>[]>(`WITH ${cte} SELECT feature AS key, source, COUNT(*) AS events,
      ARRAY_AGG(DISTINCT "userId") AS "userIds", COALESCE(SUM(units),0) AS units, COALESCE(SUM("costUsd"),0) AS cost
      FROM activity WHERE type IN ('feature_use','usage_debit') GROUP BY feature, source ORDER BY events DESC`, ...params),
    prisma.$queryRawUnsafe<{ region: string; users: number }[]>(`WITH ${cte} SELECT region, COUNT(*) AS users FROM scoped_users GROUP BY region ORDER BY users DESC`, ...params),
    filteredPayments(opts),
    prisma.$queryRawUnsafe<{ since: Date | null }[]>(`WITH ${cte} SELECT MIN(a."timestamp") AS since FROM "UserActivity" a JOIN scoped_users u ON u.id = a."userId" WHERE a."eventType" IN ('login', 'feature_use')`, ...params),
    opts.userId || opts.region || opts.q ? Promise.resolve([]) : prisma.$queryRawUnsafe<{ cost: number }[]>(
      `SELECT COALESCE(SUM("platformCostUsd"),0) AS cost FROM "UsageDeductionLog" WHERE "userId"=$1 AND "createdAt">=$2 AND "createdAt"<$3`,
      SHARED_COST_USER_ID, opts.range.from, opts.range.to),
  ]);
  const count = counts[0] ?? {};
  const paid = payments.rows.filter((r) => r.status === 'paid');
  const featureMap = new Map<string, { key: string; source: 'usage_ledger' | 'feature_event'; events: number; users: Set<string>; units: number; costUsd: number }>();
  for (const row of features) {
    const key = row.source === 'usage_ledger' ? featureForSku(row.key).key : row.key;
    const source = row.source === 'activity' ? 'feature_event' : 'usage_ledger';
    const entry = featureMap.get(`${source}:${key}`) ?? { key, source, events: 0, users: new Set<string>(), units: 0, costUsd: 0 };
    entry.events += num(row.events);
    entry.units += num(row.units);
    entry.costUsd += num(row.cost);
    for (const id of (row.userIds ?? []) as string[]) entry.users.add(id);
    featureMap.set(`${source}:${key}`, entry);
  }
  const byDay = new Map(series.map((r) => [r.day, r]));
  const activitySeries: { day: string; logins: number; featureEvents: number; activeUsers: number }[] = [];
  const finalDay = formatDateKey(new Date(opts.range.to.getTime() - 1), opts.range.tz);
  const day = new Date(`${formatDateKey(opts.range.from, opts.range.tz)}T00:00:00Z`);
  while (day.toISOString().slice(0, 10) <= finalDay) {
    const key = day.toISOString().slice(0, 10);
    const row = byDay.get(key);
    activitySeries.push({ day: key, logins: num(row?.logins), featureEvents: num(row?.features), activeUsers: num(row?.active) });
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return {
    range: { from: opts.range.from.toISOString(), to: opts.range.to.toISOString(), tz: opts.range.tz },
    users: { total: num(count.total), new: num(count.new), active: num(count.active), loginUsers: num(count.loginUsers),
      loginEvents: num(count.loginEvents), featureEvents: num(count.featureEvents), payingUsers: new Set(paid.map((p) => p.userId)).size },
    payments: { currencies: summarizePayments(payments.rows), total: payments.rows.length, paid: paid.length,
      pending: payments.rows.filter((r) => ['pending','open','draft'].includes(r.status)).length,
      failed: payments.rows.filter((r) => ['failed','uncollectible'].includes(r.status)).length, coverage: payments.coverage },
    costUsd: roundCost(num(count.cost) + num(shared[0]?.cost)),
    activitySeries,
    featureUsage: [...featureMap.values()].map((r) => ({ ...r, users: r.users.size, costUsd: roundCost(r.costUsd) })).sort((a,b) => b.events - a.events),
    regions: regions.map((r) => ({ region: r.region, users: num(r.users) })), trackingSince: iso(tracking[0]?.since ?? null),
  };
}
