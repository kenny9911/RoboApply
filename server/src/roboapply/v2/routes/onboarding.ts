// backend/src/roboapply/v2/routes/onboarding.ts
//
// Mounted at /api/v1/roboapply/v2/onboarding. First-run setup, two steps.
//
//   POST /bootstrap  — step 1 → step 2: seed the draft from the parsed resume
//   GET  /session    — restore an in-progress setup (≤7 days), same shape
//   POST /confirm    — persist the confirmed preferences; ends setup
//   POST /skip       — stamp skippedAt and get out of the way; always 200
//   POST /seen       — the panel auto-opened; increment the cap counter
//
// DELETED, and not deprecated: POST /chat/stream, POST /complete, POST /pass.
// The conversational onboarding is gone — see the header of
// RAOnboardingService.ts for why. There is no NDJSON here any more, so the
// whole flushHeaders / AbortController / writableEnded protocol goes with it
// and every response below is a plain JSON envelope.
//
// Envelope: `{ success: true, data }` / `{ success: false, error, code }` with
// machine error codes. Classification module: ra_v2_onboarding.
//
// i18n RULE (queue.ts precedent): resolve `getRequestLocale(req)` ONCE per
// request and thread it into every service call; deterministic user-visible
// strings come from lib/raOnboardingMessages.ts inside the service layer;
// error payloads stay machine codes.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { getRequestLocale } from '../lib/raLocale.js';
import { logger } from '../../../services/LoggerService.js';
import {
  raOnboardingService,
  OnboardingInvalidDraftError,
  OnboardingNoActiveSessionError,
  OnboardingResumeUnusableError,
  OnboardingVariantNotFoundError,
} from '../services/RAOnboardingService.js';
import type {
  OnboardingDraftPreferences,
  OnboardingStep,
} from '../types/onboarding.js';

const router = Router();

const MAX_FREE_TEXT_LEN = 2000;
const VALID_STEPS: readonly OnboardingStep[] = ['resume', 'confirm'];

function ok(res: Response, data: unknown, status = 200): Response {
  return res.status(status).json({ success: true, data });
}

function fail(res: Response, status: number, code: string): Response {
  return res.status(status).json({ success: false, error: code, code });
}

/**
 * Step 1 → step 2. The resume is already uploaded and parsed by the time this
 * is called; it returns everything the confirm screen renders.
 *
 * There is deliberately NO daily session cap here. The old flow refused a
 * fourth bootstrap in a day with a 429 — a rate-limit lockout during first-run
 * setup, aimed at a user who has done nothing yet, blocking the one thing that
 * makes the rest of the product work.
 */
router.post('/bootstrap', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const locale = getRequestLocale(req);
  try {
    const { resumeVariantId } = req.body ?? {};
    if (typeof resumeVariantId !== 'string' || !resumeVariantId) {
      return fail(res, 400, 'resume_variant_required');
    }
    const data = await raOnboardingService.bootstrap(userId, resumeVariantId, locale, {
      requestId: req.requestId || undefined,
    });
    return ok(res, data);
  } catch (err) {
    if (err instanceof OnboardingVariantNotFoundError) return fail(res, 404, 'not_found');
    if (err instanceof OnboardingResumeUnusableError) return fail(res, 422, 'resume_unusable');
    logger.error('RA_V2_ONBOARDING', 'bootstrap failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail(res, 500, 'internal_error');
  }
});

router.get('/session', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const locale = getRequestLocale(req);
  try {
    const data = await raOnboardingService.getSession(userId, locale);
    return ok(res, data);
  } catch (err) {
    if (err instanceof OnboardingNoActiveSessionError) return fail(res, 404, 'no_active_session');
    logger.error('RA_V2_ONBOARDING', 'session restore failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail(res, 500, 'internal_error');
  }
});

/**
 * The submit button on step 2. `draft` is the client's COMPLETE post-edit
 * state — present keys replace, absent keys are left alone — because removing
 * a seeded chip has to actually remove it.
 */
router.post('/confirm', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const locale = getRequestLocale(req);
  try {
    const { sessionId, draft, freeText } = (req.body ?? {}) as {
      sessionId?: unknown;
      draft?: unknown;
      freeText?: unknown;
    };
    if (typeof sessionId !== 'string' || !sessionId) {
      return fail(res, 404, 'no_active_session');
    }
    if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
      return fail(res, 400, 'invalid_draft');
    }
    if (freeText !== undefined && typeof freeText !== 'string') {
      return fail(res, 400, 'invalid_draft');
    }
    if (typeof freeText === 'string' && freeText.length > MAX_FREE_TEXT_LEN) {
      return fail(res, 400, 'free_text_too_long');
    }
    const data = await raOnboardingService.confirm(
      userId,
      sessionId,
      draft as OnboardingDraftPreferences,
      typeof freeText === 'string' ? freeText : undefined,
      locale,
      req.requestId || undefined,
    );
    return ok(res, data);
  } catch (err) {
    if (err instanceof OnboardingInvalidDraftError) return fail(res, 400, 'invalid_draft');
    if (err instanceof OnboardingNoActiveSessionError) return fail(res, 404, 'no_active_session');
    logger.error('RA_V2_ONBOARDING', 'confirm failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail(res, 500, 'internal_error');
  }
});

/** Always 200 — skip must never block leaving setup. */
router.post('/skip', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { sessionId } = (req.body ?? {}) as { sessionId?: unknown };
  await raOnboardingService.skip(
    userId,
    typeof sessionId === 'string' && sessionId ? sessionId : undefined,
    req.requestId || undefined,
  );
  return ok(res, { skipped: true });
});

/**
 * The panel auto-opened. Increments `preferencesBlob.onboarding.autoOpens`,
 * which the client caps at 2.
 *
 * This is a separate endpoint rather than a flag on /bootstrap because
 * bootstrap requires a `resumeVariantId` that the no-resume user does not
 * have — so counting there would never fire for the very users the cap exists
 * to protect, and the panel would greet them on every visit forever.
 *
 * Always 200: a failed counter write must never stop the panel opening.
 */
router.post('/seen', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { step } = (req.body ?? {}) as { step?: unknown };
  if (typeof step !== 'string' || !VALID_STEPS.includes(step as OnboardingStep)) {
    return fail(res, 400, 'invalid_step');
  }
  const autoOpens = await raOnboardingService.markSeen(
    userId,
    step as OnboardingStep,
    req.requestId || undefined,
  );
  return ok(res, { autoOpens });
});

export default router;
