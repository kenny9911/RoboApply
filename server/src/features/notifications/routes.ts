// server/src/features/notifications/routes.ts — STUB (FND-5). Owner: WP-39b.
//
// Mounted by features/index.ts:
//   createNotificationsRouter()  at /api/v1/roboapply/notifications (seeker)
//   createEmailPublicRouter()    at /api/v1/public/email (unsubscribe without login)

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  ListNotificationsQuerySchema,
  NotificationParamsSchema,
  PatchNotificationPreferencesBodySchema,
  RespondInvitationBodySchema,
  UnsubscribeBodySchema,
  UnsubscribeQuerySchema,
  UnsubscribeSurveyBodySchema,
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

export function createNotificationsRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const p = { params: NotificationParamsSchema };

  router.get('/', ...auth, stub('notifications.list', { query: ListNotificationsQuerySchema }));
  router.get('/unread-count', ...auth, stub('notifications.unreadCount'));
  router.post('/read-all', ...auth, stub('notifications.readAll'));
  router.get('/preferences', ...auth, stub('notifications.getPreferences'));
  router.patch('/preferences', ...auth, stub('notifications.patchPreferences', { body: PatchNotificationPreferencesBodySchema }));
  router.post('/:id/read', ...auth, stub('notifications.read', p));
  router.post(
    '/:id/respond',
    ...auth,
    requireFlag('invitations', { env: deps.env }),
    stub('notifications.respond', { ...p, body: RespondInvitationBodySchema }),
  );

  return router;
}

export function createEmailPublicRouter(_deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  router.get('/unsubscribe', stub('email.unsubscribePreview', { query: UnsubscribeQuerySchema }));
  router.post('/unsubscribe', stub('email.unsubscribe', { query: UnsubscribeQuerySchema, body: UnsubscribeBodySchema }));
  router.post('/unsubscribe/survey', stub('email.unsubscribeSurvey', { body: UnsubscribeSurveyBodySchema }));
  return router;
}
