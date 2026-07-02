# RoboApply

AI candidate-facing job-application app — **extracted from the RoboHire monorepo into a standalone, Vercel-deployable system.**

- **Frontend** — Next.js 16 (App Router) at the repo root → deploys to Vercel (`roboapply.io`).
- **API** — the Express (TypeScript, ESM) backend under [`server/`](server/), served on Vercel as a single Serverless Function via [`api/index.ts`](api/index.ts) (`export default app`).
- **Voice worker** — [`interview-agent/`](interview-agent/) LiveKit voice worker for mock interviews (a separate always-on process; **cannot** run on Vercel serverless — host it on Render/Railway/Fly).
- **Database** — Prisma + Neon Postgres, **currently shared with RoboHire** (see [`docs/ENGINEERING_PLAN.md`](docs/ENGINEERING_PLAN.md) for the DB-split path).

See [`docs/ENGINEERING_PLAN.md`](docs/ENGINEERING_PLAN.md) for architecture & rationale and [`docs/TASK_PLAN.md`](docs/TASK_PLAN.md) for the phased execution checklist.

## Quick start

```bash
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET, LLM keys, …
npm install                   # installs deps + runs `prisma generate`
npm run dev                   # Express API :4607  +  Next.js :3611 (concurrently)
```

Open http://localhost:3611. The Next dev server proxies `/api/*` → the local Express API (`NEXT_PUBLIC_API_URL`).

To also run the mock-interview voice worker:

```bash
cd interview-agent && cp .env.example .env.local   # LiveKit creds
npm install && npm run dev
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Express API + Next.js together (dev) |
| `npm run dev:server` | Express API only (`tsx watch`) |
| `npm run dev:web` | Next.js only (:3611) |
| `npm run build` | **The exact Vercel build**: `prisma generate && tsc -p server && next build` |
| `npm run build:server` | Compile the Express backend to `server/dist` |
| `npm run typecheck:server` | Type-check the backend (no emit) |
| `npm run db:push` | Push the Prisma schema (uses `DIRECT_DATABASE_URL`) |
| `npm run test` | Frontend vitest |

## Layout

```
.                       Next.js app (app/, components/, hooks/, lib/, i18n/, …)
├─ api/index.ts         Vercel function entry → re-exports the Express app
├─ server/              Standalone Express backend
│  ├─ src/app.ts        The Express app (roboapply + interview-engine + cron routes)
│  ├─ src/roboapply/    Extracted /api/v1/roboapply/* routers + V2 + engine
│  ├─ src/interview-engine/  Mock-interview control plane
│  ├─ src/cron/handlers.ts   Vercel-Cron HTTP endpoints (CRON_SECRET-gated)
│  ├─ src/{lib,services,agents,middleware,types,brands,utils}/  shared closure
│  └─ prisma/schema.prisma    (generates client to server/src/generated/prisma)
├─ interview-agent/     LiveKit voice worker (deploy separately)
├─ prisma.config.ts     Points prisma at server/prisma/schema.prisma
└─ vercel.json          rewrites (/api/v1/* → the function) + crons + function config
```

## Deploy (Vercel)

1. Import the repo into Vercel (framework auto-detected as **Next.js**).
2. Enable **Fluid Compute** (Project → Settings → Functions) and be on **Pro** (needed for 5+ sub-daily crons and the 300s function duration).
3. Set env vars (see `.env.example`) — leave `NEXT_PUBLIC_API_URL` **empty** in production so the browser calls same-origin `/api/v1/*`. Set `CRON_SECRET`, `DATABASE_URL` (pooled), `DIRECT_DATABASE_URL`, `JWT_SECRET`, `COOKIE_DOMAIN=.roboapply.io`, LLM/Stripe/LiveKit/S3 keys.
4. Deploy. `vercel.json` already wires the rewrite, the function (`maxDuration: 300`), and the 7 cron jobs.
5. Host `interview-agent/` on an always-on Node host and give it the LiveKit creds + `NEXT_PUBLIC_API_URL` → the deployed API.

Full deploy runbook + known follow-ups: [`docs/ENGINEERING_PLAN.md`](docs/ENGINEERING_PLAN.md).
