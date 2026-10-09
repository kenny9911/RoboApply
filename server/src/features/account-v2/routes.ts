// server/src/features/account-v2/routes.ts — STUB (FND-5). Owner: WP-79.
//
// Mounted by features/index.ts:
//   createTwoFactorRouter() at /api/v1/roboapply/account/2fa     (capability `totp`)
//   createStudentRouter()   at /api/v1/roboapply/account/student (capability `student`)

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireFlag } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  RegenerateRecoveryBodySchema,
  StudentEmailConfirmBodySchema,
  StudentEmailSendBodySchema,
  TotpDisableBodySchema,
  TotpVerifyBodySchema,
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

export function createTwoFactorRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('totp', { env: deps.env });

  router.get('/', ...auth, on, stub('twoFactor.status'));
  router.post('/enrol', ...auth, on, stub('twoFactor.enrol'));
  router.post('/verify', ...auth, on, stub('twoFactor.verify', { body: TotpVerifyBodySchema }));
  router.post('/disable', ...auth, on, stub('twoFactor.disable', { body: TotpDisableBodySchema }));
  router.post('/recovery-codes', ...auth, on, stub('twoFactor.recoveryCodes', { body: RegenerateRecoveryBodySchema }));

  return router;
}

export function createStudentRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const on = requireFlag('student', { env: deps.env });

  router.get('/', ...auth, on, stub('student.status'));
  router.post('/verify-email/send', ...auth, on, stub('student.sendCode', { body: StudentEmailSendBodySchema }));
  router.post('/verify-email/confirm', ...auth, on, stub('student.confirm', { body: StudentEmailConfirmBodySchema }));

  return router;
}
