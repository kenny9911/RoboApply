# INT-13 handoff (after review)

**Status: complete.** All ten items are implemented in `/Users/kenny/code/RoboApply/.claude/worktrees/wp-INT-13` (branch `wp/INT-13`), and all four gates are green at default timeouts. Nothing is committed, pushed or stashed. I did not launch anything: no dev server, build or browser was run from this bundle, so launching the new version is the orchestrator's step after the merge.

Two review findings still need edits to files outside this bundle (`deploy/cn/Dockerfile.web`, `docs/runbooks/cn-deploy.md`, `server/src/middleware/userActivity.ts`); they are under Requests.

## Review resolution

1. **CI root job fails on a clean runner (high) — fixed.**
   - Reproduced on a copy of the worktree with no `.env` files: 89 files failed, 458 passed.
   - `ci.yml` now gives the root job `DATABASE_URL: postgresql://ci@127.0.0.1:1/ci`. The same copy then ran 547 passed, 1 skipped, exit 0.
   - I left the password out of the placeholder (the review suggested `ci:ci@…:5432`), because the kit's own secret scan rejects any Postgres URL with a password. Port 1 is closed on a runner, so a test that reaches the client is refused at once.
   - The old `not.toMatch(/DATABASE_URL/)` assertion is replaced by one that allows exactly that line in the root job's `env` block and no other database or secret setting.

2. **CN web image ignores the two new build arguments (medium) — not fixable here; request kept.**
   - `deploy/cn/Dockerfile.web` is outside this bundle's ownership, so the edit is a Request.
   - Added the assertion the review asked for in `deployKit.test.ts`: every build argument the workflow passes must be declared in the web build stage, except names in a `PENDING_IN_DOCKERFILE_WEB` list (currently the two new ones).
   - Once the Dockerfile declares them, that test fails until the two names are deleted from the list.

3. **`POST /v2/search/run` answers 404 while two web callers remain (medium) — confirmed; merge-order request kept.**
   - `CommandPalette.tsx:117` and `hooks/useJobSearch.ts:23` still call it in this worktree; both are owned by INT-12 / INT-10.
   - `userActivity.ts:12,14` still maps the two retired paths; unowned.

4. **`.env.example` lacks INT-11's names (low) — fixed.**
   - Checked the names in `wp-INT-11` (read only).
   - Added `# CORS_PREVIEW_HOSTS=` and the `TAKEDOWN_CONTACT=` / `CN_TAKEDOWN_CONTACT=` pair to `.env.example`.
   - Added `CN_TAKEDOWN_CONTACT=` to `cn.env.example` and `cn.web.env.example` (INT-11's web legal source reads it too), and named it in the `k8s/web.yaml` header comment.

5. **Stored weekly summary still shown after the GoApply mode goes off (low) — fixed, more precisely than proposed.**
   - `refresh()` now records the job rows the prompt named in `metrics.namedJobIds`. `getWeekly()` shows the stored text only while the viewer may still read each of them.
   - A summary that named only the user's own import stays visible; a named row that no longer exists does not hide it.
   - A summary stored before the marker existed is hidden only on GoApply with the mode off.
   - Four new tests, including write under `partner_deeplink` then read under `off`.

6. **`ARCHITECTURE.md` rows for the two INT routes (low) — fixed.**
   - Reworded against `wp-INT-03` and `wp-INT-02`.
   - `/ext/answers/save` → `201 { saved: true, questionKey }`; a protected type → `422 invalid_request` with `details.reason = 'protected_question'` and `details.type`.
   - `/credits/cancel/survey` → `204`, no body, and at least one of `reason` / `note` is required.

7. **CN runbook contradicts the kit in four places (low) — confirmed; unowned; request kept.**

No unowned edits were made, so nothing was reverted.

## Per-item result

1. **Retire legacy job score/detail route — done.**
   - Deleted `v2/routes/jobs.ts`, `jobs.score.test.ts` and `features/match/legacyView.ts`.
   - `legacyRoute.test.ts` is kept and rewritten, because it held the only tests of `scorerRoute.ts`.
   - `legacyJobScope.ts` keeps `legacyJobVisible` and `loadLegacyVisibleJob`.
   - The unmounted-route tests keep the paths at 404 and scan for importers.

2. **Retire `/v2/search` — done (server part).**
   - Deleted `v2/routes/search.ts` and `RAJobIndexService.ts`.
   - `raResumeSeed.ts` and `raOnboardingDraft.ts` are kept; both are live and never imported the index service.
   - `RAInsightService` names a tracked job in the prompt only when `legacyJobVisible` allows it, and now re-checks the stored summary on every read (finding 5).
   - `/v2/discover` stays mounted.

3. **Dead V1 code — done.**
   - Deleted: `RoboApply{Author,Digest,IntentParser}Agent.ts`, `SeekerResumeTailorAgent.ts`, `RAOnboardingPrefExtractAgent.ts`, `roboapply/lib/{cacheKey,localTime}.ts`, `v2/lib/raQueueMessages.ts`, and six `lib/fixtures` files with their re-exports.
   - Kept, with remaining importer:
     - `raOnboardingMessages.ts` ← `raOnboardingDraft.ts`, `raOnboardingIngestRows.ts`
     - `raOnboardingDraft.ts` ← `raResumeSeed.ts`, `RAOnboardingResumeSeedAgent.ts`, `raCrossBankMatch.ts`
     - `raResumeSeed.ts` ← `features/onboarding/defaults.ts`
     - `RAJobMatchScorerAgent.ts` ← `RACrossBankSearchService.ts`, `RAResumeAIService.ts`

4. **Stale comments — done.** `features/index.ts`, `rateCard.ts`, and one line in `cron/handlers.ts`. No behaviour change.

5. **`next.config.mjs` and `app.ts` — done; the CN half is inert until Request 1.**
   - **Remote pattern:** one entry for `CN_PUBLIC_ASSET_BASE_URL`, only for a plain https URL of a real host, never a wildcard.
   - **`deploymentId`:** not set in config, because this Next version fails the Vercel build when a config value disagrees with the platform's. The CN workflow passes `NEXT_DEPLOYMENT_ID=<sha>` as a build argument instead.
   - **Trust proxy:** env-driven. `TRUST_PROXY` wins; unset, it stays `true` on Vercel and is `1` elsewhere.
   - **SIGTERM/SIGINT:** stops the cron mirror, stops accepting connections, drains (305 s in production, 1 s in dev), disconnects Prisma, exits.

6. **CN CI and worker manifests — done.**
   - `deploy-cn.yml` builds `interview-agent/deploy/cn/Dockerfile`.
   - `deploy/cn/k8s/worker.yaml` is the one manifest; `interview-agent/deploy/cn/k8s.yaml` is a pointer.
   - All eight env names are confirmed in `interview-agent/src/backends`.

7. **Root CI workflow — done.** Three jobs (root, extension, interview-agent), no secrets, no deploy, and the placeholder `DATABASE_URL` on the root job.

8. **`package.json` — done.**
   - `@vitest/coverage-v8@5.0.3` is added, lockfile only; `node_modules` was not touched.
   - `smoke:ingest` is added and was not run.
   - `check:llm-costs` is clean (48 models).

9. **Env audit — done.** About 120 names added, eight unread names removed, `RA_CROSSBANK_DAILY_CAP` corrected to `RA_CROSSBANK_DAILY_CALL_CAP`, and INT-11's three names added.

10. **Plan docs — done.** `TASK_PLAN.md` status, `ARCHITECTURE.md` §3.7 agent routes, and the two INT route rows corrected.

## Files

**Created**
- `.github/workflows/ci.yml`
- `server/src/roboapply/schedulers/processLifecycle.ts`
- `server/src/roboapply/schedulers/processLifecycle.test.ts`

**Deleted (17)**
- `server/src/roboapply/v2/routes/{jobs.ts, jobs.score.test.ts, search.ts}`
- `server/src/roboapply/v2/services/RAJobIndexService.ts`
- `server/src/features/match/legacyView.ts`
- `server/src/roboapply/agents/RoboApply{Author,Digest,IntentParser}Agent.ts`
- `server/src/roboapply/engine/agents/SeekerResumeTailorAgent.ts`
- `server/src/roboapply/v2/agents/RAOnboardingPrefExtractAgent.ts`
- `server/src/roboapply/lib/{cacheKey,localTime}.ts`
- `server/src/roboapply/v2/lib/raQueueMessages.ts`
- `lib/fixtures/{queue,activity,integrations,savedSearches,insights,keywords}.ts`

**Modified**
- `server/src/app.ts`, `app.legacyRoutes.test.ts`, `features/index.ts`, `cron/handlers.ts`, `lib/rateCard.ts`
- `server/src/features/match/legacyRoute.test.ts`
- `server/src/roboapply/v2/routes/{index.ts, index.unmounted.test.ts, legacyJobScope.test.ts}`
- `server/src/roboapply/v2/services/RAInsightService.ts`
- `server/src/roboapply/v2/lib/{legacyJobScope, raOnboardingDraft, raOnboardingMessages, raResumeSeed}.ts`
- `server/src/roboapply/v2/agents/{RATaskSettings.test.ts, RAJobMatchScorerAgent.ts}`
- `lib/fixtures/index.ts`, `next.config.mjs`, `package.json`, `package-lock.json`, `.env.example`
- `.github/workflows/deploy-cn.yml`
- `deploy/cn/{README.md, cn.env.example, cn.web.env.example, compose.yaml, k8s/worker.yaml, k8s/web.yaml}` (`web.yaml` is a comment only, new in this pass)
- `interview-agent/deploy/cn/{Dockerfile, README.md, k8s.yaml, worker.env.example}`
- `__tests__/deploy/deployKit.test.ts`
- `docs/jobright-clone/{TASK_PLAN.md, ARCHITECTURE.md}`

## Tests run

| Gate | Command | Result |
|---|---|---|
| 1 | `npx vitest run __tests__/deploy server/src/roboapply/schedulers server/src/app.legacyRoutes.test.ts server/src/roboapply/v2/routes/{index.unmounted,legacyJobScope}.test.ts server/src/features/match/legacyRoute.test.ts server/src/roboapply/v2/agents server/src/features/tracker/insights.test.ts server/src/cron` | 15 files, 296 passed |
| 2 | `npm run typecheck:server`, `npm run typecheck:web` | both clean |
| 3 | `npm run check` | all six checks clean |
| 3 | `node scripts/gen-cn-cronjobs.mjs --check` | matches `vercel.json` |
| 4 | `npx vitest run --exclude ".claude/**"` (default timeouts) | 548 files, 10024 passed, 1 skipped, 26 todo |
| CI check | clean copy, no `.env`, no `DATABASE_URL`: `npx vitest run` | 89 files failed (the review's finding) |
| CI check | same copy with `DATABASE_URL=postgresql://ci@127.0.0.1:1/ci` | 547 files passed, 1 skipped; 10017 passed, 8 skipped, 26 todo |

Extension and interview-agent suites were not run (no change under `extension/` or `interview-agent/src`).

## Requests

**Orchestrator / unowned files**
1. `deploy/cn/Dockerfile.web`: in the build stage add `ARG CN_PUBLIC_ASSET_BASE_URL=` and `ARG NEXT_DEPLOYMENT_ID=`, and export both in the `ENV` block before `npm run build:web`. Then delete both names from `PENDING_IN_DOCKERFILE_WEB` in `__tests__/deploy/deployKit.test.ts`. Until then the GoApply image host and the skew id do nothing on the mainland build.
2. `docs/runbooks/cn-deploy.md`:
   - Line 21: the worker image is built from `interview-agent/deploy/cn/Dockerfile`.
   - Line 99: `docker build -f interview-agent/deploy/cn/Dockerfile -t goapply-worker:local interview-agent`.
   - Line 210: the API drains on SIGTERM for up to 305 s.
   - Line 216: the remote pattern exists and the deployment id is a build argument.
   - Line 71: add `CN_TAKEDOWN_CONTACT` (optional) to the legal-page list.
3. `server/src/middleware/userActivity.ts` lines 12 and 14: point them at `/feed/query` and `/jobs/:id/score`, or delete them.
4. Join J6: `hooks/useJobSearch.ts` and the search slice in `lib/api/v2/_real.ts` are dead after the merge; `lib/api/v2/types.ts:20` still describes the six deleted fixture types.
5. Comment-only leftovers: `raResumeAIMessages.ts:15,595`, `raJobSearch.ts:6`, `v2/types/onboarding.ts:48,229`.
6. Run `npm install` in the clone worktree to install `@vitest/coverage-v8`.

**Other bundles**
- **INT-10 / INT-12:** merge together with INT-13. After the merge, grep for `search.run` (expect only the stub and its test) and open the command palette on both brands.
- **INT-01:** `legacyAuth.test.ts` reaches the real Prisma client (`GET /auth/me` → `EntitlementService.compute`); inject a fake.
- **INT-09:** same for `externalRoutes.practice.test.ts` (`hasLiveConsent`).
- **INT-11:** your three env names are now in `.env.example` and the two mainland examples; do not add them again.
- **INT-03:** send any agent route `ARCHITECTURE.md` §3.7 still lacks.

**Owner**
- Set `TRUST_PROXY=1` on Vercel once the edge behaviour is confirmed; until then Vercel is unchanged.
- Set the repository variable `CN_PUBLIC_ASSET_BASE_URL` before the first CN web build.
- `LIVEKIT_AGENT_NAME` / `CN_LIVEKIT_AGENT_NAME` are read but never used for dispatch; wire or drop the read in `interview-engine/config.ts`.

## i18n keys
None added, none obsoleted.

## Env vars introduced
- `TRUST_PROXY`
- `SHUTDOWN_DRAIN_TIMEOUT_MS`
- Build-time, CN web image only: `NEXT_DEPLOYMENT_ID` (and `CN_PUBLIC_ASSET_BASE_URL`, now read by `next.config.mjs`).
- CI only: a placeholder `DATABASE_URL` in the root job of `ci.yml`.
- Documented for INT-11, not read by this bundle's code: `CORS_PREVIEW_HOSTS`, `TAKEDOWN_CONTACT`, `CN_TAKEDOWN_CONTACT`.
- Renamed in the docs only: `RA_CROSSBANK_DAILY_CAP` → `RA_CROSSBANK_DAILY_CALL_CAP`.

## Known gaps
- `actionlint` is not installed; workflow validity rests on a YAML parse and the tests.
- A past week's summary that is hidden by the mode switch stays hidden while the mode is off, because refresh writes only the current week.
- A tracker entry whose job row was deleted is still named from its stored snapshot (unchanged behaviour, not in the review).
- No autoscaler on the CN worker; scale with `CN_WORKER_REPLICAS`.
- The env audit used pattern extraction plus manual checks; a name read through an unusual indirection could still be missing.
- `gen-cn-cronjobs.mjs --check` prints a note that `EXCLUDED_CRONS.billing-friday-nudge` is stale; harmless and left as is.
- `next.config.mjs` keeps a dev-only `/api/auth/:path*` rewrite to a route the wave-5 note says does not exist; left as is.