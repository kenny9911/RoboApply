# Local development

As of 2026-11-03 (main @ b89d5256).

Read the [danger section](#danger-what-a-local-stack-can-touch) before you run `npm run dev` with someone else's `.env`. The owner's checkout points at the production database, and a local API runs the platform crons.

## Prerequisites

| Need | Detail |
|---|---|
| Node | `package.json` `engines` is `24.x`, and CI runs Node 24 ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)). There is no `.nvmrc`. Vercel chooses the production runtime from `engines`, so do not widen it. The owner's Mac runs Node 26 (`v26.13.0` on 2026-11-03). That works, but `npm install` prints EBADENGINE warnings. Node 26 also exposes `localStorage`/`sessionStorage` globals that are undefined, and that stops jsdom from installing its own. [`__tests__/setup.ts`](../../__tests__/setup.ts) adds a Map-backed shim, so the tests pass on both versions. `interview-agent/` needs `>=22` and `extension/` needs `>=24`. |
| npm + the committed lockfile | Install with `npm install` (AGENTS.md). CI uses `npm ci`. Do not refresh `package-lock.json` unless the task is a dependency change. On 2026-11-03 the working tree had an uncommitted Prisma 8 RC bump in `package.json`/`package-lock.json` that is not on `main`. Committed `main` pins `prisma` and `@prisma/client` at 7.10.0. |
| Postgres | Neon. The schema needs the `pgvector` extension (`halfvec` columns), which [`server/prisma/sql/`](../../server/prisma/sql/README.md) installs before the first push. There is no local Postgres for the main app. The only Compose file with a database is [`deploy/cn/compose.yaml`](../../deploy/cn/compose.yaml) (`--profile localdb`, `pgvector/pgvector:0.8.0-pg16`), which smoke-tests the mainland images. |
| Docker (optional) | Needed only for the voice worker image ([`interview-agent/Dockerfile`](../../interview-agent/Dockerfile), `docker-compose.yml`) or the mainland stack ([`deploy/cn/`](../../deploy/cn/README.md)). Day-to-day development does not use it. |
| Python 3 + Playwright (optional) | Only for [`e2e/ia-dry-run.py`](../../e2e/ia-dry-run.py). See [08-testing-and-quality-gates.md](08-testing-and-quality-gates.md#e2e). |

## First-time setup

```bash
cp .env.example .env            # then fill it (see below)
npm install                     # postinstall runs `prisma generate` (reads the schema, never connects)
```

The Prisma schema is a folder, not one file: `server/prisma/schema/*.prisma` (`_datasource.prisma`, `legacy.prisma`, and one `ra-*.prisma` file per area). [`prisma.config.ts`](../../prisma.config.ts) points Prisma at that folder. AGENTS.md and README.md still name `server/prisma/schema.prisma`, which is out of date. The generated client goes to `server/src/generated/prisma/`. It is git-ignored and must never be edited by hand. Run `npm run db:generate` after every schema change.

### Which variables you need

[`.env.example`](../../.env.example) catalogues every variable the API and the web app read (about 1,800 lines, grouped by section). It lists names and their purpose, never real values. You need only a few of them to start:

| Group | Variables | What happens without them |
|---|---|---|
| **Required to boot** | `DATABASE_URL` (pooled Neon URL) | `server/src/lib/prisma.ts` throws `DATABASE_URL is not set` when the module loads, so the API does not start. This is the only hard boot requirement I found in the code. I did not start the API to confirm that it boots with nothing else (unverified). |
| Needed for schema work | `DIRECT_DATABASE_URL` (the non-pooler endpoint) | `prisma.config.ts` falls back to `DATABASE_URL` and then to a dummy URL. DDL sent through the pgbouncer pooler silently does nothing. |
| Strongly recommended | `PORT`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ROBOAPPLY_URL`, `JWT_SECRET`, `FIELD_ENCRYPTION_KEY` | `PORT` defaults to 4607. `JWT_SECRET` falls back to a hard-coded development secret (`seekerSession.ts`). Without `FIELD_ENCRYPTION_KEY`, anything that encrypts or decrypts a stored secret throws (`lib/crypto.ts`), for example a user's own LLM key or `SystemLLMKey` rows. |
| AI features | `LLM_PROVIDER`, `LLM_MODEL`, the task `LLM_*_MODEL` settings, and one provider key (`GEMINI_API_KEY`/`GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, …) | AI calls fail. Set `MOCK_LLM=true` to get canned empty answers in local runs. In development a copilot model that cannot stream tool calls only logs a warning; in production it refuses to boot ([`server/src/platform/startup.ts`](../../server/src/platform/startup.ts)). |
| Voice practice | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `INTERVIEW_ENGINE_AGENT_NAME`, `LIVEKIT_AGENT_CALLBACK_SECRET`, `LLM_INTERVIEW_MODEL` | Session creation fails, or rooms stay silent. See [the voice worker](#the-interview-voice-worker). |
| Everything else | Stripe, Alipay, Resend, S3/R2, RapidAPI and the job sources, Tavily, web push, the `CN_*` overrides | That feature degrades or reports itself unavailable. A `CN_<NAME>` value is only an optional GoApply override of `<NAME>`. |

Kill switches that are worth knowing on day one: `ROBOAPPLY_CRON_DISABLED`, `ROBOAPPLY_PLATFORM_CRON_DISABLED`, `ENRICH_DAILY_JOBS`, `RA_ONBOARDING_EXTERNAL_JOBS_DISABLED`, `ATS_PUBLIC_SOURCES_DISABLED`, `ALLOWED_BRANDS`, `MOCK_LLM`, `NEXT_PUBLIC_USE_STUB_API` (stubs only the v2 data layer, never auth).

### `.env` vs `.env.local`: who wins depends on the process

This is the most surprising part of the setup. Every loader uses dotenv with `override: false`, so whichever file is loaded **first** wins.

| Process | Load order | Effect |
|---|---|---|
| Express API ([`server/src/app.ts`](../../server/src/app.ts)) | shell env, then `.env`, then `.env.local` | **`.env` wins over `.env.local`.** `.env.local` only fills in variables that `.env` does not define. |
| API values read while a module loads | `server/src/lib/prisma.ts` loads `.env` itself (it does not load `.env.local`). Because ESM evaluates imports before `app.ts` reaches its own `dotenv.config` calls, | a setting that is read at import time (for example `DATABASE_URL`, `JWT_SECRET`, `RESUME_FILE_STORAGE_PROVIDER`) never sees `.env.local`. Put such settings in `.env` or in the shell. Values read per request or at startup, such as `ROBOAPPLY_CRON_DISABLED` (read in `startRoboApplyCron()`), do see `.env.local`. I inferred this from ESM semantics and did not trace the whole import graph. |
| `npm run dev:web` (plain `next dev`) | Next's own order: `process.env`, then `.env.development.local`, then `.env.local`, then `.env` (`node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`) | **`.env.local` wins.** |
| `npm run dev` (web through [`scripts/dev-web-after-api.ts`](../../scripts/dev-web-after-api.ts)) | That script loads `.env` and then `.env.local` into `process.env` before it spawns `next dev` | **`.env` wins** for every variable defined in both files, because Next never overrides `process.env`. |
| Prisma CLI ([`prisma.config.ts`](../../prisma.config.ts)) | `import 'dotenv/config'`, which reads `.env` only | |
| Vitest | The configs pin `DATABASE_URL` and `DIRECT_DATABASE_URL` to `postgresql://ci@127.0.0.1:1/ci`, and `prisma.ts` skips dotenv under `VITEST` | Tests never see your database. |
| Voice worker (`interview-agent/src/main.ts`) | `interview-agent/.env.local` | `verify-llm.mjs` reads `.env.local` and then `.env`. |

In practice: keep anything you also want to override out of `.env`, and set temporary switches either in `.env.local` (when `.env` does not define them) or in the shell. The comment at the top of `.env.example` says to "put the NEXT_PUBLIC_* vars in `.env.local`". That only takes effect if `.env` does not define them too.

`vercel env pull` rewrites `.env.local`. Re-add any local switches afterwards (the owner's `.env.local` holds `ROBOAPPLY_CRON_DISABLED=true` for this reason).

## Running

| Command | What runs |
|---|---|
| `npm run dev` | `concurrently --kill-others` with three members: (1) `dev:server`, which runs `tsx watch server/src/app.ts` on `.env` `PORT` (default 4607); (2) `dev:web:after-api`, which polls `${NEXT_PUBLIC_API_URL or http://localhost:$PORT}/api/v1/health` (60 s timeout, `ROBOAPPLY_API_READY_TIMEOUT_MS`) and then starts `next dev -p 3611`, so an open tab never sees startup 500s from the dev proxy; (3) [`scripts/dev-interview-agent.sh`](../../scripts/dev-interview-agent.sh), which builds and runs the voice worker, restarts it when it exits, and idles with a warning, without tearing down the stack, if `interview-agent/.env.local` is missing or the build fails. The worker log is at `/tmp/roboapply-interview-agent.log`. |
| `npm run dev:server` | API only. |
| `npm run dev:web` | Next only, on 3611. In development `next.config.mjs` rewrites `/api/v1/*` and `/api/auth/*` to `NEXT_PUBLIC_API_URL` (default `http://localhost:4607`). |
| `./scripts/restart.sh` | Kills whatever listens on 3611 and on `.env` `PORT`, plus the worker PID file, then runs `npm run dev`. It kills by port, so any other process on those ports dies too. |
| `./scripts/dev-clone.sh` | API on 4621, web on 3621, and a worker registered as `RoboApply-Interview-Clone`. Brands: RoboApply at `http://localhost:3621`, GoApply at `http://goapply.localhost:3621`. It sets `SMS_DEV_CONSOLE=true` (phone codes are printed in the API log) and `NEXT_PUBLIC_SHOW_ALL_NAV=true`. It was written for the `feat/jobright-clone` worktree, whose `.env` points at a Neon branch. Run from the main checkout, it uses the main `.env`. |

Both brands also work on the normal stack: RoboApply on `http://localhost:3611` and GoApply on `http://goapply.localhost:3611`. The brand comes from the Host header (`devHosts` in [`server/src/platform/brand/registry.ts`](../../server/src/platform/brand/registry.ts)). `BRAND_FORCE` or the `?__brand=` cookie forces a brand on development hosts.

[`.claude/launch.json`](../../.claude/launch.json) holds Claude Code preview entries: `web` (`npm run dev:web`, 3611), `design-preview` (`scripts/design-preview.mjs`, 3612), `clone` (dev-clone.sh in the jobright-clone worktree, 3621), and `parley`/`parley-dev`, which run a sibling `../parley` checkout of the Parley voice service on 8080. The last ones are only useful if you have that private repository.

Two `next dev` processes cannot share one checkout. To build or run a second copy, use `git worktree add` and give it a real `node_modules` (a copy or hardlinks; Turbopack rejects a `node_modules` symlink that leaves the project). The worktree build recipe is in [HANDOFF §4 step 4](../jobright-clone/HANDOFF.md).

## DANGER: what a local stack can touch

### 1. Which database `.env` points at

Check the host before running anything, without printing credentials:

```bash
grep -E '^(DATABASE_URL|DIRECT_DATABASE_URL)=' .env | sed -E 's#://[^@]*@#://<redacted>@#'
```

| Neon endpoint host | What it is |
|---|---|
| `ep-empty-snow-a6mdqwbe` | **Production** RoboApply database (its own Neon project since the July 2026 split from RoboHire). On 2026-11-03 the owner's main checkout `.env` pointed here. |
| `ep-quiet-king-a6psbfbe` | Neon **branch** `jobright-clone`. It is a copy of production and contains real users' rows. The `.claude/worktrees/jobright-clone` checkout uses it. |

README.md still says the database is "currently shared with RoboHire". That is out of date. RoboApply has had its own Neon project since 2026-07-02, and the old shared host is not RoboApply's database any more.

Because the main `.env` is production:

- Signing up locally creates a real production user. Email verification is not required for seekers.
- A session you mint (see below) also works on www.roboapply.io.
- Delete test data afterwards.

Before you do anything risky, point your own `.env` at a Neon branch you created, or at a throwaway local pgvector Postgres to which you push the schema yourself. Neither is a documented team workflow (unverified).

### 2. The local API runs the platform crons

Off Vercel, `app.ts` calls `startRoboApplyCron()` unless `ROBOAPPLY_CRON_DISABLED=true` ([`RoboApplyCronService.ts`](../../server/src/roboapply/schedulers/RoboApplyCronService.ts)). It registers:

- the renewal reminder (06:00 UTC);
- the account purge (04:00 UTC), which hard-deletes soft-deleted users and their stored files;
- interview cleanup every 15 minutes;
- every entry of `PLATFORM_CRON_JOBS` in [`server/src/cron/handlers.ts`](../../server/src/cron/handlers.ts): `queue-drain` every 5 minutes (runs every worker kind, notifications and push included), `jobs-boards` every 5 minutes, `jobs-ingest` every 10 minutes, `job-alerts` and `score-precompute` every 15 minutes, `reminders` hourly, `lifecycle-emails` hourly, `ready-weekly`, `jobs-plan`, `jobs-maintain`, `seo-rebuild`, `contacts-sync`, `compliance-daily`.

Against production, these run alongside Vercel's crons. They can email or push to real users, purge accounts and spend model or provider budget.

For any run that is not deliberately exercising crons, set these in `.env.local` (or the shell) and remove them afterwards ([HANDOFF §3](../jobright-clone/HANDOFF.md)):

```bash
ROBOAPPLY_CRON_DISABLED=true               # no in-process schedule at all
ENRICH_DAILY_JOBS=0                        # no LLM enrichment (default budget 8,000 calls/day/market)
RA_ONBOARDING_EXTERNAL_JOBS_DISABLED=true  # no metered job-search calls (JSearch, Active Jobs DB)
# ATS_PUBLIC_SOURCES_DISABLED=true         # also stop employer-board reads and the posting liveness check
```

They work from `.env.local` only if `.env` does not define them (see the precedence table above). `ROBOAPPLY_PLATFORM_CRON_DISABLED=true` turns off only the platform entries. Trigger a cron by hand with `Authorization: Bearer $CRON_SECRET` on `/api/v1/cron/<name>`. HANDOFF limits that to `jobs-plan`, `jobs-boards` and `jobs-ingest` against a production copy. Never run `queue-drain`, `score-precompute` or `account-purge` there.

### 3. Stripe

On 2026-11-03 the main `.env` held a **live** `STRIPE_SECRET_KEY` (`sk_live_…`). The code refuses any key that is not `sk_test_`/`rk_test_` unless `VERCEL_ENV=production` (`.env.example`, Stripe section). Never set `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION`. Local checkout needs a test key and a `stripe listen` secret ([`docs/jobright-clone/market/STRIPE_TEST_RECIPE.md`](../jobright-clone/market/STRIPE_TEST_RECIPE.md)). Alipay is frozen; read [HANDOFF §5](../jobright-clone/HANDOFF.md) first.

### 4. Schema changes

Never run `npm run db:push` against a database you have not identified (AGENTS.md). Schema changes are additive only. The reviewed procedure (diff, `scripts/check-schema-additive.mjs`, `prisma db execute`, then a second, empty diff) is in [HANDOFF §5](../jobright-clone/HANDOFF.md). Production changes happen only with the owner.

### 5. The voice worker registers under the production agent name

A dev-mode worker that uses the default `INTERVIEW_ENGINE_AGENT_NAME` (`RoboApply-Interview`) on the shared LiveKit project joins the production pool. Production interviews can then be dispatched to your laptop ([`interview-agent/README.md`](../../interview-agent/README.md), "Quickstart"). If you share the LiveKit project, give your local API and worker their own agent name, the way `dev-clone.sh` does.

## Signing in locally

- **Sign up normally.** Email-and-password sign-up works without email delivery, because verification does not block seekers ([`server/src/features/auth/service.ts`](../../server/src/features/auth/service.ts)). The account lands in whatever database `.env` names.
- **Mint a session without a password.** `createSeekerSession(userId)` in [`server/src/roboapply/engine/lib/seekerSession.ts`](../../server/src/roboapply/engine/lib/seekerSession.ts) writes a `Session` row (30-day default) and returns its token. Set it in the browser as the `ra_session_token` cookie (`SESSION_COOKIE_NAME` in [`lib/config.ts`](../../lib/config.ts) and `server/src/lib/cookieOptions.ts`): `document.cookie = 'ra_session_token=<token>; path=/'`. The owner's recipe was an ESM `.mts` script that imports `server/src/lib/prisma.ts` by absolute path, run with `npx tsx --env-file=.env` outside the Bash sandbox and ended with `process.exit(0)`. `prisma.$disconnect()` hangs, and HANDOFF §5 notes that standalone `tsx` scripts that import the Prisma client hang. Prefer `prisma.session.create` with a short `expiresAt`, and delete the rows afterwards: against production, the token is a real production session. There is no committed script for this (unverified beyond the owner's notes).
- **There is no auth stub.** `proxy.ts` only checks that the cookie is present, and `AuthProvider` still calls the real `/auth/me`, even with `NEXT_PUBLIC_USE_STUB_API=true`.
- **Admin account.** There is no seed script in the repository. An admin (`admin@roboapply.io`) was created once by hand during the July database split. The password is held by the owner, so ask for it. Any new admin must also have a `SeekerProfile` row; otherwise seeker login answers 403 `not_a_seeker_account` (owner's notes; I did not re-verify this in code).

## The interview voice worker

`interview-agent/` is a separate package (its own `package.json`, lockfile, `tsconfig`, Node `--test` suite) and a long-running LiveKit worker. It cannot run on Vercel.

```bash
cd interview-agent
npm install
cp .env.example .env.local   # LIVEKIT_URL/API_KEY/API_SECRET, INTERVIEW_ENGINE_AGENT_NAME,
                             # LIVEKIT_AGENT_CALLBACK_SECRET, OPENAI_API_KEY (optional tts-1 floor)
npm run dev                  # tsc build, then `node dist/main.js dev`
```

- Normally you do not start it by hand: `npm run dev` supervises it (see above).
- The API's `.env` and the worker's `.env.local` must agree on the LiveKit project, `INTERVIEW_ENGINE_AGENT_NAME` and `LIVEKIT_AGENT_CALLBACK_SECRET`. A mismatch shows up as silent rooms, or as empty transcripts and all-zero reports.
- The API refuses to create a session (503) when `LLM_INTERVIEW_MODEL` (or `LLM_INTERVIEW_LIVE_MODEL`) is not in `ALIGNED_INTERVIEW_MODELS` ([`server/src/interview-engine/config.ts`](../../server/src/interview-engine/config.ts)). `cd interview-agent && npm run verify:llm` asks the LiveKit gateway to stream one reply from every allowlisted id, or from the ids you pass (`npm run verify:llm -- openai/gpt-6-luna --effort high`). It needs only the `LIVEKIT_*` credentials. It makes real gateway calls, so it is a network command.
- Other probes: `npm run verify:greeting` and `npm run verify:voices`. Hosting recipes (Docker, Fly, Railway, Render, systemd) are in [`interview-agent/README.md`](../../interview-agent/README.md) and [`interview-agent/deploy/`](../../interview-agent/deploy).
- That README is partly out of date: it is titled "RoboHire Interview Engine", and it mentions `npm run services:start`/`services:stop`, which do not exist in the root `package.json`.

## The Chrome extension

`extension/` is its own package (MV3, one codebase, two brand builds), outside the root workspace. The root `tsconfig.json` and `vitest.config.mts` exclude it. Full details are in [`extension/README.md`](../../extension/README.md).

```bash
npm --prefix extension install
npm --prefix extension run typecheck
npm --prefix extension test          # vitest (jsdom), then the no-submit gate
npm --prefix extension run build:dev # → extension/dist/roboapply-chrome-dev/, talks to http://localhost:3611
npm run check:extension              # the same no-submit gate, from the root (part of `npm run check`)
```

Load the dev build unpacked from `chrome://extensions`. Set `NEXT_PUBLIC_EXT_ID` (GoApply: `NEXT_PUBLIC_CN_EXT_ID`) to the extension id so `/extension` can find it, then pair it from `/extension` while signed in. The product rule is that the extension never submits a form. [`scripts/check-extension-no-submit.mjs`](../../scripts/check-extension-no-submit.mjs) fails on any `.click(`, `.submit(`, synthetic click, submit or key event, or submit listener outside `src/adapters/_kit/interact.ts`, and every extension build runs it first. The Playwright e2e (`npm --prefix extension run e2e`) needs `npx --prefix extension playwright install chromium` and is not run in CI.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| A slow API call (for example a scanned-PDF resume upload) fails at about 30 s with `socket hang up`/`ECONNRESET` in the Next terminal and a plain-text 500 in the browser, while the API log shows success later | `next dev` proxies rewrites with a hard-coded 30 s cap unless `experimental.proxyTimeout` is set. [`next.config.mjs`](../../next.config.mjs) sets `600_000`. Do not change it to `0`: `proxyTimeout \|\| 30_000` treats 0 as unset. This applies to development only. |
| Every API call answers 401 although you look signed in | A dead `ra_session_token` cookie, for example one minted against another database. `proxy.ts` checks only that the cookie is present. `lib/api/client.ts` redirects to `/login` on `auth_expired`, and `/auth/logout` works without a session. Signing in again always fixes it. |
| `/auth/me` answers 500, or the API "works" but behaves like another app | Port clash. The owner runs this API on `PORT=4611`, because 4607 (the default here) may be taken by a RoboHire backend on the same machine (owner's notes). Check `lsof -nP -iTCP:4607 -sTCP:LISTEN`, and keep `PORT` and `NEXT_PUBLIC_API_URL` in agreement. |
| `AGENTS.md` shows a modified block after `next dev` | `next dev` writes and restores a managed block in `AGENTS.md` (`node_modules/next/dist/server/lib/generate-agent-files.js`). Commit it with your work rather than removing it, or the diff comes back. |
| The worker logs `ETIMEDOUT`/`ENOTFOUND` at the same minute the API logs a Neon `Connection terminated due to connection timeout` | The network dropped, often a VPN tunnel restarting on the owner's machine. It is not a code bug. The worker caps its LiveKit connect at 10 s (`WORKER_CONNECT_TIMEOUT_MS`). A DB error in the auth middleware answers 500, not 401, so users are not logged out. |
| Mock interview room stays silent | The worker is not running (check `/tmp/roboapply-interview-agent.log` for `[dev-interview-agent] status: env-missing` or `build-failed`), or the agent name or callback secret differs between the API and the worker. |
| `npx tsx …`, `npm run check:llm-costs` or `npm run eval:match` fails with `listen EPERM …/tsx-*.pipe`; tests that call `app.listen` fail with `Cannot read properties of null (reading 'port')`; `next build` hangs at "Creating an optimized production build" | The Claude Code Bash sandbox is blocking local sockets. Run the command outside the sandbox. It is not a repository bug. |
| `npm run lint` fails | Next 16 removed `next lint`, and the repository has no ESLint setup. The script is dead. |
