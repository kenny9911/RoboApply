// server/src/features/feed/payCheck.ts — the pay check: what live, recent
// posts in the reader's market state about pay for a job title (GET
// /feed/pay-check; resume.io's Salary Analyzer, from our own index only, D3).
//
// No provider, no estimate, no model: the stated pay of the posts we hold.
// The answer says what it read (counts, window, how the title and place
// matched) and never predicts an offer.
//
// Rows. The job search's own list scope (sql.ts `scopePredicates` with
// `publicOnly`): market = brand.market, public, canonical, not archived, not
// closed, not the demo seed corpus, not fraud-flagged; on GoApply only posts
// with a usable apply link. Users' own imports never count. Rows that owe an
// open-data credit line (`CREDIT_LINE_BOARDS`, 台灣就業通) are held out: this
// page cannot print the line their licence asks for. Window: first seen in the
// last PAY_CHECK_WINDOW_DAYS days, and posted in them when the post states a
// date. GoApply with CN_RECRUITMENT_INFO_MODE=off shows no third-party post,
// so the check is not available there (the route's `jobs.feed` gate answers
// 404 first; the service refuses the same way for any other caller).
//
// Title. Matched the way the job search matches a saved search's titles: the
// same predicate (sql.ts `predicateFor('titles')`), i.e. posts tagged with the
// taxonomy role the title names, with its sub-roles (`roleTaxonomyIds`), OR
// whose normalized title contains the typed one. With no role match, the
// text half alone. `titleMatch` says which.
//
// Place (optional; `resolvePlace`). "remote" (or a location that says so):
// remote posts, open to the country when one is named. A city of the city
// table: that city by any of its names, in its country (the job search's
// same-city rule, without its remote pass: pay is compared for the place).
// A region or a country: posts located there. A place the tables do not know:
// posts whose own location text contains the words.
//
// Pay. A post states pay when it is disclosed (TW-03: 面議 is not), in a
// currency, with a yearly figure (`salaryAnnualMin/Max`: hour × 2080, day ×
// 260, week × 52, month × 12 or × the months the post states), and the stated
// figures can be pay (`payPlausible`, the rule every reader applies to stored
// rows). Its value is the middle of its yearly range (or the one end it
// states). Quartiles per currency, never across currencies (the figures are
// all yearly, so periods never mix). A currency with fewer than MIN_SAMPLE
// (20, the shared one-sample rule) posts stating pay carries its count only.
//
// Bounded. One statement, newest first, at most PAY_CHECK_ROW_CAP + 1 rows
// (the extra row only tells `capped`). The scope's equality columns and the
// window ride RAJob(market, isCanonical, archivedAt, firstSeenAt DESC), so the
// read walks that index in order and stops at the cap (indexProof.ts
// `payCheck`). Only the pay columns come back: no ids, no text.

import { Prisma } from '../../generated/prisma/client.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { Market } from '../../platform/brand/registry.js';
import { cnRecruitmentInfoMode } from '../../platform/flags.js';
import { HttpError, MIN_SAMPLE, meetsMinSample, type Sourced } from '../../platform/http.js';
import { parseLocation, resolveCountry, subdivision, subdivisionCountries } from '../jobs/geo/index.js';
import { normalizeJobTitle, payPlausible } from '../jobs/normalize/index.js';
import { matchTitle, taxonomyLabel } from '../jobs/taxonomy/index.js';
import {
  PAY_CHECK_ROW_CAP,
  PAY_CHECK_WINDOW_DAYS,
  type PayCheckCurrency,
  type PayCheckPlace,
  type PayCheckResponse,
  type PayCheckTitleMatch,
} from './contract.js';
import { CREDIT_LINE_BOARDS } from './sourceLine.js';
import { predicateFor, roleTaxonomyIds, scopePredicates, type SqlScope } from './sql.js';

const DAY_MS = 86_400_000;

/** The pay columns of one post (all a pay check reads). */
export interface PayCheckRow {
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryMonths: number | null;
  salaryAnnualMin: number | null;
  salaryAnnualMax: number | null;
  salaryDisclosed: boolean;
}

/** A place, resolved: what the answer reports and the predicate that narrows the rows. */
export interface ResolvedPlace {
  place: PayCheckPlace;
  sql: Prisma.Sql;
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const lowerNames = (names: ReadonlyArray<string | null | undefined>): string[] => [
  ...new Set(names.map((n) => (n ?? '').normalize('NFKC').trim().toLowerCase()).filter(Boolean)),
];

/** "Texas", "California": a subdivision name that belongs to one country only. */
function soleSubdivision(text: string) {
  const countries = subdivisionCountries(text);
  return countries.length === 1 ? subdivision(countries[0]!, text) : null;
}

/** Posts located in a region of a country, by its code or its name (RAJob.locationRegion holds the code). */
function regionSql(country: string, code: string, name: string | null): Prisma.Sql {
  return Prisma.sql`(j."locationCountry" = ${country} AND lower(j."locationRegion") = ANY(${lowerNames([code, name])}::text[]))`;
}

/**
 * The place a location names, and the predicate for it; null for an empty
 * location (anywhere in the market) or one with no letters or digits. Pure.
 */
export function resolvePlace(location: string | null | undefined): ResolvedPlace | null {
  const input = location?.normalize('NFKC').trim() ?? '';
  if (!input) return null;
  const parsed = parseLocation(input);
  const country = parsed.country ?? null;

  if (parsed.workModel === 'remote') {
    const sql = country
      ? Prisma.sql`(j."workModel" = 'remote' AND (j."locationCountry" = ${country} OR j."remoteScope" = ${country} OR j."remoteScope" = 'global'))`
      : Prisma.sql`j."workModel" = 'remote'`;
    return { place: { input, kind: 'remote', name: null, country }, sql };
  }
  if (parsed.city) {
    const city = parsed.city;
    const names = lowerNames([city.name, city.zh, city.zhHant, ...(city.aliases ?? []), parsed.cityName]);
    return {
      place: { input, kind: 'city', name: city.name, country: city.country },
      sql: Prisma.sql`(lower(j."locationCity") = ANY(${names}::text[]) AND (j."locationCountry" IS NULL OR j."locationCountry" = ${city.country}))`,
    };
  }
  if (parsed.region && country) {
    const sub = subdivision(country, parsed.region);
    return { place: { input, kind: 'region', name: sub?.name ?? parsed.region, country }, sql: regionSql(country, parsed.region, sub?.name ?? null) };
  }
  if (country && !parsed.cityName) {
    return { place: { input, kind: 'country', name: null, country }, sql: Prisma.sql`j."locationCountry" = ${country}` };
  }
  // A word the city table does not hold may still be a region of one country ("Texas", "California"), or a country.
  const sub = country ? null : soleSubdivision(input);
  if (sub) return { place: { input, kind: 'region', name: sub.name, country: sub.country }, sql: regionSql(sub.country, sub.code, sub.name) };
  const named = country ? null : resolveCountry(input);
  if (named) return { place: { input, kind: 'country', name: null, country: named.code }, sql: Prisma.sql`j."locationCountry" = ${named.code}` };
  // Not a place the tables know: the post's own location text (or its city, as the post wrote it), in the country
  // the location names when it names one ("Springfield, US").
  const words = input.toLowerCase().replace(/\s+/g, ' ');
  if (!/[\p{L}\p{N}]/u.test(words)) return null;
  const cityWords = (parsed.cityName ?? input).normalize('NFKC').trim().toLowerCase();
  const text = Prisma.sql`(j."location" ILIKE ${`%${likeEscape(words)}%`} OR lower(j."locationCity") = ${cityWords})`;
  return {
    place: { input, kind: 'text', name: null, country },
    sql: country ? Prisma.sql`(${text} AND j."locationCountry" = ${country})` : text,
  };
}

/** How a title matches (the job search's rule; see the header). Pure. */
export function titleMatchOf(title: string, locale: string): PayCheckTitleMatch {
  const text = normalizeJobTitle(title) || title.trim().toLowerCase();
  const ids = roleTaxonomyIds({ titles: [title] });
  const role = ids.length ? (matchTitle(title, { limit: 1 })[0] ?? null) : null;
  if (!role) return { method: 'text', roleId: null, roleLabel: null, text };
  return { method: 'role', roleId: role.id, roleLabel: taxonomyLabel(role.id, locale), text };
}

export interface PayCheckSqlInput {
  market: Market;
  title: string;
  /** The place predicate (`resolvePlace(...).sql`), or null for anywhere. */
  place: Prisma.Sql | null;
  /** Start of the window. */
  since: Date;
  now: Date;
  /** Rows to read; the statement asks for one more, which only tells "capped". */
  limit: number;
}

/** The one statement a pay check runs (pure; `payCheck.test.ts` reads it and the index proof explains it). */
export function payCheckSql(input: PayCheckSqlInput): Prisma.Sql {
  const scope: SqlScope = { market: input.market, userId: null, now: input.now, publicOnly: true, heldBoards: CREDIT_LINE_BOARDS };
  const title = predicateFor('titles', { titles: [input.title] }, scope);
  const parts: Prisma.Sql[] = [
    ...scopePredicates(scope),
    Prisma.sql`j."firstSeenAt" >= ${input.since}::timestamp(3)`,
    Prisma.sql`(j."postedAt" IS NULL OR j."postedAt" >= ${input.since}::timestamp(3))`,
    // A title that matches nothing reads nothing: never every post of the window.
    title ?? Prisma.sql`FALSE`,
  ];
  if (input.place) parts.push(input.place);
  return Prisma.sql`SELECT j."salaryCurrency", j."salaryPeriod", j."salaryMin", j."salaryMax", j."salaryMonths",
  j."salaryAnnualMin", j."salaryAnnualMax", j."salaryDisclosed"
FROM "RAJob" j
WHERE ${Prisma.join(parts, '\n  AND ')}
ORDER BY j."firstSeenAt" DESC
LIMIT ${input.limit + 1}`;
}

const positive = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

/** The yearly pay one post states, in its currency, or null (see the header). Pure. */
export function statedAnnualPay(row: PayCheckRow): { currency: string; value: number } | null {
  if (row.salaryDisclosed !== true) return null;
  const currency = row.salaryCurrency?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  let lo = positive(row.salaryAnnualMin);
  let hi = positive(row.salaryAnnualMax);
  if (lo === null && hi === null) return null;
  if (!payPlausible({ min: row.salaryMin, max: row.salaryMax, currency, period: row.salaryPeriod, months: row.salaryMonths })) return null;
  if (lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo];
  return { currency, value: lo !== null && hi !== null ? (lo + hi) / 2 : (lo ?? hi)! };
}

/** Linear-interpolated quantile of a sorted, non-empty list. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export type PayCheckSummary = Pick<PayCheckResponse, 'status' | 'matchedCount' | 'withPayCount' | 'capped' | 'currencies' | 'minSample'>;

/**
 * Pure: the counts and, per currency, the quartiles of the posts' yearly pay
 * (`rows` are the posts read; `capped` = more matched than were read).
 */
export function summarizePayCheck(rows: readonly PayCheckRow[], meta: { asOf: Date; capped: boolean }, min: number = MIN_SAMPLE): PayCheckSummary {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const pay = statedAnnualPay(row);
    if (!pay) continue;
    const list = groups.get(pay.currency) ?? [];
    list.push(pay.value);
    groups.set(pay.currency, list);
  }
  const asOf = meta.asOf.toISOString();
  const currencies: PayCheckCurrency[] = [...groups.entries()]
    .map(([currency, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const n = sorted.length;
      if (!meetsMinSample(n, min)) return { currency, sampleSize: n, p25: null, median: null, p75: null };
      const s = (value: number): Sourced<number> => ({ value: Math.round(value), source: 'index', sampleSize: n, asOf, method: 'computed' });
      return { currency, sampleSize: n, p25: s(quantile(sorted, 0.25)), median: s(quantile(sorted, 0.5)), p75: s(quantile(sorted, 0.75)) };
    })
    .sort((a, b) => b.sampleSize - a.sampleSize || a.currency.localeCompare(b.currency));
  const withPayCount = currencies.reduce((sum, c) => sum + c.sampleSize, 0);
  return {
    status: currencies.some((c) => c.median !== null) ? 'ok' : 'not_enough',
    matchedCount: rows.length,
    withPayCount,
    capped: meta.capped,
    currencies,
    minSample: min,
  };
}

export interface PayCheckInput {
  title: string;
  location?: string | null;
  /** Defaults to the current brand's market. */
  market?: Market;
  /** Language of the role label (default 'en'). */
  locale?: string;
  now?: Date;
}

export interface PayCheck {
  check(input: PayCheckInput): Promise<PayCheckResponse>;
}

/** The one call a pay check needs (tests pass a fake). */
export type PayCheckDb = { $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T> };

export interface PayCheckDeps {
  db?: () => Promise<PayCheckDb>;
  env?: EnvSource;
  market?: () => Market;
  now?: () => Date;
}

const defaultDb = async (): Promise<PayCheckDb> => (await import('../../lib/prisma.js')).default as unknown as PayCheckDb;

export function createPayCheck(deps: PayCheckDeps = {}): PayCheck {
  const getDb = deps.db ?? defaultDb;
  const env = () => deps.env ?? process.env;
  const marketNow = deps.market ?? (() => getCurrentBrandOrDefault().market);
  const clock = deps.now ?? (() => new Date());

  return {
    async check(input) {
      const market = input.market ?? marketNow();
      if (market === 'cn' && cnRecruitmentInfoMode(env()) === 'off') throw new HttpError('feature_disabled');
      const now = input.now ?? clock();
      const since = new Date(now.getTime() - PAY_CHECK_WINDOW_DAYS * DAY_MS);
      const title = input.title.trim();
      // The route's contract refuses such a title first; any other caller gets the same answer.
      if (!normalizeJobTitle(title)) throw new HttpError('invalid_request', 'A job title with a letter or a number is required.');
      const place = resolvePlace(input.location);
      const db = await getDb();
      const read = await db.$queryRaw<PayCheckRow[]>(payCheckSql({ market, title, place: place?.sql ?? null, since, now, limit: PAY_CHECK_ROW_CAP }));
      const rows = read.slice(0, PAY_CHECK_ROW_CAP);
      const summary = summarizePayCheck(rows, { asOf: now, capped: read.length > PAY_CHECK_ROW_CAP });
      return {
        ...summary,
        title,
        titleMatch: titleMatchOf(title, input.locale ?? 'en'),
        place: place?.place ?? null,
        window: { days: PAY_CHECK_WINDOW_DAYS, from: since.toISOString(), to: now.toISOString() },
        rowCap: PAY_CHECK_ROW_CAP,
        period: 'year',
        asOf: now.toISOString(),
      };
    },
  };
}

/** The process-wide pay check (runs in the brand of the current request). */
export const payCheck: PayCheck = createPayCheck();
