// server/src/features/match/routes.ts — MATCH routes. Owners: WP-18 (fit analysis,
// keyword check, the score handler), WP-77 (competitiveness, still stubs).
// Mounted by features/index.ts at /api/v1/roboapply/match.
//
//   POST /jobs/:id/fit-analysis   FitAnalysisCard; `fit_analysis` credit only when a model call is
//                                 needed; needs an `Idempotency-Key` header (a retry never charges twice)
//   GET  /jobs/:id/keyword-check  requirement rows; free and deterministic (F-RES-08)
//
// `createScoreJobHandler()` is the handler for `POST /jobs/:id/score` on the
// job-detail mount (WP-34 mounts it; platform-paid, 80/day/user, beyond it the
// "Quick estimate").

import { Router, type Request, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { HttpError, markStub, NotImplementedError, parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  CompetitivenessBodySchema,
  FitAnalysisBodySchema,
  KeywordCheckQuerySchema,
  MATCH_ERROR_CODES,
  MatchJobParamsSchema,
  ScoreJobBodySchema,
  type FitAnalysisCard,
  type KeywordCheckResponse,
  type MatchFitView,
} from './contract.js';
import type { MatchService } from './MatchService.js';

function stub(what: string, s: { params?: ZodType; query?: ZodType; body?: ZodType } = {}): RequestHandler {
  return markStub(
    route(async (req) => {
      if (s.params) parseParams(req, s.params);
      if (s.query) parseQuery(req, s.query);
      if (s.body) parseBody(req, s.body);
      throw new NotImplementedError(what);
    }),
  );
}

const defaultService = async (): Promise<MatchService> => (await import('./defaultService.js')).defaultMatchService;

/** The request's UI locale (x-robo-locale header, then the locale cookie). */
async function requestLocale(req: Request): Promise<string> {
  try {
    const { getRequestLocale } = await import('../../roboapply/v2/lib/raLocale.js');
    return getRequestLocale(req);
  } catch {
    return 'en';
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;

/** POST /jobs/:id/score — mounted on the job-detail router by WP-34. Answers `{ fit }`. */
export function createScoreJobHandler(getService: () => Promise<MatchService> = defaultService): RequestHandler {
  return route(async (req): Promise<{ fit: MatchFitView }> => {
    const userId = requireUserId(req);
    const { id } = parseParams(req, MatchJobParamsSchema);
    const body = parseBody(req, ScoreJobBodySchema);
    const service = await getService();
    const fit = await service.scoreJob(userId, id, { ...body, locale: await requestLocale(req), mode: 'on_demand' });
    return { fit };
  });
}

export function createMatchRouter(deps: FeatureRouterDeps = {}, getService: () => Promise<MatchService> = defaultService): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const competitiveness = requireFlag('competitiveness', { env: deps.env });

  router.post(
    '/jobs/:id/fit-analysis',
    ...auth,
    route(async (req): Promise<FitAnalysisCard> => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, MatchJobParamsSchema);
      const body = parseBody(req, FitAnalysisBodySchema);
      const key = req.get('Idempotency-Key')?.trim();
      if (!key || !IDEMPOTENCY_KEY.test(key)) {
        throw new HttpError('invalid_request', 'An Idempotency-Key header is required.', { reason: MATCH_ERROR_CODES.idempotencyKeyRequired });
      }
      const service = await getService();
      return service.fitAnalysis(userId, id, key, { resumeVariantId: body.resumeVariantId, locale: await requestLocale(req) });
    }),
  );

  router.get(
    '/jobs/:id/keyword-check',
    ...auth,
    route(async (req): Promise<KeywordCheckResponse> => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, MatchJobParamsSchema);
      const query = parseQuery(req, KeywordCheckQuerySchema);
      const service = await getService();
      return service.keywordCheck(userId, id, { resumeVariantId: query.resumeVariantId });
    }),
  );

  router.post('/competitiveness', ...auth, competitiveness, stub('match.competitiveness', { body: CompetitivenessBodySchema }));
  router.get('/competitiveness/latest', ...auth, competitiveness, stub('match.competitivenessLatest'));

  return router;
}
