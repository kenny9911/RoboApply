// server/src/features/copilot/routes.ts — STUB (FND-5). Owner: WP-50.
// Mounted by features/index.ts at /api/v1/roboapply/copilot. Capability `copilot` per route.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  ApplyProposalBodySchema,
  CreateThreadBodySchema,
  MemoryParamsSchema,
  MessageFeedbackBodySchema,
  MessageParamsSchema,
  MessagesQuerySchema,
  ProposalParamsSchema,
  SendMessageBodySchema,
  ThreadParamsSchema,
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

export function createCopilotRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('copilot', { env: deps.env });

  router.get('/threads', ...auth, on, stub('copilot.listThreads'));
  router.post('/threads', ...auth, on, stub('copilot.createThread', { body: CreateThreadBodySchema }));
  router.get('/threads/:id/messages', ...auth, on, stub('copilot.listMessages', { params: ThreadParamsSchema, query: MessagesQuerySchema }));
  router.post('/threads/:id/messages', ...auth, on, stub('copilot.sendMessage', { params: ThreadParamsSchema, body: SendMessageBodySchema }));
  router.delete('/threads/:id', ...auth, on, stub('copilot.archiveThread', { params: ThreadParamsSchema }));
  router.post('/proposals/:id/apply', ...auth, on, stub('copilot.applyProposal', { params: ProposalParamsSchema, body: ApplyProposalBodySchema }));
  router.post('/proposals/:id/dismiss', ...auth, on, stub('copilot.dismissProposal', { params: ProposalParamsSchema }));
  router.post('/messages/:id/feedback', ...auth, on, stub('copilot.feedback', { params: MessageParamsSchema, body: MessageFeedbackBodySchema }));
  router.get('/memory', ...auth, on, stub('copilot.listMemory'));
  router.delete('/memory/:id', ...auth, on, stub('copilot.deleteMemory', { params: MemoryParamsSchema }));

  return router;
}
