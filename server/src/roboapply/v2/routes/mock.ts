// backend/src/roboapply/v2/routes/mock.ts
//
// Mounted at /api/v1/roboapply/v2/mock.
//
//   GET    /catalog          — STATIC setup catalog (interviewers/types/roles)
//   GET    /recent-sessions  — the user's completed sessions → summary cards
//   POST   /start            — create a session + generate the question set
//   POST   /next-turn        — submit an answer; get the interviewer follow-up
//   POST   /:sessionId/score — mark complete + return the scored report
//
// Method semantics + response shapes mirror lib/stub/raV2.stub.ts §Mock and
// the contract (roboapply/lib/api/v2/types.ts → MockCatalogResponse /
// MockRecentSessionsResponse / MockStartResponse / MockNextTurnResponse /
// MockScoreResponse). All reads/writes are scoped to the authed user inside
// RAMockService (404 on cross-tenant). The three model routes pass the GoApply
// phone gate and the AI consent gate first (legacyAiGates; Wave 3 gate) —
// 403 phone_binding_required / 503 ai_unavailable with zero model calls.
//
// The brand's market comes from the request (never from the body): GoApply
// gets its AI-interview practice format in the catalog and the `cn` report
// block on a score (WP-66). RoboApply responses are unchanged.
// All writes use the Interview Engine's written-practice service: the same
// duration/credit gate, verification grant and idempotent completion debit.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { legacyAiGates } from '../lib/legacyAiGates.js';
import { getRequestLocale } from '../lib/raLocale.js';
import { logger } from '../../../services/LoggerService.js';
import { raMockService } from '../services/RAMockService.js';
import {
  interviewSessionService,
  ensureFirstPracticeGrant,
  InterviewInsufficientCreditsError,
  InterviewValidationError,
  type FirstPracticeState,
} from '../../../interview-engine/sessions/InterviewSessionService.js';
import { handleEngineError } from '../../../interview-engine/routes/errors.js';

const router = Router();

function isAdmin(req: Request): boolean {
  const user = req.user as { role?: string; roles?: string[] } | undefined;
  return user?.role === 'admin' || user?.roles?.includes('admin') === true;
}

function practiceError(res: Response, op: string, err: unknown, userId: string, firstPractice: FirstPracticeState | null = null): Response {
  if (err instanceof InterviewInsufficientCreditsError) {
    return res.status(402).json({
      error: 'insufficient_credits', message: err.message,
      balance: err.balance, required: err.required, tier: err.tier,
      bucket: 'practice', firstPractice,
    });
  }
  // Keep the legacy validation response; other engine errors retain their
  // normal status (404 ownership, 409 ended, etc.).
  if (err instanceof InterviewValidationError) return res.status(422).json({ error: err.message });
  return handleEngineError(res, op, err, { userId });
}

/** The market of the request's brand (intl when it cannot be read). */
async function requestMarket(): Promise<'intl' | 'cn'> {
  try {
    const { getCurrentBrandOrDefault } = await import('../../../platform/brand/brandContext.js');
    return getCurrentBrandOrDefault().market === 'cn' ? 'cn' : 'intl';
  } catch {
    return 'intl';
  }
}

// GET /catalog — static; no DB / LLM.
router.get('/catalog', requireAuth, async (req: Request, res: Response) => {
  try {
    return res.json(raMockService.catalog(await requestMarket()));
  } catch (err) {
    logger.error('RA_V2_MOCK', 'catalog failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /recent-sessions — the user's completed sessions.
router.get('/recent-sessions', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await raMockService.recentSessions(userId);
    return res.json(result);
  } catch (err) {
    logger.error('RA_V2_MOCK', 'recentSessions failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /start — create a session + generate questions.
router.post('/start', requireAuth, ...legacyAiGates(), async (req: Request, res: Response) => {
  const userId = req.user!.id;
  let firstPractice: FirstPracticeState | null = null;
  try {
    const b = req.body ?? {};
    const admin = isAdmin(req);
    firstPractice = admin ? null : await ensureFirstPracticeGrant(userId);
    const { jobId: _jobId, ...result } = await interviewSessionService.startTextPractice({
      userId,
      role: typeof b.role === 'string' ? b.role : '',
      interviewerId: typeof b.interviewerId === 'string' ? b.interviewerId : '',
      typeId: typeof b.typeId === 'string' ? b.typeId : '',
      language: typeof b.language === 'string' ? b.language : undefined,
      durationMinutes: typeof b.durationMinutes === 'number' ? b.durationMinutes : undefined,
      job: null,
      creditExempt: admin,
      locale: getRequestLocale(req),
      knownValues: [req.user!.name ?? ''],
    });
    return res.json(result);
  } catch (err) {
    return practiceError(res, 'legacy_mock_start', err, userId, firstPractice);
  }
});

// POST /next-turn — submit an answer; get the interviewer follow-up.
router.post('/next-turn', requireAuth, ...legacyAiGates(), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { sessionId, answer, questionIndex } = req.body ?? {};
    const result = await interviewSessionService.textPracticeTurn({
      userId,
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      answer: typeof answer === 'string' ? answer.slice(0, 8000) : '',
      questionIndex: Number.isInteger(questionIndex) ? questionIndex : 0,
      locale: getRequestLocale(req),
      legacy: { creditExempt: isAdmin(req) },
    });
    return res.json(result);
  } catch (err) {
    return practiceError(res, 'legacy_mock_turn', err, req.user!.id);
  }
});

// POST /:sessionId/score — mark complete + return the scored report.
router.post('/:sessionId/score', requireAuth, ...legacyAiGates(), async (req: Request<{ sessionId: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    const { jobId: _jobId, practiceCounted: _counted, ...result } = await interviewSessionService.scoreTextPractice({
      userId, sessionId: req.params.sessionId, legacy: { creditExempt: isAdmin(req) },
    });
    return res.json(result);
  } catch (err) {
    return practiceError(res, 'legacy_mock_score', err, req.user!.id);
  }
});

export default router;
