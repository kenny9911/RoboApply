# RoboApply Extraction — Task Plan (execution loop)

Legend: ✅ done in this first cut · ⏳ next · ⬜ later / needs deploy or creds.

## Phase 0 — Analysis ✅
- ✅ Map frontend API coupling (only `/api/v1/roboapply/*`, `/interview-engine/*`, `/api/auth/*`).
- ✅ Compute the transitive backend import closure (363 files; 166 generated Prisma; ~197 first-party).
- ✅ Confirm no recruiter/CRM/agents-platform bleed-in.
- ✅ Enumerate background timers (cron, prisma keepalive, rate-limit sweeper) + env vars.
- ✅ Lock the Vercel deploy topology (root `/api/index.ts` Express function + rewrites + Vercel Cron).

## Phase 1 — Scaffold the repo ✅
- ✅ Create `/Users/kenny/code/RoboApply`, `git init`.
- ✅ Copy the Next.js frontend to the repo root (minus node_modules/.next/.env.local).
- ✅ Copy `interview-agent/` voice worker.
- ✅ Copy the backend closure into `server/src/**` (transitive-closure script).
- ✅ Copy `schema.prisma` → `server/prisma/`; copy generated client; wire `prisma.config.ts`.

## Phase 2 — Wire the standalone server ✅
- ✅ `server/src/app.ts` — Express app (CORS, raw-body webhooks, roboapply + V2 + interview-engine + cron mounts; `listen` only off-Vercel).
- ✅ `server/src/cron/handlers.ts` — Vercel-Cron HTTP endpoints (`CRON_SECRET`-gated).
- ✅ `server/src/roboapply/routes/stripeWebhook.ts` — self-contained RoboApply Stripe webhook.
- ✅ `api/index.ts` — `export default app` (imports compiled `server/dist/app.js`).
- ✅ Serverless Prisma guards (`max:1`, keepalive off on Vercel); gate rate-limit `setInterval`.
- ✅ Ambient shims: `pdf-to-img` (excluded native `canvas`) + copy `pdf-parse.d.ts`.
- ✅ Merged root `package.json` (frontend + backend deps); `vercel.json` (rewrites + function + 7 crons).
- ✅ `next.config` dev proxy retained; `proxy.ts` matcher excludes all `/api/*`; root `tsconfig` excludes `server/interview-agent/api`.

## Phase 3 — Build & fix loop ✅
- ✅ `npm install` (+ `prisma generate` postinstall).
- ✅ `tsc -p server` — fixed 206 → 0 (root cause: `@types/passport` for `req.user` + `"types"` restriction removed + `pdf-parse.d.ts`).
- ✅ `next build` — success out of the box.
- ✅ `interview-agent` `tsc` — success.
- ✅ Full `npm run build` (the Vercel command) — exit 0.
- ✅ Runtime boot smoke test (`/api/health` 200; cron 401; interview-engine 401).

## Phase 4 — Repo delivery ✅
- ✅ `README.md`, `docs/ENGINEERING_PLAN.md`, `docs/TASK_PLAN.md`, `.env.example`.
- ✅ `git init` + first commit + push to `github.com/kenny9911/RoboApply`.

## Phase 5 — Deploy to Vercel ⬜ (needs your Vercel account + secrets)
- ⬜ Import repo into Vercel (Next.js preset auto-detected).
- ⬜ Enable Fluid Compute; confirm Pro plan (5+ sub-daily crons + 300s functions).
- ⬜ Set env vars (`.env.example`); leave `NEXT_PUBLIC_API_URL` empty in prod.
- ⬜ Add domain `roboapply.io`; set `COOKIE_DOMAIN=.roboapply.io`.
- ⬜ Deploy the interview-agent voice worker to an always-on host (Render/Railway/Fly) with LiveKit creds.
- ⬜ Point a Stripe webhook endpoint at `/api/v1/roboapply/stripe/webhook`.

## Phase 6 — Post-deploy verification ⬜
- ⬜ Cold-start + a Prisma-backed read against the pooled Neon URL.
- ⬜ One SSE chat stream + one NDJSON onboarding stream (confirm incremental flush).
- ⬜ Stripe webhook signature round-trip (`stripe listen`/replay).
- ⬜ One LiveKit mock-interview session end-to-end (worker reachable, room greets).
- ⬜ Trigger one cron endpoint with `Authorization: Bearer $CRON_SECRET`.

## Phase 7 — Follow-ups (see ENGINEERING_PLAN §6) ⬜
- ⬜ Verify Stripe event parity vs the old shared endpoint.
- ⬜ (Optional) Port `requestAudit` + `requestClassification` for RoboApply usage analytics.
- ✅ Re-enable `pdf-to-img` OCR — v6 no longer needs native cairo `canvas` (uses `pdfjs-dist` + prebuilt `@napi-rs/canvas`), so it's installed in the root deps and the ambient shim is removed.
- ⬜ Decide LLM-settings (`SystemLLMKey`/`AppConfig`) ownership at DB-split time.

## Phase 8 — Database split ⬜ (see ENGINEERING_PLAN §7)
- ⬜ Provision a new Neon project; `prisma db push`.
- ⬜ Migrate RoboApply-owned rows (`User` candidates, `Seeker*`, `RA*`, `RoboApply*`, `InterviewSession`, credits, subscriptions, LLM settings).
- ⬜ Cut `DATABASE_URL` over; trim schema to RoboApply models (optional).
