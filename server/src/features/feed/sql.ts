// server/src/features/feed/sql.ts — the feed's retrieval and count SQL (WP-32; ARCH §4.8).
//
// Pure builders: every function returns a `Prisma.Sql` and touches no
// database, so `sql.test.ts` snapshots the exact statement per predicate.
// The repo (`repo.ts`) runs them through `$queryRaw`.
//
// Scope of every statement (D3, TASK_PLAN §2.2):
//   market = brand.market · isCanonical · archivedAt IS NULL · closedAt IS NULL
//   · not the demo seed corpus · fraudFlags empty (WP-17 intl scam rules and
//   WP-41 CN flags stay out until reviewed) · not hidden by this user
//   · visibility: the feed shows public rows plus the user's own imports;
//     counts (`publicOnly`) never include private rows; the visitor list
//     additionally needs `publicDisplay`.
//
// Predicates follow FILTER_SET specs in search/filterSet.ts (ruling C15).
// Conventions this file relies on (handoff requests to the writers):
//   The GoApply tags below are written by cn/jobs/card.ts (`extractPostingTags`),
//   each only when the posting states it, with its quote:
//   - marketTags `{ tag: 'class_year:<yyyy>' }` 届别
//   - marketTags `{ tag: 'school_tier:985' | 'school_tier:211' | 'school_tier:double_first_class' }`
//   - marketTags `{ tag: 'intern_days:<n>' }` days a week an internship asks for
//   - marketTags `{ tag: 'cn_hire:campus' | 'cn_hire:social' }` 校招 / 社招
//   - employerTags column: bare ids 'soe' | 'bianzhi' | 'hukou' | 'foreign' (WP-17)
//   - marketTags `{ tag: 'apply_closes:<yyyy-mm-dd>', evidenceQuote }` a stated 网申 close date
//     (the GoApply deadline sort reads only this; RAJob.expiresAt is often an estimate)

import { Prisma } from '../../generated/prisma/client.js';
import type { Market } from '../../platform/brand/registry.js';
import { normalizeCompanyName, normalizeJobTitle, normalizeSkills } from '../jobs/normalize/index.js';
import { findCity } from '../jobs/geo/index.js';
import { expandTaxonomyIds, matchTitle } from '../jobs/taxonomy/index.js';
import { includesUndisclosedPay, type FilterField, type FilterSet } from '../search/index.js';

export interface SqlScope {
  market: Market;
  userId: string | null;
  now: Date;
  /** Counts and the visitor list: public rows only (never a user's private import). */
  publicOnly?: boolean;
  /**
   * Visitor list: the provider licence allows public redisplay, and the
   * posting is not past its expiry (the SEO pages' rule, seo `basePublicWhere`).
   */
  publicDisplayOnly?: boolean;
  /**
   * With `publicDisplayOnly`: the boards still allowed to be redisplayed
   * (seo `allowedPublicBoards`). Only recruiter-bank rows and rows of these
   * boards are read, so the statement's LIMIT counts listable rows only.
   */
  publicBoards?: readonly string[];
  /** Skip the per-user hidden-state check (visitor list). */
  ignoreHidden?: boolean;
}

const DAY_MS = 86_400_000;

/** Hours of work a year / days a month used to compare pay across periods. */
export const ANNUAL_FACTOR: Readonly<Record<string, number>> = { year: 1, month: 12, week: 52, day: 260, hour: 2080 };
/** China's statutory average working days a month (劳社部发〔2008〕3号): 元/天 from a monthly internship wage. */
export const CN_WORK_DAYS_PER_MONTH = 21.75;

/** "Says no sponsorship" hides a job only when the quote itself carries a negation (F-FILT-02). */
export const SPONSORSHIP_NEGATION_REGEX =
  "\\m(no|not|unable|cannot|can't|won't|will not|does not|doesn't|without|ineligible)\\M|不|无法|無法|不提供|不支持";

/** Filter COMPANY_SIZES → RACompany.sizeBand values (WP-16a SIZE_BANDS). */
const COMPANY_SIZE_BANDS: Readonly<Record<string, string[]>> = {
  '1-10': ['1-10'],
  '11-50': ['11-50'],
  '51-200': ['51-200'],
  '201-1000': ['201-500', '501-1000', '201-1000'],
  '1001-5000': ['1001-5000'],
  '5000+': ['5001+', '5000+'],
};

/** GoApply 学历 keys → RAJob.educationLevel. */
const CN_DEGREE_LEVEL: Readonly<Record<string, string>> = { dazhuan: 'associate', bachelor: 'bachelor', master: 'master', phd: 'phd' };

/** marketTags as a JSON array (anything else counts as no tags). */
const TAGS = Prisma.sql`jsonb_array_elements(CASE WHEN jsonb_typeof(j."marketTags") = 'array' THEN j."marketTags" ELSE '[]'::jsonb END) AS t(e)`;

function hasTagPrefix(prefix: string): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM ${TAGS} WHERE t.e->>'tag' LIKE ${`${prefix}%`})`;
}
function hasTagIn(tags: string[]): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM ${TAGS} WHERE t.e->>'tag' = ANY(${tags}::text[]))`;
}

/** Calendar date in China (UTC+8, no DST) as yyyy-mm-dd: a stated 网申 date closes at the end of that day there. */
export function cnDate(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * The earliest stated application close date on or after `today` (yyyy-mm-dd
 * text), from marketTags `apply_closes:<date>` entries that carry an evidence
 * quote; NULL when the posting states none. Never RAJob.expiresAt, which is
 * postedAt + 45 days for most providers (an estimate, D3).
 */
function statedCloseSql(today: string): Prisma.Sql {
  return Prisma.sql`(SELECT min(substring(t.e->>'tag' from 14 for 10)) FROM ${TAGS}
    WHERE t.e->>'tag' ~ '^apply_closes:[0-9]{4}-[0-9]{2}-[0-9]{2}' AND length(btrim(COALESCE(t.e->>'evidenceQuote', ''))) > 0
    AND substring(t.e->>'tag' from 14 for 10) >= ${today})`;
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function lowerList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.normalize('NFKC').trim().toLowerCase()).filter(Boolean))];
}

function titlePatterns(titles: readonly string[] | undefined): string[] {
  return [...new Set((titles ?? []).map((t) => normalizeJobTitle(t) || t.trim().toLowerCase()).filter(Boolean))].map((t) => `%${likeEscape(t)}%`);
}

function companyKeys(names: readonly string[] | undefined): string[] {
  return [...new Set((names ?? []).map((n) => normalizeCompanyName(n)).filter(Boolean))];
}

/** Role ids a FilterSet targets: taxonomy ids (any level → L3) ∪ the taxonomy matches of the typed titles. */
export function roleTaxonomyIds(filters: FilterSet): string[] {
  const fromTitles = (filters.titles ?? []).flatMap((t) => matchTitle(t, { limit: 1 }).map((m) => m.id));
  return expandTaxonomyIds([...(filters.taxonomyIds ?? []), ...fromTitles]);
}

/** Annual amount of a FilterSet pay floor in its own currency. */
export function annualFloor(salaryMin: NonNullable<FilterSet['salaryMin']>): number {
  return Math.round(salaryMin.amount * (ANNUAL_FACTOR[salaryMin.period] ?? 1));
}

function cityNames(loc: { city?: string; country?: string; label: string }): string[] {
  const name = loc.city ?? loc.label.split(',')[0]?.trim() ?? '';
  const rec = findCity(name, { country: loc.country ?? null });
  return lowerList([name, rec?.name ?? '', rec?.zh ?? '', rec?.zhHant ?? '', ...(rec?.aliases ?? [])]);
}

/** One location: radius search (bounding box, then haversine) or same city; remote jobs pass. */
function locationSql(loc: NonNullable<FilterSet['locations']>[number]): Prisma.Sql {
  let lat = loc.lat;
  let lng = loc.lng;
  if ((lat === undefined || lng === undefined) && loc.radiusKm > 0) {
    const rec = findCity(loc.city ?? loc.label.split(',')[0]?.trim() ?? '', { country: loc.country ?? null });
    if (rec) {
      lat = rec.lat;
      lng = rec.lng;
    }
  }
  if (loc.radiusKm > 0 && lat !== undefined && lng !== undefined) {
    const dLat = loc.radiusKm / 111.045;
    const dLng = loc.radiusKm / (111.045 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
    return Prisma.sql`(j."geoLat" BETWEEN ${lat - dLat} AND ${lat + dLat}
      AND j."geoLng" BETWEEN ${lng - dLng} AND ${lng + dLng}
      AND 6371 * 2 * asin(sqrt(power(sin(radians(j."geoLat" - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(j."geoLat")) * power(sin(radians(j."geoLng" - ${lng}) / 2), 2))) <= ${loc.radiusKm})`;
  }
  const names = cityNames(loc);
  const country = loc.country ? Prisma.sql` AND (j."locationCountry" IS NULL OR j."locationCountry" = ${loc.country})` : Prisma.empty;
  return Prisma.sql`(lower(j."locationCity") = ANY(${names}::text[])${country})`;
}

/** The SQL predicate for one FilterSet field, or null when it does not filter (absent, view-only, boost-only). */
export function predicateFor(field: FilterField, filters: FilterSet, scope: Pick<SqlScope, 'market' | 'now'>): Prisma.Sql | null {
  const f = filters;
  const intl = scope.market === 'intl';
  switch (field) {
    case 'taxonomyIds':
    case 'titles': {
      // One role predicate: taxonomy overlap OR title text match (handled on `taxonomyIds`, or on `titles` when no ids).
      if (field === 'titles' && f.taxonomyIds?.length) return null;
      const ids = roleTaxonomyIds(f);
      const patterns = titlePatterns(f.titles);
      if (!ids.length && !patterns.length) return null;
      const parts: Prisma.Sql[] = [];
      if (ids.length) parts.push(Prisma.sql`j."taxonomyIds" && ${ids}::text[]`);
      if (patterns.length) parts.push(Prisma.sql`j."titleNormalized" ILIKE ANY(${patterns}::text[])`);
      return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
    }
    case 'excludedTitles': {
      const patterns = titlePatterns(f.excludedTitles);
      return patterns.length ? Prisma.sql`NOT (j."titleNormalized" ILIKE ANY(${patterns}::text[]))` : null;
    }
    case 'jobTypes':
      return f.jobTypes?.length ? Prisma.sql`j."employmentType" = ANY(${[...f.jobTypes]}::text[])` : null;
    case 'workModels':
      return f.workModels?.length ? Prisma.sql`j."workModel" = ANY(${[...f.workModels]}::text[])` : null;
    case 'country':
      return f.country
        ? Prisma.sql`(j."locationCountry" = ${f.country} OR (j."workModel" = 'remote' AND (j."remoteScope" = ${f.country} OR j."remoteScope" = 'global')))`
        : null;
    case 'locations': {
      if (!f.locations?.length) return null;
      return Prisma.sql`(j."workModel" = 'remote' OR ${Prisma.join(f.locations.map(locationSql), ' OR ')})`;
    }
    case 'seniority':
      return f.seniority?.length ? Prisma.sql`j."seniority" = ANY(${[...f.seniority]}::text[])` : null;
    case 'yearsRange': {
      const r = f.yearsRange;
      if (!r || (r.min === undefined && r.max === undefined)) return null;
      const parts: Prisma.Sql[] = [];
      if (r.max !== undefined) parts.push(Prisma.sql`COALESCE(j."minYears", 0) <= ${r.max}`);
      if (r.min !== undefined) parts.push(Prisma.sql`COALESCE(j."maxYears", j."minYears", 100) >= ${r.min}`);
      return Prisma.sql`(${Prisma.join(parts, ' AND ')})`;
    }
    case 'postedWithinDays':
      return f.postedWithinDays ? Prisma.sql`j."postedAt" >= ${new Date(scope.now.getTime() - f.postedWithinDays * DAY_MS)}::timestamp(3)` : null;
    case 'salaryMin': {
      if (!f.salaryMin) return null;
      const floor = annualFloor(f.salaryMin);
      const listed = Prisma.sql`(j."salaryDisclosed" = true AND j."salaryCurrency" = ${f.salaryMin.currency} AND COALESCE(j."salaryAnnualMax", j."salaryAnnualMin") >= ${floor})`;
      if (!includesUndisclosedPay(f)) return listed;
      // Not comparable (undisclosed, or listed in another currency) stays when undisclosed pay is included.
      return Prisma.sql`(${listed} OR j."salaryDisclosed" = false OR COALESCE(j."salaryAnnualMax", j."salaryAnnualMin") IS NULL OR j."salaryCurrency" IS DISTINCT FROM ${f.salaryMin.currency})`;
    }
    case 'includeUndisclosedPay':
      // Alone ("Only jobs that list pay"); with a floor it is part of `salaryMin`.
      return f.includeUndisclosedPay === false && !f.salaryMin && !f.dailyPay ? Prisma.sql`j."salaryDisclosed" = true` : null;
    case 'needsSponsorship':
      return intl && f.needsSponsorship
        ? Prisma.sql`NOT (j."sponsorship" = 'not_offered' AND COALESCE(j."sponsorshipEvidence", '') ~* ${SPONSORSHIP_NEGATION_REGEX})`
        : null;
    case 'excludeRequirements': {
      if (!intl || !f.excludeRequirements?.length) return null;
      const parts: Prisma.Sql[] = [];
      if (f.excludeRequirements.includes('citizenship')) parts.push(Prisma.sql`j."citizenshipRequired" IS NOT TRUE`);
      if (f.excludeRequirements.includes('clearance')) parts.push(Prisma.sql`j."clearanceRequired" IS NOT TRUE`);
      return Prisma.sql`(${Prisma.join(parts, ' AND ')})`;
    }
    case 'industries':
      return f.industries?.length ? Prisma.sql`EXISTS (SELECT 1 FROM unnest(c."industries") AS ci(v) WHERE lower(ci.v) = ANY(${lowerList(f.industries)}::text[]))` : null;
    case 'excludedIndustries':
      return f.excludedIndustries?.length
        ? Prisma.sql`NOT EXISTS (SELECT 1 FROM unnest(c."industries") AS ci(v) WHERE lower(ci.v) = ANY(${lowerList(f.excludedIndustries)}::text[]))`
        : null;
    case 'skills':
      return f.skills?.length ? Prisma.sql`j."skills" && ${normalizeSkills(f.skills)}::text[]` : null;
    case 'excludedSkills':
      return f.excludedSkills?.length ? Prisma.sql`NOT (j."skills" && ${normalizeSkills(f.excludedSkills)}::text[])` : null;
    case 'roleType':
      return f.roleType ? Prisma.sql`j."roleType" = ${f.roleType}` : null;
    case 'companies': {
      const keys = companyKeys(f.companies);
      return keys.length ? Prisma.sql`j."companyNameNormalized" = ANY(${keys}::text[])` : null;
    }
    case 'excludedCompanies': {
      const keys = companyKeys(f.excludedCompanies);
      return keys.length ? Prisma.sql`j."companyNameNormalized" <> ALL(${keys}::text[])` : null;
    }
    case 'companySizes': {
      if (!f.companySizes?.length) return null;
      const bands = [...new Set(f.companySizes.flatMap((s) => COMPANY_SIZE_BANDS[s] ?? [s]))];
      return Prisma.sql`(c."sizeBand" IS NULL OR c."sizeBand" = ANY(${bands}::text[]))`;
    }
    case 'excludeAgencies':
      return f.excludeAgencies ? Prisma.sql`j."isAgency" IS NOT TRUE` : null;
    case 'recruiterJobsOnly':
      return f.recruiterJobsOnly ? Prisma.sql`j."fromRecruiterBank" = true` : null;
    case 'q': {
      const q = f.q?.trim();
      if (!q) return null;
      return Prisma.sql`(j."searchText" ILIKE ${`%${likeEscape(q.toLowerCase())}%`} OR ${q.toLowerCase()} <% j."searchText")`;
    }
    // ── GoApply (market cn) ──
    case 'employerTags':
      return !intl && f.employerTags?.length ? Prisma.sql`j."employerTags" @> ${[...f.employerTags]}::text[]` : null;
    case 'hukouTag':
      return !intl && f.hukouTag ? Prisma.sql`'hukou' = ANY(j."employerTags")` : null;
    case 'classYear':
      return !intl && f.classYear ? Prisma.sql`(NOT ${hasTagPrefix('class_year:')} OR ${hasTagIn([`class_year:${f.classYear}`])})` : null;
    case 'degree': {
      if (intl || !f.degree?.length) return null;
      const levels = [...new Set(f.degree.map((d) => CN_DEGREE_LEVEL[d] ?? d))];
      return Prisma.sql`(j."educationLevel" IS NULL OR j."educationLevel" = 'none' OR j."educationLevel" = ANY(${levels}::text[]))`;
    }
    case 'employmentType': {
      if (intl || !f.employmentType?.length) return null;
      const parts: Prisma.Sql[] = [];
      if (f.employmentType.includes('internship')) parts.push(Prisma.sql`j."employmentType" = 'internship'`);
      if (f.employmentType.includes('campus')) {
        // 校招: stated as such (`cn_hire:campus`, written by cn/jobs/card.ts), or — only for a
        // row that carries no `cn_hire:` tag at all — a non-internship posting that names a
        // 届别: a stated class year is evidence of a campus posting (same leniency as
        // classYear above).
        parts.push(
          Prisma.sql`(${hasTagIn(['cn_hire:campus'])} OR (j."employmentType" IS DISTINCT FROM 'internship' AND NOT ${hasTagPrefix('cn_hire:')} AND ${hasTagPrefix('class_year:')}))`,
        );
      }
      if (f.employmentType.includes('social')) {
        // 社招: stated as such, or a non-internship posting with no 校招 statement.
        parts.push(Prisma.sql`(${hasTagIn(['cn_hire:social'])} OR (j."employmentType" IS DISTINCT FROM 'internship' AND NOT ${hasTagPrefix('cn_hire:')}))`);
      }
      return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
    }
    case 'internDays': {
      const r = f.internDays;
      if (intl || !r || (r.min === undefined && r.max === undefined)) return null;
      const n = Prisma.sql`(CASE WHEN t.e->>'tag' ~ '^intern_days:[0-9]{1,2}$' THEN split_part(t.e->>'tag', ':', 2)::int END)`;
      return Prisma.sql`(NOT ${hasTagPrefix('intern_days:')} OR EXISTS (SELECT 1 FROM ${TAGS} WHERE ${n} BETWEEN ${r.min ?? 1} AND ${r.max ?? 7}))`;
    }
    case 'dailyPay': {
      if (intl || !f.dailyPay) return null;
      const perDay = Prisma.sql`(CASE j."salaryPeriod" WHEN 'day' THEN COALESCE(j."salaryMax", j."salaryMin") WHEN 'month' THEN COALESCE(j."salaryMax", j."salaryMin") / ${CN_WORK_DAYS_PER_MONTH} END)`;
      const listed = Prisma.sql`(j."salaryDisclosed" = true AND j."salaryCurrency" = 'CNY' AND ${perDay} >= ${f.dailyPay.min})`;
      const undisclosed = includesUndisclosedPay(f) ? Prisma.sql` OR j."salaryDisclosed" = false` : Prisma.empty;
      return Prisma.sql`(j."employmentType" IS DISTINCT FROM 'internship' OR ${listed}${undisclosed})`;
    }
    case 'salaryMonthsMin':
      return !intl && f.salaryMonthsMin ? Prisma.sql`(j."salaryMonths" IS NULL OR j."salaryMonths" >= ${f.salaryMonthsMin})` : null;
    case 'schoolTiers': {
      if (intl || !f.schoolTiers?.length) return null;
      const mine = f.schoolTiers.map((t) => `school_tier:${t}`);
      return Prisma.sql`(NOT ${hasTagPrefix('school_tier:')} OR ${hasTagIn(mine)})`;
    }
    // View / ranking only: never SQL.
    case 'fitTier':
    case 'preferredCompanies':
      return null;
    default: {
      const never: never = field;
      return never;
    }
  }
}

/** Every filter predicate of a set, in FILTER_FIELDS order (absent fields contribute nothing). */
export function filterPredicates(filters: FilterSet, scope: Pick<SqlScope, 'market' | 'now'>, fields: readonly FilterField[]): Prisma.Sql[] {
  const out: Prisma.Sql[] = [];
  for (const field of fields) {
    const p = predicateFor(field, filters, scope);
    if (p) out.push(p);
  }
  return out;
}

/** Market, lifecycle, visibility, fraud and hidden-state scope (see the header). */
export function scopePredicates(scope: SqlScope): Prisma.Sql[] {
  const out: Prisma.Sql[] = [
    Prisma.sql`j."market" = ${scope.market}`,
    Prisma.sql`j."isCanonical" = true`,
    Prisma.sql`j."archivedAt" IS NULL`,
    Prisma.sql`j."closedAt" IS NULL`,
    Prisma.sql`j."sourceBoard" <> 'seed'`,
    Prisma.sql`(j."fraudFlags" IS NULL OR jsonb_typeof(j."fraudFlags") <> 'array' OR j."fraudFlags" = '[]'::jsonb)`,
  ];
  if (scope.publicOnly || !scope.userId) out.push(Prisma.sql`j."visibility" = 'public'`);
  else out.push(Prisma.sql`(j."visibility" = 'public' OR j."ownerUserId" = ${scope.userId})`);
  if (scope.publicDisplayOnly) {
    out.push(Prisma.sql`j."publicDisplay" = true`);
    out.push(Prisma.sql`(j."expiresAt" IS NULL OR j."expiresAt" > ${scope.now}::timestamp(3))`);
    if (scope.publicBoards) out.push(Prisma.sql`(j."fromRecruiterBank" = true OR j."sourceBoard" = ANY(${[...scope.publicBoards]}::text[]))`);
  }
  if (scope.userId && !scope.ignoreHidden) {
    out.push(
      Prisma.sql`NOT EXISTS (SELECT 1 FROM "RAJobUserState" s WHERE s."userId" = ${scope.userId} AND s."jobId" = j."id" AND s."hiddenAt" IS NOT NULL)`,
    );
  }
  return out;
}

/** Columns the feed reads (pre-score inputs + card fields), with the company join. */
export const FEED_COLUMNS = Prisma.sql`j."id", j."market", j."visibility", j."ownerUserId", j."title", j."titleNormalized", j."companyName",
  j."companyNameNormalized", j."companyId", j."companyLogoUrl", j."taxonomyIds", j."primaryTaxonomyId", j."seniority", j."roleType",
  j."minYears", j."maxYears", j."educationLevel", j."skills", j."skillsDetail", j."workModel", j."remoteScope", j."location",
  j."locationCity", j."locationCountry", j."geoLat", j."geoLng", j."employmentType", j."salaryMin", j."salaryMax",
  j."salaryCurrency", j."salaryPeriod", j."salaryAnnualMin", j."salaryAnnualMax", j."salaryDisclosed", j."salaryText",
  j."salaryMonths", j."sponsorship", j."sponsorshipEvidence", j."citizenshipRequired", j."clearanceRequired", j."employerTags",
  j."marketTags", j."postedAt", j."postedAtEstimated", j."firstSeenAt", j."lastSeenAt", j."expiresAt", j."sourceBoard",
  j."sourceName", j."originalSourceName", j."atsType", j."isAgency", j."fromRecruiterBank", j."employerVerified",
  j."sourcePriority", j."archivedAt", (j."benefits" IS NOT NULL AND length(j."benefits") > 0) AS "hasBenefits",
  length(j."descriptionPlain")::int AS "descriptionLength", c."industries" AS "companyIndustries", c."sizeBand" AS "companySizeBand",
  c."facts" AS "companyFacts", c."displayName" AS "companyDisplayName", c."logoUrl" AS "companyLogo"`;

const FROM = Prisma.sql`FROM "RAJob" j LEFT JOIN "RACompany" c ON c."id" = j."companyId"`;

function where(parts: Prisma.Sql[]): Prisma.Sql {
  return Prisma.sql`WHERE ${Prisma.join(parts, '\n  AND ')}`;
}

export interface RetrievalSqlInput {
  scope: SqlScope;
  filters: FilterSet;
  fields: readonly FilterField[];
  /** postedAt ≥ from (window start). */
  from: Date | null;
  /** Older refill boundary; null on the first window. With `toId`, a keyset `(postedAt, id) < (to, toId)`, else `postedAt < to`. */
  to: Date | null;
  /**
   * Id of the last row of a full previous window. Rows that share the
   * boundary `postedAt` and sat past its LIMIT are still retrieved (ties are
   * common with date-only provider dates and batch syncs).
   */
  toId?: string | null;
  /** firstSeenAt > since (new-count). */
  firstSeenAfter?: Date | null;
  /** Extra predicates ANDed in (the browse category predicate). */
  extra?: Prisma.Sql[];
  /**
   * GoApply `deadline`: jobs with a stated close date (soonest first), then
   * every job without one, newest first (they are listed, not dropped).
   */
  orderBy?: 'posted' | 'deadline';
  limit: number;
}

/** One window of candidates: newest first (or stated deadline first), LIMIT `limit`. */
export function retrievalSql(input: RetrievalSqlInput): Prisma.Sql {
  const parts = [...scopePredicates(input.scope), ...filterPredicates(input.filters, input.scope, input.fields), ...(input.extra ?? [])];
  if (input.from) parts.push(Prisma.sql`j."postedAt" >= ${input.from}::timestamp(3)`);
  if (input.to && input.toId) parts.push(Prisma.sql`(j."postedAt", j."id") < (${input.to}::timestamp(3), ${input.toId})`);
  else if (input.to) parts.push(Prisma.sql`j."postedAt" < ${input.to}::timestamp(3)`);
  if (input.firstSeenAfter) parts.push(Prisma.sql`j."firstSeenAt" > ${input.firstSeenAfter}::timestamp(3)`);
  const order =
    input.orderBy === 'deadline'
      ? Prisma.sql`ORDER BY ${statedCloseSql(cnDate(input.scope.now))} ASC NULLS LAST, j."postedAt" DESC NULLS LAST, j."id" DESC`
      : Prisma.sql`ORDER BY j."postedAt" DESC NULLS LAST, j."id" DESC`;
  return Prisma.sql`SELECT ${FEED_COLUMNS}
${FROM}
${where(parts)}
${order}
LIMIT ${input.limit}`;
}

/**
 * The category predicate of a browse (Explore → a category's list): a job
 * belongs to a category when its `taxonomyIds` carry the category id itself
 * or any role under it — the rows the Explore tile counts (`exploreCountsSql`
 * counts by the ids on the row), so the list and the tile agree.
 */
export function browseTaxonomySql(ids: readonly string[]): Prisma.Sql {
  const all = [...new Set([...ids, ...expandTaxonomyIds(ids)])];
  return Prisma.sql`j."taxonomyIds" && ${all}::text[]`;
}

export interface JobIdsSqlInput {
  scope: SqlScope;
  filters: FilterSet;
  fields: readonly FilterField[];
  /** postedAt ≥ from. */
  from: Date | null;
  /** With `from`: a posting with no date also passes (alerts for jobs we only just found). */
  allowUndated?: boolean;
  firstSeenAfter?: Date | null;
  /** `posted`: newest posting first. `first_seen`: newest in our index first (alerts). */
  orderBy: 'posted' | 'first_seen';
  limit: number;
}

/** Job ids only, for the unranked seams (report sample, alert candidates): same scope and filter predicates as the list. */
export function jobIdsSql(input: JobIdsSqlInput): Prisma.Sql {
  const parts = [...scopePredicates(input.scope), ...filterPredicates(input.filters, input.scope, input.fields)];
  if (input.from && input.allowUndated) parts.push(Prisma.sql`(j."postedAt" IS NULL OR j."postedAt" >= ${input.from}::timestamp(3))`);
  else if (input.from) parts.push(Prisma.sql`j."postedAt" >= ${input.from}::timestamp(3)`);
  if (input.firstSeenAfter) parts.push(Prisma.sql`j."firstSeenAt" > ${input.firstSeenAfter}::timestamp(3)`);
  const order =
    input.orderBy === 'first_seen'
      ? Prisma.sql`ORDER BY j."firstSeenAt" DESC, j."id" DESC`
      : Prisma.sql`ORDER BY j."postedAt" DESC NULLS LAST, j."id" DESC`;
  return Prisma.sql`SELECT j."id"
${FROM}
${where(parts)}
${order}
LIMIT ${input.limit}`;
}

/**
 * The fields `marketHooks.cardMeta` reads that the list does not select, for
 * the cards of one page. The posting text is only read to re-check a quoted
 * market tag (Taiwan work-permit tags), so it is returned only for rows that
 * carry market tags.
 */
export function cardExtrasSql(ids: string[]): Prisma.Sql {
  return Prisma.sql`SELECT j."id", j."sourceUrl", j."applyUrl", j."locations", j."fraudFlags",
  CASE WHEN jsonb_typeof(j."marketTags") = 'array' AND jsonb_array_length(j."marketTags") > 0 THEN j."descriptionPlain" END AS "descriptionPlain"
FROM "RAJob" j
WHERE j."id" = ANY(${ids}::text[])`;
}

/** Rows by id (later pages of a session), still in scope and not hidden since. */
export function rowsByIdSql(scope: SqlScope, ids: string[]): Prisma.Sql {
  const parts = [...scopePredicates(scope), Prisma.sql`j."id" = ANY(${ids}::text[])`];
  return Prisma.sql`SELECT ${FEED_COLUMNS}
${FROM}
${where(parts)}`;
}

/** `SELECT count(*)` over the retrieval predicates, capped (`LIMIT cap + 1` inside). Public rows only (D3). */
export function countSql(input: { scope: SqlScope; filters: FilterSet; fields: readonly FilterField[]; cap: number; firstSeenAfter?: Date | null }): Prisma.Sql {
  const scope: SqlScope = { ...input.scope, publicOnly: true };
  const parts = [...scopePredicates(scope), ...filterPredicates(input.filters, scope, input.fields)];
  if (input.firstSeenAfter) parts.push(Prisma.sql`j."firstSeenAt" > ${input.firstSeenAfter}::timestamp(3)`);
  return Prisma.sql`SELECT count(*)::int AS "count" FROM (SELECT 1 ${FROM}
${where(parts)}
LIMIT ${input.cap + 1}) AS capped`;
}

/**
 * Live public counts per L1 category (Explore). `since` is the lists' age
 * floor (postedAt ≥ since), so a tile counts what its browse list can reach.
 */
export function exploreCountsSql(market: Market, categoryIds: string[], since: Date | null = null): Prisma.Sql {
  const parts = [...scopePredicates({ market, userId: null, now: new Date(0), publicOnly: true }), Prisma.sql`j."taxonomyIds" && ${categoryIds}::text[]`];
  if (since) parts.push(Prisma.sql`j."postedAt" >= ${since}::timestamp(3)`);
  return Prisma.sql`SELECT t.id AS "taxonomyId", count(*)::int AS "count"
FROM "RAJob" j CROSS JOIN LATERAL unnest(j."taxonomyIds") AS t(id)
${where(parts)} AND t.id = ANY(${categoryIds}::text[])
GROUP BY t.id`;
}
