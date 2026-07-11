/**
 * raJobSearch — pure helpers that build the WHERE clauses for the
 * `RAJob` filtering surface.
 *
 * Spec: docs/roboapply/v2/04-backend-spec.md §5.3 (Search) — every input
 * field below maps 1:1 to a query parameter on `GET /api/v1/roboapply/v2/search`.
 *
 * Returns a Prisma-compatible `where` object that BE2's route handler /
 * `RASearchService` can pass directly to `prisma.rAJob.findMany`. This
 * file has zero Prisma-runtime imports — it only depends on the
 * generated client types — so it stays cheap to test and import.
 *
 * Implementation notes:
 *
 * - Spec §3 calls for a `pg_trgm` GIN index on `titleNormalized` /
 *   `companyNameNormalized` to power substring search. Prisma 7 does not
 *   natively manage GIN-trgm indexes via `@@index`, so for V2 launch
 *   (~200 seeded rows) we fall back to a plain `contains` ILIKE on the
 *   normalized columns. That's a sequential scan, which is acceptable
 *   at launch scale and forward-compatible: when V2.5 adds live ingest
 *   (10k+ rows), enable the `postgresqlExtensions` preview flag and add
 *   a raw GIN-trgm index migration; the `contains` predicate will start
 *   using the index automatically.
 *
 * - Date-posted is a relative range, NOT an enum on the Prisma side —
 *   we materialise it into a `gte: Date` predicate so the underlying
 *   query uses the btree `(postedAt DESC, archivedAt)` index.
 *
 * - `archivedAt: null` is the universal default filter (matches the
 *   spec's "excluded from search by default"). Callers cannot opt out
 *   from this helper; an admin-only deep-list path would need its own
 *   helper.
 */

import type { Prisma } from '../../../generated/prisma/client.js';

export type RADatePostedFilter = 'today' | '7d' | '30d' | 'any';
export type RAWorkTypeFilter = 'remote' | 'hybrid' | 'onsite';
export type RAEmploymentTypeFilter =
  | 'full_time'
  | 'contract'
  | 'part_time'
  | 'internship';

export interface RAJobSearchInput {
  /** Free-form query — matched against titleNormalized + companyNameNormalized. */
  q?: string | null;
  /** City/region substring — matched against location + locationCity (case-insensitive). */
  location?: string | null;
  workType?: RAWorkTypeFilter | null;
  /** Minimum salary the job advertises (annual base). */
  salaryMin?: number | null;
  /** ISO 4217 currency to match (null = any). */
  salaryCurrency?: string | null;
  datePosted?: RADatePostedFilter | null;
  employmentType?: RAEmploymentTypeFilter | null;
  /**
   * Allow archived rows? Default false. Reserved for admin tooling /
   * tracker hydration; the public search endpoint never sets this.
   */
  includeArchived?: boolean;
}

/**
 * Build the Prisma `where` clause for an `RAJob.findMany` call. Pure —
 * no DB access. Returns a fully-typed `Prisma.RAJobWhereInput`.
 */
export function buildRAJobSearchWhere(
  input: RAJobSearchInput,
): Prisma.RAJobWhereInput {
  const where: Prisma.RAJobWhereInput = {};
  const andClauses: Prisma.RAJobWhereInput[] = [];

  // Universal: exclude archived unless explicitly requested.
  if (!input.includeArchived) {
    where.archivedAt = null;
  }
  // Universal: the 'seed' demo corpus (fake postings, dead applyUrls) is never
  // user-visible — mirrors the onboarding lane's deliberate exclusion.
  where.sourceBoard = { not: 'seed' };

  // q — tokenised OR-match against normalized title / company / description.
  // Tokens of length ≥2 are required; short particles ("a", "i", "of") are
  // dropped. A job matches if ANY token hits any of the searchable fields.
  // This mirrors the stub's behaviour (lib/stub/raV2.stub.ts) and aligns
  // with how a future pg_trgm GIN index will rank — soft match by default,
  // ranked by hits. Single-substring on the full phrase was too strict:
  // queries like "AI Software Engineer" returned zero hits because no
  // single job title contains that exact phrase.
  if (input.q && input.q.trim().length > 0) {
    const raw = input.q.trim().toLowerCase();
    const tokens = raw.split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length === 0) {
      // All tokens were short — fall back to a substring match on the
      // full phrase against title/company so very short queries still work.
      andClauses.push({
        OR: [
          { titleNormalized: { contains: raw } },
          { companyNameNormalized: { contains: raw } },
        ],
      });
    } else {
      const tokenOrs: Prisma.RAJobWhereInput[] = [];
      for (const tok of tokens) {
        tokenOrs.push({ titleNormalized: { contains: tok } });
        tokenOrs.push({ companyNameNormalized: { contains: tok } });
        tokenOrs.push({ description: { contains: tok, mode: 'insensitive' } });
      }
      andClauses.push({ OR: tokenOrs });
    }
  }

  // Location — substring on both `location` (free-form) and `locationCity`.
  if (input.location && input.location.trim().length > 0) {
    const loc = input.location.trim();
    andClauses.push({
      OR: [
        { location: { contains: loc, mode: 'insensitive' } },
        { locationCity: { contains: loc, mode: 'insensitive' } },
      ],
    });
  }

  // workType — direct equality on the discriminator.
  if (input.workType) {
    where.workType = input.workType;
  }

  // employmentType — direct equality.
  if (input.employmentType) {
    where.employmentType = input.employmentType;
  }

  // Salary floor — only include rows whose `salaryMin` meets the user's
  // floor. Rows with `salaryMin: null` are excluded when a floor is set
  // (the candidate explicitly wants a number); when no floor is set, all
  // rows pass.
  if (typeof input.salaryMin === 'number' && Number.isFinite(input.salaryMin)) {
    where.salaryMin = { gte: input.salaryMin };
    if (input.salaryCurrency) {
      where.salaryCurrency = input.salaryCurrency;
    }
  }

  // datePosted — materialise the enum into a date floor.
  if (input.datePosted && input.datePosted !== 'any') {
    const floor = resolveDatePostedFloor(input.datePosted);
    if (floor) {
      where.postedAt = { gte: floor };
    }
  }

  if (andClauses.length > 0) {
    where.AND = andClauses;
  }

  return where;
}

/**
 * Translate the spec's `datePosted` enum into an absolute UTC floor.
 * Returns `null` for the no-op cases ('any' or unknown — callers should
 * never pass them, but be defensive).
 */
function resolveDatePostedFloor(value: RADatePostedFilter): Date | null {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  switch (value) {
    case 'today':
      return new Date(now - dayMs);
    case '7d':
      return new Date(now - 7 * dayMs);
    case '30d':
      return new Date(now - 30 * dayMs);
    case 'any':
    default:
      return null;
  }
}

/**
 * Normalise a title or company name string into the form stored in
 * `titleNormalized` / `companyNameNormalized`. Trimmed + lowercased.
 *
 * Used both by the seed script (which stamps these columns) and by any
 * search callers that want to do client-side previewing before hitting
 * the DB.
 */
export function normalizeForSearch(value: string): string {
  return value.trim().toLowerCase();
}
