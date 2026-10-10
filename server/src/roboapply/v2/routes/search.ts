// backend/src/roboapply/v2/routes/search.ts
//
// @deprecated (WP-32) — `/v2/search/run` is replaced by `POST /api/v1/roboapply/feed/query`
// (`q` + sorts; `lib/api/feed.ts`). The saved-search endpoints (`/saved`) were
// removed in WP-75 (replaced by `/search-profiles`, WP-20; no client called
// them). `/run` stays mounted only because `components/v3/shell/CommandPalette.tsx`
// (a hot shell file WP-75 does not own) and the WP-33 `/job-search` page
// (`hooks/useJobSearch.ts`) still call `raV2Api.search.run`; INT moves them to
// `queryFeed({ q })`, then unmounts and deletes this router and RAJobIndexService.
//
// Mounted at /api/v1/roboapply/v2/search.
//
//   POST   /run         — run the search (filters + paging + facets). Body
//                         carries the SearchQuery + limit + cursor; chosen
//                         over GET so we can pass complex preferredLocations
//                         without URL escaping.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../lib/raAuth.js';
import { logger } from '../../../services/LoggerService.js';
import { raJobIndexService } from '../services/RAJobIndexService.js';

/** @deprecated See the header: use the feed area (WP-32) and search profiles (WP-20). */
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

export default router;
