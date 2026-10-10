// server/src/features/seo/testkit.ts — an in-memory SeoRepo for tests (and
// for other areas' route tests that mount the SEO router without a
// database). Same contract as the Prisma repository, filtering with
// `matchesScope` (the row twin of `publicJobWhere`).

import type { CountExtra, GroupCount, GroupKey, SeoJobDetailRow, SeoPageRow, SeoRepo } from './repo.js';
import { matchesScope, type JobScope, type ScopeContext } from './scope.js';

let seq = 0;

/** A job row with sensible public defaults; override what the test is about. */
export function seoJob(over: Partial<SeoJobDetailRow> = {}): SeoJobDetailRow {
  seq += 1;
  const at = new Date('2026-10-01T00:00:00.000Z');
  return {
    id: `job${seq}`,
    title: 'Backend Engineer',
    companyName: `Company ${seq}`,
    location: 'Taipei, Taiwan',
    locationCity: 'Taipei',
    locationRegion: null,
    locationCountry: 'TW',
    workModel: 'onsite',
    remoteScope: null,
    employmentType: 'full_time',
    seniority: 'mid',
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryDisclosed: false,
    salaryText: null,
    sourceName: 'RoboHire',
    originalSourceName: null,
    sourceBoard: 'robohire',
    postedAt: at,
    postedAtEstimated: false,
    firstSeenAt: at,
    updatedAt: at,
    expiresAt: null,
    closedAt: null,
    archivedAt: null,
    market: 'intl',
    visibility: 'public',
    isCanonical: true,
    publicDisplay: true,
    fromRecruiterBank: true,
    fraudFlags: null,
    taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'],
    sponsorship: null,
    sponsorshipEvidence: null,
    descriptionPlain: 'Build and run the services behind our product.',
    qualifications: null,
    responsibilities: null,
    benefits: null,
    applyUrl: 'https://jobs.example.com/apply/1',
    sourceUrl: 'https://jobs.example.com/1',
    companyId: null,
    company: null,
    ...over,
  };
}

export function seoJobs(n: number, over: Partial<SeoJobDetailRow> = {}): SeoJobDetailRow[] {
  return Array.from({ length: n }, () => seoJob(over));
}

export interface MemorySeoRepo extends SeoRepo {
  jobs: SeoJobDetailRow[];
  pages: SeoPageRow[];
}

export function createMemorySeoRepo(jobs: SeoJobDetailRow[] = [], pages: SeoPageRow[] = []): MemorySeoRepo {
  const scoped = (scope: JobScope, ctx: ScopeContext, extra: CountExtra = {}) =>
    jobs.filter(
      (j) =>
        matchesScope(j, scope, ctx) &&
        (!extra.firstSeenSince || j.firstSeenAt.getTime() >= extra.firstSeenSince.getTime()) &&
        (!extra.payListed || j.salaryDisclosed),
    );
  const keyOf = (j: SeoJobDetailRow, k: GroupKey): string | null =>
    k === 'primaryTaxonomyId' ? (j.taxonomyIds[j.taxonomyIds.length - 1] ?? null) : ((j as unknown as Record<string, string | null>)[k] ?? null);
  const time = (d: Date | null) => (d ? d.getTime() : -Infinity);
  return {
    jobs,
    pages,
    async countJobs(scope, ctx, extra) {
      return scoped(scope, ctx, extra).length;
    },
    async listJobs(scope, ctx, opts) {
      const rows = scoped(scope, ctx);
      rows.sort((a, b) =>
        opts.order === 'posted'
          ? time(b.postedAt) - time(a.postedAt) || b.firstSeenAt.getTime() - a.firstSeenAt.getTime() || a.id.localeCompare(b.id)
          : b.firstSeenAt.getTime() - a.firstSeenAt.getTime() || a.id.localeCompare(b.id),
      );
      return rows.slice(0, opts.limit);
    },
    async payRows(scope, ctx, limit) {
      return scoped(scope, ctx, { payListed: true }).slice(0, limit);
    },
    async topCompanies(scope, ctx, limit) {
      const groups = await this.groupCounts(scope, ctx, ['companyName'], limit);
      return groups.map((g) => ({ name: g.keys.companyName ?? '', count: g.count }));
    },
    async groupCounts(scope, ctx, by, limit) {
      const map = new Map<string, GroupCount>();
      for (const j of scoped(scope, ctx)) {
        const keys: GroupCount['keys'] = {};
        for (const k of by) keys[k] = keyOf(j, k);
        const id = JSON.stringify(keys);
        const g = map.get(id) ?? { keys, count: 0 };
        g.count += 1;
        map.set(id, g);
      }
      return [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit);
    },
    async findJob(id) {
      return jobs.find((j) => j.id === id) ?? null;
    },
    async listJobPage(ctx, opts) {
      return scoped({}, ctx)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(opts.skip, opts.skip + opts.take)
        .map((j) => ({ id: j.id, title: j.title, companyName: j.companyName, updatedAt: j.updatedAt }));
    },
    async listSeoPages(brand, opts) {
      const rows = pages
        .filter((p) => p.brand === brand && (!opts.indexableOnly || p.indexable))
        .sort((a, b) => a.type.localeCompare(b.type) || a.slug.localeCompare(b.slug));
      const skip = opts.skip ?? 0;
      return rows.slice(skip, opts.take ? skip + opts.take : undefined);
    },
    async countSeoPages(brand, opts) {
      return pages.filter((p) => p.brand === brand && (!opts.indexableOnly || p.indexable)).length;
    },
    async upsertSeoPage(row) {
      const i = pages.findIndex((p) => p.brand === row.brand && p.locale === row.locale && p.type === row.type && p.slug === row.slug);
      if (i >= 0) pages[i] = { ...row };
      else pages.push({ ...row });
    },
  };
}
