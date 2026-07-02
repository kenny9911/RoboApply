# RoboApply Extraction — Engineering Plan

**Goal.** Split the candidate-facing **RoboApply** product out of the RoboHire
monorepo into its own repository and deploy it as an independent system on
**Vercel** (`roboapply.io`). The database stays **shared with RoboHire** (same
Neon Postgres) for now, with a clean path to a separate database later.

**Status.** ✅ First cut complete and building green (server `tsc`: 0 errors;
`next build`: success; `interview-agent` `tsc`: 0 errors; the exact Vercel build
command `prisma generate && tsc -p server && next build` exits 0; the Express
app boots and serves `/api/health`, gated routes return 401/404 as expected).

---

## 1. What RoboApply is, and what coupling had to be cut

RoboApply was three things inside RoboHire:

1. `roboapply/` — a Next.js 16 app (the candidate UI).
2. `backend/src/roboapply/**` + `backend/src/interview-engine/**` — Express
   routers mounted into the shared RoboHire API, plus a node-cron scheduler.
3. `interview-agent/` — a standalone LiveKit voice worker for mock interviews.

The frontend was already clean: it only calls `/api/v1/roboapply/*`,
`/api/v1/interview-engine/*`, and `/api/auth/*` (no recruiter endpoints). The
backend's coupling was the real work. A transitive-import analysis of the
RoboApply + interview-engine entrypoints produced a **363-file closure**, of
which **166 are auto-generated Prisma files** (regenerated, not copied). The
remaining **~197 first-party files** break down as:

| Area | Files | Notes |
|---|---:|---|
| `roboapply/**` | 93 | routers, V2, engine, agents, services, schedulers |
| `interview-engine/**` | 35 | mock-interview control plane |
| `lib/**` | 29 | LLM stack, billing, prisma, brand, region, cookies |
| `services/**` | 24 | LLM providers, Auth, Email, PDF, resume parsing |
| `agents/**` | 5 | BaseAgent + match/parse agents used by RA |
| `middleware/**` | 3 | auth, admin, usageMeter |
| `types/**`, `brands/**`, `utils/**` | 8 | shared types + brand config |

Crucially, the closure pulls in **no recruiter routes, CRM, agents-platform, or
agentic-operator code** — the existing RoboApply-V2 import boundary
(`check-roboapply-v2-boundary.mjs`) had already done most of the isolation. The
copy was done by a transitive-closure script (static + dynamic `import()` +
re-export resolution) so only reachable files came across.

---

## 2. Target architecture (single Vercel deployment)

Per the confirmed decision (all-in on Vercel serverless, mock-interview
included), the shape is:

```
                         roboapply.io (Vercel)
        ┌───────────────────────────────────────────────┐
        │  Next.js 16 app  (app/, components/, …)        │   ← pages, SSR
        │                                                │
        │  /api/v1/*  ──(vercel.json rewrite)──►  /api/index  │
        │        @vercel/node Serverless Function        │
        │        = export default <Express app>          │   ← the whole backend
        └───────────────────────────────────────────────┘
                 │ Prisma (pooled)          │ LiveKit dispatch
                 ▼                          ▼
          Neon Postgres              interview-agent worker
        (shared w/ RoboHire)      (Render/Railway — always-on)
```

**Why the Express app is mounted as one root `/api/index.ts` function** (not
ported to Next Route Handlers): it preserves the exact middleware ordering
(raw-body Stripe/LiveKit webhooks before `express.json()`), streams SSE/NDJSON
incrementally, and keeps the 193-file heavy-Node-dep graph out of Next's
bundler. `@vercel/node` invokes a default-exported Express app as `(req, res)`,
so the app runs byte-for-byte as it did in the monorepo. Vercel builds a
root-level `/api` directory even for a Next.js framework project; `vercel.json`
rewrites `/api/v1/:path*` → the function, and Next keeps owning every non-`/api`
route.

The backend is **pre-compiled to `server/dist` with `tsc`** during the Vercel
build, and `api/index.ts` imports the compiled `server/dist/app.js`. This
avoids gambling on esbuild resolving the generated Prisma client's `.js`→`.ts`
ESM import extensions, and keeps the function file trivial.

---

## 3. Serverless adaptations made

| Concern | Monorepo (always-on) | RoboApply on Vercel |
|---|---|---|
| **Process model** | `app.listen()` + long-lived | `api/index.ts` = `export default app`; `app.listen()` guarded behind `!process.env.VERCEL` |
| **Cron** | in-process `node-cron` (7 sweeps) | Vercel Cron → `GET /api/v1/cron/*` (`CRON_SECRET`-gated) in `server/src/cron/handlers.ts`; node-cron only runs off-Vercel |
| **Prisma pool** | `pg.Pool(max:10)` + 90s keepalive `setInterval` | `max: 1` and keepalive **off** when `VERCEL` is set (rely on Neon's pgbouncer) |
| **Rate-limit sweeper** | module-level `setInterval` | gated behind `!VERCEL` (per-instance map is ephemeral anyway) |
| **Stripe webhook** | shared recruiter `/api/v1/webhooks/stripe` (dispatch by `metadata.product`) | dedicated `/api/v1/roboapply/stripe/webhook` → `RoboApplyBillingService.handleRoboApplyStripeEvent` (raw-body carve-out preserved) |
| **Next middleware** | n/a | `proxy.ts` matcher excludes **all** `/api/*` so it never touches webhooks/SSE |
| **Function limits** | n/a | `vercel.json`: `maxDuration: 300`, `memory: 2048`, `includeFiles: server/dist/**`; enable Fluid Compute (Pro) |

Native-dep note: `pdf-to-img` is reached via `await import()` in a `try/catch`
OCR fallback (`PDFService.extractTextWithVision`). Early versions needed native
cairo `canvas` and were excluded via an ambient shim; `pdf-to-img` v6 instead
uses `pdfjs-dist` + `@napi-rs/canvas` (prebuilt per-platform Skia binaries, no
system libraries), which is serverless-safe, so it is now a normal root
dependency and the shim is gone. The binding is a literal `require` per
platform, so `@vercel/nft` traces the linux binary into the function bundle.

---

## 4. Repository layout

See the tree in [`README.md`](../README.md#layout). Key files created for the
split:

- `server/src/app.ts` — the slim Express app (mounts only roboapply + V2 +
  interview-engine + stripe-webhook + cron; keeps the CORS/raw-body/json chain).
- `server/src/cron/handlers.ts` — Vercel-Cron HTTP endpoints reusing the same
  sweep service functions the node-cron scheduler calls.
- `server/src/roboapply/routes/stripeWebhook.ts` — self-contained webhook.
- `server/src/types/pdf-parse.d.ts` — ambient decl the import-closure copier
  couldn't see. (`shims.d.ts` held a `pdf-to-img` shim until the package was
  installed for real; removed.)
- `api/index.ts` — Vercel function entry.
- `prisma.config.ts` (root) + `server/prisma/schema.prisma` (generates client to
  `server/src/generated/prisma`).
- `vercel.json` — rewrites + function config + 7 crons.
- Root `package.json` — merged frontend + backend deps; `build` mirrors the
  Vercel build; `postinstall: prisma generate`.

---

## 5. Environment & config

Full matrix in [`.env.example`](../.env.example). The essentials for a working
deploy: `DATABASE_URL` (pooled) + `DIRECT_DATABASE_URL`, `JWT_SECRET`,
`COOKIE_DOMAIN=.roboapply.io`, `CRON_SECRET`, at least one LLM key + `LLM_PROVIDER`,
`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`, LiveKit `LIVEKIT_*`, and S3/R2
creds. In production, **leave `NEXT_PUBLIC_API_URL` empty** so the browser calls
same-origin `/api/v1/*`.

Brand/DB resolution: the copied `lib/databaseUrl.ts` reads `DATABASE_URL_LIGHTARK`
only when `APP_NAME=gohire`; with `APP_NAME` unset it uses `DATABASE_URL`
directly — no action needed for RoboApply.

---

## 6. Known follow-ups (not blocking the build/deploy)

1. **Stripe webhook parity.** The new `/api/v1/roboapply/stripe/webhook`
   delegates to `handleRoboApplyStripeEvent`. Verify it covers every event the
   recruiter endpoint handled for `metadata.product==='roboapply'` (checkout,
   subscription.updated/deleted, invoice.paid/payment_failed) end-to-end with a
   Stripe CLI replay after deploy.
2. **Request audit / analytics.** The global `requestAudit` middleware
   (ApiRequestLog + per-request cost) was intentionally left in RoboHire. If
   RoboApply needs its own usage analytics, port `middleware/requestAudit.ts` +
   `requestClassification.ts` (small closure) and re-enable in `app.ts`.
3. **LLM settings DB layer.** `systemCredentials` / `llmStackConfigResolver`
   came along and default to env when the `SystemLLMKey`/`AppConfig` rows are
   absent — behaviour is byte-identical to pure-env, so it's safe. If the shared
   DB has RoboHire's rows, RoboApply will read them; decide whether to fork
   these rows at DB-split time.
4. **Prisma keepalive/pool on Fluid Compute.** `max:1` + no keepalive is the
   safe serverless default; tune upward if Fluid warm-instance reuse makes a
   small pool beneficial.
5. **OCR fallback.** ~~Re-enable `pdf-to-img` + `canvas` on a canvas-capable
   host~~ Done — `pdf-to-img` v6 is serverless-safe and installed (see §3).
6. **Cron duration.** Any sweep that can exceed 300s must page/batch its work
   (return early, let the next tick continue) — see `cron/handlers.ts`.

---

## 7. Database-split path (later)

The schema is copied wholesale, so the split is mechanical:

1. Provision a new Neon project; `DIRECT_DATABASE_URL` → new DB; `prisma db push`
   the current schema (or `prisma migrate diff` to seed migrations).
2. Copy the RoboApply-owned tables' data: `User` (candidate rows), all
   `Seeker*`, `RA*`, `RoboApply*`, `InterviewSession`, `MockInterviewCreditLedger`,
   `UsageDeductionLog` (sku in mock_interview/seeker_*), `SeekerSubscription`,
   `AppConfig`/`SystemLLMKey`/`UserLLMKey` (LLM settings), plus any FK-referenced
   rows. Because candidates and recruiters share one `User` table today, decide
   the ownership rule (e.g. `role in (seeker, candidate)`), or keep a read
   replica during transition.
3. Trim `server/prisma/schema.prisma` to the RoboApply-used models once the DB
   no longer holds recruiter tables (optional — unused models are harmless).
4. Cut `DATABASE_URL` over to the new DB; keep RoboHire on its own.

---

## 8. How this was validated

- `npm run build:server` (`tsc -p server`) → **0 errors**, emits `server/dist/app.js`.
- `next build` → **success**, all 23 app routes generated.
- `interview-agent` `tsc` → **0 errors**.
- Full `npm run build` (the Vercel command) → **exit 0**.
- Runtime boot: `node server/dist/app.js` serves `GET /api/health` → `{ok:true}`;
  `/api/v1/cron/*` → 401 without `CRON_SECRET`; `/api/v1/interview-engine/*` →
  401 (auth-gated, no crash). All 197 backend modules + generated Prisma client
  resolve at runtime (ESM), confirming the extraction is sound.

Not yet exercised (requires a real deploy + credentials): live Vercel function
cold-start with the pooled Neon URL, SSE/NDJSON streaming through `@vercel/node`,
the Stripe webhook signature round-trip, and a LiveKit mock-interview session.
These are the first things to smoke-test post-deploy (see §6).
