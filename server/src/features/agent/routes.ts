// server/src/features/agent/routes.ts — Ready to apply API (WP-52; ARCH §3.7).
// Mounted by features/index.ts at /api/v1/roboapply/agent. Capability `agent`
// per route (off → 404 feature_disabled; no model for the brand → 503
// ai_unavailable). The legacy V1/V2 queue routes (/v2/queue) are untouched
// (WP-75 removes them).
//
// D1: no route here submits anything or calls an employer endpoint. `open`
// returns the employer URL for the user to open and moves the tracker entry
// to Applied at once (same path as "Apply on company site"), with
// `undo-applied` as "Undo · I didn't apply".

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { isErrorCode, parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  AddToQueueBodySchema,
  AnswerKeyParamsSchema,
  CalibrationBodySchema,
  ConfirmPartBodySchema,
  GenerateListBodySchema,
  PrepareBatchBodySchema,
  PrepareBodySchema,
  PutAgentSettingsBodySchema,
  PutAnswersBodySchema,
  QueueItemParamsSchema,
  QueueListQuerySchema,
  SaveToMainBodySchema,
  SetupStepBodySchema,
  SuggestionsQuerySchema,
} from './contract.js';
import { getAgentService, type AgentServiceImpl } from './service.js';

export interface AgentRouterOptions {
  /** Test seam: the service (default: the process-wide one). */
  service?: AgentServiceImpl;
}

/**
 * `route()` plus domain errors whose code is not a platform code (auth-cn
 * `phone_binding_required` 403, the resume `unverified_claims` 409): their own
 * status, code and details are sent as they are.
 */
function agentRoute<T>(handler: (req: Request, res: Response) => Promise<T>): RequestHandler {
  return route(async (req, res) => {
    try {
      return await handler(req, res);
    } catch (err) {
      const e = err as { status?: unknown; code?: unknown; message?: unknown; details?: unknown } | null;
      if (e && typeof e.status === 'number' && typeof e.code === 'string' && !isErrorCode(e.code) && e.status >= 400 && e.status < 500) {
        res.status(e.status).json({
          success: false,
          code: e.code,
          error: typeof e.message === 'string' ? e.message : 'Request failed.',
          ...(e.details !== undefined ? { details: e.details } : {}),
        });
        return undefined as T;
      }
      throw err;
    }
  });
}

export function createAgentRouter(deps: FeatureRouterDeps = {}, options: AgentRouterOptions = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('agent', { env: deps.env });
  const svc = () => options.service ?? getAgentService();
  const itemId = (req: Request) => parseParams(req, QueueItemParamsSchema).id;

  // Settings and setup (F-AGENT-02/03)
  router.get('/settings', ...auth, on, agentRoute(async (req) => svc().getSettings(requireUserId(req))));
  router.put('/settings', ...auth, on, agentRoute(async (req) => svc().putSettings(requireUserId(req), parseBody(req, PutAgentSettingsBodySchema))));
  router.get('/setup', ...auth, on, agentRoute(async (req) => svc().setup(requireUserId(req))));
  router.post('/setup/calibration', ...auth, on, agentRoute(async (req) => svc().calibrate(requireUserId(req), parseBody(req, CalibrationBodySchema))));
  router.post('/setup/step', ...auth, on, agentRoute(async (req) => svc().completeStep(requireUserId(req), parseBody(req, SetupStepBodySchema))));

  // Suggestions, the weekly list and the main search (F-AGENT-04, F-FILT-07)
  router.get('/suggestions', ...auth, on, agentRoute(async (req) => svc().suggestions(requireUserId(req), parseQuery(req, SuggestionsQuerySchema))));
  router.post(
    '/list/generate',
    ...auth,
    on,
    agentRoute(async (req) => {
      const body = parseBody(req, GenerateListBodySchema);
      return svc().generateList(requireUserId(req), { overrides: body.overrides, more: body.more, source: 'user' });
    }),
  );
  router.post('/search/save-to-main', ...auth, on, agentRoute(async (req) => svc().saveToMain(requireUserId(req), parseBody(req, SaveToMainBodySchema))));
  router.get('/badge', ...auth, on, agentRoute(async (req) => svc().badge(requireUserId(req))));

  // Queue (F-AGENT-04/05/08/10/11)
  router.get('/queue', ...auth, on, agentRoute(async (req) => svc().listQueue(requireUserId(req), parseQuery(req, QueueListQuerySchema))));
  router.post('/queue', ...auth, on, agentRoute(async (req) => svc().addToQueue(requireUserId(req), parseBody(req, AddToQueueBodySchema))));
  router.post(
    '/queue/prepare',
    ...auth,
    on,
    agentRoute(async (req) => {
      const body = parseBody(req, PrepareBatchBodySchema);
      return svc().prepare(requireUserId(req), body.ids, body.confirm === true);
    }),
  );
  router.get('/queue/:id', ...auth, on, agentRoute(async (req) => svc().detail(requireUserId(req), itemId(req))));
  router.get('/queue/:id/history', ...auth, on, agentRoute(async (req) => svc().history(requireUserId(req), itemId(req))));
  router.post(
    '/queue/:id/prepare',
    ...auth,
    on,
    agentRoute(async (req) => {
      const id = itemId(req);
      const body = parseBody(req, PrepareBodySchema);
      return svc().prepare(requireUserId(req), [id], body.confirm === true);
    }),
  );
  router.post(
    '/queue/:id/confirm',
    ...auth,
    on,
    agentRoute(async (req) => {
      const id = itemId(req);
      return svc().confirmPart(requireUserId(req), id, parseBody(req, ConfirmPartBodySchema));
    }),
  );
  router.post('/queue/:id/open', ...auth, on, agentRoute(async (req) => svc().open(requireUserId(req), itemId(req))));
  router.post('/queue/:id/undo-applied', ...auth, on, agentRoute(async (req) => svc().undoApplied(requireUserId(req), itemId(req))));
  router.post('/queue/:id/applied', ...auth, on, agentRoute(async (req) => svc().markApplied(requireUserId(req), itemId(req))));
  router.post('/queue/:id/skip', ...auth, on, agentRoute(async (req) => svc().skip(requireUserId(req), itemId(req))));
  router.post('/queue/:id/restore', ...auth, on, agentRoute(async (req) => svc().restore(requireUserId(req), itemId(req))));
  router.delete('/queue/:id', ...auth, on, agentRoute(async (req) => svc().remove(requireUserId(req), itemId(req))));

  // Answer bank (F-AGENT-03)
  router.get('/answers', ...auth, on, agentRoute(async (req) => svc().listAnswers(requireUserId(req))));
  router.put('/answers', ...auth, on, agentRoute(async (req) => svc().putAnswers(requireUserId(req), parseBody(req, PutAnswersBodySchema).answers)));
  router.get('/answers/questions', ...auth, on, agentRoute(async () => svc().questions()));
  router.delete('/answers/:key', ...auth, on, agentRoute(async (req) => svc().deleteAnswer(requireUserId(req), parseParams(req, AnswerKeyParamsSchema).key)));

  return router;
}
