# PAR-1

Foundation of the D5 parity wave, after the independent review. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-1`, branch `wp/PAR-1`, base `84dfc24`. Nothing committed, pushed or stashed. No schema change, no new dependency, no i18n change, no dev server or browser run.

All five items are done and all six review findings are resolved (four in code, two as explicit items for the orchestrator because the files are not PAR-1's). Everything PAR-1 owns is green (22 test files, 983 tests). Both typechecks pass for the whole repository. The full suite has the same 95 expected failures in other bundles' files and the same 12 pre-existing ones.

**STOP, read first (orchestrator and owner). PAR-1 alone refuses the API boot on every `NODE_ENV=production` deployment that has no `ALLOWED_BRANDS`, Vercel previews included.** Reproduced in this worktree (`runStartupAssertions`, production, shared LLM variables only): `AssistantModelStartupError: goapply: Provider openrouter is not allowed for this brand`. With `ALLOWED_BRANDS=roboapply` the same process boots. So:

1. Before the wave branch is pushed at all, set `ALLOWED_BRANDS=roboapply` on every Vercel environment of the project (Production and Preview). Remove it deliberately when GoApply is to go live.
2. Do not push or deploy between the PAR-1 merge and the PAR-2 merge (the effective LLM profile) and the PAR-5 merge (startup).
3. Add the items of "Requests → orchestrator" O-1 to O-4 to the bundles before PAR-2..PAR-9 start. Three of them are behaviour no bundle item covers today.

## Items

### 1. [P0] brandEnv: `CN_X` is an optional override, else the shared value: done

`server/src/platform/brand/brandEnv.ts` rewritten; signature of `brandEnv(brand, name, env)` kept; RoboApply reads unchanged (it never reads a `CN_` value).

GoApply, by class of name:
- **Brand-own** (`BRAND_OWN_ENV`, the 18 names of plan §3.1): `CN_<NAME>` only.
- **Grouped** (`BRAND_ENV_GROUPS`: `voice`, `speech`, `storage`, `push`, members and anchors exactly as plan §3.1): when every `CN_` anchor of the group is set, every member is read as `CN_<NAME>` with no fallback; otherwise every member is read unprefixed.
- **Everything else**: `CN_<NAME> ?? <NAME>`, per key.

`brandEnvFlag` inherits. Exports (all re-exported from `platform/brand/index.ts`): `brandOwnEnv`, `brandEnvSource`, `brandStack`, `brandUsesSharedStack`, `cnResidencyStrict`, `cnLlmDomesticOnly`, `BRAND_OWN_ENV`, `BRAND_ENV_GROUPS`, `BRAND_ENV_GROUP_IDS`, `BRAND_STACK_IDS`, the types `BrandEnvGroup`, `BrandEnvGroupId`, `BrandStackId`, `BrandEnvSource`, and, new after the review, `brandEnvGroupProblems` with the type `BrandEnvGroupProblem`.

Semantics the consuming bundles should know:
- `brandStack(roboapply, *)` is `'shared'` and `brandUsesSharedStack(roboapply)` is `true`. `brandStack(brand, 'llm') === 'own'` is true only for GoApply with `CN_LLM_PROVIDER` or `CN_LLM_MODEL`.
- `brandEnvSource`: `'own'` = a variable only this brand reads; `'shared'` = the unprefixed infrastructure value; `'none'` = nothing set.
- `speech` needs BOTH `CN_INTERVIEW_ENGINE_STT_MODEL` and `CN_INTERVIEW_ENGINE_TTS_MODEL` to become own.
- `brandEnvName(brand, name)` is unchanged: the brand's own (override) name. A blank `CN_` anchor counts as unset.
- **`brandEnvGroupProblems(brand, env)`** (review finding 4): for each group that is NOT GoApply's own although at least one `CN_<member>` is set, returns `{ group, set: ['CN_…'], missingAnchors: ['CN_…'] }` (variable names only, never a value). Examples: `CN_S3_ENDPOINT` + keys without `CN_S3_BUCKET`; `CN_LIVEKIT_API_KEY` or `CN_VOICE_PROVIDER` without `CN_LIVEKIT_URL`; one speech model of the pair; `CN_VAPID_PRIVATE_KEY` without the public key. The read rule is unchanged (the group runs wholly on the shared names, as the plan says); this is the detection, so the fallback to the shared bucket is never silent. `[]` for RoboApply, and for a group that is wholly unset or anchored (an anchored group with a missing member is "not configured", which the module that needs it already reports).
- **`brandUsesSharedStack` is per key for the text model** (review finding 6): with GoApply's own LLM stack, it also returns true when an unprefixed routing setting is set without its `CN_` twin: `LLM_PROVIDER`, any selector of `MODEL_ENV` (`LLM_MODEL`, `LLM_VISION_MODEL`, `LLM_FAST`, …) or any `LLM_*MODEL` task model (`LLM_INTERVIEW_LIVE_MODEL`, `LLM_CAMPUS_MODEL`, …). Tuning (`LLM_TIMEOUT_MS`, retries, reasoning effort, `LLM_PII_KINDS`) does not count. Not under `cnLlmDomesticOnly`, where every route must be a mainland one. It reads the environment only: an admin override in the database (`llm_stack.*`) is invisible to it (see Request P5-5).

**Precedence (document won over the item):** the item says `brandUsesSharedStack` is true when "CN_EMAIL_TRANSPORT not aliyun_dm". Plan §3.1 says "true when any group above, or email, resolves to the shared stack". With `CN_EMAIL_TRANSPORT=none` no email is sent, so email does not resolve to the shared stack. Implemented per the plan: email counts as shared unless the transport is `aliyun_dm` or `none`.

ACCEPT, all tested: GoApply with only `S3_BUCKET` set reads the shared bucket; with `CN_S3_BUCKET` set and `CN_S3_ACCESS_KEY_ID` unset the key is `undefined` (never the shared key, nor the `AWS_` alias); `COOKIE_DOMAIN` and `LEGAL_ENTITY_NAME` never cross brands; RoboApply never reads a `CN_` value.

Tests: `brandEnv.test.ts`, a table over own / grouped / per-key names for both brands, plus `brandEnvSource`, `brandStack`, `brandUsesSharedStack` (now with the per-key LLM table and the wall), `brandEnvGroupProblems` (seven half-set shapes, the clean shapes, names-only), the two strict predicates and the index re-exports (165 tests).

### 2. [P0] Capability requirements: done

`server/src/platform/flags.ts`:
- `cnRecruitmentInfoMode`: `off` only for the literal `off`; `partner_deeplink` when set; otherwise `licensed` (unset and unknown values included).
- **`cnRecruitmentInfoModeProblem(env)`** (review finding 5): returns the raw value when `CN_RECRUITMENT_INFO_MODE` is set and is not one of `off | partner_deeplink | licensed` (case and spaces ignored), else null. `CN_RECRUITMENT_INFO_MODE=false` therefore still leaves the feed on (the plan's mapping, kept), but it is now detectable so startup can say so. See Request P5-6 and the owner question.
- `campusCalendarAllowed`: `brand.flags.campusCalendar`, and false for cn only when `CN_CAMPUS_CALENDAR_ENABLED` is set and parses false.
- `aiTextConfigured`: market cn → `contentSafetyReadiness(env).usable`, else true. `ai.vision` returns the same. `cnLlmConfigured`, `CN_LLM_PROVIDER_KEYS` and the `checkLlmEgress` import are deleted.
- `emailConfigured` (cn): `aliyun_dm` → the three `ALIYUN_DM_*` keys; `none` → false; anything else → `RESEND_API_KEY`, no `CN_EMAIL_FROM` requirement.
- `webPush`: `vapidUsable(brand, env)` for both brands.
- Payments: `cnPaymentsEnabled` replaced by exported `cnPaymentsKilled(env)`. `pay.alipay` = rail listed AND not killed AND `ALIPAY_CALLBACK_SECRET`. `pay.wechatpay` = today's merchant requirements AND not killed.
- `voiceMediaAvailable` unchanged in code; it follows the `voice` group through `brandEnv`.

ACCEPT, tested as a matrix in `flags.test.ts` ("brand parity matrix (D5)"): with exactly the ten shared variables of the item and no `CN_` value, every key `resolveFlags` returns true for RoboApply is true for GoApply except `h1bHistory`, `eeoAnswers`, `fx.reference`, `pay.stripe`, `auth.google`, `auth.line`. Each off switch turns exactly its capabilities off on GoApply and changes nothing on RoboApply.

Tests: `flags.test.ts`, 85 tests (both drift matrices green; 17 new cases for the mode problem).

### 3. [P0] Registry defaults: done

`server/src/platform/brand/registry.ts`, then `npm run gen:brand`:
- goapply `flags.coaching`, `interviewVoice`, `webPush`, `student` → `true`.
- goapply `authMethods` → `['email_password', 'phone_otp', 'wechat']`.
- goapply `jobProviders` stays `['bank_gohire', 'user_import']`.
- roboapply `jobProviders` → `['activejobs', 'bank_robohire', 'jsearch', 'user_import']` (`linkedin` removed).
- Comments: `email.transport` is the preferred transport; `llmProfile` is the profile used when the brand has its own provider.

ACCEPT: `node scripts/gen-brand-mirror.mjs --check` reports the mirror up to date; `lib/brand/registry.generated.ts` carries the same values; GoApply's list never contains `jsearch`. The `JobProvider` type union still contains `'linkedin'` on purpose (Request P7-3).

Tests: `registry.test.ts` 36, `brandParity.test.ts` 5, `brandInvariants.test.ts` 25, `__tests__/brand/*` unchanged and green.

### 4. [P1] Every deployment serves both brands unless narrowed: done

`allowedBrands()` returns both brand ids when `ALLOWED_BRANDS` and `BRAND_LOCK` are unset, in every environment. Changed in `server/src/platform/brand/runtime.ts` AND in its web twin `lib/brand/runtime.ts` (the proxy uses the twin).

**After the review (finding 2): a scope variable that is set but names no brand fails closed.** Both twins now read the scope through one function (`readScope`):
- `BRAND_LOCK` valid → that brand (unchanged).
- `ALLOWED_BRANDS` with at least one valid id → the valid ids (unchanged; empty entries such as a trailing comma are ignored).
- `ALLOWED_BRANDS` or `BRAND_LOCK` set, and no valid id anywhere (`roboaply`, `robo-apply`, `nonsense`, `,`, `BRAND_LOCK=gopply`) → `[roboapply]` only, in every environment. It used to fall through to both brands, which would have opened `goapply.top`, its crons and its queue drains on the very deployment the owner meant to keep closed. On the mainland kit the same typo leaves RoboApply as the only brand, which the residency check refuses at boot (`intl_brand_on_mainland`): loud.
- Both unset or blank → both brands (item 4, unchanged).
- New export in both twins (server one re-exported from `platform/brand/index.ts`): `allowedBrandsProblem(env)` → `null`, or `{ invalid: [{ variable: 'BRAND_LOCK' | 'ALLOWED_BRANDS', token }], failedClosed, serves }`. It also names the bad token of a partly wrong list (`roboapply,gopply` is narrowed to `roboapply`, `failedClosed: false`) and a mistyped `BRAND_LOCK` beside a valid `ALLOWED_BRANDS`.

One behaviour to know: outside production an unparseable value used to mean both brands at the base; it now means RoboApply only there too (one rule for every environment). No test or script in the repository sets such a value.

ACCEPT, tested: `NODE_ENV=production` with neither variable resolves `goapply.top` to GoApply and serves it; `ALLOWED_BRANDS=roboapply` refuses it as before; `ALLOWED_BRANDS=goapply` refuses RoboApply.

Tests: `runtime.test.ts` 42 (fail-closed table over five bad values × three environments, problem shapes, mainland case), `__tests__/lib/brandFromHost.test.ts` 45 (the twin-agreement table now covers 17 configurations and compares `allowedBrands`, `brandLock` and `allowedBrandsProblem`).

Consequences outside PAR-1's paths: Requests O-1 to O-4.

### 5. [P1] Public brand payload parity test and fallout list: done

No route change in `server/src/features/brand/` (one comment in `contract.ts`).
- `brand/routes.test.ts`: the two-host comparison over the shared-only env, on the dev hosts and on the production hosts with no deployment scope: flag matrix, `authMethods` beginning with `email_password`, `paymentRails` containing `alipay` when `ALIPAY_CALLBACK_SECRET` is set (empty without it or with the kill switch; never `stripe`), off switches reaching the payload for GoApply only.
- `features.test.ts`: the "capability on" env sets no `CN_` value (asserted). `mount.test.ts`: `CN_PAYMENTS_ENABLED=true` removed. `seams.test.ts`, `boundary.test.ts`: unchanged and green.
- The fallout list is "Red tests for other bundles" below.

## Files changed

19 files, all inside PAR-1's owns (checked against `parity-bundles.json`; the reviewer found no unowned edit and none was added):

- `server/src/platform/brand/brandEnv.ts`, `brandEnv.test.ts`, `index.ts`
- `server/src/platform/brand/registry.ts`, `registry.test.ts`
- `server/src/platform/brand/runtime.ts`, `runtime.test.ts`, `brandContext.test.ts`
- `server/src/platform/flags.ts`, `flags.test.ts`
- `server/src/features/brand/contract.ts` (comment), `routes.test.ts`
- `server/src/features/features.test.ts`, `mount.test.ts`
- `lib/brand/registry.generated.ts` (generated), `lib/brand/runtime.ts`, `lib/flags.ts` (comment)
- `__tests__/lib/brandFromHost.test.ts`, `__tests__/lib/brandParity.test.ts`

Touched in the review pass: `brandEnv.ts`, `brandEnv.test.ts`, `index.ts`, both `runtime.ts` twins, `runtime.test.ts`, `brandFromHost.test.ts`, `flags.ts`, `flags.test.ts`.

New import to know about: `brandEnv.ts` imports `MODEL_ENV` from `server/src/lib/llm/llmStackConfigSchema.ts` (a PAR-2 file with no imports of its own, so no cycle). It is the one list of model selector variables; see Request P2-4.

## Tests run

| Command | Result |
|---|---|
| Baseline before any edit: `npx vitest run --exclude ".claude/**"` | 12,594 tests: 12,570 passed, 12 failed (the pre-existing ones) |
| `npx vitest run server/src/platform/brand/brandEnv.test.ts` | 165 / 165 |
| `npx vitest run server/src/platform/flags.test.ts` | 85 / 85 |
| `npx vitest run server/src/platform/brand/runtime.test.ts __tests__/lib/brandFromHost.test.ts` | 87 / 87 (42 + 45) |
| Every test file PAR-1 owns (counted from the full run) | 22 files, 983 / 983 |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `node scripts/gen-brand-mirror.mjs --check` | up to date |
| Final: `npx vitest run --exclude ".claude/**"` | 12,815 tests: 12,696 passed, 107 failed = 12 pre-existing + 95 expected red in other bundles' files (the same 47 files and counts as before the review pass; 49 tests added, all passing) |
| One-off reproduction of finding 1 (temporary test, deleted) | production + shared LLM only: no scope → `AssistantModelStartupError` (GoApply, "Provider openrouter is not allowed for this brand"); `ALLOWED_BRANDS=roboapply` → boots; `ALLOWED_BRANDS=roboaply` (typo) → boots as RoboApply only |

## Red tests for other bundles

95 failures in 43 files (unchanged by the review pass). Each fails because of a PAR-1 default or the `brandEnv` fallback. Most "mode off" tests never set the mode: they relied on unset meaning off.

**PAR-2** (14)
- `server/src/features/cn/campus/__tests__/routes.test.ts` (1) "GoApply with the mode off and no counsel switch: 404 too": the campus calendar is on by default; assert 200 with no `CN_` value and 404 only with `CN_CAMPUS_CALENDAR_ENABLED=false`.
- `server/src/features/jobs/enrich/agent.test.ts` (1) "never an unprefixed key": GoApply falls back to `LLM_ENRICH_MODEL` / `LLM_MODEL`; the domestic-prefix refusal applies only under `CN_LLM_DOMESTIC_ONLY`.
- `server/src/features/jobs/enrich/service.test.ts` (1) "logs cost under the brand system user": `RA_SYSTEM_USER_ID` is per key, so GoApply uses the shared id when `CN_RA_SYSTEM_USER_ID` is unset; the sentinel only when neither is set.
- `server/src/features/offers/aiGate.test.ts` (1) "no CN text model configured: false": `ai.text` is true without a CN model; make the false case an unusable content-safety filter (`CN_CONTENT_SAFETY_PROVIDER=nonsense`) or `FLAG_GOAPPLY_AI_TEXT=false`.
- `server/src/lib/llm/llmModels.brand.test.ts` (3): "GoApply never falls back to the unprefixed variables" and "never reads RoboApply's blob" → assert the per-key order of plan §3.3; "requireLlmCallBrand refuses to guess only in production on a deployment that also serves GoApply" → the rule of Request O-2.
- `server/src/services/llm/LLMService.brand.test.ts` (5): the three "ai_unavailable with no CN model" cases → GoApply routes on the shared stack with the global profile; "a RoboApply-only deployment keeps the default brand" → set `ALLOWED_BRANDS=roboapply`; "explains per-task resolution" → GoApply rows show the shared selector.
- `server/src/services/llm/LLMService.streaming.test.ts` (2): "never using the RoboApply copilot model" → GoApply uses the shared copilot model; "skips GoApply without a domestic model" → GoApply is checked on the shared model and passes.

**PAR-3** (8)
- `server/src/features/account-v2/__tests__/totp.test.ts` (1) "no cross-brand fallback": `CN_TOTP_ENCRYPTION_KEY ?? TOTP_ENCRYPTION_KEY`; unsealing tries both.
- `server/src/features/account-v2/__tests__/twoFactor.test.ts` (2) "readiness needs the storage and the brand key", "opens enrolment on the real path list": GoApply with only `TOTP_ENCRYPTION_KEY` is available; `key_missing` only when neither key is set.
- `server/src/features/auth-cn/intWiring.test.ts` (1) "mini-program login: on → the challenge": GoApply's first-value route is `/campus` by default, so `details.next` is `/login/2fa?next=%2Fcampus`; `/resume` needs both `CN_CAMPUS_CALENDAR_ENABLED=false` and `CN_RECRUITMENT_INFO_MODE=off`.
- `server/src/features/push/push.test.ts` (3): "needs all three VAPID values" → for GoApply the shared set yields a config; null only when `CN_VAPID_PUBLIC_KEY` starts an incomplete own set. "GoApply has no web push" and "GoApply stays off in the push area itself" → on for GoApply with VAPID; off with `FLAG_GOAPPLY_WEB_PUSH=false` or no VAPID.
- `server/src/platform/email/EmailService.test.ts` (1) "GoApply sends only through its own configured transport and sender": with no `CN_EMAIL_TRANSPORT` GoApply sends through Resend with the shared verified sender; `transport_not_configured` only for `none` or missing keys.

**PAR-4** (11)
- `server/src/interview-engine/providers/__tests__/brandConfig.test.ts` (7): "never falls back from CN_LIVEKIT_* to LIVEKIT_*" → shared plane when `CN_LIVEKIT_URL` is unset, unconfigured (never mixed) when it is set and a member is missing; "agent names" → on the shared plane the shared agent name, `GoApply-Interview` only on its own plane; "recording switch" → per key; "voice provider id" → `CN_VOICE_PROVIDER` is read only together with `CN_LIVEKIT_URL`; "keeps one secret per brand" and "GoApply calls back to its own base URL" → both come from the `voice` group; "GoApply needs a domestic model of its own" → RoboApply routing when `CN_LLM_INTERVIEW_*` is unset.
- `server/src/interview-engine/providers/__tests__/providers.test.ts` (3): "configured only with the brand's own credentials" → the shared credentials configure GoApply; "livekit_selfhosted" → set `CN_VOICE_PROVIDER` with `CN_LIVEKIT_URL`, or `VOICE_PROVIDER` on the shared plane; "GoApply voice is off without CN_LIVEKIT_*" → on through the shared plane; off with no LiveKit at all or `FLAG_GOAPPLY_INTERVIEW_VOICE=false`.
- `server/src/interview-engine/sessions/InterviewSessionService.practice.test.ts` (1) "a GoApply session announces its report once": it sets `CN_LIVEKIT_AGENT_CALLBACK_SECRET` without `CN_LIVEKIT_URL`, so the secret now comes from the shared group (and `brandEnvGroupProblems` names exactly this shape); use the secret of the plane the session runs on.

**PAR-5** (6)
- `server/src/platform/residency/uploadPolicy.test.ts` (2) "the intl bucket never counts", "throws 503 storage_unavailable … without CN_S3_*": the shared store is the fallback; `unavailable` / 503 only under `CN_RESIDENCY_STRICT=true`.
- `server/src/platform/startup.test.ts` (3): "production + capability on + tool-less model" → production with no scope checks both brands (two failures), or pin `ALLOWED_BRANDS=roboapply`; "FLAG_<BRAND>_COPILOT=false skips that brand" → GoApply's copilot is on without a domestic model, use `FLAG_GOAPPLY_COPILOT=false` for the skip; "startup registers wechatPayReadiness" → `CN_PAYMENTS_ENABLED: ''` is not off any more, use `'false'`.
- `server/src/roboapply/v2/routes/resumes.hub.test.ts` (1) "GoApply, recruitment-info mode off": set `CN_RECRUITMENT_INFO_MODE=off` explicitly.

**PAR-7** (48)
- Set `CN_RECRUITMENT_INFO_MODE=off` explicitly for the off case and assert that the default (unset) shows postings: `server/src/features/agent/__tests__/consentAndD1.test.ts` (1), `alerts/modeOff.test.ts` (1), `cn/jobs/__tests__/modeOff.routes.test.ts` (12), `feed/marketStats.test.ts` (2), `feed/routes.test.ts` (1), `feed/seams.test.ts` (1), `jobs/detail/detail.test.ts` (1), `match/MatchService.test.ts` (1), `offers/postedRange.test.ts` (1), `resume/tailor/store.test.ts` (1), `tracker/modeOff.test.ts` (7), `tracker/reminders.test.ts` (1), `server/src/roboapply/v2/routes/legacyJobScope.test.ts` (6 new, plus its 1 pre-existing).
- `server/src/features/cn/jobs/__tests__/mode.test.ts` (6): "mode defaults to off; unknown values are off" → unset and unknown are `licensed`, `off` only for the literal; the capability, visibility and `requireCnRecruitmentInfo` cases pass the off value explicitly.
- `server/src/features/agent/__tests__/routes.test.ts` (1) "503 ai_unavailable on GoApply without a domestic model": GoApply AI is on with no CN model; 503 only with an unusable content-safety filter.
- `server/src/features/jobs/ingest/adapters/adapters.test.ts` (2): RoboApply's list is `activejobs`, `bank_robohire`, `jsearch` (plus `ats_public`), no `linkedin`; the `CN_EXTERNAL_PROVIDERS` case goes with that variable.
- `server/src/features/jobs/ingest/cron.test.ts` (3): "GoApply plans and ingests only when…" → `ingestAllowed(go, {})` is true, false only for `off`; the two count expectations included `linkedin` as a provider, recount without it.

**PAR-8** (3)
- `__tests__/shell/routes.test.ts` (1) "sign-in methods registry follows the brand order": GoApply's order is `email_password`, `phone_otp`, `wechat`.
- `server/src/features/coaching/routes.test.ts` (1) "GoApply coaching is off by default": on by default; 404 only with `FLAG_GOAPPLY_COACHING=false`.
- `server/src/roboapply/v2/routes/legacyAiGates.test.ts` (1) "GoApply, recruitment-info mode off: 404": set the mode to `off` explicitly.

**PAR-9** (1)
- `server/src/features/visitor/routes.test.ts` (1) "mode off → 404 feature_disabled": set the mode to `off` explicitly.

**In no bundle's owns** (4; Request O-4)
- `server/src/features/copilot/__tests__/support.test.ts` (1) "daily budget per brand, no fallback between brands" and `copilot/__tests__/tools.test.ts` (1) "exports the daily budget reader": `COPILOT_DAILY_BUDGET_USD` is per key, so GoApply with only the shared value gets 12.5; `CN_COPILOT_DAILY_BUDGET_USD` still wins.
- `server/src/features/match/inputs.test.ts` (1) "budgets: brandEnv without fallback": `scoreDailyBudget('goapply', { SCORE_DAILY_BUDGET: '500' })` is 500; the `CN_` value still wins.
- `server/src/features/onboarding/routes.test.ts` (1) "GoApply: PUT /steps/confirm and POST /confirm": the default `nextRoute` is `/campus` (campus and feed on); `/resume` only with both off switches in the harness env.

## Pre-existing failures

12, identical before and after (confirmed by a full run of the untouched tree before the first edit):
- `__tests__/pages/practice.test.tsx` (1)
- `__tests__/pages/settings.test.tsx` (6)
- `components/features/onboarding/goapply.test.tsx` (3)
- `server/src/features/auth-cn/routes.test.ts` (1, policy text)
- `server/src/roboapply/v2/routes/legacyJobScope.test.ts` (1, "the scope select names every column the check reads")

## Requests

### Orchestrator: items to append to the bundles before PAR-2..PAR-9 start

A request can be dropped; these four are behaviour the wave needs and that no item in `parity-bundles.json` covers (checked: the PAR-2 item on `llmBrand.ts` only adds `effectiveLlmProfile`; no PAR-5 item names `writeBrand.ts`; the four test files are in no `owns`).

- **O-1. Deployment order and scope (review finding 1, high).** Do not push or deploy between the PAR-1 merge and the PAR-2 and PAR-5 merges. Before the wave branch is pushed at all, `ALLOWED_BRANDS=roboapply` must be set on every Vercel environment of the project (Production and Preview; previews run with `NODE_ENV=production`). Why: `allowedBrands()` now returns both brands in production; `copilotBrands()` (`platform/startup.ts`) therefore includes GoApply, whose copilot model now falls back to the shared `LLM_COPILOT_MODEL` / `LLM_MODEL` while its profile is still `domestic_cn`; `assertCopilotModelSupportsTools` refuses the route and `assertAssistantModel` throws at module top level of `app.ts`. On Vercel every API request then fails; off Vercel the process exits 1. **Append to PAR-5's acceptance:** a test in `startup.test.ts` that `runStartupAssertions` with `NODE_ENV=production`, no `ALLOWED_BRANDS`, no `BRAND_LOCK` and only shared LLM variables does not throw (it can only pass after PAR-2's `effectiveLlmProfile`).
- **O-2. New PAR-2 item: `requireLlmCallBrand` (`server/src/lib/llm/llmBrand.ts`, review finding 3).** Today it throws `BrandContextMissingError` in production whenever the brand is the default and the deployment serves another brand. That was reachable only with `ALLOWED_BRANDS` naming GoApply; it is now the default production state, so any LLM call made outside a request without `runWithBrand` (the in-process node-cron tasks of `roboapply/schedulers/RoboApplyCronService.ts` on non-Vercel hosts, scripts) throws on RoboApply production. CHANGE: refuse only when the two brands would route differently, that is when GoApply's effective profile is not the global one (PAR-2's `effectiveLlmProfile('goapply') !== 'global'`, which also sees a provider in the GoApply database blob; the env-only equivalent is `brandStack('goapply', 'llm') === 'own'`) or `cnLlmDomesticOnly(env)`; otherwise return the default brand. ACCEPT: production, both brands served, shared stack only → returns `{ brandId: 'roboapply', source: 'default' }`; with `CN_LLM_PROVIDER` set or `CN_LLM_DOMESTIC_ONLY=true` → still throws. TESTS: `llmModels.brand.test.ts`, `LLMService.brand.test.ts`.
- **O-3. New PAR-5 item: `resolveWriteBrand` (`server/src/platform/residency/writeBrand.ts`, review finding 3).** `allowedBrands(env).length === 1` is no longer true on a default deployment, so a residency-critical write without a brand context gets `null` and is dropped (callers: `lib/candidateResumeIngest.ts`, `services/GoHireResumeParseService.ts` twice, `services/ResumeOriginalFileStorageService.ts`). HTTP requests are safe (`brandContext` is mounted before every router); work started outside a request is not. CHANGE: on a multi-brand deployment return `DEFAULT_BRAND` when `brandStack('goapply', 'storage', env) === 'shared'` and `cnResidencyStrict(env)` is false (both brands write to the same store, so the guess cannot misplace a file); `null` only otherwise. ACCEPT: production, no scope, shared bucket → `roboapply`; with `CN_S3_BUCKET` set or `CN_RESIDENCY_STRICT=true` → `null`. TESTS: the residency tests beside it.
- **O-4. Assign the four unowned red test files** to the orchestrator's merge step (or to PAR-2 for `copilot/__tests__/support.test.ts`, `copilot/__tests__/tools.test.ts`, `match/inputs.test.ts` and PAR-8 for `onboarding/routes.test.ts`), with the one-line expectations listed under "In no bundle's owns" above. The wave cannot go green otherwise.
- **O-5.** `server/src/platform/queue/drain.ts`, `lib/server/brand.ts` and `proxy.ts` are in no bundle's owns and read the deployment scope (`server/src/cron/handlers.ts` reads it too and is PAR-7's). No change is needed (drains and crons now run for both brands by default; the static prerender fallback still resolves to RoboApply), but nobody owns the first three if a follow-up is.

### Owner

- **Set `ALLOWED_BRANDS=roboapply` on Vercel (Production and Preview) before this wave is pushed** (O-1). A production deployment otherwise serves `goapply.top` as soon as its DNS points there (plan §8 item 5), runs its crons and queue drains for both brands, and, until PAR-2 and PAR-5 are merged, refuses to boot. A typo in that variable no longer opens GoApply: it closes the deployment to RoboApply only.
- **Decision wanted (review finding 5):** should `CN_RECRUITMENT_INFO_MODE=false | 0 | no | none | disabled` close the GoApply job feed like `off`? The plan (§3.2, §4) says only the literal `off` does, so that is what is implemented, and the value is now reported by `cnRecruitmentInfoModeProblem`. This is the switch with the licence consequence; the three sibling switches accept false/0/no/off. If yes, it is a two-line change in `flags.ts` (PAR-1's file) plus plan §4.

### PAR-2

- **P2-1.** See O-2 (now an item, not only a request).
- **P2-2.** Until `effectiveLlmProfile` lands, GoApply's AI flags are on but `LLMService` refuses the shared provider. `getProviderSetting` / `getModelSetting` already receive `CN_X ?? X` from `brandEnv`; use `brandOwnEnv` where the strict CN read is meant.
- **P2-3.** `server/src/platform/llm/contentSafety/config.ts` reads three names through `brandEnv('goapply', …)`. They are in `BRAND_OWN_ENV`, so behaviour is unchanged; its header still cites R-03.
- **P2-4.** `brandEnv.ts` imports `MODEL_ENV` from `server/src/lib/llm/llmStackConfigSchema.ts` for `brandUsesSharedStack`. Keep that export and keep the file free of imports from `platform/brand` (it has none today), or a cycle appears. A new model selector that is not in `MODEL_ENV` and does not end in `_MODEL` would be missed by `brandUsesSharedStack`.

### PAR-3

- **P3-1.** `server/src/features/push/config.ts`: `WEB_PUSH_BRANDS` / `webPushServesBrand` still exclude GoApply, so the `webPush` flag is on while the area refuses.
- **P3-2.** `server/src/platform/email/EmailService.ts`: the capability no longer needs `CN_EMAIL_FROM`; the transport and From fallback of plan §3.4 must follow or `notify.email` is on while sends are suppressed.

### PAR-4

- **P4-1.** `server/src/interview-engine/config.ts`: with the shared LiveKit project, `getInterviewAgentName('goapply')` returns `INTERVIEW_ENGINE_AGENT_NAME` when set but otherwise still `GoApply-Interview`, an agent nobody registers on the shared project (a silent room). `getR2Creds` returns null for GoApply on the shared bucket (`sharesIntlStore`), `getCnSpeechConfig` still throws without the CN pair, and `explicitCallbackBaseUrl` has its own cn branch.
- **P4-2 (review finding 4).** Report `brandEnvGroupProblems('goapply')` entries for `voice` and `speech` where the voice and speech configuration is explained (config introspection, the voice availability reason), so a `CN_LIVEKIT_API_KEY` or `CN_VOICE_PROVIDER` without `CN_LIVEKIT_URL`, or one speech model of the pair, is named instead of silently running on the shared plane.

### PAR-5

- **P5-1.** See O-3 (now an item).
- **P5-2.** `server/src/platform/startup.ts` `copilotBrands` now includes GoApply on a default production deployment; acceptance test in O-1.
- **P5-3.** `server/src/platform/residency/uploadPolicy.ts` `brandStorageConfigured` and `ResumeOriginalFileStorageService.resolveCnConfig` now see the shared bucket through the `storage` group. The existing residency guards still apply (CN-0 discards, the mainland-host check refuses), so nothing leaks in the interim; the `goapply/` key prefix and the strict-only refusal are yours.
- **P5-4.** `legal.footer.aiDisclosure` is now true for GoApply whenever its AI runs; the footer text must come from the effective stack.
- **P5-5 (review finding 6).** `brandUsesSharedStack('goapply')` is env-only. For the cross-border consent decision of plan §3.6, OR it with the routes PAR-2's resolver really returns, because an admin override in the database (`llm_stack.roboapply.*` reached through the per-key fallback, or a GoApply blob) can send a GoApply task to the shared stack with no env variable involved.
- **P5-6 (review findings 2, 4, 5): startup must report three configuration problems.** In `runStartupAssertions`, log once at boot:
  - `allowedBrandsProblem(env)` (from `platform/brand`) at error level: "ALLOWED_BRANDS / BRAND_LOCK names no brand: <tokens>. This deployment serves <serves> only."
  - `brandEnvGroupProblems('goapply', env)` at warn level, one line per entry: "GoApply <group> settings <set> are ignored because <missingAnchors> is not set; GoApply uses the shared <group> stack." Under `cnResidencyStrict(env)` a `storage` entry (and, on your judgement, any entry) is a boot failure.
  - `cnRecruitmentInfoModeProblem(env)` (from `platform/flags`) at error level: `unknown CN_RECRUITMENT_INFO_MODE value "<value>"; the job feed is ON. Use off to close it.`
  Skip the two GoApply checks when the deployment does not serve GoApply. Add a test per line to `startup.test.ts`.

### PAR-6

- **P6-1.** `cnPaymentsKilled(env)` is exported from `server/src/platform/flags.ts`. `server/src/platform/billing/planCatalog.ts` still requires `parseBoolEnv(env.CN_PAYMENTS_ENABLED)`, so plans stay unpurchasable until it uses the kill switch.
- **P6-2.** The WeChat Pay notify webhook is gated on `pay.wechatpay`, so with `CN_PAYMENTS_ENABLED=false` it answers 404 to a notify for a payment already in flight. Decide whether the notify should stay open under the kill switch, as rule A1 keeps the Alipay callback open.

### PAR-7

- **P7-1.** Every reader of the mode now gets `licensed` by default; `partner_deeplink` only when set.
- **P7-2.** RoboApply's provider list no longer contains `linkedin`.
- **P7-3.** The `JobProvider` union in `registry.ts` still lists `'linkedin'` so existing adapter code compiles. Tell the orchestrator when no code names it and the literal can be removed (PAR-1's file).

### PAR-8

- **P8-1.** GoApply `authMethods` order is email first; coaching and student are on for GoApply; web sign-in and navigation that read the registry order or these flags will change with no further edit.

### PAR-10

- **P10-1.** Document the variables below. `ALLOWED_BRANDS` default is now both brands in every environment; a value with no valid brand id serves RoboApply only; the mainland kit must keep `ALLOWED_BRANDS=goapply` (a typo there refuses the boot through `intl_brand_on_mainland`). Document that a GoApply group follows its anchor (`CN_S3_BUCKET`, `CN_LIVEKIT_URL`, both speech models, `CN_VAPID_PUBLIC_KEY`): without it the other `CN_` values of the group are ignored. Add the pre-push step of O-1 to the release checklist.

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `CN_<NAME>` (infrastructure) | optional GoApply override of `<NAME>`; by class: brand-own (never falls back), grouped (whole set, decided by the group's anchor), per key (`CN_X ?? X`) | unset → shared value |
| `CN_RESIDENCY_STRICT` | new; read by `cnResidencyStrict()`. PAR-1 adds only the predicate; behaviour arrives with PAR-2 and PAR-5 | off |
| `CN_LLM_DOMESTIC_ONLY` | new; read by `cnLlmDomesticOnly()` (also true under the strict switch). Predicate only, plus: under it `brandUsesSharedStack` ignores shared `LLM_*` settings | off |
| `CN_RECRUITMENT_INFO_MODE` | redefined: `off` \| `partner_deeplink` \| `licensed`; `off` is the off switch; any other value is `licensed` and is reported by `cnRecruitmentInfoModeProblem` | `licensed` |
| `CN_CAMPUS_CALENDAR_ENABLED` | redefined: a false value hides the campus calendar; no longer needed to turn it on | on |
| `CN_EMAIL_TRANSPORT` | redefined for the capability: `aliyun_dm` \| `resend` \| `none` | `resend` (shared `RESEND_API_KEY`) |
| `CN_PAYMENTS_ENABLED` | redefined: a false value stops both CN rails; no longer a prerequisite | on |
| `ALLOWED_BRANDS`, `BRAND_LOCK` | unchanged meaning. With neither set: both brands in every environment. Set but naming no brand: the default brand (RoboApply) only | both |
| `FLAG_GOAPPLY_COACHING`, `_INTERVIEW_VOICE`, `_WEB_PUSH`, `_STUDENT` | the registry default behind each is now true; `=false` is the off switch | on |
| No longer required by any capability | `CN_LLM_PROVIDER`, `CN_LLM_MODEL`, `CN_LLM_VISION_MODEL`, `CN_EMAIL_FROM`, `ALIPAY_API_URL`, `CN_LIVEKIT_*`, `CN_VAPID_*` | |

## i18n keys added or changed

None. PAR-1 has no namespace and changed no copy.

## Known gaps

- **Flags are ahead of the feature modules until PAR-2…PAR-9 merge.** After PAR-1 alone GoApply's public brand payload says AI, email, voice, web push, coaching, student, the feed and Alipay are on, while the modules behind them still apply the old rules. This is the planned order, but GoApply is not usable, and a production process with no scope does not boot, from PAR-1 alone (O-1).
- **The three problem detectors are exported and tested but nothing logs them yet.** `allowedBrandsProblem`, `brandEnvGroupProblems` and `cnRecruitmentInfoModeProblem` are seams; the logging belongs to `platform/startup.ts` (PAR-5, Request P5-6). The fail-closed scope rule itself is live now and needs no caller.
- **`brandUsesSharedStack` does not see database overrides** (P5-5).
- `server/src/features/index.ts` (a PAR-1 hot file) needed no change.
- Not verified in a browser or against a running stack (the bundle rules forbid both). Plan §7 step 2 (`GET /api/v1/public/brand` on both dev hosts with `GOAPPLY_PREVIEW=0`) is covered here by the route test over the same env and should still be run once on the dev stack after the wave merges.

## Review resolution

`undone`: none listed by the reviewer. `unownedEdits`: none listed; `git status` shows 19 modified files, all inside PAR-1's owns, and nothing was reverted.

1. **High: PAR-1 alone refuses the API boot on a production deployment with no `ALLOWED_BRANDS`.** Verified and reproduced (temporary test, deleted): no scope → `AssistantModelStartupError` for GoApply; `ALLOWED_BRANDS=roboapply` → boots. Not fixable inside PAR-1's owns without undoing item 4 or the plan's flag rule (the failing code is `platform/startup.ts`, PAR-5, and the LLM profile, PAR-2). Resolved as the reviewer prescribed: the stop notice at the top, Request O-1 (no push or deploy between the merges; `ALLOWED_BRANDS=roboapply` on Vercel Production and Preview before the wave branch is pushed; the PAR-5 acceptance test), the owner request, and P10-1 (release checklist). One mitigation did land in code: with finding 2 fixed, a typo in that variable can no longer reopen GoApply.
2. **Medium: `ALLOWED_BRANDS` with no valid id failed open.** Fixed in both twins (`readScope`): a set scope variable with no valid brand id serves `[DEFAULT_BRAND]` in every environment; the same for a mistyped `BRAND_LOCK` with no valid `ALLOWED_BRANDS`, which had the same hole. `allowedBrandsProblem(env)` exported from both twins and from `platform/brand/index.ts`; it also names the bad token of a partly wrong list. `runtime.test.ts` and the twin-agreement table in `brandFromHost.test.ts` rewritten (the old `'nonsense' → both` assertion is gone). Logging: Request P5-6.
3. **Medium: two production fail-closed rules fire on a default deployment and no item changes them.** Verified: `requireLlmCallBrand` and `resolveWriteBrand` behave as described, and `parity-bundles.json` has no item for either nor an owner for the four red test files. Both files are outside PAR-1's owns (PAR-2 and PAR-5), so nothing was edited; they are now written as ready-to-append items O-2, O-3 and O-4 with CHANGE / ACCEPT / TESTS. One refinement to the reviewer's wording for O-2: use PAR-2's `effectiveLlmProfile` rather than the env-only `brandStack`, so a provider set in the GoApply database blob also counts as "routes differently".
4. **Medium: a partly set GoApply group silently falls back to the shared set.** Fixed as prescribed: `brandEnvGroupProblems(brand, env)` added to `brandEnv.ts` and re-exported, table-tested over storage, voice, speech and push (seven half-set shapes, names only). The read rule is unchanged, as the reviewer agreed it should be. Reporting: Requests P5-6 (startup; failure under the strict switch) and P4-2 (voice and speech).
5. **Low: `CN_RECRUITMENT_INFO_MODE` accepts only the word `off`.** The documented mapping is kept (plan §3.2 and §4 win over a wider reading, and the reviewer made the wider reading conditional on the owner's agreement). `cnRecruitmentInfoModeProblem(env)` added and tested (`false`, `0`, `no`, `none`, `disabled`, misspellings → the raw value; the three modes and unset → null). Logging: Request P5-6. The wider mapping is put to the owner as a decision.
6. **Low: `brandUsesSharedStack` could say false while a model setting routes to the shared stack.** Fixed, with one correction to the proposed pattern: `/^LLM_[A-Z0-9_]*MODEL$/` alone would miss the selectors that do not end in `_MODEL` (`LLM_FAST`, `LLM_PRO`, `LLM_QUICK_JOB`, `LLM_MATCH_RESUME`, `LLM_INTENT_PARSER`, the `LLM_CRM_*` set, …), so the check uses the `MODEL_ENV` list from `lib/llm/llmStackConfigSchema.ts` plus that pattern plus `LLM_PROVIDER`. Skipped under `cnLlmDomesticOnly`. Ten-row table and the wall cases added to `brandEnv.test.ts`. The part env cannot see (database overrides) is stated in the function comment and handed to PAR-5 as P5-5, which is the reviewer's second option.
