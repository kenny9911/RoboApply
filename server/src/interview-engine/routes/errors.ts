// backend/src/interview-engine/routes/errors.ts
//
// Maps engine errors to HTTP responses consistently across route files.

import type { Response } from 'express';
import { logger } from '../../services/LoggerService.js';
import { InterviewEngineConfigError } from '../config.js';
import {
  InterviewValidationError,
  InterviewNotFoundError,
  InterviewAuthError,
  InterviewInsufficientCreditsError,
  InterviewNotReadyError,
  InterviewSessionFailedError,
  InterviewSessionEndedError,
  InterviewPrepareFailedError,
} from '../sessions/InterviewSessionService.js';
import { toSessionDetail } from './serialize.js';

export function handleEngineError(res: Response, op: string, err: unknown, extra?: Record<string, unknown>): Response {
  if (err instanceof InterviewValidationError) {
    return res.status(422).json({ error: 'validation_error', message: err.message });
  }
  if (err instanceof InterviewInsufficientCreditsError) {
    // 402 Payment Required — the candidate is out of mock-interview credits.
    return res.status(402).json({
      error: 'insufficient_credits',
      message: err.message,
      balance: err.balance,
      required: err.required,
      tier: err.tier,
    });
  }
  // C5 envelope: { error: <code>, message? } (+ session where the client needs it).
  if (err instanceof InterviewPrepareFailedError) {
    return res.status(err.code === 'llm_unavailable' ? 503 : 500).json({
      error: err.code,
      message: err.message,
      session: toSessionDetail(err.session),
    });
  }
  if (err instanceof InterviewNotReadyError) {
    return res.status(409).json({ error: 'not_ready', message: err.message });
  }
  if (err instanceof InterviewSessionFailedError) {
    return res.status(409).json({ error: 'session_failed', reason: err.reason, message: err.message });
  }
  if (err instanceof InterviewSessionEndedError) {
    return res.status(409).json({ error: 'session_ended', status: err.status, message: err.message });
  }
  if (err instanceof InterviewNotFoundError) {
    return res.status(404).json({ error: 'not_found' });
  }
  if (err instanceof InterviewAuthError) {
    return res.status(403).json({ error: 'forbidden', message: err.message });
  }
  if (err instanceof InterviewEngineConfigError) {
    return res.status(503).json({ error: err.code, message: err.message });
  }
  logger.error('INTERVIEW_ENGINE_ROUTE', `${op} failed`, {
    ...extra,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return res.status(500).json({ error: 'internal_error' });
}
