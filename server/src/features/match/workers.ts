// server/src/features/match/workers.ts — queue workers of the MATCH area (WP-18).
//
// server/src/platform/queue/registry.ts imports `workers` from every area and
// registers them; the drain runs each item inside `runWithBrand(item.brand)`.
//
//   'job.score'  AI score for one (user, job, resume variant), queued by the
//                score-precompute cron (ARCH §4.7). Counts against the brand's
//                daily budget; the per-user precompute cap was spent when the
//                item was queued. A failed model CALL is retried with backoff
//                (it persists nothing and costs the user nothing); a spent
//                budget defers the item to the next UTC day. An ANSWER that
//                was received and refused (it is not a checklist, or its
//                checklist cannot be trusted: `ScorerFailedError.kind ===
//                'answer'`) is not retried: the scorer runs at temperature 0,
//                so every further attempt would be one more paid call and one
//                more unit of the brand's budget for the same refusal. The
//                item is marked dead after that one attempt; the person's job
//                page still scores on demand, and the cron queues the pair
//                again when its resume, its posting or the scorer changes.
//                The payload names no scorer version: the service scores with
//                the pin of the moment the item runs (config.ts
//                `currentScorerPin`), so a queued item follows a switch of
//                MATCH_SCORER_RUBRIC or of the model, and a row it writes is
//                always of the version that is pinned now.

import { DeferWorkError, PermanentWorkError, type LeasedWorkItem, type WorkerDefinition } from '../../platform/queue/index.js';
import { ScorerFailedError, type MatchService } from './MatchService.js';

export const MATCH_WORK_KINDS = { jobScore: 'job.score' } as const;

export interface JobScorePayload {
  userId: string;
  jobId: string;
  resumeVariantId?: string | null;
}

function parsePayload(item: LeasedWorkItem<unknown>): JobScorePayload | null {
  const p = item.payload as Partial<JobScorePayload> | null;
  const userId = typeof p?.userId === 'string' && p.userId ? p.userId : item.userId;
  if (!userId || typeof p?.jobId !== 'string' || !p.jobId) return null;
  return { userId, jobId: p.jobId, resumeVariantId: typeof p.resumeVariantId === 'string' ? p.resumeVariantId : null };
}

function msToNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5);
  return Math.max(60_000, next - now.getTime());
}

export function createJobScoreHandler(getService: () => Promise<MatchService>, now: () => Date = () => new Date()) {
  return async (item: LeasedWorkItem<unknown>): Promise<void> => {
    const payload = parsePayload(item);
    if (!payload) return; // malformed: nothing to do, never retried forever
    const service = await getService();
    let view;
    try {
      view = await service.scoreJob(payload.userId, payload.jobId, {
        resumeVariantId: payload.resumeVariantId,
        mode: 'precompute',
        onAiFailure: 'throw',
      });
    } catch (err) {
      // A job or resume that is gone (404) is not worth a retry.
      if ((err as { code?: unknown })?.code === 'not_found') return;
      // The model answered and the answer was refused: the same input gives the same answer, so no second attempt.
      if (err instanceof ScorerFailedError && err.kind === 'answer') throw new PermanentWorkError(err.message);
      throw err;
    }
    if (view.estimateReason === 'budget') throw new DeferWorkError(msToNextUtcDay(now()), 'score budget spent for today');
  };
}

const defaultService = async () => (await import('./defaultService.js')).defaultMatchService;

export const workers: WorkerDefinition<unknown>[] = [
  { kind: MATCH_WORK_KINDS.jobScore, handler: createJobScoreHandler(defaultService), concurrency: 4 },
];
