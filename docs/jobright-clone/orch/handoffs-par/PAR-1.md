# PAR-1

Foundation of the D5 parity wave. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-1`, branch `wp/PAR-1`, base `84dfc24`. Nothing committed, pushed or stashed. No schema change, no new dependency, no i18n change, no dev server or browser run.

All five items are done. Everything PAR-1 owns is green (22 test files, 934 tests). Both typechecks pass for the whole repository. The full suite has 95 new failures, all outside PAR-1's paths and all expected (listed below per owning bundle); the 12 failures that existed at the base are unchanged.

**Read first, orchestrator and owner:** a production deployment with neither `ALLOWED_BRANDS` nor `BRAND_LOCK` now serves both brands (item 4, plan §3.2 / G80). That one change reaches three files PAR-1 does not own and can stop a RoboApply production boot until PAR-2 merges. See "Requests → orchestrator" O-1 and "Requests → owner".

## Items

### 1. [P0] brandEnv: `CN_X` is an optional override, else the shared value — done

`server/src/platform/brand/brandEnv.ts` rewritten; signature of `brandEnv(brand, name, env)` kept; RoboApply reads unchanged (it never reads a `CN_` value).

GoApply, by class of name:
- **Brand-own** (`BRAND_OWN_ENV`, the 18 names of plan §3.1): `CN_<NAME>` only.
- **Grouped** (`BRAND_ENV_GROUPS`: `voice`, `speech`, `storage`, `push`, members and anchors exactly as plan §3.1): when every `CN_` anchor of the group is set, every member is read as `CN_<NAME>` with no fallback; otherwise every member is read unprefixed.
- **Everything else**: `CN_<NAME> ?? <NAME>`, per key.

`brandEnvFlag` inherits. New exports (also re-exported from `platform/brand/index.ts`): `brandOwnEnv`, `brandEnvSource`, `brandStack`, `brandUsesSharedStack`, `cnResidencyStrict`, `cnLlmDomesticOnly`, `BRAND_OWN_ENV`, `BRAND_ENV_GROUPS`, plus `BRAND_ENV_GROUP_IDS`, `BRAND_STACK_IDS` and the types `BrandEnvGroup`, `BrandEnvGroupId`, `BrandStackId`, `BrandEnvSource`. Header comment rewritten (R-03 superseded by D5).

Semantics the consuming bundles should know (not spelled out in the plan, decided here):
- `brandStack(roboapply, *)` is `'shared'` and `brandUsesSharedStack(roboapply)` is `true`: RoboApply runs on the shared stack by definition. So `brandStack(brand, 'llm') === 'own'` is true only for GoApply with `CN_LLM_PROVIDER` or `CN_LLM_MODEL`.
- `brandEnvSource`: `'own'` = a variable only this brand reads (a `CN_` value for GoApply; a brand-own name such as `COOKIE_DOMAIN` for RoboApply). `'shared'` = the unprefixed infrastructure value. `'none'` = nothing set.
- `speech` needs BOTH `CN_INTERVIEW_ENGINE_STT_MODEL` and `CN_INTERVIEW_ENGINE_TTS_MODEL` to become own. One alone leaves the whole group on the shared names (the lone `CN_` value is not read).
- `brandEnvName(brand, name)` is unchanged: it returns the brand's own (override) name.
- A blank `CN_` anchor counts as unset.

**Precedence (document won over the item):** the item says `brandUsesSharedStack` is true when "CN_EMAIL_TRANSPORT not aliyun_dm". Plan §3.1 says "true when any group above, or email, resolves to the shared stack". With `CN_EMAIL_TRANSPORT=none` no email is sent, so email does not resolve to the shared stack. Implemented per the plan: email counts as shared unless the transport is `aliyun_dm` or `none`. It only matters when all five stacks are GoApply's own.

ACCEPT, all tested: GoApply with only `S3_BUCKET` set reads the shared bucket; with `CN_S3_BUCKET` set and `CN_S3_ACCESS_KEY_ID` unset the key is `undefined` (never the shared key, nor the `AWS_` alias); `COOKIE_DOMAIN` and `LEGAL_ENTITY_NAME` never cross brands; RoboApply never reads a `CN_` value.

Tests: `brandEnv.test.ts` rewritten as a table over own / grouped / per-key names for both brands, plus `brandEnvSource`, `brandStack`, `brandUsesSharedStack`, the two strict predicates and the index re-exports (142 tests).

### 2. [P0] Capability requirements — done

`server/src/platform/flags.ts`:
- `cnRecruitmentInfoMode`: `off` only for the literal `off`; `partner_deeplink` when set; otherwise `licensed` (unset and unknown values included).
- `campusCalendarAllowed`: `brand.flags.campusCalendar`, and false for cn only when `CN_CAMPUS_CALENDAR_ENABLED` is set and parses false. It no longer follows the recruitment-info mode.
- `aiTextConfigured`: market cn → `contentSafetyReadiness(env).usable`, else true. `ai.vision` returns the same. `cnLlmConfigured`, `CN_LLM_PROVIDER_KEYS` and the `checkLlmEgress` import are deleted (nothing else used them).
- `emailConfigured` (cn): `aliyun_dm` → the three `ALIYUN_DM_*` keys; `none` → false; anything else → `RESEND_API_KEY`, no `CN_EMAIL_FROM` requirement.
- `webPush`: `vapidUsable(brand, env)` for both brands.
- Payments: `cnPaymentsEnabled` replaced by exported `cnPaymentsKilled(env)` (`CN_PAYMENTS_ENABLED` set and parses false). `pay.alipay` = rail listed AND not killed AND `ALIPAY_CALLBACK_SECRET`. `pay.wechatpay` = today's merchant requirements AND not killed.
- `voiceMediaAvailable` unchanged in code; it follows the `voice` group through `brandEnv`.
- Header and the R-13 / R-14 / R-15 comments rewritten.

ACCEPT, tested as a matrix in `flags.test.ts` ("brand parity matrix (D5)"): with exactly the ten shared variables of the item and no `CN_` value, every key `resolveFlags` returns true for RoboApply is true for GoApply except `h1bHistory`, `eeoAnswers`, `fx.reference`, `pay.stripe`, `auth.google`, `auth.line` (also under `NODE_ENV=production` and with Google/LINE credentials). Each off switch turns exactly its capabilities off on GoApply and changes nothing on RoboApply: `CN_RECRUITMENT_INFO_MODE=off`, `CN_CAMPUS_CALENDAR_ENABLED=false`, `CN_EMAIL_TRANSPORT=none`, `CN_PAYMENTS_ENABLED=false`, and `FLAG_GOAPPLY_<KEY>=false` for every key that is on.

Tests: every case the item names is rewritten to the new rule; both drift matrices stay green (`voiceAvailable`, now compared over both provider variable names and seven credential sets for both brands; `wechatPayReadiness`, now with the switch unset, on and killed). 68 tests.

### 3. [P0] Registry defaults — done

`server/src/platform/brand/registry.ts`, then `npm run gen:brand`:
- goapply `flags.coaching`, `interviewVoice`, `webPush`, `student` → `true`.
- goapply `authMethods` → `['email_password', 'phone_otp', 'wechat']`.
- goapply `jobProviders` stays `['bank_gohire', 'user_import']`.
- roboapply `jobProviders` → `['activejobs', 'bank_robohire', 'jsearch', 'user_import']` (`linkedin` removed).
- Comments: `email.transport` is the preferred transport; `llmProfile` is the profile used when the brand has its own provider; stale R-03 / R-14 notes fixed.

ACCEPT: `node scripts/gen-brand-mirror.mjs --check` reports the mirror up to date after the run; `lib/brand/registry.generated.ts` carries the same values (asserted in `__tests__/lib/brandParity.test.ts`); GoApply's list never contains `jsearch`.

Left as is on purpose: the `JobProvider` type union still contains `'linkedin'`, so adapter code that names it keeps compiling (see Request P7-3).

Tests: `registry.test.ts` (flag parity, sign-in order, sources per market, rails), `brandParity.test.ts` (mirror), `brandInvariants.test.ts` and `__tests__/brand/*` unchanged and green.

### 4. [P1] Every deployment serves both brands unless narrowed — done

`allowedBrands()` returns both brand ids when `ALLOWED_BRANDS` and `BRAND_LOCK` are unset, in every environment. Changed in `server/src/platform/brand/runtime.ts` AND in its web twin `lib/brand/runtime.ts` (the proxy uses the twin; the two must agree, and a new test in `__tests__/lib/brandFromHost.test.ts` compares them over ten configurations).

ACCEPT, tested: `NODE_ENV=production` with neither variable resolves `goapply.top` to GoApply and serves it; `ALLOWED_BRANDS=roboapply` refuses it as before; `ALLOWED_BRANDS=goapply` (the mainland kit) refuses RoboApply.

Consequences outside PAR-1's paths: see Requests P2-1, P5-1, P5-2, O-1.

### 5. [P1] Public brand payload parity test and fallout list — done

No route change in `server/src/features/brand/` (one comment in `contract.ts`).
- `brand/routes.test.ts`: the two-host comparison over the shared-only env, on the dev hosts and on the production hosts with no deployment scope. Asserts the flag matrix, `authMethods` beginning with `email_password`, `paymentRails` containing `alipay` when `ALIPAY_CALLBACK_SECRET` is set (empty without it or with the kill switch; never `stripe`), and that the off switches reach the payload for GoApply only.
- `features.test.ts`: the "capability on" env now sets no `CN_` value (asserted), so its GoApply cases prove the default. The off cases keep `FLAG_<BRAND>_<KEY>=false`.
- `mount.test.ts`: `CN_PAYMENTS_ENABLED=true` removed from the env.
- `seams.test.ts`, `boundary.test.ts`: nothing assumed the old defaults; unchanged and green.
- The fallout list is "Red tests for other bundles" below.

## Files changed

19 files, all inside PAR-1's owns (checked against `parity-bundles.json`):

- `server/src/platform/brand/brandEnv.ts`, `brandEnv.test.ts`, `index.ts`
- `server/src/platform/brand/registry.ts`, `registry.test.ts`
- `server/src/platform/brand/runtime.ts`, `runtime.test.ts`, `brandContext.test.ts`
- `server/src/platform/flags.ts`, `flags.test.ts`
- `server/src/features/brand/contract.ts` (comment), `routes.test.ts`
- `server/src/features/features.test.ts`, `mount.test.ts`
- `lib/brand/registry.generated.ts` (generated), `lib/brand/runtime.ts`, `lib/flags.ts` (comment)
- `__tests__/lib/brandFromHost.test.ts`, `__tests__/lib/brandParity.test.ts`

## Tests run

| Command | Result |
|---|---|
| Baseline before any edit: `npx vitest run --exclude ".claude/**"` | 12,594 tests: 12,570 passed, 12 failed (the pre-existing ones) |
| `npx vitest run server/src/platform/brand/brandEnv.test.ts` | 142 / 142 |
| `npx vitest run server/src/platform/flags.test.ts` | 68 / 68 |
| `registry.test.ts` 36, `runtime.test.ts` 34, `brandContext.test.ts` 8 | all pass |
| `server/src/features/brand/routes.test.ts` 9, `features.test.ts` 337, `mount.test.ts` 6, `seams.test.ts` 46, `boundary.test.ts` 5 | all pass |
| `__tests__/lib/brandFromHost.test.ts` 44, `brandParity.test.ts` 5, `brandInvariants.test.ts` 25, `brandMetadata.test.tsx` 16, `__tests__/brand/*` | all pass |
| Every test file PAR-1 owns | 22 files, 934 / 934 |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `node scripts/gen-brand-mirror.mjs --check` | up to date |
| Final: `npx vitest run --exclude ".claude/**"` | 12,766 tests: 12,647 passed, 107 failed = 12 pre-existing + 95 expected red in other bundles' files (two identical runs) |

## Red tests for other bundles

95 failures in 43 files. Each fails because of a PAR-1 default or the `brandEnv` fallback. Most "mode off" tests never set the mode: they relied on unset meaning off.

**PAR-2** (14)
- `server/src/features/cn/campus/__tests__/routes.test.ts` (1) "GoApply with the mode off and no counsel switch: 404 too": the campus calendar is on by default; assert 200 with no `CN_` value and 404 only with `CN_CAMPUS_CALENDAR_ENABLED=false`.
- `server/src/features/jobs/enrich/agent.test.ts` (1) "never an unprefixed key": GoApply falls back to `LLM_ENRICH_MODEL` / `LLM_MODEL`; the domestic-prefix refusal applies only under `CN_LLM_DOMESTIC_ONLY`.
- `server/src/features/jobs/enrich/service.test.ts` (1) "logs cost under the brand system user": `RA_SYSTEM_USER_ID` is per key, so GoApply uses the shared id when `CN_RA_SYSTEM_USER_ID` is unset; the sentinel only when neither is set.
- `server/src/features/offers/aiGate.test.ts` (1) "no CN text model configured: false": `ai.text` is true without a CN model; make the false case an unusable content-safety filter (`CN_CONTENT_SAFETY_PROVIDER=nonsense`) or `FLAG_GOAPPLY_AI_TEXT=false`.
- `server/src/lib/llm/llmModels.brand.test.ts` (3): "GoApply never falls back to the unprefixed variables" and "never reads RoboApply's blob" → assert the per-key order of plan §3.3; "requireLlmCallBrand refuses to guess only in production on a deployment that also serves GoApply" → production with no `ALLOWED_BRANDS` now serves both; the RoboApply-only case needs `ALLOWED_BRANDS=roboapply` (Request P2-1).
- `server/src/services/llm/LLMService.brand.test.ts` (5): the three "ai_unavailable with no CN model" cases → GoApply routes on the shared stack with the global profile (today they fail with `LlmBrandPolicyError` because the profile is still `domestic_cn`); "a RoboApply-only deployment keeps the default brand" → set `ALLOWED_BRANDS=roboapply`; "explains per-task resolution" → GoApply rows show the shared selector.
- `server/src/services/llm/LLMService.streaming.test.ts` (2): "never using the RoboApply copilot model" → GoApply uses the shared copilot model; "skips GoApply without a domestic model" → GoApply is checked on the shared model and passes.

**PAR-3** (8)
- `server/src/features/account-v2/__tests__/totp.test.ts` (1) "no cross-brand fallback": `CN_TOTP_ENCRYPTION_KEY ?? TOTP_ENCRYPTION_KEY`; unsealing tries both.
- `server/src/features/account-v2/__tests__/twoFactor.test.ts` (2) "readiness needs the storage and the brand key", "opens enrolment on the real path list": GoApply with only `TOTP_ENCRYPTION_KEY` is available; `key_missing` only when neither key is set.
- `server/src/features/auth-cn/intWiring.test.ts` (1) "mini-program login: on → the challenge": GoApply's first-value route is `/campus` by default, so `details.next` is `/login/2fa?next=%2Fcampus`; `/resume` needs both `CN_CAMPUS_CALENDAR_ENABLED=false` and `CN_RECRUITMENT_INFO_MODE=off`.
- `server/src/features/push/push.test.ts` (3): "needs all three VAPID values" → for GoApply the shared set yields a config; null only when `CN_VAPID_PUBLIC_KEY` starts an incomplete own set. "GoApply has no web push" and "GoApply stays off in the push area itself" → web push is on for GoApply with VAPID; off with `FLAG_GOAPPLY_WEB_PUSH=false` or no VAPID.
- `server/src/platform/email/EmailService.test.ts` (1) "GoApply sends only through its own configured transport and sender": with no `CN_EMAIL_TRANSPORT` GoApply sends through Resend with the shared verified sender; `transport_not_configured` only for `none` or missing keys.

**PAR-4** (11)
- `server/src/interview-engine/providers/__tests__/brandConfig.test.ts` (7): "never falls back from CN_LIVEKIT_* to LIVEKIT_*" → shared plane when `CN_LIVEKIT_URL` is unset, unconfigured (never mixed) when it is set and a member is missing; "agent names" → on the shared plane the shared agent name, `GoApply-Interview` only on its own plane; "recording switch" → per key; "voice provider id" → `CN_VOICE_PROVIDER` is read only together with `CN_LIVEKIT_URL`; "keeps one secret per brand" and "GoApply calls back to its own base URL" → both come from the `voice` group; "GoApply needs a domestic model of its own" → RoboApply routing when `CN_LLM_INTERVIEW_*` is unset.
- `server/src/interview-engine/providers/__tests__/providers.test.ts` (3): "configured only with the brand's own credentials" → the shared credentials configure GoApply; "livekit_selfhosted" → set `CN_VOICE_PROVIDER` with `CN_LIVEKIT_URL`, or `VOICE_PROVIDER` on the shared plane; "GoApply voice is off without CN_LIVEKIT_*" → on through the shared plane; off with no LiveKit at all or `FLAG_GOAPPLY_INTERVIEW_VOICE=false`.
- `server/src/interview-engine/sessions/InterviewSessionService.practice.test.ts` (1) "a GoApply session announces its report once": it sets `CN_LIVEKIT_AGENT_CALLBACK_SECRET` without `CN_LIVEKIT_URL`, so the secret now comes from the shared group; use the secret of the plane the session runs on.

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

**In no bundle's owns** (4; Request O-2)
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

**Orchestrator**
- **O-1. Do not deploy between the PAR-1 merge and the PAR-2 and PAR-5 merges.** With PAR-1 alone, a production process with no `ALLOWED_BRANDS` (a) runs the Assistant model check for GoApply too. GoApply still has the `domestic_cn` profile while its copilot model now falls back to the shared one, so wherever a shared model is set (the normal case) the check fails for GoApply ("Provider openrouter is not allowed for this brand", as `LLMService.streaming.test.ts` now shows) and `assertAssistantModel` refuses the boot with `AssistantModelStartupError`; (b) throws `BrandContextMissingError` on any LLM call made without a brand context; (c) gets `null` from `resolveWriteBrand` for a write without a brand context. Setting `ALLOWED_BRANDS=roboapply` restores today's behaviour exactly.
- **O-2. Four red test files belong to no bundle** (`server/src/features/copilot/__tests__/support.test.ts`, `copilot/__tests__/tools.test.ts`, `match/inputs.test.ts`, `onboarding/routes.test.ts`). Each needs a one-line expectation change (above). Please assign them or fix them at the merge.
- **O-3.** `server/src/platform/queue/drain.ts`, `lib/server/brand.ts` and `proxy.ts` are in no bundle's owns and read the deployment scope. No change is needed (`drain` and the crons now run for both brands by default; the static prerender fallback still resolves to RoboApply), but nobody owns them if a follow-up is.

**Owner**
- A production deployment now serves `goapply.top` as soon as its DNS points there (plan §8 item 5), and its crons and queue drains run for both brands. To keep the RoboApply production deployment as it is today, set `ALLOWED_BRANDS=roboapply` on it before this wave is deployed.

**PAR-2**
- **P2-1.** `server/src/lib/llm/llmBrand.ts` `requireLlmCallBrand`: in production it throws when the brand is the default and the deployment serves GoApply. That used to be reachable only with `ALLOWED_BRANDS` naming GoApply; it is now the default production state, so every legacy cron or script that calls the LLM without `runWithBrand` would throw on RoboApply production. Decide the rule under D5 (for example: refuse only when the two brands would route differently, i.e. `brandStack('goapply', 'llm') === 'own'` or `cnLlmDomesticOnly()`), and state it in the handoff.
- **P2-2.** Until `effectiveLlmProfile` lands, GoApply's AI flags are on but `LLMService` refuses the shared provider. `getProviderSetting` / `getModelSetting` already receive `CN_X ?? X` from `brandEnv`; use `brandOwnEnv` where the strict CN read is meant.
- **P2-3.** `server/src/platform/llm/contentSafety/config.ts` reads three names through `brandEnv('goapply', …)`. They are in `BRAND_OWN_ENV`, so behaviour is unchanged; its header still cites R-03.

**PAR-3**
- **P3-1.** `server/src/features/push/config.ts`: `WEB_PUSH_BRANDS` / `webPushServesBrand` still exclude GoApply, so the `webPush` flag is on while the area refuses.
- **P3-2.** `server/src/platform/email/EmailService.ts`: the capability no longer needs `CN_EMAIL_FROM`; the transport and From fallback of plan §3.4 must follow or `notify.email` is on while sends are suppressed.

**PAR-4**
- **P4-1.** `server/src/interview-engine/config.ts`: with the shared LiveKit project, `getInterviewAgentName('goapply')` returns `INTERVIEW_ENGINE_AGENT_NAME` when set but otherwise still `GoApply-Interview`, an agent nobody registers on the shared project (a silent room). `getR2Creds` returns null for GoApply on the shared bucket (`sharesIntlStore`), `getCnSpeechConfig` still throws without the CN pair, and `explicitCallbackBaseUrl` has its own cn branch.

**PAR-5**
- **P5-1.** `server/src/platform/residency/writeBrand.ts` `resolveWriteBrand`: `allowedBrands(env).length === 1` is no longer true on a default production deployment, so a write without a brand context gets `null` (`WriteBrandUnknownError`) where it used to get `roboapply`.
- **P5-2.** `server/src/platform/startup.ts` `copilotBrands`: now includes GoApply on a default production deployment (see O-1).
- **P5-3.** `server/src/platform/residency/uploadPolicy.ts` `brandStorageConfigured` and `ResumeOriginalFileStorageService.resolveCnConfig` now see the shared bucket through the `storage` group. The existing residency guards still apply (CN-0 discards, the mainland-host check refuses), so nothing leaks in the interim; the `goapply/` key prefix and the strict-only refusal are yours.
- **P5-4.** `legal.footer.aiDisclosure` is now true for GoApply whenever its AI runs; the footer text must come from the effective stack.

**PAR-6**
- **P6-1.** `cnPaymentsKilled(env)` is exported from `server/src/platform/flags.ts`. `server/src/platform/billing/planCatalog.ts` still requires `parseBoolEnv(env.CN_PAYMENTS_ENABLED)` (lines near 165 and 195), so plans stay unpurchasable until it uses the kill switch.
- **P6-2.** The WeChat Pay notify webhook is gated on `pay.wechatpay`, so with `CN_PAYMENTS_ENABLED=false` it answers 404 to a notify for a payment already in flight. Decide whether the notify should stay open under the kill switch, as rule A1 keeps the Alipay callback open.

**PAR-7**
- **P7-1.** Every reader of the mode now gets `licensed` by default; `partner_deeplink` only when set.
- **P7-2.** RoboApply's provider list no longer contains `linkedin`.
- **P7-3.** The `JobProvider` union in `registry.ts` still lists `'linkedin'` so existing adapter code compiles. Tell the orchestrator when no code names it and the literal can be removed (PAR-1's file).

**PAR-8**
- **P8-1.** GoApply `authMethods` order is email first; coaching and student are on for GoApply; web sign-in and navigation that read the registry order or these flags will change with no further edit.

**PAR-10**
- **P10-1.** Document the variables below; `ALLOWED_BRANDS` default is now both brands in every environment, and the mainland kit must keep `ALLOWED_BRANDS=goapply`.

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `CN_<NAME>` (infrastructure) | optional GoApply override of `<NAME>`; by class: brand-own (never falls back), grouped (whole set), per key (`CN_X ?? X`) | unset → shared value |
| `CN_RESIDENCY_STRICT` | new; read by `cnResidencyStrict()`. PAR-1 adds only the predicate; behaviour arrives with PAR-2 and PAR-5 | off |
| `CN_LLM_DOMESTIC_ONLY` | new; read by `cnLlmDomesticOnly()` (also true under the strict switch). Predicate only | off |
| `CN_RECRUITMENT_INFO_MODE` | redefined: `off` \| `partner_deeplink` \| `licensed`; `off` is the off switch | `licensed` |
| `CN_CAMPUS_CALENDAR_ENABLED` | redefined: a false value hides the campus calendar; no longer needed to turn it on | on |
| `CN_EMAIL_TRANSPORT` | redefined for the capability: `aliyun_dm` \| `resend` \| `none` | `resend` (shared `RESEND_API_KEY`) |
| `CN_PAYMENTS_ENABLED` | redefined: a false value stops both CN rails; no longer a prerequisite | on |
| `ALLOWED_BRANDS`, `BRAND_LOCK` | unchanged meaning; the default with neither set is now both brands in every environment | both |
| `FLAG_GOAPPLY_COACHING`, `_INTERVIEW_VOICE`, `_WEB_PUSH`, `_STUDENT` | the registry default behind each is now true; `=false` is the off switch | on |
| No longer required by any capability | `CN_LLM_PROVIDER`, `CN_LLM_MODEL`, `CN_LLM_VISION_MODEL`, `CN_EMAIL_FROM`, `ALIPAY_API_URL`, `CN_LIVEKIT_*`, `CN_VAPID_*` | |

## i18n keys added or changed

None. PAR-1 has no namespace and changed no copy.

## Known gaps

- **Flags are ahead of the feature modules until PAR-2…PAR-9 merge.** After PAR-1 alone GoApply's public brand payload says AI, email, voice, web push, coaching, student, the feed and Alipay are on, while the modules behind them still apply the old rules (LLM profile, email transport, push area, voice agent name and speech, storage, plan catalog, job sources). This is the planned order, not a defect of this bundle, but GoApply is not usable from PAR-1 alone.
- **`ALLOWED_BRANDS` with no valid brand id is treated as unset.** That rule is unchanged, but its result is: it used to mean RoboApply only in production and now means both brands, so a typo no longer fails closed. Not changed here because no item asks for it; say so if a value with no valid id should refuse to boot.
- **A half-set speech pair is silent.** One `CN_INTERVIEW_ENGINE_*_MODEL` without the other leaves GoApply on the shared speech set with no warning. A warning belongs in PAR-4's config.
- `server/src/features/index.ts` (a PAR-1 hot file) needed no change.
- Not verified in a browser or against a running stack (the bundle rules forbid both). Plan §7 step 2 (`GET /api/v1/public/brand` on both dev hosts with `GOAPPLY_PREVIEW=0`) is covered here by the route test over the same env and should still be run once on the dev stack after the wave merges.
