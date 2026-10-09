// server/src/features/jobs/companies/service.ts — companies: ingest upsert, typeahead, profile, jobs, H-1B (WP-16b).
//
// D3 (ARCH §2.4, PRODUCT F-JOB-04):
//   - a company field is shown only when `RACompany.facts` names its source;
//     unknown fields are absent ("Not listed" in the UI), never guessed;
//   - ingest fills an empty field from a sourced provider/bank statement and
//     never overwrites a field another source already filled;
//   - counts come from our own index (`Sourced`, source 'index') and count
//     only live canonical public jobs of the brand's market;
//   - an ANONYMOUS viewer (no session) sees and counts only jobs cleared for
//     public display (`publicDisplay`, OPS-A4 / H12: licensed provider
//     listings and bank jobs without syndication consent stay behind a
//     session), like every other anonymous surface (public feed, SEO, /job/*);
//   - H-1B numbers cite the US DOL LCA disclosure file they came from.
// Market-scoped: a company of the other market answers 404 company_not_found.

import { createHash } from 'node:crypto';
import type prisma from '../../../lib/prisma.js';
import type { Market } from '../../../platform/brand/index.js';
import { httpError, type Sourced } from '../../../platform/http.js';
import type { FeedItem } from '../../feed/contract.js';
import { hostOf, normalizeCompanyName, type CompanyUpsert } from '../normalize/index.js';
import {
  COMPANY_ERROR_CODES,
  type CompanyJobsResponse,
  type CompanyProfile,
  type CompanyTypeaheadItem,
  type H1bHistoryResponse,
  type SourcedFact,
} from './contract.js';

export type CompaniesDb = Pick<typeof prisma, 'rACompany' | 'rAJob' | 'rAH1bEmployerStat' | '$queryRaw'>;

type FactEntry = { source: string; url?: string; fetchedAt: string };
type Facts = Record<string, FactEntry>;

// ── Slugs ─────────────────────────────────────────────────────────────────

function shortHash(s: string, n = 6): string {
  return createHash('sha1').update(s).digest('hex').slice(0, n);
}

/** URL slug: ASCII words of the display name; CJK-only names get 'c-<hash>'. Max 60 chars. */
export function companySlug(displayName: string, nameNormalized: string): string {
  const ascii = displayName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return ascii.length >= 2 ? ascii : `c-${shortHash(nameNormalized, 8)}`;
}

// ── Ingest upsert ─────────────────────────────────────────────────────────

const FACT_FIELDS = ['website', 'domain', 'industries', 'sizeBand', 'employeeCount', 'hqLocation', 'foundedYear', 'description'] as const;
type FactField = (typeof FACT_FIELDS)[number];

interface ExistingCompany {
  id: string;
  nameNormalized: string;
  logoUrl: string | null;
  isAgency: boolean | null;
  bankCompanyRef: string | null;
  website: string | null;
  domain: string | null;
  industries: string[];
  sizeBand: string | null;
  employeeCount: number | null;
  hqLocation: string | null;
  foundedYear: number | null;
  description: string | null;
  facts: unknown;
}

function isEmpty(v: unknown): boolean {
  return v == null || (Array.isArray(v) && v.length === 0) || v === '';
}

function asFacts(v: unknown): Facts {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Facts) } : {};
}

/**
 * The update for an existing company: fills only empty fields that the new
 * statement sources (per-field provenance copied into facts). Null = nothing to do.
 */
export function companyPatch(existing: ExistingCompany, next: CompanyUpsert): Record<string, unknown> | null {
  const facts = asFacts(existing.facts);
  const data: Record<string, unknown> = {};
  for (const field of FACT_FIELDS) {
    const value = next[field as FactField];
    if (isEmpty(value) || !isEmpty(existing[field as FactField]) || !next.facts[field]) continue;
    data[field] = value;
    facts[field] = next.facts[field]!;
  }
  if (!existing.logoUrl && next.logoUrl) {
    data.logoUrl = next.logoUrl;
    if (next.facts.logoUrl) facts.logoUrl = next.facts.logoUrl;
  }
  if (existing.isAgency == null && next.isAgency != null) data.isAgency = next.isAgency;
  if (!existing.bankCompanyRef && next.bankCompanyRef) data.bankCompanyRef = next.bankCompanyRef;
  if (Object.keys(data).length === 0) return null;
  data.facts = facts;
  return data;
}

function createData(c: CompanyUpsert, slug: string) {
  return {
    market: c.market,
    nameNormalized: c.nameNormalized,
    displayName: c.displayName,
    slug,
    domain: c.domain,
    logoUrl: c.logoUrl,
    website: c.website,
    industries: c.industries,
    sizeBand: c.sizeBand,
    employeeCount: c.employeeCount,
    hqLocation: c.hqLocation,
    foundedYear: c.foundedYear,
    description: c.description,
    isAgency: c.isAgency,
    bankCompanyRef: c.bankCompanyRef,
    facts: c.facts,
  };
}

const EXISTING_SELECT = {
  id: true,
  nameNormalized: true,
  logoUrl: true,
  isAgency: true,
  bankCompanyRef: true,
  website: true,
  domain: true,
  industries: true,
  sizeBand: true,
  employeeCount: true,
  hqLocation: true,
  foundedYear: true,
  description: true,
  facts: true,
} as const;

/**
 * Upserts the companies of one ingest batch (one market) on (market,
 * nameNormalized). Returns nameNormalized → RACompany.id. Never throws for a
 * slug clash: a clashing slug gets a short hash suffix.
 */
export async function upsertCompanies(db: Pick<CompaniesDb, 'rACompany'>, companies: CompanyUpsert[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const byMarket = new Map<Market, Map<string, CompanyUpsert>>();
  for (const c of companies) {
    if (!c.nameNormalized) continue;
    const m = byMarket.get(c.market) ?? new Map<string, CompanyUpsert>();
    if (!m.has(c.nameNormalized)) m.set(c.nameNormalized, c);
    byMarket.set(c.market, m);
  }
  for (const [market, wanted] of byMarket) {
    const names = [...wanted.keys()];
    const find = async (subset: string[]) =>
      (await db.rACompany.findMany({ where: { market, nameNormalized: { in: subset } }, select: EXISTING_SELECT })) as ExistingCompany[];

    const existing = await find(names);
    const have = new Map(existing.map((e) => [e.nameNormalized, e]));
    let missing = names.filter((n) => !have.has(n));
    for (const attempt of [0, 1]) {
      if (missing.length === 0) break;
      await db.rACompany.createMany({
        data: missing.map((n) => {
          const c = wanted.get(n)!;
          const slug = companySlug(c.displayName, n);
          return createData(c, attempt === 0 ? slug : `${slug.slice(0, 53)}-${shortHash(n)}`);
        }),
        skipDuplicates: true,
      });
      for (const row of await find(missing)) have.set(row.nameNormalized, { ...row, facts: row.facts });
      missing = missing.filter((n) => !have.has(n));
    }
    for (const row of existing) {
      const patch = companyPatch(row, wanted.get(row.nameNormalized)!);
      if (patch) await db.rACompany.update({ where: { id: row.id }, data: patch });
    }
    for (const [name, row] of have) ids.set(`${market}\u0000${name}`, row.id);
  }
  return ids;
}

/** Key into the map `upsertCompanies` returns. */
export function companyKey(market: Market, nameNormalized: string): string {
  return `${market}\u0000${nameNormalized}`;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** Escape LIKE wildcards. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Who is reading: a signed-in viewer, or anyone (anonymous visitors and crawlers). */
export interface CompanyReadViewer {
  /** True when there is no session: only `publicDisplay` jobs are listed or counted. */
  publicOnly: boolean;
}

/** Public, live, canonical, this market (TASK_PLAN §2.2 count rule); `publicOnly` adds publicDisplay (OPS-A4). */
export function liveJobWhere(market: Market, companyId: string, viewer: CompanyReadViewer = { publicOnly: true }) {
  return {
    companyId,
    market,
    visibility: 'public',
    isCanonical: true,
    archivedAt: null,
    ...(viewer.publicOnly ? { publicDisplay: true } : {}),
  };
}

/** Newest first; jobs without a posting date last (Postgres puts NULLs first on DESC by default). */
export function companyJobsOrder() {
  return [{ postedAt: { sort: 'desc' as const, nulls: 'last' as const } }, { id: 'desc' as const }];
}

interface CompanyRow {
  id: string;
  market: string;
  nameNormalized: string;
  displayName: string;
  slug: string;
  domain: string | null;
  logoUrl: string | null;
  website: string | null;
  industries: string[];
  sizeBand: string | null;
  hqLocation: string | null;
  foundedYear: number | null;
  description: string | null;
  facts: unknown;
}

function fact<T>(value: T | null | undefined, entry: FactEntry | undefined): SourcedFact<T> | undefined {
  if (value == null || value === '' || !entry?.source || !entry.fetchedAt) return undefined;
  return { value, source: entry.source, asOf: entry.fetchedAt, ...(entry.url ? { url: entry.url } : {}) };
}

/** Pure: company row → CompanyProfile with only sourced facts. */
export function toCompanyProfile(row: CompanyRow, openJobs: number, asOf: Date): CompanyProfile {
  const f = asFacts(row.facts);
  const facts: CompanyProfile['facts'] = {};
  const put = <K extends keyof CompanyProfile['facts']>(key: K, value: CompanyProfile['facts'][K] | undefined) => {
    if (value) facts[key] = value;
  };
  put('industry', fact(row.industries[0], f.industries));
  put('size', fact(row.sizeBand, f.sizeBand));
  put('headquarters', fact(row.hqLocation, f.hqLocation));
  put('founded', fact(row.foundedYear, f.foundedYear));
  put('description', fact(row.description, f.description));
  put('website', fact(row.website, f.website));
  const openJobsSourced: Sourced<number> = { value: openJobs, source: 'index', asOf: asOf.toISOString(), method: 'computed' };
  return {
    id: row.id,
    name: row.displayName,
    slug: row.slug,
    logoUrl: row.logoUrl,
    domain: f.domain ? row.domain : null,
    facts,
    openJobs: openJobsSourced,
  };
}

interface JobListRow {
  id: string;
  title: string;
  companyId: string | null;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  workModel: string | null;
  employmentType: string | null;
  seniority: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  salaryText: string | null;
  salaryDisclosed: boolean;
  postedAt: Date | null;
  lastSeenAt: Date;
  sourceBoard: string;
  sourceName: string | null;
  originalSourceName: string | null;
  sourceUrl: string | null;
  fromRecruiterBank: boolean;
  employerVerified: boolean;
  isAgency: boolean | null;
}

const PAY_PERIODS = new Set(['year', 'month', 'day', 'hour']);
const API_BOARDS = new Set(['activejobs', 'linkedin', 'jsearch']);

/** Pure: a live job row → the feed card shape (no fit, no badges derived here). */
export function toCompanyJobItem(r: JobListRow): FeedItem {
  const hasPay = r.salaryDisclosed && (r.salaryMin != null || r.salaryMax != null) && !!r.salaryCurrency && PAY_PERIODS.has(r.salaryPeriod ?? '');
  const kind: FeedItem['source']['kind'] = r.fromRecruiterBank ? 'bank' : API_BOARDS.has(r.sourceBoard) ? 'provider' : 'ats_public';
  return {
    jobId: r.id,
    title: r.title,
    company: { id: r.companyId, name: r.companyName, logoUrl: r.companyLogoUrl },
    location: r.location,
    workModel: r.workModel === 'remote' || r.workModel === 'hybrid' || r.workModel === 'onsite' ? r.workModel : null,
    employmentType: r.employmentType,
    seniority: r.seniority,
    pay: hasPay
      ? { min: r.salaryMin, max: r.salaryMax, currency: r.salaryCurrency!, period: r.salaryPeriod as 'year' | 'month' | 'day' | 'hour', text: r.salaryText }
      : null,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    lastSeenAt: r.lastSeenAt.toISOString(),
    source: { name: r.sourceName ?? r.originalSourceName ?? hostOf(r.sourceUrl) ?? '', kind },
    fromRecruiterBank: r.fromRecruiterBank,
    employerVerified: r.employerVerified,
    isAgency: r.isAgency === true,
    badges: [],
    fit: null,
    tracker: null,
  };
}

const COMPANY_SELECT = {
  id: true,
  market: true,
  nameNormalized: true,
  displayName: true,
  slug: true,
  domain: true,
  logoUrl: true,
  website: true,
  industries: true,
  sizeBand: true,
  hqLocation: true,
  foundedYear: true,
  description: true,
  facts: true,
} as const;

const JOB_LIST_SELECT = {
  id: true,
  title: true,
  companyId: true,
  companyName: true,
  companyLogoUrl: true,
  location: true,
  workModel: true,
  employmentType: true,
  seniority: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  salaryPeriod: true,
  salaryText: true,
  salaryDisclosed: true,
  postedAt: true,
  lastSeenAt: true,
  sourceBoard: true,
  sourceName: true,
  originalSourceName: true,
  sourceUrl: true,
  fromRecruiterBank: true,
  employerVerified: true,
  isAgency: true,
} as const;

export const COMPANY_JOBS_PAGE = 20;

/** US DOL OFLC performance data page (the LCA disclosure files' home). */
export const DOL_LCA_URL = 'https://www.dol.gov/agencies/eta/foreign-labor/performance';
export const H1B_DISCLAIMER =
  'Counts of certified Labor Condition Applications from US Department of Labor public disclosure files. A certified application is not a visa approval or a hire.';

export interface CompanyReadService {
  typeahead(market: Market, q: string, limit?: number): Promise<CompanyTypeaheadItem[]>;
  /** `viewer` defaults to anonymous (publicDisplay jobs only). */
  profile(market: Market, idOrSlug: string, viewer?: CompanyReadViewer): Promise<CompanyProfile>;
  jobs(market: Market, id: string, cursor?: string, viewer?: CompanyReadViewer): Promise<CompanyJobsResponse>;
  h1b(market: Market, id: string): Promise<H1bHistoryResponse>;
}

export function createCompanyReadService(db: CompaniesDb, now: () => Date = () => new Date()): CompanyReadService {
  async function findCompany(market: Market, idOrSlug: string): Promise<CompanyRow> {
    const row = (await db.rACompany.findFirst({
      where: { market, OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      select: COMPANY_SELECT,
    })) as CompanyRow | null;
    if (!row) throw httpError('not_found', 'Company not found.', { code: COMPANY_ERROR_CODES.notFound });
    return row;
  }

  return {
    async typeahead(market, q, limit = 8) {
      const qn = normalizeCompanyName(q) || q.trim().toLowerCase();
      if (qn.length < 2) return [];
      const prefix = `${escapeLike(qn)}%`;
      const take = Math.min(Math.max(limit, 1), 20);
      const rows = await db.$queryRaw<Array<{ id: string; name: string; slug: string; logoUrl: string | null; domain: string | null }>>`
        SELECT c."id", c."displayName" AS "name", c."slug", c."logoUrl", c."domain"
        FROM "RACompany" c
        WHERE c."market" = ${market}
          AND (c."nameNormalized" LIKE ${prefix} ESCAPE '\\' OR c."nameNormalized" % ${qn})
        ORDER BY (c."nameNormalized" LIKE ${prefix} ESCAPE '\\') DESC, similarity(c."nameNormalized", ${qn}) DESC, c."displayName" ASC
        LIMIT ${take}`;
      return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, logoUrl: r.logoUrl, domain: r.domain }));
    },

    async profile(market, idOrSlug, viewer = { publicOnly: true }) {
      const row = await findCompany(market, idOrSlug);
      const openJobs = await db.rAJob.count({ where: liveJobWhere(market, row.id, viewer) });
      return toCompanyProfile(row, openJobs, now());
    },

    async jobs(market, id, cursor, viewer = { publicOnly: true }) {
      const row = await findCompany(market, id);
      const offset = cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0;
      const rows = (await db.rAJob.findMany({
        where: liveJobWhere(market, row.id, viewer),
        orderBy: companyJobsOrder(),
        skip: offset,
        take: COMPANY_JOBS_PAGE + 1,
        select: JOB_LIST_SELECT,
      })) as JobListRow[];
      const page = rows.slice(0, COMPANY_JOBS_PAGE);
      return { items: page.map(toCompanyJobItem), cursor: rows.length > COMPANY_JOBS_PAGE ? String(offset + COMPANY_JOBS_PAGE) : null };
    },

    async h1b(market, id) {
      const row = await findCompany(market, id);
      if (market !== 'intl') return { years: [], disclaimer: H1B_DISCLAIMER };
      const stats = await db.rAH1bEmployerStat.findMany({
        where: { employerNameNormalized: row.nameNormalized },
        orderBy: { fiscalYear: 'desc' },
        take: 10,
      });
      return {
        years: stats.map((s) => ({
          fiscalYear: s.fiscalYear,
          certifiedCount: s.certifiedCount,
          medianWage:
            s.medianWageAnnualUsd == null
              ? null
              : { value: s.medianWageAnnualUsd, source: 'dol_lca' as const, asOf: s.importedAt.toISOString(), url: DOL_LCA_URL, sourceFile: s.sourceFile },
        })),
        disclaimer: H1B_DISCLAIMER,
      };
    },
  };
}
