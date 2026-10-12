// server/src/app.ts
//
// RoboApply standalone API — the Express app.
//
// This is the slim, candidate-facing slice of the former RoboHire backend:
// only the roboapply/* routers, the roboapply V2 router, the Interview Engine
// router, a self-contained RoboApply Stripe webhook, and the Vercel-Cron HTTP
// endpoints. It shares the same Neon database as RoboHire (for now) via the
// same Prisma schema.
//
// Two run modes:
//   • Local dev / any Node host — `import './app.js'` (or run this file with
//     tsx) starts an HTTP listener on PORT (default 4607) and, unless
//     ROBOAPPLY_CRON_DISABLED, registers the in-process node-cron sweeps.
//     SIGTERM / SIGINT drain running requests before the process exits
//     (roboapply/schedulers/processLifecycle.ts).
//   • Vercel serverless — `api/index.ts` imports the compiled `app` and
//     `export default app`s it. `process.env.VERCEL` is set there, so we do
//     NOT call app.listen() and we do NOT register node-cron (Vercel Cron
//     hits the /api/v1/cron/* endpoints instead — see cron/handlers.ts).

import dotenv from 'dotenv';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// BigInt JSON serializer shim — the User model carries BigInt columns
// (storageBytesUsed, customMaxStorageBytes) and JSON.stringify throws on
// BigInt by default. Emitting the decimal string keeps the wire format stable.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return (this as unknown as bigint).toString();
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local dev loads the repo-root .env / .env.local. On Vercel the platform
// injects env vars directly, so we skip file loading there.
if (!process.env.VERCEL) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: false });
  dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), override: false });
}

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import roboapplyAuthRouter from './roboapply/routes/auth.js';
import roboapplyBillingRouter from './roboapply/routes/billing.js';
import roboapplyAccountRouter from './roboapply/routes/account.js';
import roboapplyV2Router from './roboapply/v2/routes/index.js';
import interviewEngineRouter from './interview-engine/routes/index.js';
import stripeWebhookRouter from './roboapply/routes/stripeWebhook.js';
import cronRouter from './cron/handlers.js';
import { startRoboApplyCron, stopRoboApplyCron } from './roboapply/schedulers/RoboApplyCronService.js';
import { installGracefulShutdown, trustProxySetting } from './roboapply/schedulers/processLifecycle.js';
import { logger } from './services/LoggerService.js';
import { createJobSearchRouters } from './job-search/routes.js';
import { handleJobSearchBodyError } from './job-search/request-errors.js';
import { trackFeatureActivity } from './middleware/userActivity.js';
import { brandContext } from './platform/brand/brandContext.js';
import { corsOrigins } from './platform/brand/runtime.js';
import brandPublicRouter from './features/brand/routes.js';
import { mountFeatures } from './features/index.js';
// Side effect: registers every area's queue workers (queue-drain cron + kickDrain).
import './platform/queue/registry.js';
import { runStartupAssertions } from './platform/startup.js';

// ─── Startup assertions ─────────────────────────────────────────────────
// Residency (WP-15): a misconfigured mainland deployment refuses to boot.
// Assistant tool support (WP-14): report-only until WP-50 ships.
runStartupAssertions({ log: logger });

const app = express();

// Behind Vercel's edge proxy (and any Node host fronted by one), the real
// client IP arrives in `x-forwarded-for`; without this Express reports the
// proxy's constant socket address for EVERY request, so the IP-keyed auth
// rate limiter (middleware/auth.ts `rateLimit`) bucketed all users together
// and could 429 legitimate logins under concurrency. Trusting the proxy makes
// `req.ip` the actual client address so the limiter is per-user again.
//
// How much is trusted is per deployment (`trustProxySetting`): `TRUST_PROXY`
// when set; otherwise `true` on Vercel (unchanged) and one hop everywhere
// else — the mainland gateway and `next dev` each put exactly one proxy in
// front of this process, so only the entry that proxy wrote is believed.
app.set('trust proxy', trustProxySetting());

// ─── CORS ───────────────────────────────────────────────────────────────
// Same-origin in production (the Next.js app and this API share each brand's
// host via a Vercel rewrite), but we still allowlist every registry host of
// the brands this deployment serves, NEXT_PUBLIC_ROBOAPPLY_URL, FRONTEND_URLS
// and this deployment's own Vercel hosts. There is no built-in preview
// pattern: other preview origins are allowed only through CORS_PREVIEW_HOSTS
// (explicit opt-in; a bare `*.vercel.app` is refused). Dev allows localhost /
// goapply.localhost on the dev ports. Built from the brand registry
// (platform/brand/runtime.ts).
app.use(
  cors({
    origin: corsOrigins(),
    credentials: true,
  }),
);

// ─── Raw-body webhooks (MUST precede express.json) ──────────────────────
// Stripe + LiveKit + Parley need the untouched request Buffer for signature
// verification. Do not reorder these below express.json().
app.use('/api/v1/roboapply/stripe/webhook', express.raw({ type: 'application/json' }));
app.use('/api/v1/interview-engine/webhooks/livekit', express.raw({ type: '*/*' }));
app.use('/api/v1/interview-engine/webhooks/parley', express.raw({ type: '*/*', limit: '10mb' }));
// Feature webhooks (WeChat Pay v3 notify signs the raw bytes; the WeChat MP
// server endpoint sends XML). Every /api/v1/webhooks/* handler receives the
// untouched Buffer (features/index.ts mounts them).
app.use('/api/v1/webhooks', express.raw({ type: '*/*', limit: '1mb' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Lightweight request id (the recruiter backend's full request-audit
// middleware is intentionally left behind — it's an analytics concern).
app.use((req, _res, next) => {
  (req as express.Request & { requestId?: string }).requestId = crypto.randomUUID();
  next();
});

// ─── Brand + request context ────────────────────────────────────────────
// Resolves the product brand from the Host (platform/brand/runtime.ts),
// refuses brands this deployment does not serve, stamps `X-RA-Brand`, and
// enters the AsyncLocalStorage request context (which is what makes
// setCurrentUserId / BYOK / per-user log lines work). Must stay after
// cookieParser (dev override cookie) and the request id, before every router.
app.use(brandContext);

// ─── Health ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'roboapply-api' }));
app.get('/api/v1/health', (_req, res) => res.json({ ok: true, service: 'roboapply-api' }));

// ─── Routes ─────────────────────────────────────────────────────────────
app.use(trackFeatureActivity);
// Stripe webhook first so its sub-path isn't shadowed by the billing router.
app.use('/api/v1/roboapply/stripe/webhook', stripeWebhookRouter);

// Public brand + capabilities for the requesting host (no auth).
app.use('/api/v1/public/brand', brandPublicRouter);

app.use('/api/v1/roboapply/auth', roboapplyAuthRouter);
// The V1 auto-apply routers (/missions, /runs, /digest, /settings) were
// removed in WP-75 (ARCH §10.6 step 3): nothing calls them since the V1
// engine was retired, and /settings duplicated /account's delete route.
app.use('/api/v1/roboapply/billing', roboapplyBillingRouter);
app.use('/api/v1/roboapply/account', roboapplyAccountRouter);
app.use('/api/v1/roboapply/v2', roboapplyV2Router);

// The job-search API serves both brands, each with its own sources (D5):
// RoboApply searches its providers, GoApply searches its own market cn index.
// Both routers answer 404 feature_disabled when the brand's `jobs.feed`
// capability is off (CN_RECRUITMENT_INFO_MODE=off), before any key or session
// lookup. A key works only on its owner's brand host (job-search/routes.ts).
const jobSearchRouters = createJobSearchRouters();
app.use('/api/v1/job-search', jobSearchRouters.api);
app.use('/api/v1/roboapply/v2/job-search', jobSearchRouters.website);

app.use('/api/v1/interview-engine', interviewEngineRouter);

// Vercel Cron HTTP endpoints (CRON_SECRET-gated). See cron/handlers.ts.
app.use('/api/v1/cron', cronRouter);

// ─── Feature areas (Jobright clone) ─────────────────────────────────────
// Mounted ONCE and AFTER every legacy router above, so live legacy paths
// keep precedence; feature routers declare only new paths and check their
// capability per route. See features/index.ts (FEATURE_MOUNTS).
mountFeatures(app);

app.get('/', (_req, res) => {
  res.json({ name: 'RoboApply API', version: '1.0.0' });
});

// ─── Error handler ──────────────────────────────────────────────────────
app.use(
  (err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (handleJobSearchBodyError(err, req, res)) return;
    const requestId = (req as express.Request & { requestId?: string }).requestId;
    logger.error(
      'SERVER',
      'Unhandled error',
      { error: err.message, stack: err.stack, path: req.path, method: req.method },
      requestId,
    );
    if (res.headersSent) return;
    res.status(500).json({
      success: false,
      code: 'internal_error',
      error: 'An unexpected error occurred. Please try again.',
      ...(requestId ? { requestId } : {}),
    });
  },
);

// ─── Local / non-Vercel process bootstrap ───────────────────────────────
if (!process.env.VERCEL) {
  // In-process node-cron sweeps (billing, purge, interview cleanup, platform). On Vercel
  // these run as Vercel Cron → /api/v1/cron/* instead.
  try {
    startRoboApplyCron();
  } catch (err) {
    logger.warn('SERVER', 'RoboApply cron init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const port = Number(process.env.PORT || 4607);
  const server = app.listen(port, () => {
    logger.info('SERVER', `RoboApply API listening on http://localhost:${port}`);
    // eslint-disable-next-line no-console
    console.log(`\n🚀 RoboApply API on http://localhost:${port}\n`);
  });

  // Rolling updates (mainland pods, any Node host) send SIGTERM: stop the
  // cron mirror, stop accepting connections, let running requests finish,
  // then close the database pool and exit. See processLifecycle.ts.
  installGracefulShutdown({
    server,
    stopBackground: stopRoboApplyCron,
    afterDrain: async () => {
      const { default: prisma } = await import('./lib/prisma.js');
      await prisma.$disconnect();
    },
    log: {
      info: (message, meta) => logger.info('SERVER', message, meta),
      warn: (message, meta) => logger.warn('SERVER', message, meta),
    },
  });
}

export default app;
