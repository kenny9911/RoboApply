// backend/src/roboapply/v2/routes/tracker.ts
//
// Mounted at /api/v1/roboapply/v2/tracker.
//
//   GET    /          — list w/ status filter + paging + sort
//   GET    /:id       — single entry (owner-only; 404 otherwise)
//   POST   /          — create (jobId OR externalSnapshot required)
//   PATCH  /:id       — partial update
//   DELETE /:id       — soft delete (stamps deletedAt; hidden from all reads)
//   POST   /bulk      — bulk status / excitement / deadline patch

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { logger } from '../../../services/LoggerService.js';
import {
  raTrackerService,
  TrackerDuplicateError,
  TrackerInvalidInputError,
  TrackerNotFoundError,
  type RATrackerStatus,
} from '../services/RATrackerService.js';

const router = Router();

const VALID_STATUSES = new Set<RATrackerStatus>([
  'bookmarked',
  'applying',
  'applied',
  'interviewing',
  'negotiating',
  'accepted',
  'rejected',
  'withdrawn',
]);

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const raw = req.query.status;
    let statusList: RATrackerStatus[] | undefined;
    if (Array.isArray(raw)) {
      statusList = raw
        .filter((s): s is string => typeof s === 'string')
        .filter((s) => VALID_STATUSES.has(s as RATrackerStatus)) as RATrackerStatus[];
    } else if (typeof raw === 'string') {
      statusList = VALID_STATUSES.has(raw as RATrackerStatus)
        ? [raw as RATrackerStatus]
        : [];
    }

    const result = await raTrackerService.list(userId, {
      status: statusList && statusList.length > 0 ? statusList : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
      sortBy: req.query.sortBy as any,
      sortDir: req.query.sortDir as any,
    });
    return res.json(result);
  } catch (err) {
    logger.error('RA_V2_TRACKER', 'list failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /bulk must precede GET /:id so it's not captured by the param route.
router.post('/bulk', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { ids, patch } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(422).json({ error: 'ids_required' });
    }
    if (!patch || typeof patch !== 'object') {
      return res.status(422).json({ error: 'patch_required' });
    }
    const result = await raTrackerService.bulk(userId, { ids, patch });
    return res.json(result);
  } catch (err) {
    if (err instanceof TrackerInvalidInputError) {
      return res.status(403).json({ error: 'not_owner', message: err.message });
    }
    logger.error('RA_V2_TRACKER', 'bulk failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const entry = await raTrackerService.getById(userId, req.params.id);
    return res.json({ entry });
  } catch (err) {
    if (err instanceof TrackerNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('RA_V2_TRACKER', 'get failed', {
      userId: req.user?.id,
      entryId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const entry = await raTrackerService.create(userId, req.body ?? {});
    return res.status(201).json({ entry });
  } catch (err) {
    if (err instanceof TrackerDuplicateError) {
      return res.status(409).json({
        error: 'duplicate_tracker_entry',
        code: 'duplicate',
      });
    }
    if (err instanceof TrackerInvalidInputError) {
      return res.status(422).json({ error: err.message });
    }
    logger.error('RA_V2_TRACKER', 'create failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const entry = await raTrackerService.patch(userId, req.params.id, req.body ?? {});
    return res.json({ entry });
  } catch (err) {
    if (err instanceof TrackerNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('RA_V2_TRACKER', 'patch failed', {
      userId: req.user?.id,
      entryId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await raTrackerService.delete(userId, req.params.id);
    return res.status(204).send();
  } catch (err) {
    if (err instanceof TrackerNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('RA_V2_TRACKER', 'delete failed', {
      userId: req.user?.id,
      entryId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
