// server/src/interview-engine/prep/routes.ts
//
// First-party interview-prep routes (cookie session only; an API key is
// refused like every /practice route). Mounted by externalRoutes.ts at
// /api/v1/interview-engine/v1/practice/prep.
//
//   GET  /industries   the industry list in the market's order, labelled
//   POST /roles        { industry }                     → the roles it hires
//   POST /search       { query, company?, industry? }   → roles + postings
//   POST /plan         { role | jobId | jdText | posting, company?, … } → PrepPlan
//
// Every route that reaches a model or a search vendor passes the brand's AI
// gate first (GoApply: bound phone + AI consent) and a per-user rate limit.

import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { ZodType } from 'zod';
import { logger } from '../../services/LoggerService.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import { clampLocaleToBrand, type ProductBrand } from '../../platform/brand/registry.js';
import { rateLimit } from '../../platform/ratelimit/index.js';
import { aiGateOpen, currentBrand } from '../routes/practiceGate.js';
import { PrepPlanBodySchema, PrepRolesBodySchema, PrepSearchBodySchema } from './contract.js';
import { industriesFor } from './industries.js';
import { rolesForIndustry } from './industryRoles.js';
import { findJobs } from './jobFinder.js';
import { resolvePrepMarket } from './marketContext.js';
import { planInterview, PrepJobNotFoundError } from './planner.js';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface PrepRouterDeps {
  requireAuth: RequestHandler;
  requireFirstParty: RequestHandler;
  /** Overridable for tests (the defaults count in RARateCounter). */
  limiters?: Partial<Record<'search' | 'roles' | 'plan', RequestHandler>>;
}

async function requestLocale(req: Request, brand: ProductBrand): Promise<string> {
  const { getRequestLocale } = await import('../../roboapply/v2/lib/raLocale.js');
  return clampLocaleToBrand(brand, getRequestLocale(req));
}

function parse<T>(schema: ZodType<T>, req: Request, res: Response): T | null {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) return result.data;
  res.status(422).json({ error: 'validation_error', message: result.error.issues[0]?.message ?? 'Invalid request.' });
  return null;
}

function failed(res: Response, op: string, err: unknown, userId: string): Response {
  logger.error('INTERVIEW_PREP', `${op} failed`, {
    userId,
    requestId: getCurrentRequestId() ?? undefined,
    error: err instanceof Error ? err.message : String(err),
  });
  return res.status(500).json({ error: 'prep_failed' });
}

export function createPrepRouter(deps: PrepRouterDeps): Router {
  const router = Router();
  const auth = [deps.requireAuth, deps.requireFirstParty];
  const limiter = (name: 'search' | 'roles' | 'plan', windows: Array<{ windowSec: number; limit: number }>): RequestHandler =>
    deps.limiters?.[name] ?? rateLimit({ name: `practicePrep_${name}`, windows, by: 'user' });
  // Typing searches as the candidate pauses; a plan is one per target (plus a company change).
  const searchLimiter = limiter('search', [{ windowSec: 10 * MINUTE, limit: 60 }, { windowSec: DAY, limit: 400 }]);
  const rolesLimiter = limiter('roles', [{ windowSec: HOUR, limit: 60 }, { windowSec: DAY, limit: 300 }]);
  const planLimiter = limiter('plan', [{ windowSec: HOUR, limit: 30 }, { windowSec: DAY, limit: 120 }]);

  router.get('/industries', ...auth, async (req: Request, res: Response) => {
    try {
      const brand = await currentBrand();
      const locale = await requestLocale(req, brand);
      return res.json({ industries: industriesFor(brand.market === 'cn' ? 'cn' : localeMarket(locale), locale) });
    } catch (err) {
      return failed(res, 'industries', err, req.user!.id);
    }
  });

  router.post('/roles', ...auth, rolesLimiter, async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const body = parse(PrepRolesBodySchema, req, res);
    if (!body) return;
    try {
      const brand = await currentBrand();
      if (!(await aiGateOpen(req, res, brand))) return;
      const locale = await requestLocale(req, brand);
      const ctx = await resolvePrepMarket({ userId, brand, locale });
      const roles = await rolesForIndustry({ industry: body.industry, locale, ctx, requestId: getCurrentRequestId() ?? undefined });
      if (!roles) return res.status(503).json({ error: 'prep_unavailable' });
      return res.json({ roles });
    } catch (err) {
      return failed(res, 'roles', err, userId);
    }
  });

  router.post('/search', ...auth, searchLimiter, async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const body = parse(PrepSearchBodySchema, req, res);
    if (!body) return;
    try {
      const brand = await currentBrand();
      if (!(await aiGateOpen(req, res, brand))) return;
      const locale = await requestLocale(req, brand);
      const ctx = await resolvePrepMarket({ userId, brand, locale });
      const result = await findJobs(
        {
          userId,
          locale,
          query: body.query,
          company: body.company ?? null,
          industry: body.industry ?? null,
          external: body.external,
          requestId: getCurrentRequestId() ?? undefined,
        },
        ctx,
      );
      return res.json(result);
    } catch (err) {
      return failed(res, 'search', err, userId);
    }
  });

  router.post('/plan', ...auth, planLimiter, async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const body = parse(PrepPlanBodySchema, req, res);
    if (!body) return;
    if (!body.role && !body.jobId && !body.jdText && !body.posting) {
      return res.status(422).json({ error: 'validation_error', message: 'Name a role, a job or a job post.' });
    }
    try {
      const brand = await currentBrand();
      if (!(await aiGateOpen(req, res, brand))) return;
      const locale = await requestLocale(req, brand);
      const plan = await planInterview({
        userId,
        userName: req.user!.name ?? null,
        brand,
        locale,
        body,
        requestId: getCurrentRequestId() ?? undefined,
      });
      return res.json({ plan });
    } catch (err) {
      if (err instanceof PrepJobNotFoundError) return res.status(404).json({ error: 'job_not_found' });
      return failed(res, 'plan', err, userId);
    }
  });

  return router;
}

/** The industry order to show for an interface language (the job market is refined per search). */
function localeMarket(locale: string): string {
  if (locale === 'zh-TW') return 'tw';
  if (locale === 'ja') return 'jp';
  if (locale === 'ko') return 'kr';
  if (locale === 'zh') return 'cn';
  return 'default';
}
