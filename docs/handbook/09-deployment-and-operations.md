# 09 · Deployment and operations

As of 2026-11-03 (main @ b89d5256).

How RoboApply runs in production, how to release and roll back, and what to look at when it breaks. Statements marked "last known (date)" come from earlier operator notes and could not be re-checked from the repository (this handbook was written without access to Vercel, Neon or any provider).

## 1. Production topology

| Piece | Where | Notes |
|---|---|---|
| Web (Next.js 16, App Router) | Vercel project `roboapply`, team scope `kens-projects` | Domain www.roboapply.io. Git integration auto-deploys `main` of `kenny9911/RoboApply`. |
| API (Express, ESM) | The same Vercel project, **one** serverless function: [`api/index.ts`](../../api/index.ts) | Re-exports the compiled app from `server/dist/app.js`. |
| Crons | Vercel Cron, 16 entries in [`vercel.json`](../../vercel.json) | Each is an HTTP `GET /api/v1/cron/<name>` gated by `CRON_SECRET`. **Not running today** (section 6). |
| Database | Neon Postgres, RoboApply's own Neon project | Not shared with RoboHire since 2026-07-02 (section 4). |
| Voice worker | `interview-agent/` | Long-running LiveKit Agents process. Cannot run on Vercel. No production host yet (section 7). |
| GoApply (mainland) | Kit in [`deploy/cn/`](../../deploy/cn/README.md), manual workflow `.github/workflows/deploy-cn.yml` | Nothing deployed. GoApply is closed on Vercel with `ALLOWED_BRANDS=roboapply`. |

The Vercel project link is in `.vercel/project.json` of the main checkout (project name `roboapply`). The repository CI (`.github/workflows/ci.yml`) has no deploy step and reads no secrets: Vercel's Git integration is the only RoboApply deploy path.

### 1.1 How a request reaches the API

- `vercel.json` rewrites `/api/v1/:path*` to `/api/index`. Express then routes on the original URL.
- Only `/api/v1/*` goes to Express. `/api/health` and `/api/revalidate` are **Next.js** routes (`app/api/health`, `app/api/revalidate`). A green `/api/health` therefore says nothing about the API function. Use `/api/v1/health` (served by Express, `server/src/app.ts`) or any other `/api/v1/*` route.
- In production the browser calls same-origin `/api/v1/*`. In development `next.config.mjs` rewrites `/api/*` to `NEXT_PUBLIC_API_URL`; `rewrites()` returns nothing outside development.

### 1.2 Function configuration (`vercel.json`)

| Setting | Value | Why |
|---|---|---|
| `buildCommand` | `prisma generate && tsc -p server/tsconfig.json && next build` | Same as `npm run build`. The API is compiled to `server/dist` before Next builds. |
| `functions["api/index.ts"].maxDuration` | 300 s | Long LLM calls, PDF parsing, cron sweeps. Cron platform jobs budget 240 s per invocation (`cron/handlers.ts`). |
| `memory` | 2048 MB | |
| `includeFiles` | `server/**`, `content/legal/**`, `@napi-rs/canvas*`, selected `pdfjs-dist` assets | `server/**` (not `server/dist/**`) so `server/package.json` ships; PDF.js loads its canvas binding, worker and fonts dynamically, so the tracer cannot see them. |
| Fluid compute | On, per README | A dashboard setting; unverified from the repo. README also says the plan must be Pro (sub-daily crons, 300 s). |

Node is `24.x` (`engines` in `package.json`).

### 1.3 Invariants that once broke every API route

Every `/api/v1/*` route returned 500 from the first deploy until 2026-07-03. Four causes were stacked. Each is still in the code; **no test pins any of them**, so keep them in mind when touching these files.

| Invariant | Where (verified) | Symptom if broken |
|---|---|---|
| Root `package.json` has `"type": "module"` | `package.json` line 4; `server/package.json` also has it so `server/dist/**.js` is ESM | Boot crash "Cannot use import statement outside a module". An `.mts` entry is not an alternative: the `functions` pattern does not match `.mts` under `api/` (comment in `api/index.ts`). |
| `includeFiles` contains `server/**` | `vercel.json` | Same crash: `server/package.json`, the ESM marker for `dist`, is missing from the bundle. |
| No file logging when `VERCEL` is set | `server/src/services/LoggerService.ts:233` (`fileLoggingEnabled = FILE_LOGGING !== 'false' && !process.env.VERCEL`) | ENOENT at import: `/var/task` is read-only. |
| `/` listed explicitly in the proxy matcher | `proxy.ts:156`, `matcher: ['/', '/((?!_next/|_static/|favicon.ico|api/).*)']` | On Vercel's router the unnamed group does not match the bare root (it does in `next dev`), so the root loses its proxy pass: the localized landing pages lose `x-pathname`, and historically the signed-in `/` → `/home` redirect never fired. |

Also note: `proxy.ts` excludes all `/api/*`, so the Next proxy never touches raw-body webhooks or SSE; `server/src/app.ts` skips `dotenv`, `app.listen()` and node-cron when `VERCEL` is set.

### 1.4 Startup assertions

`server/src/app.ts` calls `runStartupAssertions()` (`server/src/platform/startup.ts`) at module load. On Vercel a throw there fails the function's module init, so **every** `/api/v1/*` request returns 500 until a fixed deployment is promoted. The blocking checks:

1. Residency topology (`DEPLOY_REGION`, database host, a mainland deployment serving RoboApply).
2. The Assistant (`copilot`) model of the deployment's primary brand must be able to stream tool calls (`assertCopilotModelSupportsTools`). Google direct and Anthropic direct cannot here; an `openrouter/...` selector can. Escape hatch: `FLAG_ROBOAPPLY_COPILOT=false` turns the Assistant off and lets the deployment boot (the startup file names the pattern `FLAG_<BRAND>_COPILOT`).

Other problems (bad `ALLOWED_BRANDS` value, half-set `CN_*` groups, unknown mode values) are logged under scope `STARTUP` and do not block.

## 2. Crons

All 16 are defined in `vercel.json`. Three are legacy handlers in `server/src/cron/handlers.ts`; the other 13 come from the `PLATFORM_CRON_JOBS` table in the same file, which `server/src/cron/handlers.platform.test.ts` checks against `vercel.json`. Platform jobs run once per brand the deployment serves (`ALLOWED_BRANDS`). Schedules are UTC.

| Path `/api/v1/cron/...` | Schedule | What it runs |
|---|---|---|
| `billing-renewal-reminder` | `0 6 * * *` | `runRenewalReminderSweep` (T-5 days) |
| `account-purge` | `0 4 * * *` | Legacy cover-letter cache purge, then `runAccountPurgeSweep` (deletes stored files, then the `User` row, for accounts closed past `ACCOUNT_PURGE_RETENTION_DAYS`) |
| `interview-cleanup` | `*/15 * * * *` | `reconcileExpiredSessions` (finalize or expire stranded interview sessions) |
| `jobs-plan` | `0 2 * * *` | `runJobsPlan` (ingest query planning) |
| `jobs-ingest` | `*/10 * * * *` | `runJobsIngest` (metered and bank sources) |
| `jobs-boards` | `*/5 * * * *` | `runJobsBoards` (public employer boards; kill switch `ATS_PUBLIC_SOURCES_DISABLED`) |
| `queue-drain` | `*/5 * * * *` | Drains **every** registered worker kind (enrichment, email, push, ...) |
| `jobs-maintain` | `30 3 * * *` | Maintenance, tools purge, admin health email, prunes, stale credit reservations |
| `score-precompute` | `*/15 * * * *` | `runScorePrecompute` (fit scores; spends LLM budget) |
| `job-alerts` | `*/15 * * * *` | Job alerts and signed-out alert digests |
| `reminders` | `0 * * * *` | Tracker, agent, campus and winback reminder producers; tools purge |
| `lifecycle-emails` | `15 * * * *` | Lifecycle mail |
| `ready-weekly` | `5 * * * *` | Weekly "ready to apply" |
| `seo-rebuild` | `0 4 * * *` | SEO pages |
| `contacts-sync` | `45 4 * * *` | Contacts |
| `compliance-daily` | `0 5 * * *` | Compliance tasks and interview retention |

Auth: `requireCron` accepts `Authorization: Bearer $CRON_SECRET` (or `?secret=` for manual calls) and answers **401 when `CRON_SECRET` is unset**. Vercel sends the header automatically once the variable exists.

Off Vercel, `server/src/app.ts` starts the same jobs in process (`RoboApplyCronService`) unless `ROBOAPPLY_CRON_DISABLED=true`. This matters locally: see section 4.

## 3. Environment variables in production

[`.env.example`](../../.env.example) is the catalogue (about 1,800 lines, every name with its purpose; `__tests__/deploy/envExample.test.ts` checks that the market-wave names are documented, not the whole file). Set values in Vercel Project → Settings → Environment Variables. Secret/sensitive values **cannot be pulled back** with `vercel env pull`; you can only overwrite them.

| Category | Important names | Notes |
|---|---|---|
| Core / DB | `DATABASE_URL` (pooled), `DIRECT_DATABASE_URL` (non-pooler, DDL only), `PRISMA_POOL_MAX` | Pool defaults to 1 connection on Vercel. |
| Auth | `JWT_SECRET`, `FIELD_ENCRYPTION_KEY`, `COOKIE_DOMAIN` | `FIELD_ENCRYPTION_KEY` encrypts DB-stored secrets such as `SystemLLMKey` rows; rows copied from another deployment do not decrypt under a different key. |
| Public URLs | `NEXT_PUBLIC_API_URL` **empty**, `NEXT_PUBLIC_ROBOAPPLY_URL`, `APP_URL` | A non-empty `NEXT_PUBLIC_API_URL` breaks same-origin calls; `lib/config.ts` treats a localhost API base in a production bundle as a misconfiguration. |
| Brand scope | `ALLOWED_BRANDS=roboapply`, `BRAND_LOCK`, `INTERNAL_API_SECRET` | Unset `ALLOWED_BRANDS` means both brands, production included. Set for Production and Preview on 2026-10-12. |
| Cron | `CRON_SECRET` | **Unset** (last known 2026-10-12). |
| LLM | `LLM_PROVIDER`, `LLM_MODEL`, `LLM_COPILOT_MODEL`, `LLM_INTERVIEW_MODEL`, `LLM_MATCHING_MODEL`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`, `GOOGLE_REASONING_MAX_TOKENS`, `TAVILY_API_KEY` | Admin overrides in the database win over these (3.1). |
| Mail | `RESEND_API_KEY`, `EMAIL_FROM`, `ROBOAPPLY_EMAIL_FROM` | Production sends from a `robohire.io` sender under the display name RoboApply. Do **not** set `ROBOAPPLY_EMAIL_FROM` to a `roboapply.io` address until that domain is verified in Resend. |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (comma list allowed) | Not set (last known). Without both, RoboApply lists prices but cannot open a payment. Live keys are refused unless `VERCEL_ENV=production`. |
| Storage | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | No working write key (last known). Resume originals default to `none` in production without them. |
| Push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Not set; web push is off. |
| Voice | `LIVEKIT_*`, `INTERVIEW_ENGINE_AGENT_NAME`, `INTERVIEW_ENGINE_CALLBACK_BASE_URL`, `LIVEKIT_AGENT_CALLBACK_SECRET`, `INTERVIEW_ENGINE_PARLEY_PILOT` | Which of these are set in production is unverified. |
| Job sources | `RAPID_API_KEY`, `RA_ONBOARDING_EXTERNAL_JOBS_DISABLED`, `ENRICH_DAILY_JOBS`, `ATS_PUBLIC_SOURCES_DISABLED`, `USAJOBS_API_KEY` | Budgets and kill switches; read `docs/job-search/RUNBOOK.md` before changing. |

Last known production set (2026-10-12/13, from operator notes): database pair, `FIELD_ENCRYPTION_KEY`, `JWT_SECRET`, LLM provider/model and fallback keys, `TAVILY_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `ALLOWED_BRANDS`, `LLM_COPILOT_MODEL`. Missing: `CRON_SECRET`, Stripe, S3 write key, VAPID.

### 3.1 Admin overrides in the database win over env

`server/src/lib/llm/llmStackConfigResolver.ts` reads the `AppConfig` row `llm_stack.production` (GoApply: `llm_stack.goapply.production`; the environment is `production` when `NODE_ENV=production`) and applies `override ?? env` for the default model, the fallback model and the per-purpose models. The snapshot is cached 30 s per instance; `LLM_SETTINGS_DB_DISABLED=true` ignores the row.

Consequences:

- Changing `LLM_MODEL` on Vercel has no effect while the row names a model. Last known (2026-10-13): every model in the row set to `google/gemini-3.8-flash`, `copilot` set to `openrouter/google/gemini-3.8-flash`.
- RoboApply has **no admin UI** for this row: `saveLlmStack` has no caller in the repository. Edits are direct database writes on production; back up the old value first.
- Other `AppConfig` rows (for example `agent_alex.*`) are RoboHire leftovers that no RoboApply code reads (last known).

## 4. Databases

| Database | Used by | Notes |
|---|---|---|
| Neon project "RoboApply", branch `production` | www.roboapply.io **and the main checkout's `.env`** | Real users. |
| Neon branches (e.g. `jobright-clone`) | Feature worktrees | Copies of production: real users' rows. Treat with the same care. |
| The old shared RoboHire database | RoboHire | RoboApply left it on 2026-07-02. README, `.env.example`, `prisma.config.ts` and the `server/src/app.ts` header still say "shared with RoboHire": stale. |

**The main checkout's `.env` points at production.** A local `npm run dev` there starts the in-process crons (alerts, lifecycle mail, push, queue-drain, account purge) against real users unless `ROBOAPPLY_CRON_DISABLED=true` is set. Last known (2026-10-12) it is set in the main checkout's `.env.local`; `vercel env pull` rewrites `.env.local`, so re-add it after a pull. For any verification run also set `ENRICH_DAILY_JOBS=0` and `RA_ONBOARDING_EXTERNAL_JOBS_DISABLED=true`, and never trigger `queue-drain`, `score-precompute` or `account-purge` by hand against a production copy (`docs/jobright-clone/HANDOFF.md` section 3).

**Which database am I on?** Print the host without the credentials and compare it with the branch list in the Neon console. Do not paste the host into documents or chats.

```bash
grep -E '^(DATABASE_URL|DIRECT_DATABASE_URL)=' .env | sed -E 's#://[^@]*@#://<redacted>@#; s#\?.*##'
```

Schema rules:

- The schema is a folder, `server/prisma/schema/*.prisma` (AGENTS.md still says `schema.prisma`). There is no `migrations/` directory: the database is managed by `db push`.
- **Additive only**: new models, nullable or defaulted columns, indexes. Review SQL first: `npx prisma migrate diff --from-config-datasource --to-schema server/prisma/schema --script`, then `node scripts/check-schema-additive.mjs --sql <file>`, apply with `npx prisma db execute --file`, confirm a second diff is empty apart from `docs/jobright-clone/schema-diffs/KNOWN_DRIFT.md`. Never `--accept-data-loss`.
- A Neon branch first; production only with the owner. DDL needs `DIRECT_DATABASE_URL` (DDL over the pooler silently does nothing).
- A drifted column in a shared database usually comes from a branch that pushed and never merged: search every branch with `git log -S` before calling it dead.
- Production received pgvector 0.8.6 and the reviewed additive diff on 2026-10-12 (`docs/jobright-clone/schema-diffs/production-2026-10-12-*.sql`).
- Tests never reach a database: `vitest.config.mts` and CI pin the URL to a closed loopback port.

## 5. Release procedure

### 5.1 Normal release

1. Branch, open a PR into `main`. CI (`ci.yml`) runs typecheck (API and web), `npm test`, `npm run check`, the extension and the interview-agent jobs.
2. Merge by hand once CI is green. GitHub auto-merge is not enabled for this repository.
3. Vercel builds and promotes the `main` commit to www.roboapply.io.
4. Verify on production: call an `/api/v1/*` route (for example `/api/v1/health`, or sign in and load `/jobs`), not `/api/health`.

The 2026-10-31 batch (admin view-as, resume hub, Paper, Next 16.4.1, npm audit fixes, OpenRouter base URL, add-resume nudge) was merged locally as plain `git merge` commits and pushed; PRs #6 to #11 had been opened for most of it, and GitHub marked them merged when the commits reached `main`. Either path ends in a Vercel deploy of `main`, so run CI (or the same commands locally) before you push to `main`.

### 5.2 Optional pre-release of the exact commit

Used for the 2026-10-12 jobright-clone release, when the new startup checks had to be proven on production env before the domain moved:

```bash
# From the main checkout (it holds the linked .vercel/). Never deploy a worktree directory:
# its .env would be uploaded. git archive contains only tracked files.
SHA=$(git rev-parse <commit>)
REL=$(mktemp -d)/rel-$SHA && mkdir -p "$REL"
git archive "$SHA" | tar -x -C "$REL"
mkdir -p "$REL/.vercel" && cp .vercel/project.json "$REL/.vercel/"
npx --yes vercel@<pinned> deploy --prod --skip-domain --cwd "$REL"   # production env, domain untouched
npx --yes vercel@<pinned> curl /api/v1/health --deployment <deployment-url>
```

Then merge as in 5.1. Deployment URLs sit behind Deployment Protection (they redirect to a login), which is why `vercel curl` is used. The exact flag sequence above is reconstructed from notes; check `vercel deploy --help` for the pinned version.

### 5.3 Vercel CLI

- Run it as `npx --yes vercel@<pinned version>` from the main checkout. Last known pin: `63.1.2` (2026-10-12). The Vercel MCP connector answered 403 for this team; the CLI works.
- It needs network access, so it fails inside the agent Bash sandbox.
- **Do not run `vercel env run -e production -- node -e ...`.** It was misparsed into a `vercel deploy` of the working tree (it failed only on the 15,000-file cap).

### 5.4 Environment-only change

```bash
npx --yes vercel@<pinned> env update <NAME> production        # or env rm + env add
npx --yes vercel@<pinned> redeploy <current production deployment URL> --target production
```

Before changing any LLM variable, check that the Assistant model still passes the boot check (section 1.4): a `google/` or `anthropic/` copilot model makes the API refuse to boot. After the redeploy, call an `/api/v1/*` route.

### 5.5 Rollback

```bash
npx --yes vercel@<pinned> promote <previous production deployment URL>
```

Note the current production deployment before every release so you know what to promote. **Incident 2026-10-13:** an env redeploy left the copilot falling back to a `google/` model; the API refused to boot (500 on every `/api/v1/*`, `[STARTUP]` error in the logs). Promoting the previous deployment restored service in about three minutes; the fix was `openrouter/google/gemini-3.8-flash` for `copilot` in both the `AppConfig` row and `LLM_COPILOT_MODEL`.

## 6. Observability

- **Function logs**: `npx --yes vercel@<pinned> logs --deployment <url> --json`, while reproducing the failing request in parallel. The browser sees only a generic 500; the log has the boot stack trace.
- **LoggerService** (`server/src/services/LoggerService.ts`) writes structured lines with a category, request id and user id. On Vercel it logs to stdout only. Categories worth filtering:
  - `STARTUP`: boot assertions (an error here with 500s everywhere means the function did not initialise).
  - `LLM_SERVICE`: "Auto-selected LLM fallback route" means the primary provider failed its credentials and calls are detouring.
  - `ROBOAPPLY_CRON`: per-job "complete" / "threw" / "finished with errors".
- **Usage and cost records in the database**: `UsageDeductionLog` (credits charged), `RAProviderUsage` (job-source quota per day), `RAWorkItem` (queue). LLM calls are logged with their computed cost (`logLLMCall`) but not persisted as rows by this code; model prices live in `server/src/lib/modelCostTable.ts` (`npm run llm:costs`, `docs/LLM_COSTS.md`).
- **Admin console** (`/admin`, admin role): System panel (provider health, quota, dead sources, Stripe health), credits and payments, sources, users with read-only "view as".
- **LLM key check** (local, needs network, run outside the sandbox): `npx tsx scripts/verify-llm-brand.ts --brand roboapply --db --probe`. Interview model check: `cd interview-agent && npm run verify:llm`.

## 7. Satellite services

| Service | Status | Pointer |
|---|---|---|
| LiveKit voice worker (`interview-agent/`) | Cannot run on Vercel. Portable: multi-stage `interview-agent/Dockerfile`, `docker-compose.yml`, recipes in `interview-agent/deploy/` (Fly, Render, Railway, k8s, systemd; Railway's drain default is 0 s and must be raised). No production host as last known (2026-10-10); production voice ran on a container on the owner's Mac. LiveKit's hosted agents have no Tokyo region; the notes favour a self-hosted Tokyo box. | `interview-agent/README.md` |
| Worker contract | Agent name `RoboApply-Interview` on both sides (`INTERVIEW_ENGINE_AGENT_NAME`), same `LIVEKIT_AGENT_CALLBACK_SECRET` on both sides, `INTERVIEW_ENGINE_CALLBACK_BASE_URL` = the public API origin (default is localhost, which loses every callback). The worker reads only `interview-agent/.env.local`. | `server/src/interview-engine/config.ts` |
| Parley pilot | WebRTC alternative to LiveKit for practice, code on main behind `INTERVIEW_ENGINE_PARLEY_PILOT` (off by default, `server/src/interview-engine/parley/parleyConfig.ts`). Service lives in a separate private repo; production blocked only on a VM (last known 2026-10-10). Turn-on script: `scripts/parley-vercel-env.sh`. | `scripts/parley-provision.ts` |
| Browser extension | GoApply publishes to Edge Add-ons first; RoboApply to the Chrome Web Store. Whether either listing is live is unverified (`NEXT_PUBLIC_EXT_ID`, `NEXT_PUBLIC_CN_EXT_ID`). | [`docs/runbooks/edge-addons-publish.md`](../runbooks/edge-addons-publish.md) |
| GoApply mainland stack | Kit ready, nothing deployed; blocked on the owner's legal filings (ICP etc.), not code. On Vercel GoApply is closed by `ALLOWED_BRANDS=roboapply`; remove it only on the day GoApply launches. | [`docs/runbooks/cn-deploy.md`](../runbooks/cn-deploy.md), [`deploy/cn/README.md`](../../deploy/cn/README.md) |

Note: the root `deploy/` folder holds only the mainland kit (`deploy/cn/`); the voice-worker recipes are under `interview-agent/deploy/`.

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Every `/api/v1/*` returns 500 right after a deploy; `/api/health` is fine | Function failed at init: a `STARTUP` assertion (copilot model cannot stream tools, residency) or an ESM/bundle invariant (1.3) | `vercel logs --deployment <url> --json`; promote the previous deployment (5.5); then fix env or code. `FLAG_ROBOAPPLY_COPILOT=false` is the emergency way past the copilot check. |
| "Cannot use import statement outside a module" / ENOENT `logs/` in function logs | Section 1.3 invariant broken | Restore `"type": "module"`, `server/**` in `includeFiles`, or the `VERCEL` guard. |
| Signed-in `/` does not redirect, localized landing lacks its path header | `'/'` dropped from the proxy matcher | Restore it in `proxy.ts`. |
| All cron routes 401 | `CRON_SECRET` unset | Owner decision first: setting it starts all 16 schedules at once, including LLM enrichment (`ENRICH_DAILY_JOBS`, default 8,000/day per market) and mail. Set budgets, then the secret. |
| LLM calls slow, `LLM_SERVICE` "Auto-selected LLM fallback route" warnings | Primary provider credentials dead or refused (OpenRouter 401 "User not found" on the local key since 2026-10-20; OpenRouter 403 "provider Terms Of Service" for Google models in prod, 2026-10-13) | Replace or top up the key; route Google models as `google/...` (direct); check the `AppConfig` override, not just env. |
| Practice plans fall back to the catalog panel; JSON cut off; `MAX_TOKENS` / `finish_reason=length` | Reasoning-token starvation: Gemini and DeepSeek count thinking against the output cap | Thinking reserve exists (`GOOGLE_REASONING_MAX_TOKENS`, default 8000, commit 9b5d87cd; DeepSeek equivalent). Raise it or the agent's cap. |
| Agent route returns 502 `agent_failed` after 3 retries | Same as above with empty content | Same. |
| `POST /interview-engine/sessions` 503, body "has no supported equivalent in LiveKit" | `LLM_INTERVIEW_MODEL` not in `ALIGNED_INTERVIEW_MODELS` (`server/src/interview-engine/config.ts`) | Choose a listed model, or probe the gateway with `npm run verify:llm` before adding one. Never add an unserved id: it type-checks and then dies silently in the room. |
| Interview room silent, "agent never joined" | No worker registered under the agent name | Start/host the worker; check the agent name matches on both sides. |
| Interview works but report is empty | `LIVEKIT_AGENT_CALLBACK_SECRET` differs, or `INTERVIEW_ENGINE_CALLBACK_BASE_URL` points at localhost | Align both sides. |
| Mail fails with 403 "domain not verified" | Sender domain (`roboapply.io`) has no Resend DNS records | Keep `EMAIL_FROM` on the verified `robohire.io` sender, or verify `roboapply.io` in Resend first. |
| Checkout never opens, plans show "can't be bought yet" | Stripe key or webhook secret missing, or a live key outside production | Owner sets keys and the live webhook (`docs/jobright-clone/market/STRIPE_TEST_RECIPE.md`). |
| Resume upload works but the original cannot be downloaded | S3 key cannot write ("Access Denied") | Owner issues a write key; parsed resume is kept meanwhile. |
| Resume upload 422 `parse_failed`, empty `Authorization: Bearer` to a provider | `SystemLLMKey` rows encrypted under another `FIELD_ENCRYPTION_KEY` | Re-enter the key through admin LLM settings or rely on env keys; `LLMService` now fails loudly on a missing credential instead of sending an empty one. |
| Users bounced to `/login` repeatedly | Stale session cookie (401 → `auth_expired` redirect in `lib/api/client.ts`), or a TTL env value without a unit suffix in older code | Re-login unblocks; TTLs accept `s/m/h/d/w` (`server/src/lib/parseDuration.ts`). |
| Admin cannot sign in: 403 `not_a_seeker_account` | Admin `User` has no `SeekerProfile` row | Give the admin a `SeekerProfile`. |
| Local dev: long API call dies at exactly 30 s with ECONNRESET | `next dev` proxy cap | Already set: `experimental.proxyTimeout: 600_000` in `next.config.mjs`; never set it to 0. Dev only. |
| Local dev sends mail or push to real people | Main checkout `.env` is production and the in-process crons run | `ROBOAPPLY_CRON_DISABLED=true` in `.env.local` (section 4). |
| Worker ETIMEDOUT and Neon timeouts at the same moment on the owner's Mac | VPN tunnel restart, not code | Wait or reconnect; registration connect is capped at 10 s. |
| `next build` stops with SecurityFatalError when run by an agent | Next's agent upgrade reminder for an applicable advisory | Retry once; never run the `next upgrade` command it prints. Never build in the same `.next` as a running `next dev`. |

## 9. Deeper documents

- [`docs/ENGINEERING_PLAN.md`](../ENGINEERING_PLAN.md): extraction rationale and the first deploy runbook. Stale in places: says 7 crons (16 now), `includeFiles: server/dist/**` (now `server/**`), DB split "later" (done 2026-07-02).
- [`docs/jobright-clone/HANDOFF.md`](../jobright-clone/HANDOFF.md): the jobright-clone release record, safe verification recipe, owner items (section 6). Its "nothing is on `main`" line is stale: PR #4 merged 2026-10-12.
- [`docs/jobright-clone/orch/parity-verify-results.md`](../jobright-clone/orch/parity-verify-results.md): what was verified on both brands and the "not configured" list.
- [`docs/jobright-clone/market/STRIPE_TEST_RECIPE.md`](../jobright-clone/market/STRIPE_TEST_RECIPE.md), [`ALIPAY_CUTOVER.md`](../jobright-clone/market/ALIPAY_CUTOVER.md): payment rails.
- [`docs/job-search/RUNBOOK.md`](../job-search/RUNBOOK.md): job-search quotas, kill switches, providers.
- [`docs/runbooks/`](../runbooks/): mainland deploy, Edge Add-ons publishing.
