// backend/src/roboapply/v2/routes/onboarding.ts
//
// Mounted at /api/v1/roboapply/v2/onboarding.
//
//   POST /bootstrap    — start (or supersede into) a chat-onboarding session
//   POST /chat/stream  — one conversational turn, NDJSON streamed
//   GET  /session      — restore the active session (≤7 days)
//   POST /complete     — persist the captured preferences + flip the agent on
//   POST /skip         — flush confirmed fields + stamp skippedAt; always 200
//   POST /pass         — negative signal on a surfaced job card
//
// Envelope: `{ success: true, data }` / `{ success: false, error, code }`
// with machine error codes (spec §2) — the stream itself emits bare NDJSON
// events. Classification module: ra_v2_onboarding (lib/requestClassification).
//
// i18n RULE (queue.ts precedent): resolve `getRequestLocale(req)` ONCE per
// request and thread it into every service call; deterministic user-visible
// strings come from lib/raOnboardingMessages.ts inside the service layer; LLM
// content gets the locale via agent options; error payloads stay machine codes.
//
// NDJSON protocol (agentAlex.ts /chat/stream template): pre-stream validation
// returns plain JSON 4xx BEFORE headers flush; after flushHeaders every event
// write is guarded by !res.writableEnded; the AbortController is aborted in
// res.on('close') — listening on `res`, never `req` (req 'close' fires when
// express.json() finishes the body). LLM usage logging for the streamed chat
// call lives INSIDE RAOnboardingChatAgent (logClaudeUsage shape) — do not log
// it again here or the cost telemetry double-counts.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { getRequestLocale } from '../lib/raLocale.js';
import { logger } from '../../../services/LoggerService.js';
import {
  raOnboardingService,
  OnboardingDailyLimitError,
  OnboardingInvalidAggressivenessError,
  OnboardingJobNotFoundError,
  OnboardingNoActiveSessionError,
  OnboardingResumeUnusableError,
  OnboardingSessionNotActiveError,
  OnboardingSessionSupersededError,
  OnboardingVariantNotFoundError,
} from '../services/RAOnboardingService.js';
import type { RAOnboardingStreamEvent } from '../types/onboarding.js';

const router = Router();

const MAX_MESSAGE_LEN = 4000;

function ok(res: Response, data: unknown, status = 200): Response {
  return res.status(status).json({ success: true, data });
}

function fail(res: Response, status: number, code: string): Response {
  return res.status(status).json({ success: false, error: code, code });
}

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
    if (err instanceof OnboardingDailyLimitError) return fail(res, 429, 'session_daily_limit');
    logger.error('RA_V2_ONBOARDING', 'bootstrap failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail(res, 500, 'internal_error');
  }
});

router.post('/chat/stream', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const locale = getRequestLocale(req);
  const { sessionId, message, quickReplyId } = (req.body ?? {}) as {
    sessionId?: unknown;
    message?: unknown;
    quickReplyId?: unknown;
  };

  // ── Pre-stream validation: plain JSON errors, no headers flushed ──
  if (typeof message !== 'string' || !message.trim()) {
    return fail(res, 400, 'message_required');
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return fail(res, 400, 'message_too_long');
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    return fail(res, 404, 'no_active_session');
  }
  let session: any;
  try {
    session = await raOnboardingService.loadTurnSession(userId, sessionId);
  } catch (err) {
    if (err instanceof OnboardingSessionSupersededError) return fail(res, 409, 'session_superseded');
    if (err instanceof OnboardingSessionNotActiveError) return fail(res, 409, 'session_not_active');
    if (err instanceof OnboardingNoActiveSessionError) return fail(res, 404, 'no_active_session');
    logger.error('RA_V2_ONBOARDING', 'turn session load failed', {
      userId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail(res, 500, 'internal_error');
  }

  // ── NDJSON stream ──
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: RAOnboardingStreamEvent) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };

  // Abort the whole agent chain when the client goes away. Listen on `res`,
  // never `req` (see header comment).
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    await raOnboardingService.runTurn({
      session,
      userId,
      message,
      quickReplyId: typeof quickReplyId === 'string' && quickReplyId ? quickReplyId : undefined,
      locale,
      requestId: req.requestId || undefined,
      signal: controller.signal,
      emit: sendEvent,
    });
  } catch (err) {
    // runTurn never throws by contract; this is the last-resort backstop.
    logger.error('RA_V2_ONBOARDING', 'turn crashed', {
      userId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    sendEvent({ type: 'error', code: 'turn_failed', message: 'internal_error' });
  } finally {
    res.end();
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

router.post('/complete', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const locale = getRequestLocale(req);
  try {
    const { sessionId, aggressiveness } = req.body ?? {};
    if (typeof sessionId !== 'string' || !sessionId) {
      return fail(res, 404, 'no_active_session');
    }
    const data = await raOnboardingService.complete(
      userId,
      sessionId,
      aggressiveness ?? 'balanced',
      locale,
      req.requestId || undefined,
    );
    return ok(res, data);
  } catch (err) {
    if (err instanceof OnboardingInvalidAggressivenessError) {
      return fail(res, 400, 'invalid_aggressiveness');
    }
    if (err instanceof OnboardingNoActiveSessionError) return fail(res, 404, 'no_active_session');
    logger.error('RA_V2_ONBOARDING', 'complete failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail(res, 500, 'internal_error');
  }
});

router.post('/skip', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const locale = getRequestLocale(req);
  const { sessionId } = (req.body ?? {}) as { sessionId?: unknown };
  // Always 200 — skip must never block leaving onboarding (spec §2.5).
  await raOnboardingService.skip(
    userId,
    typeof sessionId === 'string' && sessionId ? sessionId : undefined,
    locale,
    req.requestId || undefined,
  );
  return ok(res, { skipped: true });
});

router.post('/pass', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    const { sessionId, jobId } = req.body ?? {};
    if (typeof sessionId !== 'string' || !sessionId || typeof jobId !== 'string' || !jobId) {
      return fail(res, 404, 'not_found');
    }
    await raOnboardingService.pass(userId, sessionId, jobId);
    return ok(res, { passed: true });
  } catch (err) {
    if (err instanceof OnboardingNoActiveSessionError) return fail(res, 404, 'no_active_session');
    if (err instanceof OnboardingJobNotFoundError) return fail(res, 404, 'not_found');
    logger.error('RA_V2_ONBOARDING', 'pass failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail(res, 500, 'internal_error');
  }
});

export default router;
