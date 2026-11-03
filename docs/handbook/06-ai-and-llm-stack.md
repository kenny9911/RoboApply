# 06 · AI and the LLM stack

As of 2026-11-03 (main @ b89d5256).

Every text model call in the API goes through one service, `LLMService`. A call picks its model from a **task key**. The task key resolves through admin DB override → env var, per brand. The selector string decides the provider by its prefix, and a brand policy can refuse the route. Most production incidents in this area came from a model choice that was legal in one of those layers and illegal in another, so read §7 before changing any model.

## 1. Where things live

| Concern | Path |
|---|---|
| The service, providers, retries, fallback | [`server/src/services/llm/`](../../server/src/services/llm/) (`LLMService.ts`, `*Provider.ts`, `fallbackRouting.ts`, `withRetry.ts`, `toolStreaming.ts`, `reasoningEffort.ts`, `providerPrefixes.ts`) |
| Model settings: task keys, env names, DB blob | [`server/src/lib/llm/`](../../server/src/lib/llm/) (`llmTaskSettings.ts`, `llmModels.ts`, `llmStackConfigSchema.ts`, `llmStackConfigResolver.ts`, `llmSelector.ts`, `systemCredentials.ts`) |
| Brand routing policy, egress, content safety | [`server/src/platform/llm/`](../../server/src/platform/llm/) |
| Agent base class | [`server/src/agents/BaseAgent.ts`](../../server/src/agents/BaseAgent.ts) |
| Embeddings | [`server/src/platform/embeddings/`](../../server/src/platform/embeddings/) |
| Interview voice models | [`server/src/interview-engine/config.ts`](../../server/src/interview-engine/config.ts), `interview-agent/` |
| Cost table | [`server/src/lib/modelCostTable.ts`](../../server/src/lib/modelCostTable.ts) → [`docs/LLM_COSTS.md`](../LLM_COSTS.md) |
| Boot checks | [`server/src/platform/startup.ts`](../../server/src/platform/startup.ts) |

## 2. Providers and selectors

Providers: OpenRouter, OpenAI, Google (Gemini SDK), Anthropic, DeepSeek, Kimi/Moonshot, and an OpenAI-compatible adapter for MiniMax, Ollama, `newapi` (a gateway) and the mainland vendors Qwen/DashScope, GLM/Zhipu and Doubao/Ark.

A **selector** is `<routing-prefix>/<model>`. The first segment is a routing hint if it is in `DIRECT_PROVIDER_PREFIXES` ([`providerPrefixes.ts`](../../server/src/services/llm/providerPrefixes.ts)); the prefix is stripped before the call.

| Selector | Goes to | Model id sent |
|---|---|---|
| `google/gemini-3.8-flash` (or `gemini/…`) | Google direct | `gemini-3.8-flash` |
| `openrouter/google/gemini-3.8-flash` | OpenRouter | `google/gemini-3.8-flash` |
| `deepseek/deepseek-v4-pro` | DeepSeek direct (mainland host) | `deepseek-v4-pro` |
| `anthropic/claude-sonnet-4-6` | Anthropic direct | `claude-sonnet-4-6` (Anthropic ids are dashed; OpenRouter slugs are dotted, and `AnthropicProvider` does not translate) |
| `qwen/…` | DashScope only on GoApply's own (domestic) profile; elsewhere an OpenRouter slug. `dashscope/…` is unambiguous. | |
| `vendor/model` with an unknown prefix, or a bare id | The **provider mode**: `LLM_PROVIDER`, default `openrouter`. Mode `direct` sends `vendor/model` to OpenRouter and a bare id to the default model's provider. | |

The rule lives in `resolveSelectorRoute()`; both `LLMService` and the tooling use it. `parseLlmSelector()` ([`llmSelector.ts`](../../server/src/lib/llm/llmSelector.ts)) is the per-call `llm` override some agents accept.

**API keys** resolve per provider as user BYOK (where the brand allows it) → `SystemLLMKey` DB row (encrypted with `FIELD_ENCRYPTION_KEY`) → env (`OPENROUTER_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …); see [`systemCredentials.ts`](../../server/src/lib/llm/systemCredentials.ts). If a `SystemLLMKey` row exists, rotating the env key changes nothing. A row that cannot be decrypted is logged and falls back to env.

## 3. How a call picks its model

### Task keys

[`llmTaskSettings.ts`](../../server/src/lib/llm/llmTaskSettings.ts) defines the candidate-product tasks: `matching`, `extract`, `onboarding`, `rewrite`, `interview`, `copilot`, `enrich`, `writing`. [`llmStackConfigSchema.ts`](../../server/src/lib/llm/llmStackConfigSchema.ts) maps every model key to its env var in `MODEL_ENV`, for example `matching → LLM_MATCHING_MODEL`, `copilot → LLM_COPILOT_MODEL`, `defaultModel → LLM_MODEL`, `fallbackModel → LLM_FALLBACK_MODEL`. `PURPOSE_KEYS` also carries RoboHire keys (`fast`, `pro`, `evaluation`, `crm*`, `agentAlex`, …); only a few of them are read by RoboApply code: `intentParser` → `fast` (job search, prep role resolver) and `matchResume` (`ResumeMatchAgent`).

| Task | Typical callers |
|---|---|
| `extract` | Resume parse, PDF, resume summary |
| `matching` | `RAJobMatchScorerAgent`, match scorer route |
| `onboarding` | Onboarding resume seed |
| `rewrite` | Resume rewrite, resume check, builder suggestions |
| `writing` | Cover letters, outreach, offers, prep writing, extension answers |
| `enrich` | Job enrichment (cheap, high volume) |
| `interview` | Blueprint, scoring, coaching, text mock interviewer |
| `copilot` | The Assistant (streamed, with tool calls) |

A task with no model inherits the default model (`LLM_MODEL`). This happens through `getTaskModelOrDefault`, or when an agent passes `undefined` and `LLMService` falls back to the default. There is no hard-coded model default: if neither the task model nor `LLM_MODEL` is set, the call throws. Only the provider mode has a code default (`openrouter`).

### Precedence

For RoboApply, each key resolves to the first set value of:

1. the admin override blob, `AppConfig` row `llm_stack.{env}` (`env` is `production` when `NODE_ENV=production`, else `development`);
2. the env var (`LLM_*`).

For GoApply, per key: its own blob `llm_stack.goapply.{env}` → `CN_<NAME>` → RoboApply's blob → `<NAME>`. RoboApply never reads a `CN_` value or GoApply's blob. Retry and timeout tuning (`LLM_RETRY_*`, `LLM_TIMEOUT_MS`) is shared and comes from RoboApply's blob or env.

**The blob cache** ([`llmStackConfigResolver.ts`](../../server/src/lib/llm/llmStackConfigResolver.ts)) holds one snapshot per brand with a 30 s TTL. The hot path reads it synchronously. A cold cache returns an all-null blob, so the call uses the env value, and a background fetch warms it. A DB error keeps the last blob for 10 s. Consequences:

- A fresh serverless instance serves its first calls, and runs its boot checks, on **env values**. Warm instances use the blob. Production config therefore has to be valid in **both** places.
- `warmupLlmStack()` and `saveLlmStack()` exist but nothing calls them. There is no RoboApply admin UI for the blob; the owner edits the `AppConfig` row directly (which also skips the `AdminAdjustment` audit that `saveLlmStack` writes).
- `LLM_SETTINGS_DB_DISABLED=true` ignores the blob entirely.

To see what actually resolves, run `npx tsx scripts/verify-llm-brand.ts` (flags: `--brand`, `--db` to include the blob, `--probe` to send a 1-token call, `--require-priced`). `--db` and `--probe` touch the database and providers. The owner's notes say tsx scripts fail inside the Claude Code Bash sandbox, so run them outside it.

## 4. Resilience

[`fallbackRouting.ts`](../../server/src/services/llm/fallbackRouting.ts) and `LLMService.buildFallbackCandidates`:

- **Transient errors** (429, 5xx, timeouts, empty output) are retried on the same route by `withLLMRetry`: 3 attempts by default, 800 ms base, 6 s max (`LLM_RETRY_ATTEMPTS`/`_BASE_MS`/`_MAX_MS`). If a fallback model is configured, transient failures also try it.
- **Credential failures** (401, 402, billing text, non-moderation 403, missing key) are never retried. They open a **10-minute in-process circuit** for that provider and key fingerprint, then try:
  1. the configured fallback (`fallbackModel` in the blob, else `LLM_FALLBACK_MODEL`);
  2. unless `LLM_FALLBACK_AUTO=false`, `AUTO_FALLBACK_PREFERENCE`: `google/gemini-3.8-flash` → `anthropic/claude-sonnet-4-6` → `deepseek/deepseek-v4-flash` → `openai/gpt-6-luna`. These are direct providers only, never OpenRouter. A hop is skipped if its provider has no key, has an open circuit, is refused by the brand policy, or (for the Assistant) cannot stream tools.
- With no route left the call throws `LLMUnavailableError` (`code: 'llm_unavailable'`, no HTTP status). The interview control plane maps it to 503; elsewhere, check the route's error handler. It deliberately carries no 401, so the browser does not read it as "session expired".
- Per-request 403s (moderation "flagged", region blocks) don't open the circuit.

Practical effect: a dead OpenRouter key makes one burst of errors, then calls quietly run on Google direct for 10 minutes at a time. The Assistant is the exception: Google cannot serve it, so it fails.

## 5. Brand policy

[`platform/llm/brandPolicy.ts`](../../server/src/platform/llm/brandPolicy.ts) checks the **endpoint host** of the primary route and of every fallback hop:

- **RoboApply:** a prompt that carries user data never goes to a mainland-China endpoint (`api.deepseek.com`, `api.moonshot.cn`, DashScope, Zhipu, Ark, MiniMax China, or `newapi` pointed at one). OpenRouter serving a DeepSeek model is allowed (host `openrouter.ai`). Only a call that sets `carriesUserData: false` explicitly skips the check.
- **GoApply, default:** every route RoboApply may use, plus the domestic vendors. GoApply runs on the shared stack (profile `global`) unless `CN_LLM_PROVIDER` or `CN_LLM_MODEL` (or a provider in its blob) gives it its own (profile `domestic_cn`). A bare `CN_LLM_MODEL` with no `CN_LLM_PROVIDER` has no route, and GoApply AI then answers 503.
- **GoApply domestic-only wall:** `CN_LLM_DOMESTIC_ONLY=true` (implied by `CN_RESIDENCY_STRICT=true`; opt-in, never assumed). Only mainland vendors on mainland hosts (`CN_LLM_DOMESTIC_HOSTS` for a self-hosted gateway), no international fallback, no BYOK. Shared values that name no mainland vendor are not inherited.
- Every GoApply call also passes content safety on input and output (`platform/llm/contentSafety/`, events in `RAContentSafetyEvent`).

The per-brand rules are in [ARCHITECTURE §1.8](../jobright-clone/ARCHITECTURE.md) and `GOAPPLY_PARITY_PLAN.md` §3.3. `.env.example` documents every `CN_LLM_*` override.

## 6. Tool streaming, thinking models and agents

### The Assistant needs tool streaming

The Assistant (`features/copilot/CopilotService.ts`) calls `LLMService.streamChatWithTools` with `task: 'copilot'` and `carriesUserData: true`. Tool calls are streamed over the OpenAI chat-completions protocol. `TOOL_STREAMING_PROVIDERS` in [`toolStreaming.ts`](../../server/src/services/llm/toolStreaming.ts) lists openrouter, openai, deepseek, kimi/moonshot, minimax, ollama, newapi, qwen, glm and doubao. **Google direct and Anthropic are not in it.**

At boot, `assertCopilotModelSupportsTools` runs through `platform/startup.ts` for every served brand whose copilot capability is on. In production, if the copilot route of the **primary brand** cannot stream tools, is refused by policy, or doesn't exist, the API **refuses to boot**, and every `/api/v1/*` request returns 500. A failure for a non-primary brand only logs an error. Outside production it is a warning. The escape hatch is `FLAG_<BRAND>_COPILOT=false`.

Because an unset `LLM_COPILOT_MODEL` inherits `LLM_MODEL`, switching the default model to a `google/…` selector takes the API down unless the copilot model is set explicitly. That happened on 2026-10-13 (owner's notes). For RoboApply in production, OpenRouter is effectively the only workable copilot provider: DeepSeek and Kimi are mainland hosts, and the owner's notes say the OpenAI key was out of credit.

### Thinking models and max tokens

Reasoning tokens count against the output cap. A small `maxTokens` on a thinking model returns empty or cut-off output. That looks like a parse failure, and after 3 retries it surfaces as a 502.

- **Google:** `googleMaxOutputTokens()` adds a reserve on top of the caller's cap for Gemini 2.5/3 (`GOOGLE_REASONING_MAX_TOKENS`, default 8,000, or the agent's `getReasoningMaxTokens()` if larger).
- **DeepSeek:** the same idea (`DEEPSEEK_REASONING_MAX_TOKENS`, default 8,000).
- **OpenRouter:** sends `reasoning.max_tokens` from `getReasoningMaxTokens()`, but an explicit reasoning effort wins over it. With a task effort set, only a large enough `getMaxTokens()` protects the agent.
- **Effort** ([`reasoningEffort.ts`](../../server/src/services/llm/reasoningEffort.ts)): `LLM_<TASK>_REASONING_EFFORT` → admin key tuning → provider env (e.g. `DEEPSEEK_REASONING_EFFORT`) → `LLM_REASONING_EFFORT`. Each provider drops values it doesn't accept (DeepSeek takes high/max only; OpenAI direct has no `max`).

### BaseAgent

[`BaseAgent<TInput, TOutput>`](../../server/src/agents/BaseAgent.ts) is the pattern for single-shot agents. Subclasses implement `getAgentPrompt()`, `formatInput(input, locale)` and `parseOutput()`, and may override:

- `getTemperature()` (default 0.7);
- `getMaxTokens()`: set it for small structured outputs, because OpenRouter pre-checks credit against the cap;
- `getReasoningMaxTokens()`, `getReasoningEffort()`;
- `getResponseFormat()`: return `'json_object'` to opt into provider JSON mode. It is off by default, and must stay off for agents that write reasoning before the JSON.
- `getLocaleDirective(locale)`: see below.

`execute()` / `executeWithJsonResponse()` wrap the call in `withLLMRetry` and log per-agent cost. The model is passed in by the caller, usually from a `pick…Model()` helper that calls `getTaskModel(task)`.

**Output language.** `languageService.getStrictOutputLanguageDirective(locale, scope)` has two scopes:

- `'analysis'`: the agent writes *about* the user's documents (scoring, evaluation).
- `'content'`: the agent *authors* the artifact (resume bullets, cover letters, interview questions, interviewer turns).

Authoring agents must use `'content'` and put `this.outputLanguageReminder(locale)` on the first line of the user message. With `'analysis'` the model can satisfy the directive and still write English; this shipped once. The reference implementation is `RAResumeRewriteAgent`.

**Where agents live:**

- `server/src/agents/`: `BaseAgent`, `ResumeParseAgent`, `ResumeMatchAgent`.
- `server/src/roboapply/v2/agents/`: match scorer, career insight, cross-bank explorer/insight, resume rewrite/tailor, onboarding resume seed, text mock interviewer, interview questions/strategy/tactics/job requirements.
- `server/src/features/*/`: cover letter, outreach, offer writer, resume check/builder, prep agents, job enrichment (`features/jobs/enrich/agent.ts`).
- `server/src/interview-engine/`: `prompt/InterviewBlueprintAgent`, `scoring/{HolisticScorecard,QuestionDeepDive,Recommendations}Agent`, `coaching/InterviewCoachAgent`, and `prep/agents.ts` (role resolver, industry roles, company style, interview planner).
- Prep skills (archetypes, formats, domains, patterns, markets): `interview-engine/skills/` and `catalog/`. See [PREP_AGENTS.md](../interview-practice/PREP_AGENTS.md).

`raModels.ts` and its two routing paths no longer exist. The file and the direct `buildAnthropicClient` onboarding-chat path were deleted in `8ff0c8b5` (2026-08-29); V2 agents now resolve models with `getTaskModel()`. A few `RA_V2_*_MODEL` env names remain (e.g. `RA_V2_CROSSBANK_EXPLORER_MODEL`, `RA_V2_CAREER_INSIGHT_MODEL`). The general lesson still holds: a direct SDK client wants the provider's own id, while `LLMService` wants a routing prefix.

## 7. Interview voice models

The voice interview uses three model settings ([`interview-engine/config.ts`](../../server/src/interview-engine/config.ts)):

| Setting | Used for | Fallback |
|---|---|---|
| `LLM_INTERVIEW_MODEL` (task `interview`; blob overridable) | Blueprint, evaluation, coaching, text practice | `LLM_MODEL` for calls that inherit |
| `LLM_INTERVIEW_LIVE_MODEL` (env only) | Live turns in the LiveKit worker | `LLM_INTERVIEW_MODEL` |
| `LLM_INTERVIEW_BLUEPRINT_MODEL` (env only) | Prepare step and practice-prep planner | `LLM_INTERVIEW_MODEL` |

Live turns run on **LiveKit Inference**, not through `LLMService`. The live selector must map through `ALIGNED_INTERVIEW_MODELS` (plus mapped Kimi K2.5/K2.6 and `deepseek/deepseek-v4-pro`). Otherwise session create throws `InterviewEngineConfigError`, which returns **503** before LiveKit is contacted. The list holds GPT-6 luna/sol, GPT-5.x, GPT-4.x, and Gemini 2.5/3.x up to `gemini-3.6-flash`. **`google/gemini-3.8-flash` is not in it.** The LiveKit docs and SDK types lag the gateway, so check an id against the gateway itself with `cd interview-agent && npm run verify:llm -- <model>`, and update the mirror list in `interview-agent/verify-llm.mjs` too. Never add an id that hasn't been probed: an unserved id type-checks, then the room dies silently.

Live effort: `LLM_INTERVIEW_LIVE_REASONING_EFFORT`, default `low` for OpenAI reasoning families and none otherwise. `max` is rejected.

Speech: STT defaults to `deepgram/nova-3` with fallback `deepgram/nova-2` (`INTERVIEW_ENGINE_STT_MODEL`, `INTERVIEW_ENGINE_STT_FALLBACK_MODELS`). TTS comes from the per-locale voice catalog in `interview-engine/voice/voiceCatalog.ts` (mostly Cartesia `sonic-3`), with `INTERVIEW_ENGINE_TTS_*` and `INTERVIEW_ENGINE_VOICE_<LOCALE>` / `_MODEL_<LOCALE>` overrides. GoApply can switch to DashScope speech with `CN_INTERVIEW_ENGINE_STT_MODEL` + `CN_INTERVIEW_ENGINE_TTS_MODEL`. An alternative voice engine (Parley) sits behind `INTERVIEW_ENGINE_PARLEY_PILOT`.

## 8. Embeddings, retrieval and web search

- **Embeddings** ([`platform/embeddings/client.ts`](../../server/src/platform/embeddings/client.ts)) are the only embeddings path; `LLMService` has none. It calls an OpenAI-compatible `/embeddings` endpoint. Settings are `EMBED_MODEL` (default `openai/text-embedding-3-small`), `EMBED_BASE_URL` (default OpenAI), `EMBED_API_KEY` (else `OPENAI_API_KEY` when no base URL is set), `EMBED_BATCH_SIZE` and `EMBED_DAILY_TOKENS` (per-brand budget in `RARateCounter`). GoApply uses `CN_EMBED_*`, and the base URL and key must be set as a pair. Every vector is 1024-dim to fit the `halfvec(1024)` columns. A wrong length fails the call; nothing is padded. With no key, a policy refusal or a spent budget, the result is `{ unavailable }` and retrieval runs without the dense leg. It never invents a vector.
- **Retrieval** (`features/retrieval/`) builds job and user texts, a sweep queues embedding work, and vectors are read and written with raw SQL ([05 §5](05-data-model.md)).
- **Web search** uses Tavily (`TAVILY_API_KEY`) for interview research, prep company style and job-detail news. Callers run `assertNoPiInPayload` ([`platform/residency/egressPolicy.ts`](../../server/src/platform/residency/egressPolicy.ts)) first: the query is refused if it contains an email, phone number, government id or a known user value such as the user's name. Tavily helpers never throw; with no key they return nothing.
- **Job-link import** reads pages through Firecrawl. `IMPORT_FETCH_DENYLIST` (on top of a built-in list: LinkedIn, Indeed, Glassdoor, BOSS直聘, 104, …) blocks sites that must not be machine-read, including after redirects ([`features/jobs/import/urlPolicy.ts`](../../server/src/features/jobs/import/urlPolicy.ts)).

## 9. Costs

- [`modelCostTable.ts`](../../server/src/lib/modelCostTable.ts) has one row per model (USD per 1M tokens); other id shapes are derived. `LoggerService.logLLMCall` prices every call through `modelPricing.ts`. An unknown id bills at the $1 in / $3 out default and warns. Spend is stored per row at write time; repricing is forward-only.
- `npm run llm:costs` prints the table and lists every configured `LLM_*` model with no row. `-- --write` regenerates [`docs/LLM_COSTS.md`](../LLM_COSTS.md).
- `npm run check:llm-costs` (part of `npm run check`) **only fails when `LLM_COSTS.md` is out of date** with the table. It does not fail on unpriced configured models. Use `verify-llm-brand.ts --require-priced` for that.
- An admin `rate_card.{env}` blob in `AppConfig` overrides the table's display; clear stale entries after a repricing.
- Volume budgets: job enrichment `ENRICH_DAILY_JOBS` (default 8,000 per market per day), Assistant `COPILOT_DAILY_BUDGET_USD`, embeddings `EMBED_DAILY_TOKENS`.

## 10. Production configuration (last known, not verified by this author)

From the owner's notes, October 2026:

- Text tasks run on **`google/gemini-3.8-flash` via Google direct**. The owner's instruction: never `gemini-3-flash-preview`. The production blob `llm_stack.production` was set so on 2026-10-13 (`defaultModel`, `fallbackModel` and the purposes), and Vercel `LLM_MODEL` matches.
- The Assistant runs on **`openrouter/google/gemini-3.8-flash`**, set in both `purposes.copilot` in the blob and Vercel `LLM_COPILOT_MODEL`.
- OpenRouter keys have had problems: the local key answered 401 "User not found" (2026-10-13 and 2026-10-20), and production OpenRouter answered 403 "provider Terms Of Service" for Google models. Whether 3.8-flash is affected is unverified. The local OpenAI key had no credit, and Anthropic needed a top-up (HANDOFF §6). **Check a provider before relying on it.**
- Production has no `LLM_MATCHING_MODEL`, so the scorer uses the default model. Changing it marks stored fit scores stale, and they are re-scored within the daily budgets.
- Vercel env is used while an instance's blob cache is cold; the blob wins on warm instances.
- Interview models in production were not recorded in the notes. Given the allowlist, `gemini-3.8-flash` cannot be the live model.

## 11. Changing a model safely

1. **Decide the layer.** In production, change the blob (`AppConfig` `llm_stack.production`, and `llm_stack.goapply.production` if GoApply has its own) **and** the Vercel env var to the same value. Cold instances read env, warm ones read the blob. Record what you changed; a direct row edit leaves no `AdminAdjustment`.
2. **Check the selector routes where you think.** Use a `google/` or `openrouter/` prefix explicitly. Run `npx tsx scripts/verify-llm-brand.ts --brand roboapply` (add `--db` for the blob, outside the sandbox).
3. **Copilot.** If you touch `LLM_MODEL` or `LLM_COPILOT_MODEL`, make sure the copilot route is still a tool-streaming provider allowed for RoboApply. Simulate the boot check with production-like env: a tsx script that sets the env, imports `assertCopilotModelSupportsTools` from `server/src/services/llm/LLMService.ts` and prints `assertCopilotModelSupportsTools({ throwOnError: false })`. Every entry must be `ok: true`.
4. **Interview.** If the change reaches `LLM_INTERVIEW_MODEL` or `LLM_INTERVIEW_LIVE_MODEL`, the live selector must be in `ALIGNED_INTERVIEW_MODELS`; probe it with `npm run verify:llm` in `interview-agent/`.
5. **Thinking budget.** If the new model thinks (Gemini 2.5/3, DeepSeek, GPT-5/6, o-series), check agents with small `getMaxTokens()` caps.
6. **Cost.** Make sure the model has a row in `modelCostTable.ts` (`npm run llm:costs`). Add the row and run `npm run llm:costs -- --write` if not.
7. **GoApply.** With `CN_LLM_DOMESTIC_ONLY`, a non-mainland shared value is ignored, so check what GoApply resolves to instead.
8. **After deploy,** call a real `/api/v1/*` route. `/api/health` is served by Next.js ([`app/api/health/route.ts`](../../app/api/health/route.ts)) and stays green while the Express function is refusing to boot. If the API does not boot, promote the previous deployment first, then fix.

## 12. Stale or contradictory docs

- The `raModels.ts` routing trap in older notes and briefs is obsolete; the file was deleted on 2026-08-29.
- ARCHITECTURE §1.8 says the GoApply blob is looked up under `llm.stack.<brandId>`; the code uses `llm_stack.goapply.{env}`. The same section says `check:llm-costs` must cover every `CN_*` model; the script only checks the doc is in sync.
- `llmStackConfigResolver.ts` describes "invalidate-on-save so admin edits land within ~1s", and `withRetry.ts` mentions an admin page at `/product/admin/llm-settings`. Nothing in RoboApply calls `saveLlmStack`, and there is no such page here (RoboHire heritage).
- `fallbackRouting.ts` lists `anthropic/claude-sonnet-4-6` as an auto-fallback hop and notes it was unverified (Anthropic key out of credit on 2026-10-09).
