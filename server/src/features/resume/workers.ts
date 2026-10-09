// server/src/features/resume/workers.ts — queue workers of RES (FND-3 seam; WP-22).
//
// server/src/platform/queue/registry.ts imports `workers` from every area.
//
//   'resume.grade'  payload { variantId, targetTitle?, idempotencyKey? }
//                   Runs the resume check for one variant outside a request
//                   (onboarding enqueues it after the resume upload, WP-30).
//                   Same service as POST /v2/resumes/:id/grade, so the AI
//                   consent gate, credit reservation and release all apply.

import { PermanentWorkError, type WorkerDefinition } from '../../platform/queue/index.js';
import { runWithBrand } from '../../lib/requestContext.js';

export const RESUME_WORK_KINDS = { resumeGrade: 'resume.grade' } as const;

export interface ResumeGradePayload {
  variantId: string;
  targetTitle?: string;
  /** Defaults to `queue:<item id>`, so a retried item never pays twice. */
  idempotencyKey?: string;
}

function parsePayload(raw: unknown): ResumeGradePayload {
  if (!raw || typeof raw !== 'object') throw new PermanentWorkError('resume.grade: payload must be an object');
  const p = raw as Record<string, unknown>;
  if (typeof p.variantId !== 'string' || !p.variantId) throw new PermanentWorkError('resume.grade: variantId is required');
  return {
    variantId: p.variantId,
    targetTitle: typeof p.targetTitle === 'string' ? p.targetTitle : undefined,
    idempotencyKey: typeof p.idempotencyKey === 'string' ? p.idempotencyKey : undefined,
  };
}

export const workers: WorkerDefinition[] = [
  {
    kind: RESUME_WORK_KINDS.resumeGrade,
    concurrency: 2,
    handler: async (item) => {
      if (!item.userId) throw new PermanentWorkError('resume.grade: userId is required');
      const userId = item.userId;
      const payload = parsePayload(item.payload);
      const { getResumeCheckService } = await import('./index.js');
      await runWithBrand(item.brand, () =>
        getResumeCheckService().grade(userId, payload.variantId, {
          targetTitle: payload.targetTitle,
          idempotencyKey: payload.idempotencyKey ?? `queue:${item.id}`,
        }),
      );
    },
  },
];
