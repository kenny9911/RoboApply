// server/src/features/agent/routes.ts — STUB (FND-5). Owner: WP-52.
// Mounted by features/index.ts at /api/v1/roboapply/agent. Capability `agent` per route.
// The legacy V1/V2 queue routes (/v2/queue) are untouched (WP-75 removes them).

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  AddToQueueBodySchema,
  CalibrationBodySchema,
  ConfirmPartBodySchema,
  PrepareBodySchema,
  PutAgentSettingsBodySchema,
  PutAnswersBodySchema,
  QueueItemParamsSchema,
  QueueListQuerySchema,
} from './contract.js';

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

export function createAgentRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('agent', { env: deps.env });
  const item = { params: QueueItemParamsSchema };

  router.get('/settings', ...auth, on, stub('agent.getSettings'));
  router.put('/settings', ...auth, on, stub('agent.putSettings', { body: PutAgentSettingsBodySchema }));
  router.get('/setup', ...auth, on, stub('agent.setup'));
  router.post('/setup/calibration', ...auth, on, stub('agent.calibration', { body: CalibrationBodySchema }));
  router.get('/suggestions', ...auth, on, stub('agent.suggestions'));

  router.get('/queue', ...auth, on, stub('agent.listQueue', { query: QueueListQuerySchema }));
  router.post('/queue', ...auth, on, stub('agent.addToQueue', { body: AddToQueueBodySchema }));
  router.post('/queue/:id/prepare', ...auth, on, stub('agent.prepare', { ...item, body: PrepareBodySchema }));
  router.post('/queue/:id/confirm', ...auth, on, stub('agent.confirm', { ...item, body: ConfirmPartBodySchema }));
  router.post('/queue/:id/open', ...auth, on, stub('agent.open', item));
  router.post('/queue/:id/undo-applied', ...auth, on, stub('agent.undoApplied', item));
  router.post('/queue/:id/applied', ...auth, on, stub('agent.markApplied', item));
  router.post('/queue/:id/skip', ...auth, on, stub('agent.skip', item));
  router.delete('/queue/:id', ...auth, on, stub('agent.remove', item));

  router.get('/answers', ...auth, on, stub('agent.getAnswers'));
  router.put('/answers', ...auth, on, stub('agent.putAnswers', { body: PutAnswersBodySchema }));

  return router;
}
