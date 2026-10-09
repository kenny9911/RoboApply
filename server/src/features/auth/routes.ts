// server/src/features/auth/routes.ts — STUB (FND-5). Owner: WP-10.
//
// Two routers, mounted by features/index.ts AFTER the legacy routers:
//   createAuthRouter()    at /api/v1/roboapply/auth     (new paths only)
//   createAccountRouter() at /api/v1/roboapply/account  (new paths only)
// The legacy roboapply/routes/{auth,account}.ts keep signup, login, me,
// logout and the existing /account/* paths; nothing here shadows them.
// Handlers parse input and answer 501 not_implemented until WP-10 fills them.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag, type FlagKey } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  ForgotPasswordBodySchema,
  IdentityParamsSchema,
  OAuthCallbackQuerySchema,
  OAuthStartQuerySchema,
  RecordConsentBodySchema,
  ResetPasswordBodySchema,
  VerifyEmailQuerySchema,
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

/** New /auth paths (public unless noted). */
export function createAuthRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const flag = (key: FlagKey) => requireFlag(key, { env: deps.env });

  router.get('/methods', stub('auth.methods'));

  router.post('/password/forgot', flag('auth.passwordReset'), stub('auth.passwordForgot', { body: ForgotPasswordBodySchema }));
  router.post('/password/reset', flag('auth.passwordReset'), stub('auth.passwordReset', { body: ResetPasswordBodySchema }));

  router.post('/email/verify/send', ...auth, stub('auth.emailVerifySend'));
  router.get('/email/verify', stub('auth.emailVerify', { query: VerifyEmailQuerySchema }));

  router.get('/oauth/google/start', flag('auth.google'), stub('auth.googleStart', { query: OAuthStartQuerySchema }));
  router.get('/oauth/google/callback', flag('auth.google'), stub('auth.googleCallback', { query: OAuthCallbackQuerySchema }));
  router.get('/oauth/line/start', flag('auth.line'), stub('auth.lineStart', { query: OAuthStartQuerySchema }));
  router.get('/oauth/line/callback', flag('auth.line'), stub('auth.lineCallback', { query: OAuthCallbackQuerySchema }));

  return router;
}

/** New /account paths (seeker session). */
export function createAccountRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];

  router.get('/identities', ...auth, stub('account.identities'));
  router.delete('/identities/:id', ...auth, stub('account.unlinkIdentity', { params: IdentityParamsSchema }));
  router.get('/consents', ...auth, stub('account.consents'));
  router.post('/consents', ...auth, stub('account.recordConsent', { body: RecordConsentBodySchema }));

  return router;
}
