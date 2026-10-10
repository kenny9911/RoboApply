// server/src/features/jobs/ingest/maintain.ts — `jobs-maintain` steps (ARCH §4.6; WP-16b).
//
//   1. Expire: a public posting past its provider expiry — or, with none,
//      posted more than 45 days ago — is archived (closeReason 'expired').
//      Bank jobs and public ATS boards never expire by date: the bank sync
//      or the board sync closes them (an employer's board lists a role for
//      as long as it is open).
//   2. Missed refreshes: a job of a metered search provider that two later
//      counted runs of the query that last returned it did not return — while
//      it is still inside that query's datePosted window — is archived as
//      'source_removed' (tracking.ts). This needs Schema request SR-16b-1;
//      until its columns exist (`perQueryTracking` false) the step is skipped
//      and nothing is archived as 'source_removed'.
//   3. Dedupe repair: canonical flags are recomputed for every key touched in
//      the last two days (archived canonicals hand over to the next row).
//   4. Enrichment catch-up (WP-17 → WP-16b), at most ENRICH_REQUEUE_PER_RUN
//      jobs a run, oldest enrichment first:
//        a. rows enriched at an older ENRICH_VERSION are queued again (one
//           `job.enrich` item per job per version: a second run queues nothing);
//        b. rows that still owe a model pass (`enrichModel = 'rules'`: they
//           were finished while the brand had no usable enrich model, or
//           with ENRICH_DAILY_JOBS=0) are queued for one once the brand has
//           a model AND a daily budget above 0. The pass is recorded ON THE
//           ROW: it ends with the model's id, or with 'rules_checked' when
//           the model has nothing to add, the owner has not allowed AI, or
//           the call failed on its last attempt (enrich/service.ts
//           `rulesOnlyMarker`). Neither value is selected here again, so the
//           retry does not come back when the queue prunes its finished
//           items (7 days), and settled rows never fill the oldest-first
//           window ahead of rows that still owe a pass. The work-item key
//           (one per job per model id) only stops a second item while the
//           first is still queued or deferred.
//      Items carry the brand, so the drain runs them inside that brand.

import { createHash } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client.js';
import type { EnvSource, Market, ProductBrand } from '../../../platform/brand/index.js';
import type { EnqueueManyItem } from '../../../platform/queue/index.js';
import type { JobSourceAdapter } from '../sources/index.js';
import { PUBLIC_ATS } from '../sources/atsPublic/contract.js';
import { MAX_AGE_DAYS } from './config.js';
import type { IngestDb } from './db.js';
import type { EnqueueManyFn } from './pipeline.js';
import { buildMissedSql } from './tracking.js';
import { applyDedupe } from './upsert.js';

/** Bank boards never expire by date. */
export const BANK_BOARDS = ['robohire', 'gohire'] as const;
/**
 * `sourceBoard` values the date-expiry step never archives: the recruiter
 * banks and the public ATS boards (`ats_public`: greenhouse, lever, ashby,
 * smartrecruiters). Their own sync closes a posting the source stopped listing.
 */
export const NO_DATE_EXPIRY_BOARDS: readonly string[] = [...BANK_BOARDS, ...PUBLIC_ATS];

/** Jobs queued for re-enrichment per maintenance run (both kinds together). */
export const ENRICH_REQUEUE_PER_RUN = 500;
const ENRICH_KIND = 'job.enrich';

export function buildExpireSql(market: Market): Prisma.Sql {
  return Prisma.sql`
    UPDATE "RAJob" SET "archivedAt" = now(), "closedAt" = COALESCE("closedAt", now()), "closeReason" = 'expired', "updatedAt" = now()
    WHERE "market" = ${market} AND "visibility" = 'public' AND "archivedAt" IS NULL
      AND "sourceBoard" <> ALL(${[...NO_DATE_EXPIRY_BOARDS]}::text[])
      AND ("expiresAt" < now() OR ("expiresAt" IS NULL AND "postedAt" < now() - make_interval(days => ${MAX_AGE_DAYS}::int)))`;
}

/** Live rows enriched at an older version (never-enriched rows are queued by ingest and import). */
export function buildStaleEnrichSql(market: Market, version: number, limit: number): Prisma.Sql {
  return Prisma.sql`
    SELECT "id" FROM "RAJob"
    WHERE "market" = ${market} AND "archivedAt" IS NULL AND "enrichVersion" < ${version}::int
    ORDER BY "enrichedAt" ASC NULLS FIRST, "id" ASC
    LIMIT ${limit}::int`;
}

/**
 * Live rows at the current version that still owe a model pass (`rulesModel`
 * = the enrich area's RULES_ONLY_MODEL). A row whose pass was made carries
 * the model's id or RULES_CHECKED_MODEL and is not selected.
 */
export function buildRulesOnlySql(market: Market, version: number, rulesModel: string, limit: number): Prisma.Sql {
  return Prisma.sql`
    SELECT "id" FROM "RAJob"
    WHERE "market" = ${market} AND "archivedAt" IS NULL AND "enrichVersion" = ${version}::int AND "enrichModel" = ${rulesModel}
    ORDER BY "enrichedAt" ASC NULLS FIRST, "id" ASC
    LIMIT ${limit}::int`;
}

/**
 * The work-item key "one enrichment per job per version" — the same string as
 * the enrich area's `enrichDedupeKey` (a test keeps the two equal).
 */
export function staleEnrichDedupeKey(jobId: string, version: number): string {
  return `${ENRICH_KIND}:${jobId}:v${version}`;
}

/**
 * Work-item key of a rules-only job's model pass (one per job per model id).
 * It only prevents a duplicate while the item exists; that the pass was made
 * is recorded on the row (see the header), because finished items are pruned.
 */
export function rulesRetryDedupeKey(jobId: string, model: string | undefined, version: number): string {
  const tag = createHash('sha1').update(model ?? 'default').digest('hex').slice(0, 10);
  return `${staleEnrichDedupeKey(jobId, version)}:model:${tag}`;
}

/** What the catch-up needs to know about the brand's enrich model. */
export interface EnrichModelAvailability {
  available: boolean;
  /** The configured model id (undefined = the stack default). */
  model?: string;
}

/**
 * The enrich area's public surface, loaded when the catch-up runs: a static
 * import would pull the model client into every module that loads the
 * inventory crons and workers.
 */
const enrichArea = () => import('../enrich/index.js');

export interface EnrichCatchUpOptions {
  brand: ProductBrand;
  enqueueMany: EnqueueManyFn;
  env?: EnvSource;
  /** Cap for this run (default ENRICH_REQUEUE_PER_RUN). */
  limit?: number;
  /** The brand's enrich model (default: the enrich area's `resolveEnrichModel`). */
  enrichModel?: (brand: ProductBrand, env: EnvSource) => EnrichModelAvailability | Promise<EnrichModelAvailability>;
}

export interface EnrichCatchUpResult {
  /** Jobs newly queued because their enrichment is from an older version. */
  staleQueued: number;
  /** Rules-only jobs newly queued for a model pass. */
  rulesQueued: number;
  /** Whether a model pass is possible for this brand right now. */
  modelAvailable: boolean;
}

/**
 * Step 4. Queues at most `limit` jobs: stale versions first, the rest of the
 * cap for rules-only jobs (only with a usable model and a budget above 0).
 * The counts are items actually created (an item already queued for the same
 * job and version is left alone).
 */
export async function runEnrichCatchUp(db: IngestDb, market: Market, options: EnrichCatchUpOptions): Promise<EnrichCatchUpResult> {
  const env = options.env ?? process.env;
  const cap = Math.max(0, Math.floor(options.limit ?? ENRICH_REQUEUE_PER_RUN));
  const { ENRICH_VERSION, RULES_ONLY_MODEL, enrichDailyLimit, resolveEnrichModel } = await enrichArea();
  const route = await (options.enrichModel ?? resolveEnrichModel)(options.brand, env);
  const modelAvailable = route.available && enrichDailyLimit(env) > 0;
  if (cap === 0) return { staleQueued: 0, rulesQueued: 0, modelAvailable };
  const brand = options.brand.id;

  const stale = await db.$queryRaw<Array<{ id: string }>>(buildStaleEnrichSql(market, ENRICH_VERSION, cap));
  const staleItems: EnqueueManyItem[] = stale.map((r) => ({ kind: ENRICH_KIND, payload: { jobId: r.id }, options: { dedupeKey: staleEnrichDedupeKey(r.id, ENRICH_VERSION), brand } }));
  const staleQueued = staleItems.length ? (await options.enqueueMany(staleItems)).inserted : 0;

  let rulesQueued = 0;
  const left = cap - stale.length;
  if (modelAvailable && left > 0) {
    const rules = await db.$queryRaw<Array<{ id: string }>>(buildRulesOnlySql(market, ENRICH_VERSION, RULES_ONLY_MODEL, left));
    // `force`: the row already carries the current version, so a plain item would answer "already enriched".
    const items: EnqueueManyItem[] = rules.map((r) => ({
      kind: ENRICH_KIND,
      payload: { jobId: r.id, force: true },
      options: { dedupeKey: rulesRetryDedupeKey(r.id, route.model, ENRICH_VERSION), brand },
    }));
    if (items.length) rulesQueued = (await options.enqueueMany(items)).inserted;
  }
  return { staleQueued, rulesQueued, modelAvailable };
}

export interface MaintainResult {
  expired: number;
  missed: number;
  dedupeRepaired: number;
  /** False while Schema request SR-16b-1 is pending: the missed-refresh step did not run. */
  missedRule: boolean;
  /** Jobs queued for re-enrichment this run (0 when the step did not run). */
  enrichQueued: number;
}

export async function runMaintenance(
  db: IngestDb,
  market: Market,
  adapters: readonly JobSourceAdapter[],
  options: { perQueryTracking: boolean; enrich?: EnrichCatchUpOptions },
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
  let enrichQueued = 0;
  if (options.enrich) {
    const caught = await runEnrichCatchUp(db, market, options.enrich);
    enrichQueued = caught.staleQueued + caught.rulesQueued;
  }
  return { expired, missed, dedupeRepaired, missedRule: options.perQueryTracking, enrichQueued };
}
