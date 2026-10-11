// server/src/features/jobs/liveness/index.ts — public surface of the on-demand
// posting check (MKT-5C; JI-10; MARKET_STRATEGY 1.5 "Closure").
//
// Seams other areas call:
//   - confirmListing(job, opts)   the job page and the apply click: checks a
//                                 row the caller already loaded and writes the
//                                 answer (jobs/detail);
//   - checkJobLive(jobId, opts)   Ready to apply: loads the row, checks it,
//                                 writes the answer, and says only
//                                 'open' | 'closed' | 'unknown' (agent/deps.ts).
// Both never throw: whatever goes wrong is "unknown", and the caller goes on
// exactly as it did before this check existed.
//
// What it does and never does is in check.ts; the three endpoints and the one
// request are in postingApi.ts.
//
// The dedupe repair after an archive is the ingest area's `applyDedupe`. That
// area's public surface (jobs/ingest/index.ts) does not export it yet, so it
// is read from there at run time and used when it is there
// (`ingestDedupeRepair`). Until then an archived row hands its dedupe group
// over at the next ingest page that touches the group or at the daily
// `jobs-maintain` (which repairs every group changed in the last two days).
// The ingest area is loaded only after a "gone" answer: a repair is needed at
// no other time, and a posting found listed must not pay for that module.

import type { Market } from '../../../platform/brand/index.js';
import {
  LIVENESS_JOB_SELECT,
  applyLiveness,
  checkPostingLive,
  type ApplyLivenessOptions,
  type LiveResult,
  type LiveState,
  type LivenessDb,
  type LivenessDeps,
  type LivenessJob,
} from './check.js';

export {
  LIVENESS_BOARD_CLOSE_REASON,
  LIVENESS_BOARD_KILL_SWITCH,
  LIVENESS_CACHE_MS,
  LIVENESS_CLOSE_REASON,
  LIVENESS_HOST_FAILURES_TO_PAUSE,
  LIVENESS_HOST_PAUSE_MAX_MS,
  LIVENESS_HOST_PAUSE_MS,
  LIVENESS_HOST_REQUESTS_PER_MINUTE,
  LIVENESS_JOB_SELECT,
  LIVENESS_KILL_SWITCH,
  LIVENESS_MAX_IN_FLIGHT,
  LIVENESS_RECHECK_ENV,
  LIVENESS_RECHECK_HOURS,
  applyLiveness,
  checkPostingLive,
  createLivenessCache,
  createLivenessHosts,
  isBoardRowOfKey,
  livenessApplies,
  livenessEnabled,
  livenessRecheckHours,
  parsePostingKey,
  postingTargetOf,
  resetLivenessForTests,
} from './check.js';
export type { AppliedLiveness, ApplyLivenessOptions, LiveResult, LiveState, LiveVia, LivenessCache, LivenessDb, LivenessDeps, LivenessHosts, LivenessJob, PostingTarget, TargetOutcome } from './check.js';
export { LIVENESS_ATS, LIVENESS_HOSTS, LIVENESS_TIMEOUT_MS, POSTING_ENDPOINTS, requestPosting, retryAfterMs } from './postingApi.js';
export type { FetchLike as LivenessFetch, LivenessAts, PostingAnswer, PostingEndpoint } from './postingApi.js';

type RepairDedupe = NonNullable<ApplyLivenessOptions['repairDedupe']>;

export interface ConfirmListingOptions extends LivenessDeps {
  /** The database the answer is written to (default: the Prisma client, loaded on first use). */
  db?: LivenessDb;
  /** The dedupe repair after an archive. Absent → `ingestDedupeRepair`; null → none. */
  repairDedupe?: RepairDedupe | null;
  /** Test seam: how the ingest area is loaded for that repair (asked only after a "gone" answer). */
  loadIngest?: () => Promise<unknown>;
  log?: (message: string, meta: Record<string, unknown>) => void;
}

const defaultDb = async (): Promise<LivenessDb> => (await import('../../../lib/prisma.js')).default;

/** `applyDedupe(db, market, keys)` of jobs/ingest/upsert.ts, as the ingest area's index exports it once it does. */
type IngestApplyDedupe = (db: unknown, market: Market, keys: string[] | null) => Promise<number>;

/**
 * The ingest area's dedupe repair bound to `db`, or undefined while that
 * area's index does not export `applyDedupe` (or cannot be loaded). `load` is
 * the test seam; whatever it returns is read defensively.
 */
export async function ingestDedupeRepair(db: LivenessDb, load: () => Promise<unknown> = () => import('../ingest/index.js')): Promise<RepairDedupe | undefined> {
  try {
    const area = (await load()) as { applyDedupe?: IngestApplyDedupe } | null | undefined;
    const applyDedupe = area?.applyDedupe;
    return typeof applyDedupe === 'function' ? (market, keys) => applyDedupe(db, market, keys) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check a row and write the answer (`checkPostingLive` then `applyLiveness`).
 * Returns the answer of the check. Never throws: a failing write is logged and
 * the answer still stands (the next call writes it again).
 */
export async function confirmListing(job: LivenessJob, opts: ConfirmListingOptions = {}): Promise<LiveResult> {
  let result: LiveResult;
  try {
    result = await checkPostingLive(job, opts);
  } catch (err) {
    opts.log?.('liveness: the check failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    return { state: 'unknown', checkedAt: null, via: null, reason: 'failed', requested: false };
  }
  // Only the ATS's own answer is written (check.ts `applyLiveness`): skip the database for everything else.
  if (result.via !== 'ats_api') return result;
  try {
    const db = opts.db ?? (await defaultDb());
    // A dedupe group needs repair after a closure and at no other time: the ingest area is loaded only then,
    // so a posting found listed (by far the usual answer) never pays for that module.
    const repairDedupe =
      result.state !== 'closed' ? undefined : opts.repairDedupe === undefined ? await ingestDedupeRepair(db, opts.loadIngest) : (opts.repairDedupe ?? undefined);
    await applyLiveness(db, job, result, { repairDedupe, log: opts.log });
  } catch (err) {
    opts.log?.('liveness: the answer could not be written', { jobId: job.id, state: result.state, error: err instanceof Error ? err.message : String(err) });
  }
  return result;
}

/**
 * Is the posting of this job still listed? Loads the row, checks it and writes
 * the answer. 'unknown' for a job that does not exist, a row the check does
 * not apply to, and anything that fails.
 */
export async function checkJobLive(jobId: string, opts: ConfirmListingOptions = {}): Promise<LiveState> {
  try {
    const db = opts.db ?? (await defaultDb());
    const row = (await db.rAJob.findUnique({ where: { id: jobId }, select: LIVENESS_JOB_SELECT })) as LivenessJob | null;
    if (!row) return 'unknown';
    return (await confirmListing(row, { ...opts, db })).state;
  } catch (err) {
    opts.log?.('liveness: the row could not be read', { jobId, error: err instanceof Error ? err.message : String(err) });
    return 'unknown';
  }
}
