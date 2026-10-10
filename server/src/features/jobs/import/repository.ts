// server/src/features/jobs/import/repository.ts — database reads and writes
// of the job import (WP-35). Typed Prisma only.
//
// Honesty rules encoded here:
//   - an imported job is written `visibility='private'`, `ownerUserId` set,
//     `sourceBoard='user_import'`, `publicDisplay=false`, never canonical
//     for anyone else: every aggregate and public count filters
//     `visibility='public'`, so imports never appear in counts or pages;
//   - "private company rows" (F-JOB-04): an import links to the market's
//     existing company record when the name matches, but never creates one —
//     a company page (and its "{n} open jobs") is never seeded from what a
//     user typed;
//   - a public match is looked up only among live, canonical public jobs of
//     the same market.

import prisma from '../../../lib/prisma.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { NormalizedJob } from '../normalize/index.js';

/** The private RAJob row an import writes. */
export interface PrivateJobInput {
  job: NormalizedJob;
  ownerUserId: string;
  companyId: string | null;
  /** Rule-based warnings found before saving (`[{ rule, evidence, at }]`). */
  fraudFlags: Array<{ rule: string; evidence: string; at: string }> | null;
}

export interface StoredImportJob {
  id: string;
  ownerUserId: string | null;
  visibility: string;
  sourceBoard: string;
  market: string;
  archivedAt: Date | null;
  fraudFlags: unknown;
}

export interface AddedJobRow {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  workModel: string | null;
  applyUrl: string;
  createdAt: Date;
  fraudFlags: unknown;
}

export interface ImportRepository {
  /**
   * The user's own import with identical content (externalId), or the same
   * non-empty apply link with the same title (a re-paste with an edited
   * description). A shared link alone (a generic careers page) is not enough.
   */
  findOwnImport(
    userId: string,
    match: { externalId: string; applyUrl: string | null; titleNormalized: string },
  ): Promise<{ id: string; archivedAt: Date | null } | null>;
  findPublicMatch(match: { market: string; urls: string[]; dedupeKey: string | null }): Promise<{ id: string } | null>;
  findCompanyId(market: string, nameNormalized: string): Promise<string | null>;
  createPrivateJob(input: PrivateJobInput): Promise<{ id: string }>;
  restore(jobId: string): Promise<void>;
  loadJob(jobId: string): Promise<StoredImportJob | null>;
  listAdded(userId: string, options: { before: { createdAt: Date; id: string } | null; take: number }): Promise<AddedJobRow[]>;
  trackerStatuses(userId: string, jobIds: string[]): Promise<Map<string, string>>;
  archiveAdded(userId: string, jobId: string, now: Date): Promise<boolean>;
  /** The user's name and email, never sent to a no-PI vendor. */
  knownValues(userId: string): Promise<string[]>;
}

/** The Prisma delegates the repository uses (tests pass a fake cast to this type). */
export type ImportDb = Pick<typeof prisma, 'rAJob' | 'rACompany' | 'rATrackerEntry' | 'user'>;

const int = (v: number | null): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v));

/** NormalizedJob → the RAJob create data for a private import. */
export function privateJobData(input: PrivateJobInput): Prisma.RAJobUncheckedCreateInput {
  const { job } = input;
  return {
    externalId: job.externalId,
    sourceBoard: 'user_import',
    // Empty when the job was typed by hand without a link (the column is NOT NULL).
    applyUrl: job.applyUrl ?? '',
    title: job.title,
    titleNormalized: job.titleNormalized,
    companyName: job.companyName,
    companyNameNormalized: job.companyNameNormalized,
    companyLogoUrl: null,
    location: job.location,
    locationCity: job.locationCity,
    locationCountry: job.locationCountry,
    // Deprecated NOT NULL column: mirrors workModel ('onsite' is only its legacy placeholder).
    workType: job.workModel ?? 'onsite',
    employmentType: job.employmentType,
    salaryMin: int(job.salaryMin),
    salaryMax: int(job.salaryMax),
    salaryCurrency: job.salaryCurrency,
    salaryPeriod: job.salaryPeriod,
    description: job.description,
    descriptionPlain: job.descriptionPlain,
    postedAt: job.postedAt,
    market: job.market,
    visibility: 'private',
    ownerUserId: input.ownerUserId,
    companyId: input.companyId,
    taxonomyIds: job.taxonomyIds,
    primaryTaxonomyId: job.primaryTaxonomyId,
    seniority: job.seniority,
    roleType: job.roleType,
    minYears: int(job.minYears),
    maxYears: int(job.maxYears),
    skills: job.skills,
    workModel: job.workModel,
    remoteScope: job.remoteScope,
    locationRegion: job.locationRegion,
    locations: job.locations.map((l) => ({ city: l.city, region: l.region, country: l.country, lat: l.lat, lng: l.lng })),
    geoLat: job.geoLat,
    geoLng: job.geoLng,
    salarySource: job.salarySource,
    salaryAnnualMin: int(job.salaryAnnualMin),
    salaryAnnualMax: int(job.salaryAnnualMax),
    salaryMonths: int(job.salaryMonths),
    salaryDisclosed: job.salaryDisclosed,
    salaryText: job.salaryText,
    sourceUrl: job.sourceUrl,
    // No aggregator: the user is the source. The UI says "Added by you".
    sourceName: null,
    originalSourceName: null,
    originalHost: job.originalHost,
    atsType: job.atsType,
    isAgency: job.isAgency,
    fromRecruiterBank: false,
    employerVerified: false,
    applicantCount: null,
    applicantCountSource: null,
    applicantCountAt: null,
    postedAtEstimated: job.postedAtEstimated,
    expiresAt: null,
    dedupeKey: job.dedupeKey,
    // A private row is never anyone's canonical public job; it points at nothing.
    isCanonical: true,
    canonicalJobId: null,
    sourcePriority: job.sourcePriority,
    searchText: job.searchText,
    publicDisplay: false,
    ...(input.fraudFlags && input.fraudFlags.length ? { fraudFlags: input.fraudFlags } : {}),
  };
}

export function createPrismaImportRepository(getDb: () => ImportDb = () => prisma): ImportRepository {
  return {
    async findOwnImport(userId, match) {
      // Not by dedupeKey: the same title, company and place can be a second posting the user means to keep.
      const or: Prisma.RAJobWhereInput[] = [{ externalId: match.externalId }];
      if (match.applyUrl && match.titleNormalized) or.push({ applyUrl: match.applyUrl, titleNormalized: match.titleNormalized });
      const row = await getDb().rAJob.findFirst({
        where: { sourceBoard: 'user_import', ownerUserId: userId, OR: or },
        orderBy: { createdAt: 'desc' },
        select: { id: true, archivedAt: true },
      });
      return row;
    },

    async findPublicMatch(match) {
      const or: Prisma.RAJobWhereInput[] = [];
      for (const url of match.urls) or.push({ applyUrl: url }, { sourceUrl: url });
      if (match.dedupeKey) or.push({ dedupeKey: match.dedupeKey });
      if (!or.length) return null;
      const row = await getDb().rAJob.findFirst({
        where: { visibility: 'public', market: match.market, archivedAt: null, isCanonical: true, OR: or },
        orderBy: { sourcePriority: 'asc' },
        select: { id: true },
      });
      return row;
    },

    async findCompanyId(market, nameNormalized) {
      if (!nameNormalized) return null;
      const row = await getDb().rACompany.findFirst({ where: { market, nameNormalized }, select: { id: true } });
      return row?.id ?? null;
    },

    async createPrivateJob(input) {
      const row = await getDb().rAJob.create({ data: privateJobData(input), select: { id: true } });
      return { id: row.id };
    },

    async restore(jobId) {
      await getDb().rAJob.update({ where: { id: jobId }, data: { archivedAt: null, closedAt: null, closeReason: null }, select: { id: true } });
    },

    async loadJob(jobId) {
      return await getDb().rAJob.findFirst({
        where: { id: jobId },
        select: { id: true, ownerUserId: true, visibility: true, sourceBoard: true, market: true, archivedAt: true, fraudFlags: true },
      });
    },

    async listAdded(userId, options) {
      const where: Prisma.RAJobWhereInput = { sourceBoard: 'user_import', ownerUserId: userId, visibility: 'private', archivedAt: null };
      if (options.before) {
        where.OR = [
          { createdAt: { lt: options.before.createdAt } },
          { createdAt: options.before.createdAt, id: { lt: options.before.id } },
        ];
      }
      return await getDb().rAJob.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: options.take,
        select: { id: true, title: true, companyName: true, location: true, workModel: true, applyUrl: true, createdAt: true, fraudFlags: true },
      });
    },

    async trackerStatuses(userId, jobIds) {
      const out = new Map<string, string>();
      if (!jobIds.length) return out;
      const rows = await getDb().rATrackerEntry.findMany({
        where: { userId, jobId: { in: jobIds }, deletedAt: null },
        select: { jobId: true, status: true },
      });
      for (const r of rows) if (r.jobId) out.set(r.jobId, r.status);
      return out;
    },

    async archiveAdded(userId, jobId, now) {
      const { count } = await getDb().rAJob.updateMany({
        where: { id: jobId, ownerUserId: userId, sourceBoard: 'user_import', visibility: 'private', archivedAt: null },
        data: { archivedAt: now, closedAt: now, closeReason: 'removed_by_user' },
      });
      return count > 0;
    },

    async knownValues(userId) {
      const user = await getDb().user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
      return [user?.name, user?.email].filter((v): v is string => typeof v === 'string' && v.trim().length > 1);
    },
  };
}
