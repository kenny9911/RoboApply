// backend/src/roboapply/v2/routes/search.ts
//
// Mounted at /api/v1/roboapply/v2/search.
//
//   POST   /run         — run the search (filters + paging + facets). Body
//                         carries the SearchQuery + limit + cursor; chosen
//                         over GET so we can pass complex preferredLocations
//                         without URL escaping. Frontend stub calls
//                         search.run(...).
//   POST   /saved       — save a search query for the dropdown
//   GET    /saved       — list the user's saved searches (newest first)
//   DELETE /saved/:id   — delete a saved search (owner-only; 404 otherwise)

import { Router, type Request, type Response } from 'express';
import prisma from '../../../lib/prisma.js';
import { requireAuth } from '../lib/raAuth.js';
import { logger } from '../../../services/LoggerService.js';
import { raJobIndexService } from '../services/RAJobIndexService.js';

const router = Router();

router.post('/run', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const body = req.body ?? {};
    const result = await raJobIndexService.search(userId, {
      q: typeof body.q === 'string' ? body.q : undefined,
      location: typeof body.location === 'string' ? body.location : undefined,
      workType: body.workType,
      salaryMin: typeof body.salaryMin === 'number' ? body.salaryMin : undefined,
      salaryCurrency: body.salaryCurrency,
      datePosted: body.datePosted,
      sortBy: body.sortBy,
      employmentType: body.employmentType,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
    });
    return res.json(result);
  } catch (err) {
    logger.error('RA_V2_SEARCH', 'run failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/saved', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name, query } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(422).json({ error: 'name_required' });
    }
    if (!query || typeof query !== 'object') {
      return res.status(422).json({ error: 'query_required' });
    }

    const p = prisma as any;
    const existing = await p.rASavedSearch.findFirst({
      where: { userId, name: name.trim() },
    });
    if (existing) {
      return res.status(409).json({ error: 'saved_search_name_taken' });
    }
    const row = await p.rASavedSearch.create({
      data: { userId, name: name.trim(), query },
    });
    logger.info('RA_V2_SEARCH', 'saved search created', { userId, savedId: row.id });
    return res.status(201).json({
      savedSearch: {
        id: row.id,
        userId: row.userId,
        name: row.name,
        query: row.query,
        lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    logger.error('RA_V2_SEARCH', 'save failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/saved', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const p = prisma as any;
    const rows = await p.rASavedSearch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({
      savedSearches: rows.map((r: any) => ({
        id: r.id,
        userId: r.userId,
        name: r.name,
        query: r.query,
        lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    logger.error('RA_V2_SEARCH', 'list saved failed', {
      userId: req.user?.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.delete('/saved/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const p = prisma as any;
    const existing = await p.rASavedSearch.findFirst({
      where: { id: req.params.id, userId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'not_found' });
    }
    await p.rASavedSearch.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (err) {
    logger.error('RA_V2_SEARCH', 'delete saved failed', {
      userId: req.user?.id,
      savedId: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
