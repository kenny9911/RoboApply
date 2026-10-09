// server/src/features/auth-cn/routes.ts — STUB (FND-5). Owner: WP-11.
//
// Mounted by features/index.ts:
//   createPhoneAuthRouter()   at /api/v1/roboapply/auth/phone
//   createWechatAuthRouter()  at /api/v1/roboapply/auth/wechat
//   createAuthCnAdminRouter() at /api/v1/roboapply/admin/auth-cn (admin)
// Capability per route; handlers parse input and answer 501 until WP-11.

import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { seekerAuth } from '../../roboapply/engine/middleware/seekerAuth.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { requireFlag, type FlagKey } from '../../platform/flags.js';
import { markStub, NotImplementedError, parseBody, parseParams, parseQuery, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import {
  BindPhoneBodySchema,
  ChangePhoneBodySchema,
  CreateInvitesBodySchema,
  ListInvitesQuerySchema,
  SendCodeBodySchema,
  VerifyCodeBodySchema,
  WechatCallbackQuerySchema,
  WechatMiniLoginBodySchema,
  WechatStartQuerySchema,
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

export function createPhoneAuthRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const auth = [...(deps.seekerAuth ?? seekerAuth)];
  const otp = requireFlag('auth.phoneOtp', { env: deps.env });

  router.post('/send-code', otp, stub('authCn.sendCode', { body: SendCodeBodySchema }));
  router.post('/verify', otp, stub('authCn.verify', { body: VerifyCodeBodySchema }));
  router.post('/bind', ...auth, otp, stub('authCn.bind', { body: BindPhoneBodySchema }));
  router.post('/change', ...auth, otp, stub('authCn.change', { body: ChangePhoneBodySchema }));

  return router;
}

export function createWechatAuthRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const flag = (key: FlagKey) => requireFlag(key, { env: deps.env });

  router.get('/qr', flag('auth.wechatWeb'), stub('authCn.wechatQr', { query: WechatStartQuerySchema }));
  router.get('/callback', flag('auth.wechatWeb'), stub('authCn.wechatCallback', { query: WechatCallbackQuerySchema }));
  router.get('/mp/start', flag('auth.wechatInApp'), stub('authCn.wechatMpStart', { query: WechatStartQuerySchema }));
  router.get('/mp/callback', flag('auth.wechatInApp'), stub('authCn.wechatMpCallback', { query: WechatCallbackQuerySchema }));
  router.post('/mini/login', flag('auth.wechatMini'), stub('authCn.wechatMiniLogin', { body: WechatMiniLoginBodySchema }));

  return router;
}

export function createAuthCnAdminRouter(deps: FeatureRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];

  router.get('/invites', ...admin, stub('authCn.admin.listInvites', { query: ListInvitesQuerySchema }));
  router.post('/invites', ...admin, stub('authCn.admin.createInvites', { body: CreateInvitesBodySchema }));

  return router;
}
