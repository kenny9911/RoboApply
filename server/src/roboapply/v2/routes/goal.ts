// backend/src/roboapply/v2/routes/goal.ts
//
// Mounted at /api/v1/roboapply/v2/goal.
//
//   GET  /  -> { goal: RACareerGoal | null }
//   PUT  /  -> { goal: RACareerGoal }   (upsert; matches frontend contract)
//   PATCH /  -> { goal: RACareerGoal }   (alias of PUT; spec §5.1 used PATCH)

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { logger } from '../../../services/LoggerService.js';
import { raCareerGoalService } from '../services/RACareerGoalService.js';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const goal = await raCareerGoalService.get(userId);
    return res.json({ goal });
  } catch (err) {
    logger.error('RA_V2_GOAL', 'GET /goal failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

async function handleUpsert(req: Request, res: Response): Promise<Response> {
  try {
    const userId = req.user!.id;
    const body = req.body ?? {};
    if (typeof body.targetTitle !== 'string' || !body.targetTitle.trim()) {
      return res.status(422).json({
        error: 'invalid_goal',
        details: { field: 'targetTitle' },
      });
    }
    if (
      typeof body.notesMarkdown === 'string' &&
      body.notesMarkdown.length > 4000
    ) {
      return res.status(422).json({
        error: 'invalid_goal',
        details: { field: 'notesMarkdown', reason: 'too_long' },
      });
    }
    if (
      typeof body.weeklyApplicationGoal === 'number' &&
      (body.weeklyApplicationGoal < 1 || body.weeklyApplicationGoal > 50)
    ) {
      return res.status(422).json({
        error: 'invalid_goal',
        details: { field: 'weeklyApplicationGoal' },
      });
    }
    const goal = await raCareerGoalService.upsert(userId, body);
    return res.json({ goal });
  } catch (err) {
    logger.error('RA_V2_GOAL', 'goal upsert failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
}

router.put('/', requireAuth, handleUpsert);
router.patch('/', requireAuth, handleUpsert);

export default router;
