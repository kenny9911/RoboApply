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
// RAMockService (404 on cross-tenant).

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { getRequestLocale } from '../lib/raLocale.js';
import { logger } from '../../../services/LoggerService.js';
import {
  raMockService,
  MockValidationError,
  MockSessionNotFoundError,
} from '../services/RAMockService.js';

const router = Router();

// GET /catalog — static; no DB / LLM.
router.get('/catalog', requireAuth, async (req: Request, res: Response) => {
  try {
    return res.json(raMockService.catalog());
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
router.post('/start', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { role, interviewerId, typeId, format, language, durationMinutes } = req.body ?? {};
    const result = await raMockService.start(userId, {
      role,
      interviewerId,
      typeId,
      format,
      language: typeof language === 'string' ? language : undefined,
      durationMinutes: typeof durationMinutes === 'number' ? durationMinutes : undefined,
    }, getRequestLocale(req));
    return res.json(result);
  } catch (err) {
    if (err instanceof MockValidationError) {
      return res.status(422).json({ error: err.message });
    }
    logger.error('RA_V2_MOCK', 'start failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /next-turn — submit an answer; get the interviewer follow-up.
router.post('/next-turn', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { sessionId, answer, questionIndex } = req.body ?? {};
    const result = await raMockService.nextTurn(userId, {
      sessionId,
      answer,
      questionIndex,
    }, getRequestLocale(req));
    return res.json(result);
  } catch (err) {
    if (err instanceof MockSessionNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err instanceof MockValidationError) {
      return res.status(422).json({ error: err.message });
    }
    logger.error('RA_V2_MOCK', 'nextTurn failed', {
      userId: req.user?.id,
      sessionId: req.body?.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /:sessionId/score — mark complete + return the scored report.
router.post('/:sessionId/score', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await raMockService.score(userId, req.params.sessionId);
    return res.json(result);
  } catch (err) {
    if (err instanceof MockSessionNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err instanceof MockValidationError) {
      return res.status(422).json({ error: err.message });
    }
    logger.error('RA_V2_MOCK', 'score failed', {
      userId: req.user?.id,
      sessionId: req.params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
