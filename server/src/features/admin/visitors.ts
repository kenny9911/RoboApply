// server/src/features/admin/visitors.ts — "Visitors and sign-ups": how many
// visitors came, where from, and how many became accounts.
//
// Source: RAVisitor (one row per linked visitor, written by the events ingest;
// growth/visitors.ts). The report is a cohort: the visitors FIRST SEEN in the
// range, and how far each has got since (opened sign-up → started → account →
// finished setup). Visitors who already had an account when first seen are
// counted apart (`knownUsers`) and left out of the funnel.
//
// Two numbers put the funnel in context, because not every visit has a
// visitor row (growth/visitors.ts explains why):
//   - `untrackedVisits`: page loads counted without a visitor id (a RoboApply
//     visitor in the EEA, the UK or Switzerland before or without consent);
//   - `newAccounts`: every account created in the range, matched or not.
//
// Every number is a live query (no caching, no estimates). While the table is
// not in the database yet the report answers `ready: false` with zeros.

import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { formatDateKey, resolveTimeZone } from '../../lib/timeBuckets.js';
import { httpError } from '../../platform/http.js';
import {
  MAX_VISITOR_DAYS,
  type VisitorBreakdownRow,
  type VisitorDayRow,
  type VisitorFunnel,
  type VisitorListResponse,
  type VisitorStatus,
  type VisitorView,
  type VisitorsReportResponse,
} from './contract.js';

const DAY_MS = 24 * 60 * 60_000;
export const DEFAULT_VISITOR_DAYS = 30;
export const VISITORS_PAGE_SIZE = 25;
/** Rows per breakdown table. */
export const VISITOR_BREAKDOWN_ROWS = 12;

export interface VisitorRange {
  from: Date;
  /** Exclusive. */
  to: Date;
  tz: string;
}

export interface VisitorScope extends VisitorRange {
  brand?: string;
}

export const VISITOR_DIMENSIONS = ['channel', 'source', 'landing', 'country', 'device', 'method'] as const;
export type VisitorDimension = (typeof VISITOR_DIMENSIONS)[number];

export interface VisitorTotals extends VisitorFunnel {
  knownUsers: number;
  pageViews: number;
  medianSecondsToSignup: number | null;
}

export interface VisitorListRow {
  id: string;
  brand: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  channel: string;
  landingPath: string | null;
  referrerHost: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  country: string | null;
  device: string | null;
  locale: string | null;
  pageViews: number;
  visits: number;
  signupViewedAt: Date | null;
  signupFrom: string | null;
  signupStartedAt: Date | null;
  signupMethod: string | null;
  signedUpAt: Date | null;
  knownUser: boolean;
  user: { id: string; email: string; name: string | null } | null;
  /** The linked account finished setup. */
  onboarded: boolean;
}

export interface VisitorReportStore {
  totals(scope: VisitorScope): Promise<VisitorTotals>;
  /** Days that have visitors (the report fills the others with zeros). */
  daily(scope: VisitorScope): Promise<VisitorDayRow[]>;
  breakdown(scope: VisitorScope, dimension: VisitorDimension, take: number): Promise<VisitorBreakdownRow[]>;
  untrackedVisits(scope: VisitorScope): Promise<number>;
  newAccounts(scope: VisitorScope): Promise<number>;
  list(scope: VisitorScope, filter: { status?: VisitorStatus; channel?: string }, page: { skip: number; take: number }): Promise<VisitorListRow[]>;
}

// ── Range ────────────────────────────────────────────────────────────────

/** The instant a calendar day starts in `tz`. */
function dayStart(day: string, tz: string): Date {
  const target = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== day) return new Date(Number.NaN);
  const format = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const parts = format.formatToParts(new Date(guess));
    const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const delta = target - Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess);
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Resolve `from`/`to` to instants. A day (YYYY-MM-DD) is read in `tz` and
 * `to` includes that whole day; an ISO instant is taken as is (`to`
 * exclusive). Default: the last 30 days, ending now.
 */
export function resolveVisitorRange(input: { from?: string; to?: string; tz?: string }, now: Date = new Date()): VisitorRange {
  const tz = resolveTimeZone(input.tz);
  const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const parse = (raw: string, end: boolean) => (isDay(raw) ? dayStart(end ? addDays(raw, 1) : raw, tz) : new Date(raw));
  const to = input.to ? parse(input.to, true) : now;
  const from = input.from ? parse(input.from, false) : dayStart(addDays(formatDateKey(to, tz), -(DEFAULT_VISITOR_DAYS - 1)), tz);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) throw httpError('invalid_request', 'Use dates like 2026-10-01.');
  if (from >= to) throw httpError('invalid_request', 'The start date is after the end date.');
  if (to.getTime() - from.getTime() > MAX_VISITOR_DAYS * DAY_MS) throw httpError('invalid_request', `Choose at most ${MAX_VISITOR_DAYS} days.`);
  return { from, to, tz };
}

/** Every calendar day of the range in `tz`, oldest first. */
export function daysOfRange(range: VisitorRange): string[] {
  const first = formatDateKey(range.from, range.tz);
  const last = formatDateKey(new Date(range.to.getTime() - 1), range.tz);
  const out: string[] = [];
  for (let day = first; day <= last && out.length <= MAX_VISITOR_DAYS + 1; day = addDays(day, 1)) out.push(day);
  return out;
}

// ── Pure builders ────────────────────────────────────────────────────────

const ZERO_FUNNEL = (): VisitorFunnel => ({ visitors: 0, signupViewed: 0, signupStarted: 0, signedUp: 0, onboarded: 0 });

/** The furthest stage a visitor reached. */
export function visitorStatus(row: Pick<VisitorListRow, 'knownUser' | 'signedUpAt' | 'signupStartedAt' | 'signupViewedAt' | 'onboarded'>): VisitorStatus {
  if (row.knownUser) return 'known_user';
  if (row.signedUpAt) return row.onboarded ? 'onboarded' : 'signed_up';
  if (row.signupStartedAt) return 'signup_started';
  if (row.signupViewedAt) return 'signup_viewed';
  return 'browsing';
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toVisitorView(row: VisitorListRow): VisitorView {
  return {
    id: row.id,
    brand: row.brand,
    status: visitorStatus(row),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    channel: row.channel,
    source: row.utmSource || row.referrerHost || null,
    campaign: row.utmCampaign,
    landingPath: row.landingPath,
    country: row.country,
    device: row.device,
    locale: row.locale,
    pageViews: row.pageViews,
    visits: row.visits,
    signupFrom: row.signupFrom,
    signupMethod: row.signupMethod,
    signupViewedAt: iso(row.signupViewedAt),
    signupStartedAt: iso(row.signupStartedAt),
    signedUpAt: iso(row.signedUpAt),
    user: row.user,
  };
}

function emptyReport(range: VisitorRange, ready: boolean): VisitorsReportResponse {
  return {
    ready,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    tz: range.tz,
    funnel: ZERO_FUNNEL(),
    knownUsers: 0,
    pageViews: 0,
    medianSecondsToSignup: null,
    untrackedVisits: 0,
    newAccounts: 0,
    daily: daysOfRange(range).map((day) => ({ day, ...ZERO_FUNNEL() })),
    channels: [],
    sources: [],
    landingPages: [],
    countries: [],
    devices: [],
    methods: [],
  };
}

/** Prisma: the table (P2021) or a column (P2022) is not in the database yet; raw queries say 42P01. */
export function isMissingVisitorTable(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  if (e?.code === 'P2021' || e?.code === 'P2022') return true;
  if (e?.code === 'P2010' && (e.meta?.code === '42P01' || e.meta?.code === '42703')) return true;
  return typeof e?.message === 'string' && /relation "RAVisitor" does not exist/i.test(e.message);
}

export async function getVisitorsReport(
  store: VisitorReportStore,
  input: { from?: string; to?: string; tz?: string; brand?: string },
  now?: Date,
): Promise<VisitorsReportResponse> {
  const range = resolveVisitorRange(input, now);
  const scope: VisitorScope = { ...range, brand: input.brand };
  // The two context counts read other tables, so they are answered even while the visitor table is missing.
  const context = Promise.all([store.untrackedVisits(scope), store.newAccounts(scope)]);
  let parts: [VisitorTotals, VisitorDayRow[], ...VisitorBreakdownRow[][]];
  try {
    parts = await Promise.all([
      store.totals(scope),
      store.daily(scope),
      ...VISITOR_DIMENSIONS.map((d) => store.breakdown(scope, d, VISITOR_BREAKDOWN_ROWS)),
    ]);
  } catch (err) {
    if (!isMissingVisitorTable(err)) throw err;
    const [untrackedVisits, newAccounts] = await context;
    return { ...emptyReport(range, false), untrackedVisits, newAccounts };
  }
  const [untrackedVisits, newAccounts] = await context;
  const [totals, daily, channels, sources, landingPages, countries, devices, methods] = parts;
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const { knownUsers, pageViews, medianSecondsToSignup, ...funnel } = totals;
  return {
    ready: true,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    tz: range.tz,
    funnel,
    knownUsers,
    pageViews,
    medianSecondsToSignup: medianSecondsToSignup === null ? null : Math.round(medianSecondsToSignup),
    untrackedVisits,
    newAccounts,
    daily: daysOfRange(range).map((day) => byDay.get(day) ?? { day, ...ZERO_FUNNEL() }),
    channels,
    sources,
    landingPages,
    countries,
    devices,
    methods,
  };
}

export async function listVisitors(
  store: VisitorReportStore,
  input: { from?: string; to?: string; tz?: string; brand?: string; status?: VisitorStatus; channel?: string; cursor?: string },
  now?: Date,
): Promise<VisitorListResponse> {
  const range = resolveVisitorRange(input, now);
  const skip = input.cursor?.startsWith('o:') ? Math.max(0, Math.floor(Number(input.cursor.slice(2))) || 0) : 0;
  let rows: VisitorListRow[];
  try {
    // One more than a page, to know whether another page follows.
    rows = await store.list({ ...range, brand: input.brand }, { status: input.status, channel: input.channel }, { skip, take: VISITORS_PAGE_SIZE + 1 });
  } catch (err) {
    if (!isMissingVisitorTable(err)) throw err;
    return { ready: false, items: [], cursor: null };
  }
  const more = rows.length > VISITORS_PAGE_SIZE;
  return { ready: true, items: rows.slice(0, VISITORS_PAGE_SIZE).map(toVisitorView), cursor: more ? `o:${skip + VISITORS_PAGE_SIZE}` : null };
}

// ── Prisma implementation ────────────────────────────────────────────────

type Db = Pick<typeof prisma, '$queryRaw' | 'rAVisitor' | 'seekerProfile' | 'user'>;

const num = (v: unknown): number => {
  const x = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/**
 * A UTC instant as a `timestamp` literal. Columns hold UTC wall time
 * (`timestamp without time zone`); the cast ignores the trailing `Z`, so the
 * comparison does not depend on the database session's time zone.
 */
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

// Each stage includes the later ones, so the funnel never grows from stage to stage.
const SIGNED = Prisma.sql`v."signedUpAt" IS NOT NULL`;
const STARTED = Prisma.sql`(v."signupStartedAt" IS NOT NULL OR v."signedUpAt" IS NOT NULL)`;
const VIEWED = Prisma.sql`(v."signupViewedAt" IS NOT NULL OR v."signupStartedAt" IS NOT NULL OR v."signedUpAt" IS NOT NULL)`;
// Setup is finished when the profile's onboarding stage is 'done' (the stage machine's last stage).
const PROFILE_DONE = Prisma.sql`(sp."id" IS NOT NULL AND sp."deletedAt" IS NULL AND sp."onboardingStep" = 'done')`;

const DIMENSION_SQL: Record<VisitorDimension, Prisma.Sql> = {
  channel: Prisma.sql`v."channel"`,
  source: Prisma.sql`COALESCE(NULLIF(v."utmSource", ''), v."referrerHost")`,
  landing: Prisma.sql`v."landingPath"`,
  country: Prisma.sql`v."country"`,
  device: Prisma.sql`v."device"`,
  method: Prisma.sql`v."signupMethod"`,
};

function cohort(scope: VisitorScope): Prisma.Sql {
  return Prisma.sql`v."firstSeenAt" >= ${ts(scope.from)} AND v."firstSeenAt" < ${ts(scope.to)} ${scope.brand ? Prisma.sql`AND v."brand" = ${scope.brand}` : Prisma.empty}`;
}

/** The `where` of one status, for the typed list query. */
export function statusWhere(status: VisitorStatus | undefined): Prisma.RAVisitorWhereInput {
  const done: Prisma.SeekerProfileWhereInput = { deletedAt: null, onboardingStep: 'done' };
  switch (status) {
    case 'known_user':
      return { knownUser: true };
    case 'onboarded':
      return { knownUser: false, signedUpAt: { not: null }, user: { is: { seekerProfile: { is: done } } } };
    case 'signed_up':
      return { knownUser: false, signedUpAt: { not: null }, NOT: { user: { is: { seekerProfile: { is: done } } } } };
    case 'signup_started':
      return { knownUser: false, signedUpAt: null, signupStartedAt: { not: null } };
    case 'signup_viewed':
      return { knownUser: false, signedUpAt: null, signupStartedAt: null, signupViewedAt: { not: null } };
    case 'browsing':
      return { knownUser: false, signedUpAt: null, signupStartedAt: null, signupViewedAt: null };
    default:
      return {};
  }
}

export function createPrismaVisitorReportStore(db: Db = prisma): VisitorReportStore {
  return {
    async totals(scope) {
      const rows = await db.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
          COUNT(*) FILTER (WHERE v."knownUser") AS known_users,
          COUNT(*) FILTER (WHERE NOT v."knownUser") AS visitors,
          COUNT(*) FILTER (WHERE NOT v."knownUser" AND ${VIEWED}) AS signup_viewed,
          COUNT(*) FILTER (WHERE NOT v."knownUser" AND ${STARTED}) AS signup_started,
          COUNT(*) FILTER (WHERE NOT v."knownUser" AND ${SIGNED}) AS signed_up,
          COUNT(*) FILTER (WHERE NOT v."knownUser" AND ${SIGNED} AND ${PROFILE_DONE}) AS onboarded,
          COALESCE(SUM(v."pageViews") FILTER (WHERE NOT v."knownUser"), 0) AS page_views,
          (percentile_cont(0.5) WITHIN GROUP (ORDER BY GREATEST(EXTRACT(EPOCH FROM (v."signedUpAt" - v."firstSeenAt")), 0))
            FILTER (WHERE NOT v."knownUser" AND ${SIGNED}))::float8 AS median_secs
        FROM "RAVisitor" v
        LEFT JOIN "SeekerProfile" sp ON sp."userId" = v."userId"
        WHERE ${cohort(scope)}`;
      const r = rows[0] ?? {};
      return {
        visitors: num(r.visitors),
        signupViewed: num(r.signup_viewed),
        signupStarted: num(r.signup_started),
        signedUp: num(r.signed_up),
        onboarded: num(r.onboarded),
        knownUsers: num(r.known_users),
        pageViews: num(r.page_views),
        medianSecondsToSignup: r.median_secs === null || r.median_secs === undefined ? null : num(r.median_secs),
      };
    },

    async daily(scope) {
      const rows = await db.$queryRaw<Array<Record<string, unknown>>>`
        SELECT to_char((v."firstSeenAt" AT TIME ZONE 'UTC') AT TIME ZONE ${scope.tz}, 'YYYY-MM-DD') AS day,
          COUNT(*) AS visitors,
          COUNT(*) FILTER (WHERE ${VIEWED}) AS signup_viewed,
          COUNT(*) FILTER (WHERE ${STARTED}) AS signup_started,
          COUNT(*) FILTER (WHERE ${SIGNED}) AS signed_up,
          COUNT(*) FILTER (WHERE ${SIGNED} AND ${PROFILE_DONE}) AS onboarded
        FROM "RAVisitor" v
        LEFT JOIN "SeekerProfile" sp ON sp."userId" = v."userId"
        WHERE ${cohort(scope)} AND NOT v."knownUser"
        GROUP BY 1
        ORDER BY 1`;
      return rows.map((r) => ({
        day: String(r.day),
        visitors: num(r.visitors),
        signupViewed: num(r.signup_viewed),
        signupStarted: num(r.signup_started),
        signedUp: num(r.signed_up),
        onboarded: num(r.onboarded),
      }));
    },

    async breakdown(scope, dimension, take) {
      const expr = DIMENSION_SQL[dimension];
      // Sign-up methods: of those who started (the method is unknown before that).
      const extra = dimension === 'method' ? Prisma.sql`AND ${STARTED}` : Prisma.empty;
      const rows = await db.$queryRaw<Array<Record<string, unknown>>>`
        SELECT ${expr} AS key, COUNT(*) AS visitors, COUNT(*) FILTER (WHERE ${SIGNED}) AS signed_up
        FROM "RAVisitor" v
        WHERE ${cohort(scope)} AND NOT v."knownUser" ${extra}
        GROUP BY 1
        ORDER BY 2 DESC, 3 DESC, 1 ASC NULLS LAST
        LIMIT ${take}`;
      return rows.map((r) => ({ key: typeof r.key === 'string' && r.key ? r.key : null, visitors: num(r.visitors), signedUp: num(r.signed_up) }));
    },

    async untrackedVisits(scope) {
      // Page loads without a visitor id: the client's in-memory visit id groups one load and nothing more.
      const rows = await db.$queryRaw<Array<{ n: bigint | number }>>`
        SELECT COUNT(DISTINCT e."props"->>'sessionId') AS n
        FROM "RAProductEvent" e
        WHERE e."name" = 'page_viewed' AND e."anonId" IS NULL
          AND e."createdAt" >= ${ts(scope.from)} AND e."createdAt" < ${ts(scope.to)}
          ${scope.brand ? Prisma.sql`AND e."brand" = ${scope.brand}` : Prisma.empty}`;
      return num(rows[0]?.n);
    },

    newAccounts(scope) {
      return db.user.count({ where: { createdAt: { gte: scope.from, lt: scope.to }, ...(scope.brand ? { brand: scope.brand } : {}) } });
    },

    async list(scope, filter, page) {
      const where: Prisma.RAVisitorWhereInput = {
        firstSeenAt: { gte: scope.from, lt: scope.to },
        ...(scope.brand ? { brand: scope.brand } : {}),
        ...(filter.channel ? { channel: filter.channel } : {}),
        ...statusWhere(filter.status),
      };
      const rows = await db.rAVisitor.findMany({
        where,
        orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
        skip: page.skip,
        take: page.take,
        include: { user: { select: { id: true, email: true, name: true } } },
      });
      const userIds = rows.flatMap((r) => (r.userId ? [r.userId] : []));
      const profiles = userIds.length
        ? await db.seekerProfile.findMany({ where: { userId: { in: userIds } }, select: { userId: true, onboardingStep: true, deletedAt: true } })
        : [];
      const done = new Set(profiles.filter((p) => !p.deletedAt && p.onboardingStep === 'done').map((p) => p.userId));
      return rows.map((r) => ({
        id: r.id,
        brand: r.brand,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        channel: r.channel,
        landingPath: r.landingPath,
        referrerHost: r.referrerHost,
        utmSource: r.utmSource,
        utmCampaign: r.utmCampaign,
        country: r.country,
        device: r.device,
        locale: r.locale,
        pageViews: r.pageViews,
        visits: r.visits,
        signupViewedAt: r.signupViewedAt,
        signupFrom: r.signupFrom,
        signupStartedAt: r.signupStartedAt,
        signupMethod: r.signupMethod,
        signedUpAt: r.signedUpAt,
        knownUser: r.knownUser,
        user: r.user,
        onboarded: !!r.userId && done.has(r.userId),
      }));
    },
  };
}
