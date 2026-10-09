// server/src/features/jobs/ingest/tracking.ts — per-query "missed refresh" tracking (WP-16b; Schema request SR-16b-1).
//
// The `jobs-maintain` rule "archive after 2 missed refreshes" needs to know
// WHICH query last returned a job and how many successful runs that query has
// made since. That needs three columns that do not exist yet (SR-16b-1):
//
//   RAIngestQuery.runCount      Int     @default(0)
//   RAJob.lastSeenQueryId       String?
//   RAJob.lastSeenRun           Int?
//
// This module is the narrow adapter over them. `perQueryTrackingAvailable`
// probes information_schema (cached for an hour); until all three columns
// exist, ingest writes nothing extra and maintenance archives nothing as
// 'source_removed' (expiry and the 45-day rule still run). A provider-level
// proxy ("unseen for N hours while the provider ran elsewhere") is NOT used:
// with ~6,000 queries sharing a few hundred calls a day, and searches limited
// to recent postings, it archived live jobs within days.
//
// The rule, once the columns exist (`buildMissedSql`, mirrored by the pure
// `isMissedTwice`):
//   - a run counts only when it succeeded AND returned at least one posting
//     (an empty page from a flaky API is inconclusive);
//   - each counted run bumps runCount and stamps the jobs it returned with
//     (lastSeenQueryId, lastSeenRun = the new runCount);
//   - a job is archived when its query's runCount ≥ lastSeenRun + 2, i.e. two
//     later counted runs of that query did not return it;
//   - but only while the job is still inside the query's `datePosted` window
//     (minus a day of margin): a 'week' search can never return a posting
//     older than 7 days, so dropping out of the window is not "removed" —
//     those jobs are left to expiresAt / the 45-day rule.

import { Prisma } from '../../../generated/prisma/client.js';
import type { Market } from '../../../platform/brand/index.js';
import type { IngestDb } from './db.js';

/** Days a provider `datePosted` filter reaches back ('all' and unknown → no window). */
export const DATE_POSTED_WINDOW_DAYS: Readonly<Record<string, number>> = { today: 1, '3days': 3, week: 7, month: 30 };

/** Counted runs without the job after which it is archived. */
export const MISSED_RUNS = 2;

const PROBE_TTL_MS = 60 * 60_000;
let cache: { at: number; value: boolean } | null = null;

/** Test seam. */
export function resetTrackingCacheForTests(): void {
  cache = null;
}

/** Whether the SR-16b-1 columns exist (read-only information_schema probe, cached for an hour; any failure → false). */
export async function perQueryTrackingAvailable(db: Pick<IngestDb, '$queryRaw'>, now: number = Date.now()): Promise<boolean> {
  if (cache && now - cache.at < PROBE_TTL_MS) return cache.value;
  let value = false;
  try {
    const rows = await db.$queryRaw<Array<{ n: number | bigint }>>`
      SELECT count(*)::int AS "n" FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND ((table_name = 'RAIngestQuery' AND column_name = 'runCount')
          OR (table_name = 'RAJob' AND column_name IN ('lastSeenQueryId', 'lastSeenRun')))`;
    value = Array.isArray(rows) && Number(rows[0]?.n ?? 0) === 3;
  } catch {
    value = false;
  }
  cache = { at: now, value };
  return value;
}

/** Bumps a query's counted runs; RETURNING the new count. */
export function buildBumpRunSql(queryId: string): Prisma.Sql {
  return Prisma.sql`UPDATE "RAIngestQuery" SET "runCount" = "runCount" + 1 WHERE "id" = ${queryId} RETURNING "runCount"`;
}

/** Stamps the jobs a counted run returned. */
export function buildStampSeenSql(queryId: string, run: number, jobIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`UPDATE "RAJob" SET "lastSeenQueryId" = ${queryId}, "lastSeenRun" = ${run}::int WHERE "id" = ANY(${[...jobIds]}::text[])`;
}

/** After a counted run: bump the query and stamp what it returned. */
export async function recordCountedRun(db: IngestDb, queryId: string, jobIds: readonly string[]): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ runCount: number }>>(buildBumpRunSql(queryId));
  const run = Array.isArray(rows) ? rows[0]?.runCount : undefined;
  if (typeof run !== 'number') return null;
  if (jobIds.length) await db.$executeRaw(buildStampSeenSql(queryId, run, jobIds));
  return run;
}

/** SQL for a query's `datePosted` window in days (NULL = no window). */
const WINDOW_SQL = Prisma.sql`(CASE q."params"->>'datePosted' WHEN 'today' THEN 1 WHEN '3days' THEN 3 WHEN 'week' THEN 7 WHEN 'month' THEN 30 ELSE NULL END)`;

/** The per-query missed-refresh archive for one metered search provider (needs SR-16b-1). */
export function buildMissedSql(market: Market, provider: string, boards: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    UPDATE "RAJob" AS j SET "archivedAt" = now(), "closedAt" = now(), "closeReason" = 'source_removed', "updatedAt" = now()
    FROM "RAIngestQuery" q
    WHERE j."market" = ${market} AND j."visibility" = 'public' AND j."archivedAt" IS NULL
      AND j."sourceBoard" = ANY(${[...boards]}::text[])
      AND j."lastSeenQueryId" = q."id" AND q."provider" = ${provider} AND q."market" = ${market}
      AND j."lastSeenRun" IS NOT NULL AND q."runCount" >= j."lastSeenRun" + ${MISSED_RUNS}::int
      AND (${WINDOW_SQL} IS NULL OR COALESCE(j."postedAt", j."firstSeenAt") > now() - make_interval(days => ${WINDOW_SQL} - 1))`;
}

/** Pure mirror of `buildMissedSql`'s condition (documentation + tests). */
export function isMissedTwice(
  job: { lastSeenRun: number | null; postedAt: Date | null; firstSeenAt: Date },
  query: { runCount: number; datePosted: string },
  now: Date,
): boolean {
  if (job.lastSeenRun == null || query.runCount < job.lastSeenRun + MISSED_RUNS) return false;
  const window = DATE_POSTED_WINDOW_DAYS[query.datePosted];
  if (window === undefined) return true;
  const posted = (job.postedAt ?? job.firstSeenAt).getTime();
  return posted > now.getTime() - (window - 1) * 86_400_000;
}
