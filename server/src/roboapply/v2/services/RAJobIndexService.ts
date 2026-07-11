// backend/src/roboapply/v2/services/RAJobIndexService.ts
//
// Job index queries against the `RAJob` table. Used by /search/run and the
// job-detail page. Filters, sort modes, keyset pagination, facets.
//
// Note: `roboapply/v2/lib/raJobSearch.ts` is BE1-owned and will hold the
// trigram-similarity helpers when live ingest lands in V2.5. For the seed-
// data scale (~200 rows) we do everything in Prisma here — sequential scans
// are cheap and the filter shapes match the stub byte-for-byte.

import prisma from '../../../lib/prisma.js';

export type RAWorkType = 'remote' | 'hybrid' | 'onsite';
export type RAEmploymentType = 'full_time' | 'contract' | 'part_time' | 'internship';
export type RADatePosted = 'today' | '7d' | '30d' | 'any';
export type RASortBy = 'relevance' | 'recent' | 'salary_desc' | 'match_desc';
// robohire/gohire = cross-bank search agent team materializations.
export type RASourceBoard =
  | 'greenhouse'
  | 'lever'
  | 'seed'
  | 'manual'
  | 'jsearch'
  | 'robohire'
  | 'gohire';
export type RASalaryPeriod = 'year' | 'hour' | 'month';

export interface RAJobView {
  id: string;
  externalId: string;
  sourceBoard: RASourceBoard;
  applyUrl: string;
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  workType: RAWorkType;
  employmentType: RAEmploymentType | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: RASalaryPeriod | null;
  description: string;
  qualifications: string | null;
  responsibilities: string | null;
  benefits: string | null;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RAJobListItem {
  id: string;
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  workType: RAWorkType;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  postedAt: string | null;
  isBookmarked: boolean;
  matchScoreCached: number | null;
}

export interface SearchQuery {
  q?: string;
  location?: string;
  workType?: RAWorkType;
  salaryMin?: number;
  salaryCurrency?: string;
  datePosted?: RADatePosted;
  sortBy?: RASortBy;
  employmentType?: RAEmploymentType;
}

export interface SearchRunParams extends SearchQuery {
  limit?: number;
  cursor?: string;
}

export interface SearchRunResult {
  jobs: RAJobListItem[];
  nextCursor: string | null;
  facets?: {
    workType: Record<string, number>;
    locationCountry: Record<string, number>;
  };
}

function isoOrNull(d: any): string | null {
  if (d == null) return null;
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

function isoDate(d: any): string {
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

export function toJobView(row: any): RAJobView {
  return {
    id: row.id,
    externalId: row.externalId,
    sourceBoard: row.sourceBoard as RASourceBoard,
    applyUrl: row.applyUrl,
    title: row.title,
    companyName: row.companyName,
    companyLogoUrl: row.companyLogoUrl ?? null,
    location: row.location ?? null,
    locationCity: row.locationCity ?? null,
    locationCountry: row.locationCountry ?? null,
    workType: (row.workType ?? 'onsite') as RAWorkType,
    employmentType: (row.employmentType ?? null) as RAEmploymentType | null,
    salaryMin: row.salaryMin ?? null,
    salaryMax: row.salaryMax ?? null,
    salaryCurrency: row.salaryCurrency ?? null,
    salaryPeriod: (row.salaryPeriod ?? null) as RASalaryPeriod | null,
    description: row.description ?? '',
    qualifications: row.qualifications ?? null,
    responsibilities: row.responsibilities ?? null,
    benefits: row.benefits ?? null,
    postedAt: isoOrNull(row.postedAt),
    createdAt: isoDate(row.createdAt),
    updatedAt: isoDate(row.updatedAt),
  };
}

const DAY_MS = 86_400_000;

export class RAJobIndexService {
  /** GET /search/run. Sort-by-match requires per-user joined `matchScoreCached`
   *  values which only exist for jobs the user has actively scored — we fall
   *  back to NULL (-1 in sort) for unscored jobs. */
  async search(userId: string, params: SearchRunParams): Promise<SearchRunResult> {
    const p = prisma as any;
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
    const offset = params.cursor ? Math.max(0, parseInt(params.cursor, 10) || 0) : 0;

    // sourceBoard 'seed' = the demo fixture corpus (fake postings with dead
    // applyUrls) — excluded defensively here, matching the onboarding lane's
    // deliberate exclusion (RAOnboardingRecommendService), so an un-archived
    // seed row can never leak into user-visible search/home results.
    const where: any = { archivedAt: null, sourceBoard: { not: 'seed' } };
    if (params.q && params.q.trim()) {
      const tokens = params.q
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2);
      const needle = params.q.toLowerCase();
      if (tokens.length === 0) {
        where.OR = [
          { titleNormalized: { contains: needle } },
          { companyNameNormalized: { contains: needle } },
        ];
      } else {
        // Soft-match: ANY token in title|company|description. Mirrors the
        // stub's BUG-RA-V2-03 round-2 fix so the Home grid renders enough
        // results for goal-title queries.
        const orClauses: any[] = [];
        for (const t of tokens) {
          orClauses.push({ titleNormalized: { contains: t } });
          orClauses.push({ companyNameNormalized: { contains: t } });
          orClauses.push({ descriptionPlain: { contains: t, mode: 'insensitive' } });
        }
        where.OR = orClauses;
      }
    }
    if (params.location) {
      const needle = params.location.toLowerCase();
      where.AND = [
        ...(where.AND ?? []),
        {
          OR: [
            { location: { contains: needle, mode: 'insensitive' } },
            { locationCity: { contains: needle, mode: 'insensitive' } },
          ],
        },
      ];
    }
    if (params.workType) where.workType = params.workType;
    if (params.employmentType) where.employmentType = params.employmentType;
    if (typeof params.salaryMin === 'number') {
      where.salaryMax = { gte: params.salaryMin };
    }
    if (params.datePosted && params.datePosted !== 'any') {
      const limitDays =
        params.datePosted === 'today' ? 1 : params.datePosted === '7d' ? 7 : 30;
      where.postedAt = { gte: new Date(Date.now() - limitDays * DAY_MS) };
    }

    const sortBy = params.sortBy ?? 'relevance';
    let orderBy: any = [{ postedAt: 'desc' }];
    if (sortBy === 'recent') orderBy = [{ postedAt: 'desc' }];
    else if (sortBy === 'salary_desc') orderBy = [{ salaryMax: 'desc' }];
    // 'match_desc' is handled in-memory below (requires per-user join).
    // 'relevance' falls back to default ordering.

    // We need facets on cold-load (no cursor) -> need the full filtered set.
    // 200 rows max, so the inflated cost is trivial.
    const rowsAll = await p.rAJob.findMany({ where, orderBy });

    const bookmarks = await p.rATrackerEntry.findMany({
      where: { userId, jobId: { in: rowsAll.map((r: any) => r.id) } },
      select: { jobId: true },
    });
    const bookmarkedIds = new Set<string>(
      bookmarks.map((b: any) => b.jobId).filter((x: any): x is string => !!x),
    );

    const scoreRows = await p.rAJobMatchScore.findMany({
      where: { userId, jobId: { in: rowsAll.map((r: any) => r.id) } },
      orderBy: { score: 'desc' },
      select: { jobId: true, score: true, resumeVariantId: true, generatedAt: true },
    });
    const bestScoreByJob = new Map<string, number>();
    for (const sr of scoreRows as Array<{ jobId: string; score: number }>) {
      const prev = bestScoreByJob.get(sr.jobId);
      if (prev === undefined || sr.score > prev) bestScoreByJob.set(sr.jobId, sr.score);
    }

    let sorted: any[] = rowsAll;
    if (sortBy === 'match_desc') {
      sorted = [...rowsAll].sort((a, b) => {
        const sa = bestScoreByJob.get(a.id) ?? -1;
        const sb = bestScoreByJob.get(b.id) ?? -1;
        return sb - sa;
      });
    }

    const page = sorted.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < sorted.length ? String(nextOffset) : null;

    const items: RAJobListItem[] = page.map((j: any) => ({
      id: j.id,
      title: j.title,
      companyName: j.companyName,
      companyLogoUrl: j.companyLogoUrl ?? null,
      location: j.location ?? null,
      workType: (j.workType ?? 'onsite') as RAWorkType,
      salaryMin: j.salaryMin ?? null,
      salaryMax: j.salaryMax ?? null,
      salaryCurrency: j.salaryCurrency ?? null,
      postedAt: isoOrNull(j.postedAt),
      isBookmarked: bookmarkedIds.has(j.id),
      matchScoreCached: bestScoreByJob.get(j.id) ?? null,
    }));

    let facets: SearchRunResult['facets'];
    if (!params.cursor) {
      const workType: Record<string, number> = {};
      const locationCountry: Record<string, number> = {};
      for (const j of sorted) {
        const wt = j.workType ?? 'onsite';
        workType[wt] = (workType[wt] ?? 0) + 1;
        if (j.locationCountry) {
          locationCountry[j.locationCountry] = (locationCountry[j.locationCountry] ?? 0) + 1;
        }
      }
      facets = { workType, locationCountry };
    }

    return { jobs: items, nextCursor, facets };
  }

  async getById(jobId: string): Promise<RAJobView | null> {
    const p = prisma as any;
    const row = await p.rAJob.findUnique({ where: { id: jobId } });
    return row ? toJobView(row) : null;
  }
}

export const raJobIndexService = new RAJobIndexService();
