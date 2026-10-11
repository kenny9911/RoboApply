// server/src/features/retrieval/sweep.ts
//
// The retrieval sweep: the third step of the score-precompute cron
// (features/match/cron.ts; every 15 minutes, per brand, inside the cron's
// remaining time). It only enqueues and deletes; the embedding itself runs in
// the queue workers drained by `queue-drain` (MARKET_STRATEGY 2.3 stack
// constraints). No cron entry of its own.
//
// For the market of the cron's brand:
//   0. keep the query model tag in line (modelTag.ts): a model change re-embeds
//      the market gradually and the tag queries filter on moves to the new
//      model at the crossover (one row per job, see modelTag.ts);
//   1. `jobsNeedingIndex(market, tag, 960)` → `job.index` items of 96 ids each,
//      at most 10 a run; nothing when every live row is indexed. The rows that
//      lack a search document come first. When no vector can be written for
//      the brand right now (no key, the route policy refuses the endpoint, the
//      daily budget is 0 or spent: `embeddingAvailability`, no request) the
//      read asks for the lexical part only, so rows that cannot get a vector
//      never fill the window in front of rows that need a search document;
//   2. people active in the last 7 days whose resume or saved search changed
//      since their vector → `user.embed` (deduped by person, hashes and model
//      tag, so an unchanged person with a vector costs one queue lookup and no
//      model call). On GoApply only people who pass the two consent gates are
//      queued. Nobody is queued while the market is between two models (a
//      person's vector of the model queries still use must not be replaced
//      before the switch) or while user text cannot be embedded;
//   3. GoApply: delete the vectors of people without the AI consent or without
//      a live 个性化推荐 grant (a rotating window of the people who have a
//      vector made from their data), and with the AI consent gone also the
//      vectors of their own private imports.
//
// DEDUPE KEYS AND RE-RUNS. An item can finish without doing its work: the
// client was unavailable when it ran, or it died after five failed attempts
// during an outage. The queue keeps finished items for days, so a key alone
// would block the same rows (the read returns them in the same order) until
// the item is purged. Step 1 therefore enqueues with `onConflict: 'requeue'`:
// rows the read still returns DO need a run, so a finished or dead item for
// them runs again, while a queued or leased one is left alone. Step 2 does the
// same for a person who has no vector of the current model.
//
// CONSENT READS. A lookup that fails is not a withdrawal. The two gates here
// THROW on a lookup error (`hasLiveConsent`, not the fail-closed `aiAllowed`):
// step 2 then skips the person (nothing is queued without a definite yes) and
// step 3 deletes only on a definite no and stops its walk at the first error.
//
// A step that fails is logged and reported; the next step still runs, and the
// cron run that came before is never failed by this one.

import crypto from 'node:crypto';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { BrandId } from '../../platform/brand/registry.js';
import type { EmbeddingAvailability } from '../../platform/embeddings/index.js';
import type { CronContext, EnqueueOptions, EnqueuedItem } from '../../platform/queue/index.js';
import { logger } from '../../services/LoggerService.js';
import { reconcileModelTag, type ModelTagState } from './modelTag.js';
import { defaultRetrievalRepo, type RetrievalRepo } from './repo.js';
import { JOB_INDEX_MAX_IDS, RETRIEVAL_WORK_KINDS, userVectorGate, type JobIndexPayload, type UserEmbedPayload } from './workers.js';

export const RETRIEVAL_SWEEP_LIMITS = {
  /** Rows read per run. */
  jobsPerRun: 960,
  /** Ids per `job.index` item: one embeddings request. */
  batchSize: JOB_INDEX_MAX_IDS,
  /** `job.index` items queued per market and run. */
  maxBatches: 10,
  /** People who were active within this many days are looked at. */
  activeDays: 7,
  /** People looked at per run, most recently active first. */
  maxUsers: 200,
  /** People with vectors whose consent is re-checked per run (GoApply). */
  consentChecksPerRun: 200,
  /** A step is not started with less than this much of the cron's time left. */
  reserveMs: 5_000,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const sha1 = (text: string): string => crypto.createHash('sha1').update(text).digest('hex');

/** The hook's item: one index run per job and enrichment. */
export function jobIndexDedupeKey(jobId: string, enrichedAt: Date | null | undefined): string {
  return `job.index:${jobId}:${enrichedAt ? enrichedAt.getTime() : 0}`;
}

/** The sweep's item: one run per set of ids and model tag. */
export function jobIndexBatchDedupeKey(jobIds: readonly string[], modelTag: string | null): string {
  return `job.index.batch:${sha1(`${[...jobIds].sort().join(',')}|${modelTag ?? ''}`)}`;
}

/** One `user.embed` per person, market, state of their inputs and model tag. */
export function userEmbedDedupeKey(userId: string, market: string, state: { resumeHash: string | null; searchProfileVersion: number | null }, modelTag: string): string {
  return `user.embed:${userId}:${market}:${sha1(`${state.resumeHash ?? ''}|${state.searchProfileVersion ?? ''}|${modelTag}`).slice(0, 16)}`;
}

export const consentCursorConfigKey = (market: string): string => `retrieval.consentCursor.${market}`;

export interface RetrievalSweepDeps {
  repo: Pick<RetrievalRepo, 'jobsNeedingIndex' | 'indexStats' | 'getConfig' | 'setConfig' | 'embeddedUserIds' | 'deleteUserEmbeddings' | 'deleteJobEmbeddingsOfOwner' | 'userEmbeddingMeta'>;
  enqueue: (kind: string, payload: JobIndexPayload | UserEmbedPayload, options: EnqueueOptions) => Promise<EnqueuedItem>;
  /** The match area's `activeUsers`: ids of the brand's people active since `since`, most recent first. */
  activeUsers: (brandId: BrandId, since: Date, limit: number) => Promise<string[]>;
  /** What a person's vectors depend on: the primary resume's content hash and the saved search's version. */
  userState: (userId: string) => Promise<{ resumeHash: string | null; searchProfileVersion: number | null }>;
  /** GoApply "Use AI" consent, STRICT: resolves true or false for a record that was read and throws when it could not be. */
  aiAllowed: (userId: string) => Promise<boolean>;
  /** GoApply 个性化推荐 grant, STRICT in the same way. */
  personalized: (userId: string) => Promise<boolean>;
  /**
   * May a vector be written for the brand now (`embeddingAvailability`: key,
   * route policy, daily budget; no request)? `carriesUserData` is false for
   * public job text and true for a person's text.
   */
  vectorsWritable: (brandId: BrandId, carriesUserData: boolean) => Promise<EmbeddingAvailability>;
  env?: EnvSource;
}

export interface RetrievalSweepResult {
  skipped?: 'no_time';
  model?: Pick<ModelTagState, 'writeTag' | 'queryTag' | 'switched' | 'coverage' | 'previousCoverage'>;
  /**
   * `job.index` items waiting to run after this sweep and the rows they carry:
   * new items, and finished or dead items for the same rows set to run again.
   * (An item that was still waiting from an earlier run counts too: the queue
   * answers the same for both.)
   */
  jobBatches?: number;
  jobsQueued?: number;
  /** Why job vectors were not asked for in this run (search documents still are); absent when they were. */
  jobVectors?: Exclude<EmbeddingAvailability, 'ok'>;
  /** `user.embed` items queued: new, or set to run again for a person without a vector of the current model. */
  usersQueued?: number;
  /** Why no person was queued in this run; absent when people were looked at. */
  userVectors?: Exclude<EmbeddingAvailability, 'ok'> | 'between_models';
  /** People whose vectors were deleted because a consent is missing. */
  vectorsRemovedFor?: number;
  /** Steps that failed (logged); the others ran. */
  failed?: string[];
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function createRetrievalSweep(getDeps: () => Promise<RetrievalSweepDeps>) {
  return async (ctx: Pick<CronContext, 'brand' | 'budget' | 'now'>): Promise<RetrievalSweepResult> => {
    const L = RETRIEVAL_SWEEP_LIMITS;
    if (ctx.budget.exhausted(L.reserveMs)) return { skipped: 'no_time' };
    const deps = await getDeps();
    const brand = ctx.brand;
    const market = brand.market;
    const result: RetrievalSweepResult = {};
    const failed: string[] = [];
    const step = async (name: string, run: () => Promise<void>): Promise<void> => {
      if (ctx.budget.exhausted(L.reserveMs)) return;
      try {
        await run();
      } catch (err) {
        failed.push(name);
        logger.warn('RETRIEVAL_SWEEP', `${name} failed; the other steps still run`, { brand: brand.id, error: err instanceof Error ? err.message : String(err) });
      }
    };

    let tags: ModelTagState = { writeTag: null, queryTag: null, coverage: null, previousCoverage: null, switched: false };
    await step('model_tag', async () => {
      tags = await reconcileModelTag(market, { repo: deps.repo, env: deps.env });
      const share = (v: number | null): number | null => (v === null ? null : Math.round(v * 1000) / 1000);
      result.model = { writeTag: tags.writeTag, queryTag: tags.queryTag, switched: tags.switched, coverage: share(tags.coverage), previousCoverage: share(tags.previousCoverage) };
    });

    /** 'ok' when the read itself fails: the worker then decides (and fails, so the queue retries). */
    const writable = async (carriesUserData: boolean): Promise<EmbeddingAvailability> => {
      try {
        return await deps.vectorsWritable(brand.id, carriesUserData);
      } catch (err) {
        logger.warn('RETRIEVAL_SWEEP', 'could not read whether vectors can be written; asking for them', { brand: brand.id, error: err instanceof Error ? err.message : String(err) });
        return 'ok';
      }
    };

    // 1. Postings: the search document always, the vector when one can be written now.
    await step('jobs', async () => {
      let vectorTag = tags.writeTag;
      if (vectorTag) {
        const available = await writable(false);
        if (available !== 'ok') {
          vectorTag = null;
          result.jobVectors = available;
        }
      } else result.jobVectors = 'no_key';
      const ids = await deps.repo.jobsNeedingIndex(market, vectorTag, L.jobsPerRun);
      result.jobBatches = 0;
      result.jobsQueued = 0;
      for (const batch of chunk(ids, L.batchSize).slice(0, L.maxBatches)) {
        // The read still returns these rows, so they need a run: a finished or dead item for them runs again.
        const item = await deps.enqueue(RETRIEVAL_WORK_KINDS.jobIndex, { jobIds: batch }, { dedupeKey: jobIndexBatchDedupeKey(batch, vectorTag), onConflict: 'requeue', brand: brand.id, priority: 300 });
        if (item.created || item.status === 'queued') {
          result.jobBatches += 1;
          result.jobsQueued += batch.length;
        }
      }
    });

    // 2. People: only with a model, not while the market is between two models, and only while user text can be embedded.
    await step('users', async () => {
      result.usersQueued = 0;
      const tag = tags.writeTag;
      if (!tag) {
        result.userVectors = 'no_key';
        return;
      }
      if (tags.queryTag !== null && tags.queryTag !== tag) {
        result.userVectors = 'between_models';
        return;
      }
      const available = await writable(true);
      if (available !== 'ok') {
        result.userVectors = available;
        return;
      }
      const users = await deps.activeUsers(brand.id, new Date(ctx.now.getTime() - L.activeDays * DAY_MS), L.maxUsers);
      for (const userId of users) {
        if (ctx.budget.exhausted(L.reserveMs)) break;
        try {
          // Strict gates: a lookup error throws and the person is skipped (nothing is queued without a definite yes).
          if ((await userVectorGate(userId, market, deps)) !== 'ok') continue;
          const state = await deps.userState(userId);
          // No vector of this model: an earlier item for the same inputs did not write one (the client was unavailable, the
          // item died in an outage, or the person withdrew a consent and granted it again), so it must run again.
          const hasVector = (await deps.repo.userEmbeddingMeta(userId, market)).some((m) => m.model === tag);
          const item = await deps.enqueue(
            RETRIEVAL_WORK_KINDS.userEmbed,
            { userId, market },
            { dedupeKey: userEmbedDedupeKey(userId, market, state, tag), onConflict: hasVector ? 'keep' : 'requeue', brand: brand.id, userId, priority: 300 },
          );
          if (item.created || (!hasVector && item.status === 'queued')) result.usersQueued += 1;
        } catch (err) {
          logger.warn('RETRIEVAL_SWEEP', 'skipped a person whose consent or state could not be read', { brand: brand.id, userId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    // 3. GoApply: no vector outlives a withdrawn consent. Deleted only on a definite "no".
    if (market === 'cn') {
      await step('consent', async () => {
        result.vectorsRemovedFor = 0;
        const key = consentCursorConfigKey(market);
        const cursor = (await deps.repo.getConfig(key)) || null;
        let ids = await deps.repo.embeddedUserIds(market, cursor, L.consentChecksPerRun);
        // Past the end: start again from the first person.
        if (!ids.length && cursor) ids = await deps.repo.embeddedUserIds(market, null, L.consentChecksPerRun);
        let last: string | null = null;
        let lookupError: unknown = null;
        for (const userId of ids) {
          if (ctx.budget.exhausted(L.reserveMs)) break;
          let gate: Awaited<ReturnType<typeof userVectorGate>>;
          try {
            gate = await userVectorGate(userId, market, deps);
          } catch (err) {
            // A failed read is not a withdrawal: nothing is deleted, and the walk stops here so this person is read again next run.
            lookupError = err;
            break;
          }
          if (gate !== 'ok') {
            let rows = await deps.repo.deleteUserEmbeddings(userId, market);
            // A private import was embedded under the AI consent only.
            if (gate === 'no_ai_consent') rows += await deps.repo.deleteJobEmbeddingsOfOwner(userId, market);
            if (rows > 0) result.vectorsRemovedFor += 1;
          }
          last = userId;
        }
        const finished = !lookupError && ids.length < L.consentChecksPerRun && last === ids[ids.length - 1];
        const next = finished ? '' : (last ?? cursor ?? '');
        if (next !== (cursor ?? '')) await deps.repo.setConfig(key, next);
        if (lookupError) throw lookupError instanceof Error ? lookupError : new Error(String(lookupError));
      });
    }

    if (failed.length) result.failed = failed;
    return result;
  };
}

/** Everything but `activeUsers`, which the cron hands in (the match area owns that read). */
async function defaultDeps(): Promise<Omit<RetrievalSweepDeps, 'activeUsers'>> {
  const [queue, consent, match, embeddings] = await Promise.all([
    import('../../platform/queue/index.js'),
    import('../../platform/consent/index.js'),
    import('../match/index.js'),
    import('../../platform/embeddings/index.js'),
  ]);
  return {
    repo: defaultRetrievalRepo,
    enqueue: (kind, payload, options) => queue.enqueue(kind, payload, options),
    userState: async (userId) => {
      const { user, resume } = await match.matchService.userContext(userId);
      return { resumeHash: resume?.resumeContentHash ?? null, searchProfileVersion: user.searchProfileVersion ?? null };
    },
    // Strict on purpose (they throw on a lookup error): these two answers also decide a deletion.
    aiAllowed: (userId) => consent.hasLiveConsent(userId, consent.AI_CONSENT_TYPE),
    personalized: (userId) => consent.hasLiveConsent(userId, 'personalized_recommendation'),
    vectorsWritable: (brandId, carriesUserData) => embeddings.embeddingAvailability(brandId, { carriesUserData }),
  };
}

/**
 * The sweep with production dependencies, for the cron of one brand. The
 * caller passes `activeUsers` (the match repository's read of who was active).
 */
export function runRetrievalSweep(
  ctx: Pick<CronContext, 'brand' | 'budget' | 'now'>,
  deps: Pick<RetrievalSweepDeps, 'activeUsers'> & Partial<RetrievalSweepDeps>,
): Promise<RetrievalSweepResult> {
  return createRetrievalSweep(async () => ({ ...(await defaultDeps()), ...deps }))(ctx);
}
