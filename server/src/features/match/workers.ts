// server/src/features/match/workers.ts — queue workers of the MATCH area (WP-18).
//
// server/src/platform/queue/registry.ts imports `workers` from every area and
// registers them; the drain runs each item inside `runWithBrand(item.brand)`.
//
//   'job.score'  AI score for one (user, job, resume variant), queued by the
//                score-precompute cron (ARCH §4.7). Counts against the brand's
//                daily budget; the per-user precompute cap was spent when the
//                item was queued. A failed model call is retried with backoff
//                (it persists nothing and costs the user nothing); a spent
//                budget defers the item to the next UTC day.

import { DeferWorkError, type LeasedWorkItem, type WorkerDefinition } from '../../platform/queue/index.js';
import type { MatchService } from './MatchService.js';

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
      throw err;
    }
    if (view.estimateReason === 'budget') throw new DeferWorkError(msToNextUtcDay(now()), 'score budget spent for today');
  };
}

const defaultService = async () => (await import('./defaultService.js')).defaultMatchService;

export const workers: WorkerDefinition<unknown>[] = [
  { kind: MATCH_WORK_KINDS.jobScore, handler: createJobScoreHandler(defaultService), concurrency: 4 },
];
