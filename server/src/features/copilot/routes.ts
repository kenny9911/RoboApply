// server/src/features/copilot/routes.ts — the Assistant API (ARCH §3.5; WP-50).
// Mounted by features/index.ts at /api/v1/roboapply/copilot. Capability `copilot` per route.
//
//   GET    /threads                    threads (newest first)
//   POST   /threads                    { contextJobId? } → thread (201)
//   GET    /threads/:id/messages       ?before=&limit= → messages (with cards), chronological
//   POST   /threads/:id/messages       { text, chip?, contextJobId?, resumeId? } → SSE
//                                       (Idempotency-Key required; credit `assistant`)
//   POST   /threads/:id/stop           stop the reply being written → { stopped }
//   DELETE /threads/:id                archive → 204
//   POST   /proposals/:id/apply        → { applied, result } (credit actions spend their own bucket here)
//   POST   /proposals/:id/dismiss      → 204
//   POST   /messages/:id/feedback      { value, note? } → 204
//   GET    /memory · DELETE /memory/:id
//   GET    /nudge                      → { nudge } (at most one, from real signals)
//
// Errors before the stream opens are ordinary JSON envelopes (401, 404
// feature_disabled / thread_not_found, 402 credits_exhausted, 403
// phone_binding_required, 422, 503 ai_unavailable). After it opens,
// problems arrive as an SSE `error` event. A client disconnect aborts the
// model call; because a proxy in front may keep the upstream request open
// after the browser left, the Stop button also calls POST /threads/:id/stop.

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { getRequestLocale } from '../../roboapply/v2/lib/raLocale.js';
import { requireFlag } from '../../platform/flags.js';
import { mapError, parseBody, parseParams, parseQuery, requireUserId, route } from '../../platform/http.js';
import { openSse } from '../../platform/sse.js';
import { AuthCnError, requirePhoneBound } from '../auth-cn/index.js';
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
import type { CopilotService } from './CopilotService.js';

export interface CopilotRouterOptions {
  /** The service (tests inject one over fakes); default: the process-wide one. */
  service?: CopilotService | (() => Promise<CopilotService>);
  /** GoApply phone-binding gate (tests pass a pass-through). */
  phoneGate?: RequestHandler;
}

/** route() plus the auth-cn 403 `phone_binding_required` raised by area seams (tailor). */
function copilotRoute<T>(handler: (req: Request, res: Response) => Promise<T>, options: { status?: number } = {}): RequestHandler {
  return route(async (req, res) => {
    try {
      return await handler(req, res);
    } catch (err) {
      if (err instanceof AuthCnError) {
        res.status(err.status).json({ success: false, code: err.code, error: err.message, ...(err.details ? { details: err.details } : {}) });
        return undefined as T;
      }
      throw err;
    }
  }, options);
}

function noContent(res: Response): void {
  res.status(204).end();
}

export function createCopilotRouter(deps: FeatureRouterDeps = {}, options: CopilotRouterOptions = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('copilot', { env: deps.env });
  const phoneGate = options.phoneGate ?? requirePhoneBound();
  const service = async (): Promise<CopilotService> => {
    if (typeof options.service === 'function') return options.service();
    if (options.service) return options.service;
    return (await import('./index.js')).getCopilotService();
  };

  router.get(
    '/threads',
    ...auth,
    on,
    copilotRoute(async (req) => (await service()).listThreads(requireUserId(req))),
  );

  router.post(
    '/threads',
    ...auth,
    on,
    copilotRoute(async (req) => (await service()).createThread(requireUserId(req), parseBody(req, CreateThreadBodySchema)), { status: 201 }),
  );

  router.get(
    '/threads/:id/messages',
    ...auth,
    on,
    copilotRoute(async (req) => {
      const { id } = parseParams(req, ThreadParamsSchema);
      return (await service()).listMessages(requireUserId(req), id, parseQuery(req, MessagesQuerySchema));
    }),
  );

  router.post(
    '/threads/:id/messages',
    ...auth,
    on,
    phoneGate,
    copilotRoute(async (req, res) => {
      const userId = requireUserId(req);
      const { id } = parseParams(req, ThreadParamsSchema);
      const body = parseBody(req, SendMessageBodySchema);
      const svc = await service();
      const controller = new AbortController();
      // Everything that can fail before streaming answers as JSON.
      const stream = await svc.handleTurn(userId, id, body, {
        signal: controller.signal,
        idempotencyKey: req.get('Idempotency-Key') ?? null,
        locale: getRequestLocale(req),
      });
      const sse = openSse(req, res);
      const onAbort = () => controller.abort();
      sse.signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const e of stream) {
          if (sse.closed) break;
          sse.send(e.event, e.data);
        }
      } catch (err) {
        const mapped = mapError(err);
        sse.send('error', { code: mapped.body.code, message: mapped.body.error, retryable: mapped.status >= 500 });
      } finally {
        sse.signal.removeEventListener('abort', onAbort);
        sse.close();
      }
      return undefined;
    }),
  );

  router.post(
    '/threads/:id/stop',
    ...auth,
    on,
    copilotRoute(async (req) => {
      const { id } = parseParams(req, ThreadParamsSchema);
      return (await service()).stopTurn(requireUserId(req), id);
    }),
  );

  router.delete(
    '/threads/:id',
    ...auth,
    on,
    copilotRoute(async (req, res) => {
      const { id } = parseParams(req, ThreadParamsSchema);
      await (await service()).archiveThread(requireUserId(req), id);
      noContent(res);
    }),
  );

  router.post(
    '/proposals/:id/apply',
    ...auth,
    on,
    phoneGate,
    copilotRoute(async (req) => {
      const { id } = parseParams(req, ProposalParamsSchema);
      const body = parseBody(req, ApplyProposalBodySchema);
      return (await service()).proposals.apply(requireUserId(req), id, { baseVersion: body.baseVersion, locale: getRequestLocale(req) });
    }),
  );

  router.post(
    '/proposals/:id/dismiss',
    ...auth,
    on,
    copilotRoute(async (req, res) => {
      const { id } = parseParams(req, ProposalParamsSchema);
      await (await service()).proposals.dismiss(requireUserId(req), id);
      noContent(res);
    }),
  );

  router.post(
    '/messages/:id/feedback',
    ...auth,
    on,
    copilotRoute(async (req, res) => {
      const { id } = parseParams(req, MessageParamsSchema);
      await (await service()).feedback(requireUserId(req), id, parseBody(req, MessageFeedbackBodySchema));
      noContent(res);
    }),
  );

  router.get(
    '/memory',
    ...auth,
    on,
    copilotRoute(async (req) => (await service()).listMemory(requireUserId(req))),
  );

  router.delete(
    '/memory/:id',
    ...auth,
    on,
    copilotRoute(async (req, res) => {
      const { id } = parseParams(req, MemoryParamsSchema);
      await (await service()).deleteMemory(requireUserId(req), id);
      noContent(res);
    }),
  );

  router.get(
    '/nudge',
    ...auth,
    on,
    copilotRoute(async (req) => (await service()).nudge(requireUserId(req))),
  );

  return router;
}
