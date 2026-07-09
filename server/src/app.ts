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
import roboapplyMissionsRouter from './roboapply/routes/missions.js';
import roboapplyRunsRouter from './roboapply/routes/runs.js';
import roboapplyDigestRouter from './roboapply/routes/digest.js';
import roboapplySettingsRouter from './roboapply/routes/settings.js';
import roboapplyBillingRouter from './roboapply/routes/billing.js';
import roboapplyAccountRouter from './roboapply/routes/account.js';
import roboapplyV2Router from './roboapply/v2/routes/index.js';
import interviewEngineRouter from './interview-engine/routes/index.js';
import stripeWebhookRouter from './roboapply/routes/stripeWebhook.js';
import cronRouter from './cron/handlers.js';
import { startRoboApplyCron } from './roboapply/schedulers/RoboApplyCronService.js';
import { logger } from './services/LoggerService.js';

const app = express();

// Behind Vercel's edge proxy (and any Node host fronted by one), the real
// client IP arrives in `x-forwarded-for`; without this Express reports the
// proxy's constant socket address for EVERY request, so the IP-keyed auth
// rate limiter (middleware/auth.ts `rateLimit`) bucketed all users together
// and could 429 legitimate logins under concurrency. Trusting the proxy makes
// `req.ip` the actual client address so the limiter is per-user again.
app.set('trust proxy', true);

// ─── CORS ───────────────────────────────────────────────────────────────
// Same-origin in production (the Next.js app and this API share roboapply.io
// via a Vercel rewrite), but we still allowlist the apex + api subdomain and
// local dev origins for direct/cross-origin calls.
const frontendUrlsFromEnv = (process.env.FRONTEND_URLS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const productionOrigins: (string | RegExp)[] = [
  process.env.NEXT_PUBLIC_ROBOAPPLY_URL || 'https://roboapply.io',
  'https://roboapply.io',
  'https://www.roboapply.io',
  'https://api.roboapply.io',
  ...frontendUrlsFromEnv,
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/i,
];

app.use(
  cors({
    origin:
      process.env.NODE_ENV === 'production'
        ? productionOrigins
        : ['http://localhost:3611', 'http://localhost:3000'],
    credentials: true,
  }),
);

// ─── Raw-body webhooks (MUST precede express.json) ──────────────────────
// Stripe + LiveKit need the untouched request Buffer for signature
// verification. Do not reorder these below express.json().
app.use('/api/v1/roboapply/stripe/webhook', express.raw({ type: 'application/json' }));
app.use('/api/v1/interview-engine/webhooks/livekit', express.raw({ type: '*/*' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Lightweight request id (the recruiter backend's full request-audit
// middleware is intentionally left behind — it's an analytics concern).
app.use((req, _res, next) => {
  (req as express.Request & { requestId?: string }).requestId = crypto.randomUUID();
  next();
});

// ─── Health ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'roboapply-api' }));
app.get('/api/v1/health', (_req, res) => res.json({ ok: true, service: 'roboapply-api' }));

// ─── Routes ─────────────────────────────────────────────────────────────
// Stripe webhook first so its sub-path isn't shadowed by the billing router.
app.use('/api/v1/roboapply/stripe/webhook', stripeWebhookRouter);

app.use('/api/v1/roboapply/auth', roboapplyAuthRouter);
app.use('/api/v1/roboapply/missions', roboapplyMissionsRouter);
app.use('/api/v1/roboapply/runs', roboapplyRunsRouter);
app.use('/api/v1/roboapply/digest', roboapplyDigestRouter);
app.use('/api/v1/roboapply/settings', roboapplySettingsRouter);
app.use('/api/v1/roboapply/billing', roboapplyBillingRouter);
app.use('/api/v1/roboapply/account', roboapplyAccountRouter);
app.use('/api/v1/roboapply/v2', roboapplyV2Router);

app.use('/api/v1/interview-engine', interviewEngineRouter);

// Vercel Cron HTTP endpoints (CRON_SECRET-gated). See cron/handlers.ts.
app.use('/api/v1/cron', cronRouter);

app.get('/', (_req, res) => {
  res.json({ name: 'RoboApply API', version: '1.0.0' });
});

// ─── Error handler ──────────────────────────────────────────────────────
app.use(
  (err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
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
  // In-process node-cron sweeps (matcher/digest/submitter/etc.). On Vercel
  // these run as Vercel Cron → /api/v1/cron/* instead.
  try {
    startRoboApplyCron();
  } catch (err) {
    logger.warn('SERVER', 'RoboApply cron init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const port = Number(process.env.PORT || 4607);
  app.listen(port, () => {
    logger.info('SERVER', `RoboApply API listening on http://localhost:${port}`);
    // eslint-disable-next-line no-console
    console.log(`\n🚀 RoboApply API on http://localhost:${port}\n`);
  });
}

export default app;
