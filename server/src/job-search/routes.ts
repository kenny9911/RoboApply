import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/LoggerService.js';
import { jobSearchService, parseSearchInput, JobSearchValidationError } from './service.js';
import { JobSearchAccessError, jobSearchKeys } from './keys.js';
import { SearchQuotaError, jobSearchQuota } from './quota.js';
import { jobSearchOpenApi } from './openapi.js';

type Dependencies = {
  service: typeof jobSearchService;
  keys: typeof jobSearchKeys;
  quota: typeof jobSearchQuota;
  sessionAuth: RequestHandler;
};

function requestId(req: Request, res: Response, next: NextFunction) {
  req.requestId ??= randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function fail(err: unknown, req: Request, res: Response) {
  if (err instanceof SearchQuotaError) res.setHeader('Retry-After', err.retryAfter);
  if (err instanceof JobSearchValidationError) {
    return res.status(400).json({ error: err.message, code: 'invalid_request', requestId: req.requestId });
  }
  if (err instanceof JobSearchAccessError) {
    if (err.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(err.status).json({ error: err.message, code: err.code, requestId: req.requestId });
  }
  // Never return SQL, credentials, or upstream response bodies to clients.
  logger.error('JOB_SEARCH', 'Request failed', { requestId: req.requestId, path: req.path });
  return res.status(503).json({ error: 'Job search is temporarily unavailable.', code: 'service_unavailable', requestId: req.requestId });
}

export function createJobSearchRouters(overrides: Partial<Dependencies> = {}) {
  const d = { service: jobSearchService, keys: jobSearchKeys, quota: jobSearchQuota, sessionAuth: requireAuth, ...overrides };
  const api = Router();
  const website = Router();
  api.use(requestId);
  website.use(requestId);

  api.get('/openapi.json', (_req, res) => res.json(jobSearchOpenApi));
  api.use(async (req, res, next) => {
    try {
      res.locals.searchIdentity = await d.keys.authenticate(req.get('authorization'));
      next();
    } catch (err) { fail(err, req, res); }
  });

  website.use(d.sessionAuth);
  website.use((req, res, next) => {
    // Broad legacy API keys cannot create scoped integration keys or evade
    // the partner provider permissions through the candidate route.
    if (req.apiKeyId || !req.user?.id) {
      return res.status(403).json({ error: 'A user session is required.', code: 'session_required', requestId: req.requestId });
    }
    res.locals.searchIdentity = { userId: req.user.id };
    next();
  });

  for (const [router, audience] of [[api, 'api'], [website, 'website']] as const) {
    router.get('/providers', (_req, res) => res.json({ providers: d.service.providers(audience) }));
    router.post('/search', async (req, res) => {
      let reservation: string | undefined;
      let apiKeyId: string | undefined;
      let status = 503;
      const start = Date.now();
      const controller = new AbortController();
      const close = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', close);
      try {
        const input = parseSearchInput(req.body);
        const identity = res.locals.searchIdentity as { userId: string; apiKeyId?: string };
        apiKeyId = identity.apiKeyId;
        const candidates = d.service.providers(audience).filter(p => !input.providers || input.providers.includes(p.id));
        if (!candidates.some(p => p.enabled)) {
          // Do not re-enter the service without a reservation. A circuit can
          // recover between readiness checks and otherwise start unpaid work.
          return res.status(503).json({
            error: 'No selected job source is currently available.', code: 'providers_unavailable', requestId: req.requestId,
            data: { jobs: [], meta: {
              requestId: req.requestId, totalReturned: 0, deduplicated: 0, partial: true,
              providers: candidates.map(p => ({ id: p.id, name: p.name, status: 'unavailable', reason: p.reason, resultCount: 0 })),
              searchedAt: new Date().toISOString(), cache: 'miss',
            } },
          });
        }
        reservation = await d.quota.reserve(identity.userId, identity.apiKeyId, req.requestId);
        const result = await d.service.search(input, { audience, requestId: req.requestId, signal: controller.signal });
        const succeeded = result.meta.providers.some(p => p.status === 'ok' || p.status === 'empty');
        status = succeeded ? 200 : 503;
        if (!succeeded) return res.status(status).json({
          error: 'No selected job source is currently available.', code: 'providers_unavailable',
          requestId: req.requestId, data: result,
        });
        return res.json(result);
      } catch (err) {
        status = err instanceof JobSearchAccessError ? err.status : err instanceof JobSearchValidationError ? 400 : 503;
        return fail(err, req, res);
      } finally {
        res.off('close', close);
        if (reservation) {
          try { await d.quota.finish(reservation, status, Date.now() - start, apiKeyId); }
          catch { logger.warn('JOB_SEARCH', 'Usage finalization failed; reservation retained', { requestId: req.requestId }); }
        }
      }
    });
  }

  website.get('/keys', async (req, res) => {
    try { res.json(await d.keys.list(req.user!.id)); }
    catch (err) { fail(err, req, res); }
  });
  website.post('/keys', async (req, res) => {
    try { res.status(201).json(await d.keys.create(req.user!.id, req.body)); }
    catch (err) { fail(err, req, res); }
  });
  website.delete('/keys/:id', async (req, res) => {
    try { await d.keys.revoke(req.user!.id, req.params.id); res.status(204).end(); }
    catch (err) { fail(err, req, res); }
  });
  return { api, website };
}
