// server/src/features/tw/routes.ts — Taiwan routes of the international brand
// (MKT-5F; MARKET_STRATEGY §9.5 JT-6, JT-7). Mounted by features/index.ts;
// the web calls them through lib/api/tw.ts.
//
//   createTwRouter()        at /api/v1/roboapply/tw (public: no session needed,
//                           so the note also works on a public job page)
//     GET /pay-rule         → TwPayRuleView | null   (at most 5 minutes behind an edit)
//                           The pay-disclosure rule for the note "Why is pay
//                           not listed?": the statutory amount, the provision,
//                           the link and the day it was read, from AppConfig
//                           `tw.payRule.v1`; the law as read on 2026-10-11
//                           when no admin has stored one; null when a stored
//                           value cannot be read as a rule. The route is open,
//                           so the row is read at most once a minute in each
//                           process (payRule.ts `TwPayRuleHold`), and the
//                           caller may keep the answer four more minutes.
//     GET /districts        → TwDistrictsResponse    (Cache-Control: 1 day)
//                           The 22 counties with their districts, for the
//                           district filter. Names are data, not copy.
//   createTwAdminRouter()   at /api/v1/roboapply/admin/tw (admin)
//     GET /pay-rule         → TwPayRuleAdminView
//     PUT /pay-rule         PutTwPayRuleBody → TwPayRuleAdminView
//                           422 invalid_request with one issue per field for an
//                           entry that breaks a rule; one admin audit row
//                           (`admin_tw_pay_rule_updated`) per save.
//
// Every route answers 404 feature_disabled on GoApply: the rule and the
// district table belong to the Taiwan market of the international brand.
//
// Handlers are thin: the rule lives in payRule.ts, the table in districts.ts.

import { Router, type Request, type RequestHandler } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/admin.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/index.js';
import { HttpError, fail, parseBody, requireUserId, route } from '../../platform/http.js';
import type { FeatureRouterDeps } from '../index.js';
import { logger } from '../../services/LoggerService.js';
import { PutTwPayRuleBodySchema, TW_PAY_RULE_CONFIG_KEY, type TwDistrictsResponse, type TwPayRuleAdminView, type TwPayRuleView } from './contract.js';
import { twDistrictsResponse } from './districts.js';
import {
  TW_PAY_RULE_CALLER_MAX_AGE_S,
  TwPayRuleValidationError,
  adminTwPayRule,
  publicTwPayRule,
  readTwPayRule,
  saveTwPayRule,
  twPayRuleHold,
  type TwPayRuleDb,
  type TwPayRuleHold,
} from './payRule.js';

/**
 * The note may be 5 minutes behind an admin's edit, never longer: the process
 * keeps one read for a minute (`TW_PAY_RULE_HOLD_MS`), so the caller may keep
 * the answer for the four minutes that are left.
 */
export const TW_PAY_RULE_CACHE_CONTROL = `public, max-age=${TW_PAY_RULE_CALLER_MAX_AGE_S}`;
/** The district table changes only with a deploy. */
export const TW_DISTRICTS_CACHE_CONTROL = 'public, max-age=86400';
/** RAAdminAuditLog.eventType of a pay-rule save. */
export const TW_PAY_RULE_AUDIT_EVENT = 'admin_tw_pay_rule_updated';

/** What the admin router writes to the admin audit log (features/admin `writeAdminAudit`; loaded on first use). */
export interface TwAudit {
  write(input: { adminId: string; subjectUserId: string | null; eventType: string; payload: Record<string, unknown> }): Promise<unknown>;
}

export interface TwRouterDeps extends FeatureRouterDeps {
  /** Test seam; defaults to the process-wide Prisma client. */
  db?: TwPayRuleDb;
  now?: () => Date;
  /** Test seam for the audit row. */
  audit?: TwAudit;
  /**
   * The in-process hold of the rule that the public GET reads through and a
   * save clears. Defaults to the process's own (`twPayRuleHold`), which the
   * two routers share; a test passes one of its own to both.
   */
  payRuleHold?: TwPayRuleHold;
}

/** RoboApply (market intl) only; GoApply answers 404 feature_disabled. */
const intlOnly: RequestHandler = (_req, res, next) => {
  if (getCurrentBrandOrDefault().market !== 'intl') {
    fail(res, 'feature_disabled', 'Not available here.');
    return;
  }
  next();
};

async function defaultDb(): Promise<TwPayRuleDb> {
  return (await import('../../lib/prisma.js')).default;
}

async function defaultAudit(): Promise<TwAudit> {
  const admin = await import('../admin/index.js');
  const store = admin.createPrismaAuditStore();
  return { write: (input) => admin.writeAdminAudit(store, input) };
}

export function createTwRouter(deps: TwRouterDeps = {}): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const db = async () => deps.db ?? (await defaultDb());
  const hold = deps.payRuleHold ?? twPayRuleHold;

  router.get(
    '/pay-rule',
    intlOnly,
    route(async (_req, res): Promise<TwPayRuleView | null> => {
      // Open to everyone: one read a minute in this process, however many requests arrive.
      const at = now();
      const view = publicTwPayRule(await hold.read(async () => readTwPayRule(await db(), at), at));
      res.setHeader('Cache-Control', TW_PAY_RULE_CACHE_CONTROL);
      return view;
    }),
  );

  router.get(
    '/districts',
    intlOnly,
    route(async (_req, res): Promise<TwDistrictsResponse> => {
      res.setHeader('Cache-Control', TW_DISTRICTS_CACHE_CONTROL);
      return twDistrictsResponse();
    }),
  );

  return router;
}

function adminIdOf(req: Request): string {
  return requireUserId(req);
}

export function createTwAdminRouter(deps: TwRouterDeps = {}): Router {
  const router = Router();
  const admin = [...(deps.adminAuth ?? [requireAuth, requireAdmin])];
  const now = deps.now ?? (() => new Date());
  const db = async () => deps.db ?? (await defaultDb());
  const audit = async () => deps.audit ?? (await defaultAudit());
  const hold = deps.payRuleHold ?? twPayRuleHold;

  router.get(
    '/pay-rule',
    ...admin,
    intlOnly,
    route(async (_req, res): Promise<TwPayRuleAdminView> => {
      res.setHeader('Cache-Control', 'no-store');
      return adminTwPayRule(await readTwPayRule(await db(), now()));
    }),
  );

  router.put(
    '/pay-rule',
    ...admin,
    intlOnly,
    route(async (req, res): Promise<TwPayRuleAdminView> => {
      const adminId = adminIdOf(req);
      const body = parseBody(req, PutTwPayRuleBodySchema);
      const store = await db();
      const at = now();
      const before = await readTwPayRule(store, at);
      let saved;
      try {
        saved = await saveTwPayRule(store, body, adminId, at);
      } catch (err) {
        if (err instanceof TwPayRuleValidationError) {
          throw new HttpError('invalid_request', 'The pay rule is not valid.', { where: 'body', issues: err.issues.map((i) => ({ path: [i.path], code: 'custom', message: i.message })) });
        }
        throw err;
      }
      // The public route of this process answers the new rule at once (another process within a minute).
      hold.clear();
      // One audit row per save: who changed the amount people are told, from what to what. An audit failure
      // never undoes the save it records (features/admin `writeAdminAudit` already logs and swallows its own).
      try {
        await (await audit()).write({
          adminId,
          subjectUserId: null,
          eventType: TW_PAY_RULE_AUDIT_EVENT,
          payload: {
            key: TW_PAY_RULE_CONFIG_KEY,
            from: before.rule ? { thresholdTwd: before.rule.thresholdTwd, asOf: before.rule.asOf, stored: before.stored } : { stored: before.stored },
            to: { thresholdTwd: saved.thresholdTwd, lawLabel: saved.lawLabel, sourceUrl: saved.sourceUrl, asOf: saved.asOf },
          },
        });
      } catch (err) {
        logger.error('TW', 'pay rule saved, audit row not written', { adminId, error: err instanceof Error ? err.message : String(err) });
      }
      res.setHeader('Cache-Control', 'no-store');
      return adminTwPayRule({ stored: 'config', rule: saved });
    }),
  );

  return router;
}
