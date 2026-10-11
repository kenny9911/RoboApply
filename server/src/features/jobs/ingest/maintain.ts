// server/src/features/jobs/ingest/maintain.ts — `jobs-maintain` steps (ARCH §4.6; WP-16b).
//
//   1. Expire (MARKET_STRATEGY M-22, §1.5 "Closure"; JI-10): a public posting
//      past the deadline its source states is archived, whatever the source
//      (closeReason 'expired'). A posting with NO stated deadline is archived
//      by age (posted more than 45 days ago) only when it is an aggregator's
//      row (`AGE_EXPIRY_BOARDS`: activejobs, linkedin, jsearch). Employer
//      boards, the recruiter banks, the open-data and government sources are
//      never archived by age: they close by listing diff, tombstone, sweep
//      absence or their stated deadline (an employer's board lists a role for
//      as long as it is open, often for months).
//   2. Missed refreshes: a job of a metered search provider that two later
//      counted runs of the query that last returned it did not return — while
//      it is still inside that query's datePosted window — is archived as
//      'source_removed' (tracking.ts). Only for a provider whose counted run
//      is everything the query can return (tracking.ts `missedRuleApplies`):
//      never an employer board, a recruiter bank, an open-data or government
//      source, and never JSearch. The columns it reads (SR-16b-1) exist since
//      the M0 push; on a database without them (`perQueryTracking` false) the
//      step is skipped and nothing is archived as 'source_removed'.
//   2b. Mainland, unseen (MARKET_STRATEGY §1.5 "Closure", M-22; JI-10): a
//      public row of market `cn` that no source has confirmed listed for 45
//      days (`lastSeenAt`, CN_UNSEEN_DAYS) is archived as 'expired', whatever
//      its board. It is the last of the three mainland closures, after the
//      validity a source states (step 1) and disappearance from a complete
//      listing (the board sync's diff, the bank's tombstones): it catches the
//      rows of a source that stopped being read at all (a board switched off,
//      a bank job the transport no longer returns). A user's own import is
//      never touched. It runs for market `cn` only: an international board or
//      bank row has no age and no unseen cut-off.
//   3. Dedupe priorities (JI-5, JC-7): live rows of a provider whose priority
//      changed (employer boards 10 → 5, GoHire bank 15 → 3) take the number
//      `PROVIDER_META` holds (`alignSourcePriority`; a second run writes
//      nothing). The rows it changes count as touched, so step 5 re-ranks
//      their groups in the same run.
//   4. Bank rows with no page a candidate can open (PAR carry-over 7b; the
//      rule the bank sync applies to the rows it reads, here for the rows it
//      does not reach):
//        a. the bank has NO posting-page template: every open row of it is
//           archived as 'no_apply_target', whether or not its sync runs. The
//           lists hold such rows already, but dedupe does not know that rule:
//           a held GoHire row (priority 3) would stay the canonical row of
//           its group and hide the employer-board twin, which is the only row
//           of the posting a candidate could open. Archived, it hands the
//           group over in step 5 of the same run;
//        b. the bank HAS a template and its sync is not running: an open row
//           whose stored apply link is not its page under the template (a row
//           stored before the template, still pointing at the missing
//           /jobs/<id> route) is archived the same way. A row whose link IS
//           the bank's page stays listed.
//      Whenever the step archives rows of a bank, the stored cursor of that
//      bank's sync is cleared, so its next run reads the bank from the
//      beginning and the upsert reopens every row the bank still lists
//      ('no_apply_target' is a reason it revives). Without that, a sync whose
//      cursor already carries the current template's mark would continue
//      where it stopped and the archived rows would stay closed until each
//      changed at the bank.
//   5. Dedupe repair: exact twins (one `atsPostingKey`) are aligned on one
//      dedupe key, then canonical flags are recomputed for every key touched
//      in the last two days (archived canonicals hand over to the next row).
//   6. Enrichment catch-up (WP-17 → WP-16b), at most ENRICH_REQUEUE_PER_RUN
//      jobs a run:
//        a. rows enriched at an older ENRICH_VERSION are queued again, the
//           newest postings first (the rows people are shown first get the
//           new version first; one `job.enrich` item per job per version: a
//           second run queues nothing);
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
//           first is still queued or deferred. Oldest enrichment first.
//        c. the skills-only pass (MKT-4D request 10): a public row at the
//           current version that still holds a skill with no canonical id
//           (`skillsDetail[].via = 'none'`: it was enriched while the
//           embedding step was off) is queued for `{ jobId, skillsOnly: true }`
//           once the brand has an embedding model AND `RASkill` holds a label
//           vector of that model. No model call and no enrichment budget; one
//           item per job per model tag, so the same vocabulary state never
//           queues a job twice while the item exists. Newest postings first.
//           A user's own import is left out (it is mapped by exact alias only).
//      The three kinds share the cap, in that order. Items carry the brand, so
//      the drain runs them inside that brand.

import { createHash } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client.js';
import type { EnvSource, Market, ProductBrand } from '../../../platform/brand/index.js';
import type { EnqueueManyItem } from '../../../platform/queue/index.js';
import { bankPublicJobUrl, bankPublicJobUrlTemplate } from '../../../roboapply/v2/lib/raCrossBankMatch.js';
import { AGE_EXPIRY_BOARDS, PROVIDER_META, safeUrl } from '../normalize/index.js';
import { adapterEnabledFor, type JobSourceAdapter } from '../sources/index.js';
import { PUBLIC_ATS } from '../sources/atsPublic/contract.js';
import { MAX_AGE_DAYS } from './config.js';
import type { IngestDb } from './db.js';
import type { EnqueueManyFn } from './pipeline.js';
import { buildMissedSql, missedRuleApplies } from './tracking.js';
import { applyDedupe, archiveClosedBankJobs, archiveUnlistedJobs } from './upsert.js';

/** `sourceBoard` of the two recruiter banks (the bank id). */
export const BANK_BOARDS = ['robohire', 'gohire'] as const;
type BankBoard = (typeof BANK_BOARDS)[number];
/** The market each bank's rows are written to (the rule of raCrossBankMatch `bankMarket`; a test holds them equal). */
const BANK_MARKET: Readonly<Record<BankBoard, Market>> = { robohire: 'intl', gohire: 'cn' };
/** The provider id of each bank's sync, which is its `RAIngestQuery.provider` (a test holds them equal to `PROVIDER_META`). */
export const BANK_SYNC_PROVIDER: Readonly<Record<BankBoard, 'bank_robohire' | 'bank_gohire'>> = { robohire: 'bank_robohire', gohire: 'bank_gohire' };

/** Jobs queued for re-enrichment per maintenance run (all kinds together). */
export const ENRICH_REQUEUE_PER_RUN = 500;
const ENRICH_KIND = 'job.enrich';

/**
 * Step 1. A stated deadline that has passed archives a row of ANY source; with
 * no deadline, only an aggregator's row is archived by its posting age.
 */
export function buildExpireSql(market: Market): Prisma.Sql {
  return Prisma.sql`
    UPDATE "RAJob" SET "archivedAt" = now(), "closedAt" = COALESCE("closedAt", now()), "closeReason" = 'expired', "updatedAt" = now()
    WHERE "market" = ${market} AND "visibility" = 'public' AND "archivedAt" IS NULL
      AND ("expiresAt" < now()
        OR ("expiresAt" IS NULL AND "sourceBoard" = ANY(${[...AGE_EXPIRY_BOARDS]}::text[]) AND "postedAt" < now() - make_interval(days => ${MAX_AGE_DAYS}::int)))`;
}

// ── Step 2b: a mainland row no source has confirmed for 45 days ───────────

/** The market the unseen rule applies to (mainland China). */
export const UNSEEN_MARKET: Market = 'cn';
/** Days without a sighting after which a public mainland row is archived (MARKET_STRATEGY §1.5: "else 45 days unseen"). */
export const CN_UNSEEN_DAYS = 45;
/** `sourceBoard` of a user's own import: nobody lists it, so "unseen" says nothing about it. */
export const USER_IMPORT_BOARD = PROVIDER_META.user_import.sourceBoard;

/**
 * Step 2b: public rows of the mainland market whose `lastSeenAt` is older than
 * CN_UNSEEN_DAYS, of every board except a user's import, are archived as
 * 'expired'. The market is a constant of the statement, not a parameter: the
 * rule exists for no other market. An 'expired' row is reopened by the upsert
 * if its source lists it again (upsert.ts `revivesOnRelist`).
 */
export function buildUnseenMainlandSql(): Prisma.Sql {
  return Prisma.sql`
    UPDATE "RAJob" SET "archivedAt" = now(), "closedAt" = COALESCE("closedAt", now()), "closeReason" = 'expired', "updatedAt" = now()
    WHERE "market" = ${UNSEEN_MARKET} AND "visibility" = 'public' AND "archivedAt" IS NULL
      AND "sourceBoard" <> ${USER_IMPORT_BOARD}
      AND "lastSeenAt" < now() - make_interval(days => ${CN_UNSEEN_DAYS}::int)`;
}

/** Runs step 2b for `market`: the statement for the mainland market, nothing (0) for any other. */
export async function archiveUnseenMainland(db: IngestDb, market: Market): Promise<number> {
  return market === UNSEEN_MARKET ? db.$executeRaw(buildUnseenMainlandSql()) : 0;
}

// ── Step 3: dedupe priorities follow PROVIDER_META ────────────────────────

/** The providers whose dedupe priority changed (JI-5), with the boards their rows are stored under. */
export function priorityTargets(): Array<{ boards: string[]; priority: number }> {
  return [
    { boards: [...PUBLIC_ATS], priority: PROVIDER_META.ats_public.sourcePriority },
    { boards: [PROVIDER_META.bank_gohire.sourceBoard], priority: PROVIDER_META.bank_gohire.sourcePriority },
  ];
}

/** Live rows of `boards` in `market` that carry another number take `priority`. Rows already right are not written. */
export function buildAlignPrioritySql(market: Market, boards: readonly string[], priority: number): Prisma.Sql {
  return Prisma.sql`
    UPDATE "RAJob" SET "sourcePriority" = ${priority}::int, "updatedAt" = now()
    WHERE "market" = ${market} AND "archivedAt" IS NULL AND "sourceBoard" = ANY(${[...boards]}::text[]) AND "sourcePriority" <> ${priority}::int`;
}

/**
 * Sets `sourcePriority` to the `PROVIDER_META` value on live rows that still
 * carry an older number (employer boards 10 → 5, GoHire bank 15 → 3). One
 * idempotent UPDATE per provider; returns the rows changed (0 on a second
 * run). The ingest upsert writes the right number on every row it touches;
 * this reaches the rows no source has listed again yet.
 */
export async function alignSourcePriority(db: IngestDb, market: Market): Promise<number> {
  let changed = 0;
  for (const target of priorityTargets()) changed += await db.$executeRaw(buildAlignPrioritySql(market, target.boards, target.priority));
  return changed;
}

// ── Step 4: a bank row whose link is not the bank's posting page ──────────

/** Most open rows of one bank the dead-link check reads per run. */
export const DEAD_BANK_LINK_SCAN_LIMIT = 20_000;

export interface DeadBankLinkOptions {
  env?: EnvSource;
  now?: Date;
  /** The bank's page for one job (default: raCrossBankMatch `bankPublicJobUrl`). */
  publicJobUrl?: (bank: BankBoard, jobId: string) => string | null;
  /** Whether the bank has a usable template (default: raCrossBankMatch `bankPublicJobUrlTemplate`). */
  hasTemplate?: (bank: BankBoard) => boolean;
}

/**
 * Clears the stored cursor of a bank's sync in `market`, so its next run
 * reads the bank from the beginning (a query with no cursor is a full sync,
 * for every transport). Nothing else of the query is touched: not its
 * schedule, and not `updatedAt`, which is the planner's "last demanded" stamp.
 */
export function buildRestartBankSyncSql(market: Market, provider: string): Prisma.Sql {
  return Prisma.sql`
    UPDATE "RAIngestQuery" SET "params" = "params" - 'cursor'
    WHERE "market" = ${market} AND "provider" = ${provider} AND ("params" -> 'cursor') IS NOT NULL`;
}

/**
 * Step 4 (the header has the rule). For each bank of `market`:
 *   - no template: archives every open public row as 'no_apply_target';
 *   - a template, and the bank's adapter absent from `adapters` or not
 *     enabled: archives the open public rows whose `applyUrl` is not the
 *     bank's page for that job. With a template and a running sync nothing is
 *     done (its first pass with the template rewrites every link).
 * A bank it archived rows of has its sync cursor cleared.
 */
export async function archiveDeadBankLinks(db: IngestDb, market: Market, adapters: readonly JobSourceAdapter[], options: DeadBankLinkOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const pageOf = options.publicJobUrl ?? ((bank: BankBoard, id: string) => bankPublicJobUrl(bank, id, env));
  const hasTemplate = options.hasTemplate ?? ((bank: BankBoard) => bankPublicJobUrlTemplate(bank, env) !== null);
  let archived = 0;
  for (const bank of BANK_BOARDS) {
    if (BANK_MARKET[bank] !== market) continue;
    let closed = 0;
    if (!hasTemplate(bank)) {
      // An empty listing: every open public row of the bank in this market is closed.
      closed = await archiveUnlistedJobs(db, market, bank, [], now, 'no_apply_target');
    } else {
      const adapter = adapters.find((a) => a.sourceBoards.includes(bank));
      if (adapter && adapterEnabledFor(adapter, market)) continue;
      const open = await db.rAJob.findMany({
        where: { market, sourceBoard: bank, archivedAt: null, visibility: 'public' },
        select: { externalId: true, applyUrl: true },
        take: DEAD_BANK_LINK_SCAN_LIMIT,
      });
      const dead = open.filter((r) => safeUrl(pageOf(bank, r.externalId)) !== safeUrl(r.applyUrl)).map((r) => r.externalId);
      closed = await archiveClosedBankJobs(db, bank, dead, now, 'no_apply_target');
    }
    if (closed > 0) await db.$executeRaw(buildRestartBankSyncSql(market, BANK_SYNC_PROVIDER[bank]));
    archived += closed;
  }
  return archived;
}

/**
 * Live rows enriched at an older version (never-enriched rows are queued by
 * ingest and import), the newest postings first: a version bump reaches the
 * rows the lists show first before it reaches the long tail (MKT-4D item 4).
 */
export function buildStaleEnrichSql(market: Market, version: number, limit: number): Prisma.Sql {
  return Prisma.sql`
    SELECT "id" FROM "RAJob"
    WHERE "market" = ${market} AND "archivedAt" IS NULL AND "enrichVersion" < ${version}::int
    ORDER BY "postedAt" DESC NULLS LAST, "id" ASC
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

/** Whether `RASkill` holds a label vector of the embedding model `modelTag` (the skills-only pass has something to map with). */
export function buildSkillVectorProbeSql(modelTag: string): Prisma.Sql {
  return Prisma.sql`SELECT 1 AS "one" FROM "RASkill" WHERE "embedding" IS NOT NULL AND "embeddingModel" = ${modelTag} LIMIT 1`;
}

/**
 * Live public rows at the current version that still hold a skill with no
 * canonical id (`skillsDetail` has an entry with `via: 'none'`), newest
 * postings first. A user's own import is private and so is never selected.
 */
export function buildSkillRemapSql(market: Market, version: number, limit: number): Prisma.Sql {
  return Prisma.sql`
    SELECT "id" FROM "RAJob"
    WHERE "market" = ${market} AND "archivedAt" IS NULL AND "visibility" = 'public'
      AND "enrichVersion" = ${version}::int AND "skillsDetail" @> '[{"via":"none"}]'::jsonb
    ORDER BY "postedAt" DESC NULLS LAST, "id" ASC
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
  /**
   * The tag of the brand's embedding model, null when it has none (default:
   * platform/embeddings `resolveEmbeddingConfig(brand, env).modelTag`). The
   * skills-only pass is queued only with a tag.
   */
  embeddingModelTag?: (brand: ProductBrand, env: EnvSource) => string | null | Promise<string | null>;
}

export interface EnrichCatchUpResult {
  /** Jobs newly queued because their enrichment is from an older version. */
  staleQueued: number;
  /** Rules-only jobs newly queued for a model pass. */
  rulesQueued: number;
  /** Whether a model pass is possible for this brand right now. */
  modelAvailable: boolean;
  /** Jobs newly queued for a skills-only pass (step 6c); 0 while the brand has no embedding model or `RASkill` no label vector of it. */
  skillsQueued: number;
}

/** The default of `EnrichCatchUpOptions.embeddingModelTag`, loaded when the catch-up runs. */
async function defaultEmbeddingModelTag(brand: ProductBrand, env: EnvSource): Promise<string | null> {
  const { resolveEmbeddingConfig } = await import('../../../platform/embeddings/index.js');
  return resolveEmbeddingConfig(brand, env).modelTag;
}

/**
 * Step 6. Queues at most `limit` jobs: stale versions first, then rules-only
 * jobs (only with a usable model and a budget above 0), then the skills-only
 * pass with what is left of the cap (only with an embedding model whose label
 * vectors `RASkill` holds). The counts are items actually created (an item
 * already queued for the same job and version is left alone).
 */
export async function runEnrichCatchUp(db: IngestDb, market: Market, options: EnrichCatchUpOptions): Promise<EnrichCatchUpResult> {
  const env = options.env ?? process.env;
  const cap = Math.max(0, Math.floor(options.limit ?? ENRICH_REQUEUE_PER_RUN));
  const { ENRICH_VERSION, RULES_ONLY_MODEL, enrichDailyLimit, resolveEnrichModel } = await enrichArea();
  const route = await (options.enrichModel ?? resolveEnrichModel)(options.brand, env);
  const modelAvailable = route.available && enrichDailyLimit(env) > 0;
  if (cap === 0) return { staleQueued: 0, rulesQueued: 0, modelAvailable, skillsQueued: 0 };
  const brand = options.brand.id;

  const stale = await db.$queryRaw<Array<{ id: string }>>(buildStaleEnrichSql(market, ENRICH_VERSION, cap));
  const staleItems: EnqueueManyItem[] = stale.map((r) => ({ kind: ENRICH_KIND, payload: { jobId: r.id }, options: { dedupeKey: staleEnrichDedupeKey(r.id, ENRICH_VERSION), brand } }));
  const staleQueued = staleItems.length ? (await options.enqueueMany(staleItems)).inserted : 0;

  let rulesQueued = 0;
  let left = cap - stale.length;
  if (modelAvailable && left > 0) {
    const rules = await db.$queryRaw<Array<{ id: string }>>(buildRulesOnlySql(market, ENRICH_VERSION, RULES_ONLY_MODEL, left));
    left -= rules.length;
    // `force`: the row already carries the current version, so a plain item would answer "already enriched".
    const items: EnqueueManyItem[] = rules.map((r) => ({
      kind: ENRICH_KIND,
      payload: { jobId: r.id, force: true },
      options: { dedupeKey: rulesRetryDedupeKey(r.id, route.model, ENRICH_VERSION), brand },
    }));
    if (items.length) rulesQueued = (await options.enqueueMany(items)).inserted;
  }

  // 6c. The skills-only pass. A failing probe (no RASkill table, no embedding settings) queues nothing and fails nothing.
  let skillsQueued = 0;
  if (left > 0) {
    try {
      const modelTag = await (options.embeddingModelTag ?? defaultEmbeddingModelTag)(options.brand, env);
      const hasVectors = modelTag ? (await db.$queryRaw<unknown[]>(buildSkillVectorProbeSql(modelTag))).length > 0 : false;
      if (modelTag && hasVectors) {
        const remap = await db.$queryRaw<Array<{ id: string }>>(buildSkillRemapSql(market, ENRICH_VERSION, left));
        const { skillRemapDedupeKey } = await enrichArea();
        const items: EnqueueManyItem[] = remap.map((r) => ({
          kind: ENRICH_KIND,
          payload: { jobId: r.id, skillsOnly: true },
          options: { dedupeKey: skillRemapDedupeKey(r.id, modelTag), brand },
        }));
        if (items.length) skillsQueued = (await options.enqueueMany(items)).inserted;
      }
    } catch {
      skillsQueued = 0;
    }
  }
  return { staleQueued, rulesQueued, modelAvailable, skillsQueued };
}

export interface MaintainResult {
  expired: number;
  missed: number;
  /** Public mainland rows archived as 'expired' because no source confirmed them for CN_UNSEEN_DAYS (step 2b); always 0 for another market. */
  unseenMainland: number;
  /** Live rows whose dedupe priority was brought to the `PROVIDER_META` value (0 once every row is right). */
  priorityAligned: number;
  /** Open bank rows archived as 'no_apply_target': their bank has no posting page, or their link is not that page (step 4). */
  deadBankLinks: number;
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
  options: { perQueryTracking: boolean; enrich?: EnrichCatchUpOptions; deadBankLinks?: DeadBankLinkOptions },
): Promise<MaintainResult> {
  const expired = await db.$executeRaw(buildExpireSql(market));
  let missed = 0;
  if (options.perQueryTracking) {
    for (const a of adapters) {
      // Metered search providers whose counted run is the query's whole answer, and no other source (tracking.ts).
      if (!missedRuleApplies(a)) continue;
      missed += await db.$executeRaw(buildMissedSql(market, a.provider, a.sourceBoards));
    }
  }
  // Mainland only, after stated validity (above) and disappearance (the sources' own syncs): 45 days unseen.
  const unseenMainland = await archiveUnseenMainland(db, market);
  // Before the dedupe repair: both steps change which row of a group is the one to show.
  const priorityAligned = await alignSourcePriority(db, market);
  const deadBankLinks = await archiveDeadBankLinks(db, market, adapters, { env: options.enrich?.env, ...options.deadBankLinks });
  const dedupeRepaired = await applyDedupe(db, market, null);
  let enrichQueued = 0;
  if (options.enrich) {
    const caught = await runEnrichCatchUp(db, market, options.enrich);
    enrichQueued = caught.staleQueued + caught.rulesQueued + caught.skillsQueued;
  }
  return { expired, missed, unseenMainland, priorityAligned, deadBankLinks, dedupeRepaired, missedRule: options.perQueryTracking, enrichQueued };
}
