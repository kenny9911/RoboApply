// server/src/features/visitor/routes.ts — visitor assistant and logged-out job alerts (WP-78).
//
// Mounted by features/index.ts (public; no route requires a session):
//   createVisitorCopilotRouter() at /api/v1/public/copilot (capability `visitorAssistant`)
//     POST /                 one visitor turn, SSE (`meta`, `delta`, `tool`, `card`, `error`, `done`).
//                            Page-scoped public tools only (copilot.handleVisitorTurn, WP-50);
//                            every `job_list` card is re-checked against the public-page
//                            predicate (as the visitor feed) before it is sent;
//                            nothing is stored; 10/h + 30/day per IP (`visitorCopilotPerIp`).
//                            Both brands when the flag is on (default off on both).
//                            GoApply: the body carries `consent`, the version of the
//                            consent line the visitor ticked in the widget; without it
//                            422 consent_required, before the limiter and before any model.
//   createVisitorAlertsRouter() at /api/v1/public/alerts (capability `jobs.alerts`)
//     POST /                 sign up (double opt-in) → 202 pending_confirmation;
//                            501 provider_not_configured without an email transport
//     GET  /confirm?token=   what the link confirms (no change)
//     POST /confirm          confirm
//     POST /unsubscribe      one click. Behind the capability like every route here
//                            (on by default on both brands; GoApply with
//                            CN_RECRUITMENT_INFO_MODE=off → the whole router is off); the shared
//                            /unsubscribe/<token> page (WP-39b, /api/v1/public/email)
//                            takes the same token and is never switched off.

import { Router, type Request, type RequestHandler } from 'express';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { clampLocaleToBrand } from '../../platform/brand/registry.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import { emailOrigin, sendEmail } from '../../platform/email/EmailService.js';
import { isEnabled, requireFlag } from '../../platform/flags.js';
import { HttpError, fail, mapError, parseBody, parseQuery, route } from '../../platform/http.js';
import { clientIp, consumeRateLimit, rateLimit, rateLimitKey, type RateLimitDb } from '../../platform/ratelimit/index.js';
import { openSse } from '../../platform/sse.js';
import { getRequestLocale } from '../../roboapply/v2/lib/raLocale.js';
import type { FeatureRouterDeps } from '../index.js';
import { VisitorAlertsService, type VisitorAlertsDeps, type VisitorRate } from './alerts.js';
import {
  AnonAlertTokenQuerySchema,
  AnonAlertUnsubscribeBodySchema,
  ConfirmAnonAlertBodySchema,
  CreateAnonAlertBodySchema,
  VISITOR_CONSENT_VERSION,
  VISITOR_ERROR_CODES,
  VisitorTurnBodySchema,
  type VisitorTurnInput,
} from './contract.js';
import { createAnonAlertDigestTask, type AnonDigestDeps } from './digest.js';
import { alertConfirmTemplate, alertDigestTemplate } from './emails.js';
import { createPrismaVisitorAlertsRepo, prismaPublicJobIds } from './repo.js';
import type { CronTask } from '../../platform/queue/index.js';

function brandOf(req: Request): ProductBrand {
  return (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
}

// ── Visitor assistant ────────────────────────────────────────────────────

type TurnStream = AsyncIterable<{ event: string; data: unknown }>;
export type VisitorTurnFn = (input: VisitorTurnInput, options: { tools: 'public'; signal?: AbortSignal; locale?: string }) => Promise<TurnStream>;

const defaultTurn: VisitorTurnFn = async (input, options) => {
  // Lazy: the Assistant pulls the LLM stack; nothing loads it until a visitor asks.
  const { handleVisitorTurn } = await import('../copilot/index.js');
  return handleVisitorTurn(input, options);
};

export interface VisitorCopilotOptions {
  turn?: VisitorTurnFn;
  /** The ids among `ids` a public page may show now (default: the seo predicate, as the visitor feed uses). */
  stillPublic?: (ids: string[], brand: ProductBrand, now: Date) => Promise<Set<string>>;
  now?: () => Date;
  /** Replace the per-IP limiter (tests). */
  rateLimiter?: RequestHandler;
  rateDb?: RateLimitDb;
}

/**
 * GoApply AI needs the person's consent. A visitor has no account to hold a
 * grant, so the consent is the line ticked in the widget, sent with every
 * turn as its version (the pattern of the free tools, tools/service.ts). A
 * turn without the current version is refused here: it uses none of the
 * visitor's allowance and reaches no model. RoboApply passes through.
 */
export const requireVisitorConsent: RequestHandler = (req, res, next) => {
  if (brandOf(req).market !== 'cn') return next();
  const consent = (req.body as { consent?: unknown } | undefined)?.consent;
  if (consent !== VISITOR_CONSENT_VERSION) {
    fail(res, 'invalid_request', 'Tick the box to let the assistant answer with AI.', {
      reason: VISITOR_ERROR_CODES.consentRequired,
      consentVersion: VISITOR_CONSENT_VERSION,
    });
    return;
  }
  next();
};

type StillPublic = NonNullable<VisitorCopilotOptions['stillPublic']>;

/**
 * A visitor sees only what a public job page may show. `search_jobs` (public)
 * reads `feedService.publicList`, which applies the public-page predicate
 * itself since INT-05 (expiry and the current provider list are part of its
 * statement). Every `job_list` card is still re-checked here, exactly like the
 * visitor feed, as a second guard: items that fail are dropped, and a card
 * left empty is not sent. If the check itself fails, the card is dropped
 * (fail closed). Other cards pass unchanged.
 */
export async function publicCardOnly(card: unknown, brand: ProductBrand, now: Date, stillPublic: StillPublic): Promise<unknown | null> {
  const c = card as { type?: unknown; data?: unknown } | null;
  if (!c || c.type !== 'job_list') return card;
  const data = (c.data ?? {}) as { items?: unknown };
  const items = Array.isArray(data.items) ? data.items.filter((i): i is { jobId: string } => !!i && typeof (i as { jobId?: unknown }).jobId === 'string') : [];
  if (!items.length) return null;
  let allowed: Set<string>;
  try {
    allowed = await stillPublic([...new Set(items.map((i) => i.jobId))], brand, now);
  } catch {
    return null;
  }
  const kept = items.filter((i) => allowed.has(i.jobId));
  if (!kept.length) return null;
  return { ...c, data: { ...data, items: kept } };
}

export function createVisitorCopilotRouter(deps: FeatureRouterDeps & { visitorCopilot?: VisitorCopilotOptions } = {}): Router {
  const router = Router();
  const opts = deps.visitorCopilot ?? {};
  const turn = opts.turn ?? defaultTurn;
  const limiter = opts.rateLimiter ?? rateLimit({ name: 'visitorCopilotPerIp', by: 'ip', db: opts.rateDb });
  let stillPublic = opts.stillPublic ?? null;
  const checkPublic: StillPublic = (ids, brand, at) => (stillPublic ??= prismaPublicJobIds())(ids, brand, at);
  const now = opts.now ?? (() => new Date());

  router.post(
    '/',
    requireFlag('visitorAssistant', { env: deps.env }),
    requireVisitorConsent,
    limiter,
    route(async (req, res) => {
      // `consent` was checked above; the Assistant gets the turn only.
      const { consent: _consent, ...body } = parseBody(req, VisitorTurnBodySchema);
      const brand = brandOf(req);
      const locale = clampLocaleToBrand(brand, getRequestLocale(req));
      const controller = new AbortController();
      // Errors before the stream opens (daily budget → 503) answer as an envelope.
      const stream = await turn(body, { tools: 'public', signal: controller.signal, locale });
      const sse = openSse(req, res);
      const onAbort = () => controller.abort();
      sse.signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const e of stream) {
          if (sse.closed) break;
          if (e.event === 'card') {
            const card = await publicCardOnly(e.data, brand, now(), checkPublic);
            if (sse.closed) break;
            if (card) sse.send('card', card);
            continue;
          }
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
  return router;
}

// ── Logged-out job alerts ────────────────────────────────────────────────

/** Rate counters on RARateCounter (personal identifiers hashed in the key). */
export function platformVisitorRate(db?: RateLimitDb): VisitorRate {
  return {
    async consume(name, scope, id, windows) {
      const r = await consumeRateLimit({ key: rateLimitKey(name, scope, id), windows, db });
      return { allowed: r.allowed, retryAfterSec: r.retryAfterSec };
    },
  };
}

export function defaultVisitorAlertsDeps(): VisitorAlertsDeps {
  return {
    repo: createPrismaVisitorAlertsRepo(),
    rate: platformVisitorRate(),
    sendConfirm: ({ brand, to, locale, params }) => sendEmail({ template: alertConfirmTemplate, to, locale, params, brand }),
    origin: (brand) => emailOrigin(brand),
  };
}

export function createVisitorAlertsRouter(deps: FeatureRouterDeps & { visitorAlerts?: VisitorAlertsService } = {}): Router {
  const router = Router();
  const on = requireFlag('jobs.alerts', { env: deps.env });
  let service = deps.visitorAlerts ?? null;
  const svc = () => (service ??= new VisitorAlertsService(defaultVisitorAlertsDeps()));

  router.post(
    '/',
    on,
    route(
      async (req) => {
        const body = parseBody(req, CreateAnonAlertBodySchema);
        // No email transport on this deployment → no signup: a confirm link could never arrive.
        if (!(await isEnabled('notify.email', { brand: brandOf(req), env: deps.env }))) {
          throw new HttpError('provider_not_configured', 'Email is not set up here, so alerts cannot be confirmed.');
        }
        return svc().create({ email: body.email, filters: body.filters, frequency: body.frequency, locale: body.locale }, { brand: brandOf(req), ip: clientIp(req) });
      },
      { status: 202 },
    ),
  );

  router.get(
    '/confirm',
    on,
    route(async (req, res) => {
      const { token } = parseQuery(req, AnonAlertTokenQuerySchema);
      res.setHeader('Cache-Control', 'no-store');
      return svc().preview(token, brandOf(req));
    }),
  );

  router.post(
    '/confirm',
    on,
    route(async (req) => {
      const { token } = parseBody(req, ConfirmAnonAlertBodySchema);
      return svc().confirm(token, brandOf(req));
    }),
  );

  router.post(
    '/unsubscribe',
    on,
    route(async (req) => {
      const { token } = parseBody(req, AnonAlertUnsubscribeBodySchema);
      return svc().unsubscribe(token, brandOf(req));
    }),
  );

  return router;
}

// ── Digest cron task ─────────────────────────────────────────────────────

export function defaultAnonDigestDeps(): AnonDigestDeps {
  return {
    repo: createPrismaVisitorAlertsRepo(),
    alertsEnabled: (brand) => isEnabled('jobs.alerts', { brand }),
    send: ({ brand, to, locale, params }) => sendEmail({ template: alertDigestTemplate, to, locale, params, brand }),
    origin: (brand) => emailOrigin(brand),
  };
}

/** `job-alerts` cron task for logged-out alerts (INT wires it; see digest.ts). */
export const runAnonAlertDigests: CronTask = (ctx) => createAnonAlertDigestTask(defaultAnonDigestDeps())(ctx);
