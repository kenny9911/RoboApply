# PAR-2

LLM on the shared stack. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-2`, branch `wp/PAR-2`, base `3fa104e` (PAR-1 merged). Nothing committed, pushed or stashed. No schema change, no new dependency, no i18n change, no dev server, no browser, no call to a real provider or database.

All six items are done, plus PAR-1's requests P2-1 to P2-4, plus the four review findings (three fixed in code, one is a file I may not edit and is a request to the orchestrator). Every test in a file PAR-2 owns is green (47 files, 809 tests). Both typechecks pass for the whole repository. `npm run check` passes. The full suite has 89 failures in 38 files, none in a PAR-2 file: 78 were already red at the base (PAR-1's list) and 11 are turned red by this bundle in other bundles' files (listed below with the assertion each should make). The review round changed neither number.

**Where the documents won over the item text (4 points):**

1. **The wall follows the brand, not the profile.** Item 3 says the mainland-only branch runs "only when the effective profile is domestic_cn AND cnLlmDomesticOnly". Plan §4 says `CN_LLM_DOMESTIC_ONLY` means "GoApply may use only mainland model endpoints". Read literally, the item would let GoApply reach OpenRouter behind the wall whenever it has no domestic provider (its effective profile is then `global`). Implemented per the plan: the wall holds for GoApply whenever the switch is on, whatever profile the caller resolved. One predicate, `llmDomesticOnlyApplies(brand, env)` in `platform/llm/brandPolicy.ts`, is used by the settings resolver, the route check, BYOK, the task-model prefix check and `requireLlmCallBrand`.
2. **A GoApply selector is read in GoApply's context, a shared selector in the shared one.** Plan §3.3 covers one direction ("mixed case": a shared selector is qualified). The other direction is not in the documents: GoApply sets `CN_LLM_MODEL=qwen-plus` (a bare id) with no `CN_LLM_PROVIDER`. The per-key rule gives it the shared provider mode, which would send a bare domestic model id to OpenRouter. `getProviderSetting('goapply')` still returns the shared value (the documented per-key rule), but `getLlmRoutingDefaults` (what LLMService and the scorer check route with) uses only GoApply's own provider on the domestic profile, so that call answers `ai_unavailable / no_model` as it did before, with a log line that names the missing variable.
3. **A `qwen/…` selector in a `CN_` variable keeps meaning DashScope** while GoApply runs on the shared profile (for example only `CN_LLM_VISION_MODEL=qwen/qwen-vl-max` is set). On the global profile `qwen/` is an OpenRouter id, so the value is returned as `dashscope/qwen-vl-max`. Without this, an existing CN setting would silently change route.
4. **Content safety degrades per value, and Aliyun Green without keys degrades too.** The item names three cases (provider, timeout, keyword URL). Plan §6 G5 says "misconfig degrades to keyword list". Implemented: every value that cannot run falls back to its own safe default (unknown provider or unusable Aliyun Green → keyword list; bad timeout → default; bad keyword URL → built-in list only), so a bad timeout does not cost a working Aliyun Green its place. Fail closed only under `CN_RESIDENCY_STRICT`.

## Review resolution

1. **[medium] Behind the wall a shared task selector shadowed GoApply's own domestic default: fixed.** Verified first with the reviewer's cases (wall + `CN_LLM_PROVIDER=deepseek` + `CN_LLM_MODEL` + a shared `LLM_COPILOT_MODEL` resolved to the shared selector and was refused; `resolveCampusModel` answered unavailable). The fix is one rule in the settings resolver, `layersOf` in `server/src/lib/llm/llmModels.ts`: when `llmDomesticOnlyApplies(brand, env)`, a value of the shared stack is inherited only if it names a mainland vendor by itself; otherwise the key counts as unset. A selector is judged on the route it has on the shared stack (`resolveSelectorRoute` with the shared provider mode and default model, then `isGoApplyDirectProvider`). So every caller of `getModelSetting`, `getTaskModel`, `getTaskModelOrDefault`, `getFallbackModelSetting` and `getEnvModelSetting` falls back to GoApply's own default with no change of its own: LLMService, the Assistant boot check, enrichment, the fit scorer, campus extraction. What I did beyond the prescribed fix, and why:
   - **The shared provider mode follows the same rule.** Behind the wall GoApply takes the shared `LLM_PROVIDER` only when it names a mainland vendor, and there is no OpenRouter default. Without this a bare GoApply task id (only `CN_LLM_REWRITE_MODEL=qwen-plus`) was still sent to OpenRouter and refused with a 500. It now has no route and answers 503.
   - **503, not 500.** `LLMService` raises `AiUnavailableError('no_model')` when the wall holds and the call has no model or no route (`missingModelIsUnavailable`), in `chat`, `streamChatWithTools` and `assertPrimaryRoute`. The log detail names the wall and the variables to set. A route GoApply itself names and the wall refuses (its own `CN_` selector or an explicit per-call model that is international) stays `LlmBrandPolicyError` 500: that is a wrong setting, not a missing one.
   - **The boot check no longer stops RoboApply for GoApply's missing model.** With the wall on and no mainland model at all, `assertCopilotModelSupportsTools` returns GoApply as `ok: true, skipped: 'no mainland model behind the domestic-only wall (AI unavailable)'` and logs one warning. This is the pre-D5 behaviour for exactly this state (the base skipped a GoApply with no domestic model); a state that answers 503 by design should not refuse the boot of a process that also serves RoboApply. `npm run verify:llm` reports the same state as a violation (exit 1), so it is still loud where an operator looks. Without the wall a brand with no model is still a failure, never a skip.
   - **A gateway is not inherited behind the wall.** `newapi` cannot be judged by its name, so a shared stack that runs on a gateway is not borrowed by GoApply behind the wall, even when the host is on `CN_LLM_DOMESTIC_HOSTS`; GoApply names it in its own settings (`CN_LLM_PROVIDER=newapi`), as it had to before D5. The task-model rule in `enrich/agent.ts` already excluded `newapi/` for the same reason. This reverses what the first round did for that one case (a streaming test pinned it; rewritten).
   - `extract.test.ts:148-149` did not need a change (those rows have no mainland model, so the answer is still unavailable); a new test covers the fall-through. `LLMService.brand.test.ts:409` is rewritten (503 `no_model`, nothing sent).
   - New field `sharedWalledOff` on `ModelKeyResolution` and `LlmRouteExplanation`: the shared value the wall set aside, so the admin view and `verify:llm` can say what is not used.
2. **[low] `llmUsesSharedStack` ignored the wall: fixed.** It returns false when `llmDomesticOnlyApplies(b, env)`, also when GoApply inherits a shared value that names a mainland vendor (every route is a mainland one then), which matches the LLM part of PAR-1's `brandUsesSharedStack`. Tested for both switches, with and without a stack of GoApply's own, and with an admin override.
3. **[low] Three red tests in `server/src/platform/flags.test.ts`: confirmed, not fixable by me.** The file belongs to PAR-1 (merged). The exact edit is under Requests → Orchestrator.
4. **[low] `verify:llm --db` labelled an admin override as an environment variable: fixed.** A value from an override row prints as `admin override (llm_stack.goapply.development)=<selector> [own]` (the real AppConfig key), also for a value GoApply inherits from RoboApply's row (`[shared]`) and for the provider mode. The `--json` row has `settingSource` (`override`, `env`, `shared`, `none`). While verifying I found that `--db` never showed an override at all: the resolver reads a cache synchronously and the script never loaded it (the base script had the same fault). It now loads both rows first and says per brand whether a row was read. New test `server/src/lib/llm/verifyLlmBrandScript.test.ts` runs the real script against a mocked AppConfig table and an explicit environment (no `.env`, no provider call).

No unowned edits were reported and none exist: 51 changed paths, all inside PAR-2's owns (checked against `parity-bundles.json`).

## Items

### 1. [P0] Model and provider settings fall back per key to the shared stack: done

- `server/src/lib/llm/llmModels.ts` rewritten around one layered read. GoApply: its own `llm_stack.goapply` blob → `CN_<NAME>` (`brandOwnEnv`) → RoboApply's blob → `<NAME>`. RoboApply: its blob → `<NAME>`, never a `CN_` value or GoApply's blob. `getModelSetting`, `getProviderSetting`, `getDefaultModel`, `getFallbackModelSetting`, `getTaskModel`, `getTaskModelOrDefault` and `resolveModelKey` take an optional third `env` argument (default `process.env`).
- Behind the domestic-only wall the shared layer is used only for a value that names a mainland vendor (review finding 1): any other shared value is set aside and the key counts as unset.
- `resolveModelKey` reports `source: 'override' | 'env' | 'shared' | 'none'` and new fields `sharedEnvName`, `shared`, `sharedWalledOff`; `effective` is the selector that runs.
- New exports of `llmModels.ts`: `resolveProviderSetting(brand, env)` (value + source), `getLlmRoutingDefaults(brand, env)` (`{ profile, providerMode, model }`, the one routing rule LLMService and the scorer check share), `getEnvModelSetting(envName, brand, env)` (the same per-key rule, qualification and wall rule for a selector variable outside the stack table, such as `LLM_CAMPUS_MODEL`), `llmUsesSharedStack(brand, env)` (true when any routing setting, admin overrides included, comes from the shared stack and the wall is off; this is what PAR-1's P5-5 asks PAR-5 to OR with `brandUsesSharedStack`), `LlmSettingSource`.
- `server/src/lib/llm/llmBrand.ts`: `effectiveLlmProfile(brand, env)` (`domestic_cn` only when `brandStack(brand, 'llm')` is own or the GoApply blob names a provider; RoboApply always `global`) and `llmCallBrand(brand, env)` (the registry entry with the effective profile and `llmEnvPrefix ''` on the shared stack).
- `server/src/services/llm/providerPrefixes.ts` (still a leaf, no imports): `resolveSelectorRoute` (the routing rule, moved out of LLMService so there is one copy), `splitSelectorPrefix`, `stripProviderPrefix`, `qualifySelector(raw, sharedProviderMode, sharedDefaultModel)`, `pinDomesticSelector`, `DEFAULT_PROVIDER_MODE`. `qualifySelector` is applied only when GoApply has routing settings of its own and the value came from the shared stack; with no `CN_LLM_*` and no GoApply blob nothing is rewritten.
- Comments and docs: `llmTaskSettings.ts`, `llmStackConfigResolver.ts`, `llmSelector.ts` (now reads the effective profile), `llmStackConfigSchema.ts` (also `buildEnvDefaultsSnapshot('goapply')` now shows `CN_<NAME>`, else `<NAME>`; the file stays import-free, P2-4).
- Budgets: header comments of `features/copilot/budget.ts` and `features/match/config.ts` now say per key.
- `scripts/verify-llm-brand.ts` (`npm run verify:llm`): prints per brand the effective profile, the provider mode with where it is set and the wall state, and per task where the value really comes from (a variable, or an admin override row) with `[own]` or `[shared]`. Behind the wall a row also shows the shared value that is not used. Exit 1 on a refused route, a copilot model that cannot stream tools, or the wall with no mainland default model. Run without `--probe` and without `--db` against the worktree env: both brands resolve the same selectors, "No policy violations".

ACCEPT, all tested: with no `CN_LLM_*` and no GoApply blob every model key and the provider mode are the same strings for both brands; with `CN_LLM_PROVIDER=deepseek`, `CN_LLM_MODEL` set and only the shared `LLM_VISION_MODEL`, GoApply's vision model is the shared one on its real route (bare `gpt-6-vision` → `openrouter/gpt-6-vision`), never DeepSeek; RoboApply never reads a CN value.

Tests: `llmModels.brand.test.ts` (23), `services/llm/providerPrefixes.test.ts` (23, a table that proves a qualified selector routes for GoApply's own stack exactly as the raw one routes for RoboApply), `LLMService.config.test.ts` (4), `verifyLlmBrandScript.test.ts` (4), `copilot/__tests__/support.test.ts`, `tools.test.ts`, `match/inputs.test.ts` (the three formerly unowned red tests).

### 2. [P0] LLMService serves GoApply on the shared route: done

- `LLMService.callBrand` returns `llmCallBrand(...)`, so `resolveDefaults`, `resolveDirectModel`, `assertPrimaryRoute`, `routeAndCall`, `streamChatWithTools`, `probeModel` and `explainRoute` treat GoApply without a domestic provider as RoboApply is treated: same default provider, selector dialect, models, fallback chain. The brand id stays `goapply`, so content safety, the route policy, OpenRouter attribution headers and logs still see GoApply.
- `AiUnavailableError('no_model')` (503) in two states an operator chose: the domestic profile (GoApply with a stack of its own and no model anywhere, or a bare id and no provider of its own), and behind the wall when GoApply has no mainland model or route for the call. On the shared stack without the wall a missing model is the same configuration error RoboApply gets.
- `assertCopilotModelSupportsTools`: GoApply is checked like RoboApply. The one skip is the wall with no mainland model (see Review resolution 1).
- `explainRoute` adds `profile`, `source` and `sharedWalledOff` (optional fields).
- **Calls without a brand context (P2-1 / O-2).** `requireLlmCallBrand` throws `BrandContextMissingError` only in production and only when a served brand other than the default would route differently by an operator's choice: `effectiveLlmProfile` is not `global` (so a provider in the GoApply blob counts too), or `llmDomesticOnlyApplies`. Otherwise the call completes as the default brand with the existing one-time warning.
- **Callers that reach the default.** I traced every sending call that resolves to the default brand through one full suite run (a temporary trace in `callBrand`, removed afterwards). Only PAR-2's own tests reached it. A static pass over the entry points that have no HTTP request found none in production either: platform crons run inside `runWithBrand` (`cron/handlers.ts:227`), queue items inside `runWithBrand(item.brand)` (`platform/queue/drain.ts:341`), interview session work inside `inBrand(session brand)` (`InterviewSessionService`), enrichment and campus extraction inside `runWithBrand` (this bundle), and the three legacy node-cron tasks of `RoboApplyCronService` (renewal reminder, account purge, interview cleanup) make no context-less model call. HTTP requests always have a brand (`app.ts:132`). A user id can only be set inside a request store, and every store in use is created with a brand, so no call that carries a user id reaches the default. Nothing needed wrapping inside PAR-2's paths; there is no list for other bundles.

ACCEPT, all tested: chat, streaming and tool streaming with only the shared env reach the same provider and model as RoboApply and the same fallback chain; `CN_LLM_PROVIDER` set → the domestic path as before; production with no `ALLOWED_BRANDS` and no `CN_LLM_*` → a context-less call completes as RoboApply with one warning; with `CN_LLM_PROVIDER`, `CN_LLM_MODEL` or the wall → `BrandContextMissingError`; a production boot with a shared tool-capable copilot model passes the Assistant check for both brands, also with the wall on and a mainland default of GoApply's own. `npm run check:llm-costs`: clean (48 models).

Tests: `LLMService.brand.test.ts` (46), `LLMService.streaming.test.ts` (37), `LLMService.fallback.test.ts` (48, mocks updated), `LLMService.config.test.ts`.

### 3. [P0] The domestic-only wall is an operator opt-in: done

`platform/llm/brandPolicy.ts` `checkLlmRoute` (and through it `filterLlmChain`, `checkLlmEgress`): for GoApply, after the `missing_route` check, every route is allowed unless `cnLlmDomesticOnly(env)`; behind the wall the old rules return unchanged (`byok_not_allowed`, `newapi_host_not_allowlisted`, `provider_not_domestic`, `host_not_domestic`). RoboApply's rule is untouched, and GoApply's wall never changes a RoboApply decision. New export `llmDomesticOnlyApplies` (also from `platform/llm/index.ts`). The settings resolver applies the same wall one step earlier (Review resolution 1), so a refusal here now means a route GoApply itself named.

Tests: `platform/llm/brandPolicy.test.ts` (default-allow table, the wall table for both ways of passing the brand, the strict switch, chains), `services/llm/egressPolicy.test.ts`.

### 4. [P0] Task-level models: done

- `features/jobs/enrich/agent.ts`: `resolveEnrichModel` = `getTaskModelOrDefault('enrich', brand, env)`, `{ model, available: Boolean(model) }`. New `taskModelRoute(brand, model, env)` is the one refusal rule: `not_domestic_provider` and the provider pin apply only behind the wall. Exported from `features/jobs/enrich/index.ts` with the `EnrichModelRoute` type.
- `features/match/scorerRoute.ts`: `defaultProviderFor` and `defaultScorerRouteAllowed` use `getLlmRoutingDefaults(brand.id, env)` for both brands and pass the effective profile and default model to `scorerRoute`, which now delegates to `resolveSelectorRoute`.
- `features/cn/campus/extract.ts`: `resolveCampusModel` = `CN_LLM_CAMPUS_MODEL`, else the shared `LLM_CAMPUS_MODEL`, else the enrichment model; same refusal rule. Behind the wall an international shared campus model falls through to the enrichment model. `service.ts`: the 503 message no longer says "domestic".
- **One RoboApply change the item prescribes:** `resolveEnrichModel('roboapply')` now returns the model explicitly (task model, else `LLM_MODEL`) and `available: false` when there is no model at all. Before it returned `{ model: undefined, available: true }` and let LLMService fail. Routing is identical when a model exists. Two visible effects: with no model anywhere a job finishes "rules only / no_model" at once instead of failing every attempt first; and `jobs/ingest/maintain.ts` builds its retry dedupe key from `route.model`, which is now the real model string, so rows still marked rules-only are queued once more (bounded by the run cap and `ENRICH_DAILY_JOBS`).

ACCEPT, tested: GoApply with only `LLM_MODEL`: enrichment available with RoboApply's model, cost row under the shared system user when `CN_RA_SYSTEM_USER_ID` is unset; the scorer model resolves to the shared one and its route is allowed; campus extraction proposes fields; the calendar answers 200 with no `CN_` value and 404 only with `CN_CAMPUS_CALENDAR_ENABLED=false`. Behind the wall with a mainland default of GoApply's own and shared task models set: enrichment, the scorer and campus extraction all resolve GoApply's own model.

Tests: `enrich/agent.test.ts`, `service.test.ts`, `workers.test.ts`, `cn/campus/__tests__/extract.test.ts`, `routes.test.ts`, `service.test.ts`, `match/legacyRoute.test.ts`, `competitiveness.test.ts`, `scorerV3.test.ts` (the scorer model per brand, with a wall case), `offers/aiGate.test.ts`.

### 5. [P1] Personal API keys follow RoboApply unless the wall is on: done

`lib/byokService.ts` `isByokAllowedForBrand(brandId, env)` is true for both brands and false for GoApply only when `llmDomesticOnlyApplies`. LLMService calls it in both places instead of testing the profile. The endpoint re-check of a personal key runs for both brands (a GoApply user's key may point at a mainland host; a RoboApply user's may not, as before).

Tests: `lib/byokService.test.ts`, `lib/llm/byokBrand.test.ts` (rewritten), two cases in `LLMService.brand.test.ts`.

### 6. [P1] Content safety stays on GoApply and never turns AI off by default: done

`platform/llm/contentSafety/config.ts`: see point 4 at the top. `ContentSafetyConfig` and `ContentSafetyReadiness` gain `degraded: boolean`; `provider` is the provider that really runs; `usable` is false only under `CN_RESIDENCY_STRICT` with a problem; `cn1Ready` is never true while there is a problem. `engine.ts` logs the degraded state once per process (warn) and the strict failure once (error). The filter follows the brand id, so it runs for GoApply on any route.

ACCEPT, tested: a GoApply prompt with a built-in blocked keyword is refused on the shared international route with the real default filter (422 `content_blocked`, nothing sent, one event row), the same prompt on RoboApply is not filtered; a typo in `CN_CONTENT_SAFETY_PROVIDER` leaves `ai.text` true (checked through the real flag resolver in `aiGate.test.ts`).

Tests: `contentSafety/config.test.ts`, `contentSafety.test.ts`, `LLMService.brand.test.ts`.

### PAR-1 requests

- **P2-1:** done (item 2). **P2-2:** done (`brandOwnEnv` for the strict read). **P2-3:** the `contentSafety/config.ts` header is rewritten. **P2-4:** `MODEL_ENV` kept, `llmStackConfigSchema.ts` still imports nothing, and a comment says why.

### waveFIX carry-over

- PAR-2 item 1 (keyword stopwords): nothing to do. The extractor (`features/jobs/enrich/keywords.ts`) was not touched; the re-run for stored rows stays an owner item.
- No "Hot files" or "Unowned fix WPs" entry names a file inside PAR-2's owns.

## Files changed

51 files, all inside PAR-2's owns.

- `server/src/lib/llm/`: `llmModels.ts`, `llmBrand.ts`, `llmTaskSettings.ts`, `llmSelector.ts`, `llmStackConfigResolver.ts`, `llmStackConfigSchema.ts`, `llmModels.brand.test.ts`, `byokBrand.test.ts`, new `verifyLlmBrandScript.test.ts`
- `server/src/lib/byokService.ts`, `byokService.test.ts`
- `server/src/services/llm/`: `LLMService.ts`, `providerPrefixes.ts`, `errors.ts`, `LLMService.brand.test.ts`, `LLMService.streaming.test.ts`, `LLMService.fallback.test.ts`, `LLMService.config.test.ts`, `egressPolicy.test.ts`, new `providerPrefixes.test.ts`
- `server/src/platform/llm/`: `brandPolicy.ts`, `egressPolicy.ts` (header), `index.ts`, `brandPolicy.test.ts`, `contentSafety/config.ts`, `engine.ts`, `index.ts`, `config.test.ts`, `contentSafety.test.ts`
- `server/src/features/jobs/enrich/`: `agent.ts`, `service.ts`, `index.ts`, `agent.test.ts`, `service.test.ts`, `workers.test.ts`
- `server/src/features/match/`: `scorerRoute.ts`, `config.ts` (comment), `legacyRoute.test.ts`, `competitiveness.test.ts`, `scorerV3.test.ts`, `inputs.test.ts`
- `server/src/features/cn/campus/`: `extract.ts`, `service.ts`, `__tests__/extract.test.ts`, `routes.test.ts`, `service.test.ts`
- `server/src/features/copilot/budget.ts` (comment), `__tests__/support.test.ts`, `tools.test.ts`
- `server/src/features/offers/aiGate.test.ts`
- `scripts/verify-llm-brand.ts`

Changed in the review round: `llmModels.ts`, `LLMService.ts`, `errors.ts`, `scripts/verify-llm-brand.ts`, comments in `brandPolicy.ts`, `enrich/agent.ts`, `cn/campus/extract.ts`, and the tests `llmModels.brand.test.ts`, `LLMService.brand.test.ts`, `LLMService.streaming.test.ts`, `enrich/agent.test.ts`, `cn/campus/__tests__/extract.test.ts`, `match/scorerV3.test.ts`, new `verifyLlmBrandScript.test.ts`.

## Tests run

| Command | Result |
|---|---|
| Baseline of the owned files before any edit (first round) | 17 failed (PAR-1's 14 plus the 3 formerly unowned) |
| Every test file in PAR-2's owns (the vitest paths `server/src/lib/llm server/src/services/llm server/src/platform/llm server/src/lib/byokService.test.ts server/src/features/jobs/enrich server/src/features/cn/campus` and the eight single files) | 47 files, 809 / 809 |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npm run check:llm-costs` | clean, 48 models |
| `npx tsx scripts/verify-llm-brand.ts` (no `--probe`, no `--db`) | both brands resolve the same selectors; "No policy violations". Also run with `CN_LLM_DOMESTIC_ONLY=true` + `CN_LLM_PROVIDER` + `CN_LLM_MODEL` (every GoApply task on its own DeepSeek default, each row names the shared value that is not used, no violation) and with the wall alone (every task "not configured", one violation with the line that says what to set) |
| `npx vitest run --exclude ".claude/**"` (run twice after the review changes, same failing set both times) | 12,938 tests: 12,838 passed, 89 failed in 38 files, 1 skipped, 10 todo. No failure in a PAR-2 file |

## Red tests for other bundles

Turned red by PAR-2 (11). Each is a test that pinned behaviour an item deliberately changes. The review round added none and removed none.

**`server/src/platform/flags.test.ts` (3), PAR-1's file, PAR-1 is merged: see Requests → Orchestrator**
- "GoApply AI runs on the shared stack by default…", "AI-only product flags … go off with the content-safety filter", "requireFlag > 404 feature_disabled, 503 ai_unavailable for AI".

**PAR-5** `server/src/platform/residency/startupAssertions.test.ts` (2)
- "refuses a CN model route outside the domestic allowlist", "resolves selectors the way LLMService does and fails closed on anything off the domestic list": `checkLlmRoute` allows GoApply's non-mainland routes by default, so `cn_llm_off_allowlist` is reported only with `CN_LLM_DOMESTIC_ONLY=true` or `CN_RESIDENCY_STRICT=true` in the env. This matches PAR-5's own item (failure only under the strict switch).

**PAR-11** (5)
- `server/src/features/cn/jobs/__tests__/service.test.ts` (3) "flags with a verified quote…", "a non-domestic model id is refused (R-13)", "CN_LLM_FRAUD_MODEL wins when set": the fraud resolver goes through `resolveEnrichModel`, which pins a provider and refuses a non-domestic id only behind the wall. Assert no `provider` option by default, and move the refusal and the pin under `CN_LLM_DOMESTIC_ONLY=true`.
- `server/src/features/match/MatchService.test.ts` (1) "GoApply with consent but an international scorer model: zero scorer calls": GoApply now gets the AI score on that model; the quick estimate only with `CN_LLM_DOMESTIC_ONLY=true` (the check reads `process.env`, so stub it).
- `server/src/features/match/cron.test.ts` (1) "GoApply with an international scorer model: skips the run": the same; `skipped: 'ai_unavailable'` only behind the wall.

**PAR-7** `server/src/features/jobs/ingest/maintain.test.ts` (1)
- "the real model rule: GoApply needs a domestic CN_* model; RoboApply uses the stack default": GoApply with `{ LLM_ENRICH_MODEL }` or `{ CN_LLM_ENRICH_MODEL: 'openai/gpt-cheap' }` has `modelAvailable: true` (false only behind the wall); the last RoboApply call passes `env: {}`, which now has no model, so give it `LLM_MODEL`.

Still red from PAR-1's list, not caused by PAR-2 (78 failures, 33 files; `MatchService.test.ts` carries one of each kind): unchanged in file and count from PAR-1's handoff for PAR-3, PAR-4, PAR-5, PAR-7 / PAR-11, PAR-8 and PAR-9, except that `legacyJobScope.test.ts` shows 6 here (its seventh, pre-existing one passes in this worktree).

## Pre-existing failures

None observed in a PAR-2 file. Of the 12 PAR-1 recorded as pre-existing (`__tests__/pages/practice.test.tsx`, `settings.test.tsx`, `components/features/onboarding/goapply.test.tsx`, `auth-cn/routes.test.ts`, one in `legacyJobScope.test.ts`), none failed in any full run of this worktree. I did not investigate why; they are outside PAR-2's owns.

## Requests

### Owner

- **GoApply AI now spends on the shared provider keys by default.** Every GoApply text call, enrichment, fit score and campus extraction routes through the same OpenRouter / provider keys as RoboApply until `CN_LLM_*` is set. The enrichment catch-up will start giving GoApply jobs a model pass (bounded by `ENRICH_DAILY_JOBS`), and the per-brand budgets (`COPILOT_DAILY_BUDGET_USD`, `SCORE_DAILY_BUDGET`) are the shared values unless the `CN_` ones are set.
- **`CN_LLM_DOMESTIC_ONLY=true` needs one mainland model, not one per task.** Set `CN_LLM_PROVIDER` and `CN_LLM_MODEL` (or a `CN_LLM_MODEL` with a vendor prefix such as `deepseek/…`). Every GoApply task then runs on that model unless its own `CN_LLM_<TASK>_MODEL` names another; RoboApply's `LLM_<TASK>_MODEL` values are ignored for GoApply. With the wall on and no mainland model, every GoApply AI call answers 503 `ai_unavailable`, the process still boots (one warning) and `npm run verify:llm` exits 1 with the line that says what to set.
- **Behind the wall, write the default with its vendor prefix if you want job enrichment and campus extraction.** Those two (and the fraud check) require a model id that names its mainland vendor (`deepseek/deepseek-v4-flash`), as they did before D5. A bare `CN_LLM_MODEL=deepseek-v4-flash` with `CN_LLM_PROVIDER=deepseek` works for every chat and Assistant call but leaves enrichment on rules only.

### Orchestrator

- **`server/src/platform/flags.test.ts` (PAR-1's, merged): grant the edit at merge.** Three tests pin "a typo in `CN_CONTENT_SAFETY_PROVIDER` turns GoApply AI off", which item 6 changes on purpose. The edit: line 40, `const SAFETY_BROKEN = { CN_CONTENT_SAFETY_PROVIDER: 'nonsense', CN_RESIDENCY_STRICT: 'true' };` (this alone turns lines 251, 252, 254, 271 and 279 green); add one assertion that without the strict switch the same typo leaves the flag on, `expect(isEnabledForBrand(key, go, { CN_CONTENT_SAFETY_PROVIDER: 'nonsense' }), key).toBe(true)`; line 253 (`aliyun_green` without keys) expects `true`, and `false` with `CN_RESIDENCY_STRICT: 'true'` added to the env.
- **Decision for whoever now owns `platform/flags.ts`:** under `CN_LLM_DOMESTIC_ONLY` with no mainland model, `ai.text` stays true, so GoApply shows its AI features and each call answers 503. To make the flag follow, `aiTextConfigured` for `cn` would also require a model when the wall is on: `!cnLlmDomesticOnly(env) || Boolean(getDefaultModel('goapply', env))` (from `lib/llm/llmModels.js`). I did not ask for more because the plan defines the requirement as content safety only.
- `server/src/features/match/cron.ts` is in no bundle's owns (its test file is PAR-11's). No change is needed there for this bundle.

### PAR-5

- `startupAssertions.test.ts`: see above. Behind the wall GoApply no longer inherits an international shared value, so check what GoApply really resolves (`llmService.explainRoute(task, 'goapply')`, or `resolveModelKey(key, 'goapply', env).effective`) and not the raw `LLM_*` variables: `cn_llm_off_allowlist` then fires only for a route GoApply itself names. To report a route as a warning without the wall, ask the policy directly: `checkLlmRoute({ …, env: { ...env, CN_LLM_DOMESTIC_ONLY: 'true' } })`.
- `platform/startup.ts`: `CopilotToolsCheck.skipped` is set in one case only, with `ok: true`: the wall is on and GoApply has no mainland model (LLMService logs one warning). If the strict residency posture should refuse that boot, that belongs in the residency assertions: `cnResidencyStrict(env) && !getDefaultModel('goapply', env)`. GoApply with no copilot or default model and no wall is a failure like RoboApply's (`problem: 'no copilot or default model configured'`). The O-1 acceptance test (production, no scope, shared LLM variables only, no throw) should pass once merged: the same case is green in `LLMService.streaming.test.ts`.
- Disclosures and the cross-border predicate (P5-5): use `llmUsesSharedStack('goapply', env)` from `lib/llm/llmModels.ts` (also exported from `platform/llm/index.ts`) beside `brandUsesSharedStack`. It is false behind the wall, as the LLM part of `brandUsesSharedStack` is. For the endpoint rule use `llmDomesticOnlyApplies(brand, env)`: the wall is enforced for GoApply whenever the switch is on, with or without a provider of its own.
- `contentSafetyReadiness()` has a new `degraded` flag and its `provider` is the one that really runs. `usable` is false only under `CN_RESIDENCY_STRICT`. If startup should say so at boot, log `problems` when `degraded` (the engine already warns once, on first use).

### PAR-11

- The three test files above.
- `features/cn/jobs/fraud/llm.ts`: it reads `brandEnv(brand, 'LLM_FRAUD_MODEL')` and puts the value in the CN task slot of `resolveEnrichModel`, so a shared `LLM_FRAUD_MODEL` is treated as GoApply's own: it is not qualified when GoApply has its own provider, and behind the wall an international shared value is refused instead of falling through to the enrichment model. Use `getEnvModelSetting('LLM_FRAUD_MODEL', brand, env)` and `taskModelRoute(brand, model, env)` (exported from `features/jobs/enrich/index.ts`), as `cn/campus/extract.ts` does.

### PAR-7

- `maintain.test.ts` above.
- `features/admin/safety.ts` copies the readiness fields one by one: add `degraded` so the console can show "running on the keyword list because of: …".

### PAR-4

- For selector variables outside the stack table (`LLM_INTERVIEW_BLUEPRINT_MODEL`, `LLM_INTERVIEW_LIVE_MODEL`) use `getEnvModelSetting(name, brand)` rather than `brandEnv`, so a shared value is qualified when GoApply has its own provider and is not inherited behind the wall unless it names a mainland vendor. `getTaskModel('interview', brand)` already does both.
- `interview-engine/config.ts:439` (`isGoApplyDirectProvider`): that check belongs behind `llmDomesticOnlyApplies(brand, env)` now.

### PAR-10

- Document the variables below, the wall rule (one mainland default is enough; shared international values are ignored for GoApply; a gateway is named in GoApply's own settings), and `npm run verify:llm` as the way to see which stack each GoApply task resolves to (`--db` to include the admin override rows; exit 1 on a refused route, a copilot model without tool streaming, or the wall with no mainland model).

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `CN_LLM_PROVIDER`, `CN_LLM_MODEL`, `CN_LLM_<TASK>_MODEL`, `CN_LLM_FALLBACK_MODEL` and the other `CN_` twins of the `LLM_*` selectors | redefined: optional GoApply overrides, read per key. Unset → the shared `LLM_*` value (RoboApply's admin override first). `CN_LLM_PROVIDER` or `CN_LLM_MODEL` puts GoApply on its own (domestic) profile | unset → shared stack |
| `CN_LLM_DOMESTIC_ONLY` | now enforced: GoApply may use mainland model endpoints only (primary and fallback), no BYOK, task models must name a domestic provider. A shared `LLM_*` value is inherited only when it names a mainland vendor (`deepseek/…`, `dashscope/…`, `kimi/…`, …); any other counts as unset, so a task runs on GoApply's own default. No default gateway: a bare id needs GoApply's own provider. With no mainland model GoApply AI answers 503. Also makes a context-less LLM call throw in production | off |
| `CN_RESIDENCY_STRICT` | for this bundle: implies the wall, and a content-safety setting that cannot run fails closed (GoApply AI off) | off |
| `CN_CONTENT_SAFETY_PROVIDER`, `CN_CONTENT_SAFETY_TIMEOUT_MS`, `CN_SAFETY_KEYWORDS_URL`, `ALIYUN_GREEN_*` | redefined: a value that cannot run falls back to its safe default with one warning; AI stays on | `keyword_only`, 5000 ms, built-in list |
| `CN_LLM_DOMESTIC_HOSTS` | unchanged, but only consulted behind the wall | none |
| `LLM_CAMPUS_MODEL` | new as a shared name: the campus extractor's model when `CN_LLM_CAMPUS_MODEL` is unset | unset → the enrichment model |
| `CN_COPILOT_DAILY_BUDGET_USD`, `CN_SCORE_DAILY_BUDGET`, `CN_RA_SYSTEM_USER_ID` | redefined (by PAR-1's `brandEnv`; tests and comments here): per key, else the shared value | shared value |
| No longer required | `CN_LLM_PROVIDER`, `CN_LLM_MODEL`, `CN_LLM_ENRICH_MODEL`, `CN_LLM_CAMPUS_MODEL` for GoApply AI, enrichment, fit scores and campus extraction (required again, as one mainland default, only behind the wall) | |

## i18n keys added or changed

None. PAR-2 has no namespace. The one changed server string is an operator-facing API error message (campus extraction, admin only): "No model is configured for reading pages; fill the form by hand."

## Known gaps

- **Wall on, no mainland model:** GoApply AI answers 503 while the `ai.text` flag stays true (see Requests → Orchestrator). The boot continues with one warning; `verify:llm` exits 1.
- **A shared stack on a mainland gateway is not inherited behind the wall.** `LLM_PROVIDER=newapi` with an allowlisted host served GoApply behind the wall after the first round; it no longer does, and GoApply needs `CN_LLM_PROVIDER=newapi` and `CN_LLM_MODEL` (the pre-D5 posture). The name of a gateway says nothing about where it is, and reading its host inside the settings resolver would have tied that module to the credential store.
- **Behind the wall, enrichment, campus extraction and the fraud check need a vendor-prefixed model id** (unchanged from before D5): a bare `CN_LLM_MODEL` with `CN_LLM_PROVIDER` serves chat and the Assistant but leaves those three on rules only. Accepting a bare id there when GoApply's own provider is a mainland vendor is a small change in `taskModelRoute`; I left it because it changes what PAR-11's fraud tests must assert.
- **A bare GoApply task model without a provider of its own and without the wall** (for example only `CN_LLM_VISION_MODEL=qwen-vl-max`): GoApply is on the shared profile, so the bare id goes through the shared provider mode (OpenRouter by default). A prefixed id (`dashscope/…`, `qwen/…`, `deepseek/…`) routes as written. `verify:llm` shows the route.
- **Admin overrides and a cold cache:** the per-key order reads two blobs from the in-memory cache. In the first moments after boot (before `warmupLlmStack` completes) a setting that exists only in the database resolves from env, as it already did for RoboApply.
- **`brandUsesSharedStack` (PAR-1) still sees env only;** `llmUsesSharedStack` is the complement and is not wired into any consent decision by this bundle (PAR-5's item).
- **Callers without a brand context** were checked by one traced test run and by reading the entry points, not by a production trace. The one-time warning (`LLM_POLICY`, "LLM call without a brand context") stays as the runtime signal.
- **`verify:llm --db` was not run against a database** (the bundle rules forbid it). Its override labels and its loading of the override rows are covered by the new test with a mocked AppConfig table.
- Not verified in a browser or against a running stack or a real provider (the bundle rules forbid all three).
