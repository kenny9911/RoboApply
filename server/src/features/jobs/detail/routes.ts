// server/src/features/jobs/detail/routes.ts — job detail routes (WP-34).
// Mounted by features/index.ts at /api/v1/roboapply/jobs, AFTER /jobs/import.
//
//   GET    /:id                 JobDetailResponse (a posting its ATS no longer lists is answered closed)
//   POST   /:id/score           MATCH's handler (WP-18): `{ fit }`, platform-paid, 80/day/user
//   GET    /:id/similar         { items: FeedItem[] }
//   The two reads pass the request's UI language on, so the skill labels of the
//   page's fit are in the language the keyword check and a re-score answer in.
//   POST   /:id/save            tracker `bookmarked` (+ growth checklist 'save_job')
//   DELETE /:id/save            removes a `bookmarked` entry (409 once applied)
//   POST   /:id/apply-click     tracker → applied at once; { applyUrl, atsType, extensionSupported, trackerEntryId }
//   POST   /:id/applied         "I applied"
//   DELETE /:id/applied         "Undo · I didn't apply"
//   POST   /:id/share           { url, public }
//   GET    /:id/company-news    V2; 404 feature_disabled until the `companyNews` flag is on;
//                                30/h per user (each miss is a paid Tavily search)
//
// D1: none of these contacts an employer.

import { Router, type Request, type RequestHandler } from 'express';
import { seekerAuth } from '../../../roboapply/engine/middleware/seekerAuth.js';
import { parseBody, parseParams, requireUserId, route } from '../../../platform/http.js';
import { HOUR, rateLimit } from '../../../platform/ratelimit/index.js';
import type { FeatureRouterDeps } from '../../index.js';
import { JobIdParamsSchema, MarkAppliedBodySchema } from './contract.js';
import type { JobDetailServiceImpl } from './service.js';

export interface JobDetailRouterDeps extends FeatureRouterDeps {
  /** Test seam: the service (default: the Prisma-backed one). */
  service?: JobDetailServiceImpl;
  /** Test seam: the score handler (default: MATCH's `createScoreJobHandler()`). */
  scoreHandler?: RequestHandler;
  /** Test seam: the company-news limiter (default: COMPANY_NEWS_RATE_LIMIT per user). */
  newsLimiter?: RequestHandler;
}

/** The request's UI locale (x-robo-locale header, then the locale cookie), as MATCH's routes read it; undefined when it cannot be read. */
async function requestLocale(req: Request): Promise<string | undefined> {
  try {
    const { getRequestLocale } = await import('../../../roboapply/v2/lib/raLocale.js');
    return getRequestLocale(req) || undefined;
  } catch {
    return undefined;
  }
}

/** Company news per user: 30/h (each cache miss is a paid Tavily search). */
export const COMPANY_NEWS_RATE_LIMIT = [{ limit: 30, windowSec: HOUR }] as const;

export function createJobDetailRouter(deps: JobDetailRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const service = async (): Promise<JobDetailServiceImpl> => deps.service ?? (await import('./defaultService.js')).defaultJobDetailService();
  const id = (req: Parameters<typeof parseParams>[0]) => parseParams(req, JobIdParamsSchema).id;

  router.get(
    '/:id',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const jobId = id(req);
      return (await service()).get(userId, jobId, { locale: await requestLocale(req) });
    }),
  );
  // MATCH's handler, loaded on first use so mounting this router at boot stays light.
  let score: RequestHandler | null = deps.scoreHandler ?? null;
  const scoreHandler: RequestHandler = async (req, res, next) => {
    try {
      score ??= (await import('../../match/index.js')).createScoreJobHandler();
    } catch (err) {
      next(err);
      return;
    }
    return score(req, res, next);
  };
  router.post('/:id/score', ...auth, scoreHandler);
  router.get(
    '/:id/similar',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const jobId = id(req);
      return (await service()).similar(userId, jobId, { locale: await requestLocale(req) });
    }),
  );
  router.post('/:id/save', ...auth, route(async (req) => (await service()).save(requireUserId(req), id(req))));
  router.delete('/:id/save', ...auth, route(async (req) => (await service()).unsave(requireUserId(req), id(req))));
  router.post('/:id/apply-click', ...auth, route(async (req) => (await service()).recordApplyClick(requireUserId(req), id(req))));
  router.post(
    '/:id/applied',
    ...auth,
    route(async (req) => {
      const userId = requireUserId(req);
      const jobId = id(req);
      const body = parseBody(req, MarkAppliedBodySchema);
      return (await service()).markApplied(userId, jobId, body.appliedAt);
    }),
  );
  router.delete('/:id/applied', ...auth, route(async (req) => (await service()).undoApplied(requireUserId(req), id(req))));
  router.post('/:id/share', ...auth, route(async (req) => (await service()).share(requireUserId(req), id(req))));
  const newsLimiter = deps.newsLimiter ?? rateLimit({ name: 'companyNewsPerUser', windows: COMPANY_NEWS_RATE_LIMIT, by: 'user' });
  router.get('/:id/company-news', ...auth, newsLimiter, route(async (req) => (await service()).companyNews(requireUserId(req), id(req))));

  return router;
}
