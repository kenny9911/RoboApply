// server/src/roboapply/v2/lib/legacyAiGates.ts — consent and phone gates for deprecated /v2 LLM routes.
//
// The legacy V2 AI routes (`/v2/mock/{start,next-turn,:id/score}`,
// `/v2/resumes/:id/{tailor-diff,tailor-apply}`) stay mounted until WP-66 /
// WP-36b / WP-75 retire them. Until then every model call for a user passes
// the same checks as the feature routes (TASK_PLAN.md §2.2, H4):
//   - GoApply: a bound phone (`requirePhoneBound`, 403 phone_binding_required);
//   - the user's AI consent and the brand's text model (`resumeAiAvailable`,
//     503 ai_unavailable, zero model calls).
// Charging stays as it is (carried over to the owner WPs).

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { requirePhoneBound } from '../../../features/auth-cn/index.js';
import { resumeAiAvailable } from '../../../features/resume/index.js';

/** 503 `ai_unavailable` (the legacy shape the V2 client already reads) unless AI is available for this user. */
export async function requireLegacyAiAvailable(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId || !(await resumeAiAvailable(userId))) {
      res.status(503).json({ error: 'ai_unavailable', code: 'ai_unavailable' });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

let phoneGate: RequestHandler | null = null;

/** GoApply phone binding, then AI availability. Place after `requireAuth`. */
export function legacyAiGates(): RequestHandler[] {
  phoneGate ??= requirePhoneBound();
  return [phoneGate, requireLegacyAiAvailable];
}
