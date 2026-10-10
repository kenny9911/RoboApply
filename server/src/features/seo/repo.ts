// server/src/features/seo/repo.ts
//
// The SEO area's data access. `SeoRepo` is the narrow surface the service
// and the cron use; `createPrismaSeoRepo` runs it on typed Prisma with the
// `publicJobWhere` predicate (scope.ts), and `testkit.ts` runs the same
// contract in memory with `matchesScope`. Nothing here decides what is
// public: the scope does.

import type { Prisma } from '../../generated/prisma/client.js';
import { publicJobWhere, type JobScope, type ScopeContext, type ScopeRow } from './scope.js';
import type { PayRow } from './stats.js';

/** Fields a job card / ticker / sitemap row needs, plus the scope fields. */
export interface SeoJobRow extends ScopeRow, PayRow {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  locationRegion: string | null;
  employmentType: string | null;
  seniority: string | null;
  salaryText: string | null;
  sourceName: string | null;
  originalSourceName: string | null;
  postedAt: Date | null;
  postedAtEstimated: boolean;
  firstSeenAt: Date;
  updatedAt: Date;
}

/** A job page row: card fields + posting text + company. */
export interface SeoJobDetailRow extends SeoJobRow {
  descriptionPlain: string;
  qualifications: string | null;
  responsibilities: string | null;
  benefits: string | null;
  applyUrl: string;
  sourceUrl: string | null;
  companyId: string | null;
  company: { displayName: string; website: string | null; logoUrl: string | null; facts: unknown } | null;
}

export interface CountExtra {
  /** firstSeenAt ≥ this. */
  firstSeenSince?: Date;
  /** salaryDisclosed = true. */
  payListed?: boolean;
}

export type GroupKey = 'primaryTaxonomyId' | 'locationCity' | 'locationCountry' | 'companyName';

export interface GroupCount {
  keys: Partial<Record<GroupKey, string | null>>;
  count: number;
}

/** A `RASeoPage` row as the service reads and writes it. */
export interface SeoPageRow {
  brand: string;
  locale: string;
  type: string;
  slug: string;
  params: unknown;
  title: string;
  h1: string;
  intro: string;
  stats: unknown;
  jobCount: number;
  indexable: boolean;
  lastBuiltAt: Date;
}

export interface SeoRepo {
  countJobs(scope: JobScope, ctx: ScopeContext, extra?: CountExtra): Promise<number>;
  /** Newest first (postedAt, then firstSeenAt). */
  listJobs(scope: JobScope, ctx: ScopeContext, opts: { limit: number; order: 'posted' | 'firstSeen' }): Promise<SeoJobRow[]>;
  /** Pay fields of jobs that disclose pay (bounded). */
  payRows(scope: JobScope, ctx: ScopeContext, limit: number): Promise<PayRow[]>;
  topCompanies(scope: JobScope, ctx: ScopeContext, limit: number): Promise<Array<{ name: string; count: number }>>;
  groupCounts(scope: JobScope, ctx: ScopeContext, by: readonly GroupKey[], limit: number): Promise<GroupCount[]>;
  /** One job by id, whatever its state (the service decides 404 vs 410). */
  findJob(id: string): Promise<SeoJobDetailRow | null>;
  /** Sitemap rows of public jobs, ordered by id. */
  listJobPage(ctx: ScopeContext, opts: { skip: number; take: number }): Promise<Array<{ id: string; title: string; companyName: string; updatedAt: Date }>>;
  listSeoPages(brand: string, opts: { indexableOnly: boolean; skip?: number; take?: number }): Promise<SeoPageRow[]>;
  countSeoPages(brand: string, opts: { indexableOnly: boolean }): Promise<number>;
  upsertSeoPage(row: SeoPageRow): Promise<void>;
}

// ── Prisma implementation ────────────────────────────────────────────────

const CARD_SELECT = {
  id: true,
  title: true,
  companyName: true,
  location: true,
  locationCity: true,
  locationRegion: true,
  locationCountry: true,
  workModel: true,
  remoteScope: true,
  employmentType: true,
  seniority: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  salaryPeriod: true,
  salaryDisclosed: true,
  salaryText: true,
  sourceName: true,
  originalSourceName: true,
  sourceBoard: true,
  postedAt: true,
  postedAtEstimated: true,
  firstSeenAt: true,
  updatedAt: true,
  expiresAt: true,
  closedAt: true,
  archivedAt: true,
  market: true,
  visibility: true,
  isCanonical: true,
  publicDisplay: true,
  fromRecruiterBank: true,
  fraudFlags: true,
  taxonomyIds: true,
  sponsorship: true,
  sponsorshipEvidence: true,
} as const satisfies Prisma.RAJobSelect;

const DETAIL_SELECT = {
  ...CARD_SELECT,
  descriptionPlain: true,
  qualifications: true,
  responsibilities: true,
  benefits: true,
  applyUrl: true,
  sourceUrl: true,
  companyId: true,
  company: { select: { displayName: true, website: true, logoUrl: true, facts: true } },
} as const satisfies Prisma.RAJobSelect;

type GroupByFn = (args: {
  by: GroupKey[];
  where: Prisma.RAJobWhereInput;
  _count: { _all: true };
  orderBy: { _count: { id: 'desc' } };
  take: number;
}) => Promise<Array<Partial<Record<GroupKey, string | null>> & { _count: { _all: number } }>>;

/** The typed Prisma surface the repository uses (tests never reach it). */
export interface SeoPrismaDb {
  rAJob: {
    count(args: { where: Prisma.RAJobWhereInput }): Promise<number>;
    findMany(args: Prisma.RAJobFindManyArgs): Promise<unknown[]>;
    findUnique(args: Prisma.RAJobFindUniqueArgs): Promise<unknown | null>;
    groupBy: unknown;
  };
  rASeoPage: {
    findMany(args: Prisma.RASeoPageFindManyArgs): Promise<unknown[]>;
    count(args: { where: Prisma.RASeoPageWhereInput }): Promise<number>;
    upsert(args: Prisma.RASeoPageUpsertArgs): Promise<unknown>;
  };
}

function extraWhere(extra: CountExtra = {}): Prisma.RAJobWhereInput[] {
  const out: Prisma.RAJobWhereInput[] = [];
  if (extra.firstSeenSince) out.push({ firstSeenAt: { gte: extra.firstSeenSince } });
  if (extra.payListed) out.push({ salaryDisclosed: true });
  return out;
}

function whereWith(scope: JobScope, ctx: ScopeContext, extra?: CountExtra): Prisma.RAJobWhereInput {
  const w = publicJobWhere(scope, ctx);
  return { ...w, AND: [...((w.AND as Prisma.RAJobWhereInput[]) ?? []), ...extraWhere(extra)] };
}

export function createPrismaSeoRepo(db: SeoPrismaDb): SeoRepo {
  const groupBy = db.rAJob.groupBy as GroupByFn;
  return {
    countJobs: (scope, ctx, extra) => db.rAJob.count({ where: whereWith(scope, ctx, extra) }),
    async listJobs(scope, ctx, opts) {
      const orderBy: Prisma.RAJobOrderByWithRelationInput[] =
        opts.order === 'posted' ? [{ postedAt: { sort: 'desc', nulls: 'last' } }, { firstSeenAt: 'desc' }, { id: 'asc' }] : [{ firstSeenAt: 'desc' }, { id: 'asc' }];
      return (await db.rAJob.findMany({ where: whereWith(scope, ctx), select: CARD_SELECT, orderBy, take: opts.limit })) as SeoJobRow[];
    },
    async payRows(scope, ctx, limit) {
      return (await db.rAJob.findMany({
        where: whereWith(scope, ctx, { payListed: true }),
        select: { salaryMin: true, salaryMax: true, salaryCurrency: true, salaryPeriod: true, salaryDisclosed: true },
        orderBy: { id: 'asc' },
        take: limit,
      })) as PayRow[];
    },
    async topCompanies(scope, ctx, limit) {
      const rows = await groupBy({ by: ['companyName'], where: whereWith(scope, ctx), _count: { _all: true }, orderBy: { _count: { id: 'desc' } }, take: limit });
      return rows.map((r) => ({ name: r.companyName ?? '', count: r._count._all })).filter((r) => r.name);
    },
    async groupCounts(scope, ctx, by, limit) {
      const rows = await groupBy({ by: [...by], where: whereWith(scope, ctx), _count: { _all: true }, orderBy: { _count: { id: 'desc' } }, take: limit });
      return rows.map((r) => {
        const keys: GroupCount['keys'] = {};
        for (const k of by) keys[k] = r[k] ?? null;
        return { keys, count: r._count._all };
      });
    },
    async findJob(id) {
      return (await db.rAJob.findUnique({ where: { id }, select: DETAIL_SELECT })) as SeoJobDetailRow | null;
    },
    async listJobPage(ctx, opts) {
      return (await db.rAJob.findMany({
        where: whereWith({}, ctx),
        select: { id: true, title: true, companyName: true, updatedAt: true },
        orderBy: { id: 'asc' },
        skip: opts.skip,
        take: opts.take,
      })) as Array<{ id: string; title: string; companyName: string; updatedAt: Date }>;
    },
    async listSeoPages(brand, opts) {
      return (await db.rASeoPage.findMany({
        where: { brand, ...(opts.indexableOnly ? { indexable: true } : {}) },
        orderBy: [{ type: 'asc' }, { slug: 'asc' }],
        ...(opts.skip ? { skip: opts.skip } : {}),
        ...(opts.take ? { take: opts.take } : {}),
      })) as SeoPageRow[];
    },
    countSeoPages: (brand, opts) => db.rASeoPage.count({ where: { brand, ...(opts.indexableOnly ? { indexable: true } : {}) } }),
    async upsertSeoPage(row) {
      const data = {
        params: row.params as Prisma.InputJsonValue,
        title: row.title,
        h1: row.h1,
        intro: row.intro,
        stats: row.stats as Prisma.InputJsonValue,
        jobCount: row.jobCount,
        indexable: row.indexable,
        lastBuiltAt: row.lastBuiltAt,
      };
      await db.rASeoPage.upsert({
        where: { brand_locale_type_slug: { brand: row.brand, locale: row.locale, type: row.type, slug: row.slug } },
        create: { brand: row.brand, locale: row.locale, type: row.type, slug: row.slug, ...data },
        update: data,
      });
    },
  };
}

let defaultRepo: SeoRepo | null = null;

/** The repository over the shared Prisma client (lazy, so importing the router never opens a connection). */
export async function defaultSeoRepo(): Promise<SeoRepo> {
  if (!defaultRepo) {
    const { default: prisma } = await import('../../lib/prisma.js');
    defaultRepo = createPrismaSeoRepo(prisma as unknown as SeoPrismaDb);
  }
  return defaultRepo;
}
