// server/src/features/alice/routes.ts — Alice's API (docs/alice/ALICE.md §2 "API").
//
// Mounted by features/index.ts at /api/v1/roboapply/alice. Capability `alice`
// per route (off → 404 feature_disabled; the brand's AI cannot run → 503
// ai_unavailable, AI_DEPENDENT_FLAGS). A database without the Alice tables
// answers 503 `ai_unavailable` with reason `alice_not_ready` (store.ts).
//
// POST /turn answers as a stream (SSE): `progress` while a subagent or worker
// runs, `message` for each new message, `thread` with the whole state, then
// `done`; or `error`. Checks that fail before the first event (consent,
// limits, a running turn, a wrong stage) answer a plain JSON error instead, so
// the client never shows half a turn. A client that leaves does not stop the
// turn: the profiles it is writing are stored and shown on the next visit.
// D1: no route here submits anything.

import { Router, type Request, type Response } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { mapError, parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import { openSse, type SseStream } from '../../platform/sse.js';
import { getRequestLocale } from '../../roboapply/v2/lib/raLocale.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  ALICE_LIMITS,
  AliceEntryParamsSchema,
  AliceMatchesQuerySchema,
  AlicePatchProfileBodySchema,
  AliceProfileParamsSchema,
  AliceReminderBodySchema,
  AliceTurnBodySchema,
  type AliceStreamEvent,
} from './contract.js';
import { getAliceService, type AliceContext, type AliceService } from './service.js';

export interface AliceRouterOptions {
  /** Test seam: the service (default: the process-wide one). */
  service?: AliceService;
}

function headerCountry(req: Request): string | null {
  const raw = req.headers['x-vercel-ip-country'] ?? req.headers['cf-ipcountry'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
}

export function contextOf(req: Request): AliceContext {
  let locale = 'en';
  try {
    locale = getRequestLocale(req) ?? 'en';
  } catch {
    locale = 'en';
  }
  return { locale, country: headerCountry(req), requestId: getCurrentRequestId() };
}

function noContent(res: Response): void {
  res.status(204).end();
}

export function createAliceRouter(deps: FeatureRouterDeps = {}, options: AliceRouterOptions = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('alice', { env: deps.env });
  const svc = async () => options.service ?? (await getAliceService());

  router.get('/thread', ...auth, on, route(async (req) => (await svc()).getThread(requireUserId(req), contextOf(req))));

  router.post(
    '/turn',
    ...auth,
    on,
    route(async (req, res) => {
      const userId = requireUserId(req);
      const body = parseBody(req, AliceTurnBodySchema);
      const service = await svc();
      let sse: SseStream | null = null;
      const emit = (e: AliceStreamEvent) => {
        sse ??= openSse(req, res);
        sse.send(e.event, e.data);
      };
      try {
        await service.turn(userId, body, { ...contextOf(req), emit });
        emit({ event: 'done', data: {} });
      } catch (err) {
        // Nothing streamed yet: a plain JSON error (route() maps it).
        if (!sse) throw err;
        const mapped = mapError(err);
        const details = (mapped.body as { details?: { reason?: unknown } }).details;
        emit({
          event: 'error',
          data: { code: mapped.body.code, ...(typeof details?.reason === 'string' ? { reason: details.reason } : {}), message: mapped.body.error },
        });
      } finally {
        (sse as SseStream | null)?.close();
      }
      return undefined;
    }),
  );

  router.get('/profiles', ...auth, on, route(async (req) => (await svc()).listProfiles(requireUserId(req))));
  router.patch(
    '/profiles/:id',
    ...auth,
    on,
    route(async (req) => (await svc()).patchProfile(requireUserId(req), parseParams(req, AliceProfileParamsSchema).id, parseBody(req, AlicePatchProfileBodySchema))),
  );
  router.delete(
    '/profiles/:id',
    ...auth,
    on,
    route(async (req, res) => {
      await (await svc()).deleteProfile(requireUserId(req), parseParams(req, AliceProfileParamsSchema).id);
      noContent(res);
    }),
  );
  router.get(
    '/profiles/:id/matches',
    ...auth,
    on,
    route(async (req) => {
      const q = parseQuery(req, AliceMatchesQuerySchema);
      return (await svc()).matches(requireUserId(req), parseParams(req, AliceProfileParamsSchema).id, q.limit ?? ALICE_LIMITS.matches, contextOf(req));
    }),
  );
  router.get('/applications', ...auth, on, route(async (req) => (await svc()).applications(requireUserId(req))));
  router.put(
    '/reminders/:entryId',
    ...auth,
    on,
    route(async (req) => {
      const body = parseBody(req, AliceReminderBodySchema);
      return (await svc()).setReminder(requireUserId(req), parseParams(req, AliceEntryParamsSchema).entryId, body.date);
    }),
  );
  router.delete(
    '/reminders/:entryId',
    ...auth,
    on,
    route(async (req, res) => {
      await (await svc()).setReminder(requireUserId(req), parseParams(req, AliceEntryParamsSchema).entryId, null);
      noContent(res);
    }),
  );
  return router;
}
