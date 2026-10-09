// server/src/features/jobs/ingest/maintain.ts — `jobs-maintain` steps (ARCH §4.6; WP-16b).
//
//   1. Expire: a public, non-bank posting past its provider expiry — or, with
//      none, posted more than 45 days ago — is archived (closeReason 'expired').
//      Bank jobs never expire by date; the bank sync closes them.
//   2. Missed refreshes: a job of a metered search provider that two later
//      counted runs of the query that last returned it did not return — while
//      it is still inside that query's datePosted window — is archived as
//      'source_removed' (tracking.ts). This needs Schema request SR-16b-1;
//      until its columns exist (`perQueryTracking` false) the step is skipped
//      and nothing is archived as 'source_removed'.
//   3. Dedupe repair: canonical flags are recomputed for every key touched in
//      the last two days (archived canonicals hand over to the next row).

import { Prisma } from '../../../generated/prisma/client.js';
import type { Market } from '../../../platform/brand/index.js';
import type { JobSourceAdapter } from '../sources/index.js';
import { MAX_AGE_DAYS } from './config.js';
import type { IngestDb } from './db.js';
import { buildMissedSql } from './tracking.js';
import { applyDedupe } from './upsert.js';

/** Bank boards never expire by date. */
export const BANK_BOARDS = ['robohire', 'gohire'] as const;

export function buildExpireSql(market: Market): Prisma.Sql {
  return Prisma.sql`
    UPDATE "RAJob" SET "archivedAt" = now(), "closedAt" = COALESCE("closedAt", now()), "closeReason" = 'expired', "updatedAt" = now()
    WHERE "market" = ${market} AND "visibility" = 'public' AND "archivedAt" IS NULL
      AND "sourceBoard" <> ALL(${[...BANK_BOARDS]}::text[])
      AND ("expiresAt" < now() OR ("expiresAt" IS NULL AND "postedAt" < now() - make_interval(days => ${MAX_AGE_DAYS}::int)))`;
}

export interface MaintainResult {
  expired: number;
  missed: number;
  dedupeRepaired: number;
  /** False while Schema request SR-16b-1 is pending: the missed-refresh step did not run. */
  missedRule: boolean;
}

export async function runMaintenance(
  db: IngestDb,
  market: Market,
  adapters: readonly JobSourceAdapter[],
  options: { perQueryTracking: boolean },
): Promise<MaintainResult> {
  const expired = await db.$executeRaw(buildExpireSql(market));
  let missed = 0;
  if (options.perQueryTracking) {
    for (const a of adapters) {
      // Only metered search providers run planned queries; banks close their own jobs.
      if (a.kind !== 'search' || a.dailyCallLimit() === null) continue;
      missed += await db.$executeRaw(buildMissedSql(market, a.provider, a.sourceBoards));
    }
  }
  const dedupeRepaired = await applyDedupe(db, market, null);
  return { expired, missed, dedupeRepaired, missedRule: options.perQueryTracking };
}
