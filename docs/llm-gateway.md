# LLM gateway

Added 2026-11-22; per-area fallback models, reasoning effort and Default
inheritance added 2026-11-23. Admins manage AI providers and choose the
provider, model, reasoning effort and fallback models for each kind of work at
**Admin → LLM gateway** (`/admin/llm`). The design follows GoHire-Harness's
gateway (`GoHire-Harness/docs/harness/18-llm-gateway.md`): named provider
entries with a base URL, a key and a fetched model list, and per-purpose routing
that falls back to a default. It is built on RoboApply's per-key model seam.

## What an admin sets

**Providers.** Any number of entries (at most 16). Each has:

| Field | Notes |
|---|---|
| Name | Unique. Shown in the area lists. The entry's id is a slug of its first name and never changes. |
| Type | The client that speaks to the endpoint: OpenAI-compatible (`newapi`), OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot, MiniMax, OpenRouter, Ollama. Add the same type twice for two accounts or two gateways. |
| API base URL | Required for OpenAI-compatible, MiniMax and Ollama; otherwise empty means the vendor's own host. Include the version path (`https://gateway.example.com/v1`), no endpoint suffix. |
| API key | Stored encrypted. Never returned: the page shows a preview (`sk-…ab12`). |
| Models | Fetched from the provider with that key (**Fetch models**), saved with the entry. |

**Functionality areas.** Each is assigned a provider entry, a model and a
reasoning effort, with up to three ordered fallback models, or left unassigned:

| Area | Model keys it owns |
|---|---|
| Default | `defaultModel` |
| Match resume | `matching`, `matchResume`, `matchScreen`, `prematchFilter` |
| Parse resume | `extract`, `resumeTag` |
| Visual | `vision` (image and scanned-page OCR) |
| Evaluation | `evaluation` (interview scorecard, per-question review, recommendations) |
| Insights | `insights` (weekly career summary, cross-bank search summary) |
| Writing | `writing`, `rewrite` |
| Assistant | `copilot`, `onboarding`, `intentParser` |
| Job details | `enrich`, `jobTag`, `quickJob` |

The page shows, under each area, what every one of its keys resolves to now and
where that value comes from: the area's assignment, the Default area's, a saved
per-key setting, an env variable, RoboApply's settings for GoApply, or the
default model.

Not assignable: the live voice interview (`interview`), which accepts only the
models LiveKit lists, and the global fallback model (`LLM_FALLBACK_MODEL`).

## Where a model comes from: the gateway first, then the env

For every key of an area, in this order (`getModelSetting`,
`server/src/lib/llm/llmModels.ts`):

1. the area's own assignment;
2. for an unassigned area, the Default area's assignment: its model, its
   fallbacks and its effort;
3. the key's saved per-key override (`purposes.*` in the stack blob; no page
   edits these);
4. the key's env variable (`LLM_MATCHING_MODEL`, `LLM_VISION_MODEL`, …);
5. the default model: the Default area, else the `defaultModel` override,
   else `LLM_MODEL`.

No model is chosen in code. Visual and Evaluation used to borrow another task's
model when nothing was set (the extract model and the interview model); they now
end on the default model like every other area.

GoApply reads the same order in its own settings (`llm_stack.goapply.{env}`,
then `CN_<NAME>`), then RoboApply's, then the unprefixed env variable. Behind the
domestic-only wall RoboApply's assignments are not used for GoApply.

One guard: `copilot` streams tool calls, so it does not inherit a Default entry
whose type cannot (Google, Anthropic). It keeps its own setting or env value
instead, and the rest of the Assistant area follows Default.

## How an assignment reaches a call

1. An assignment is stored as `routes.<area> = { providerId, model, effort,
   fallbacks: [{ providerId, model, effort }] }` in the stack blob (`AppConfig`
   `llm_stack.{env}`, GoApply: `llm_stack.goapply.{env}`).
2. It becomes the selector `<type>@<entry>:<area>/<model>`, for example
   `newapi@aigw:writing/gpt-6.1-sol`. `<type>@<entry>` pins the entry under
   every provider mode and profile; the `:<area>` route tag changes nothing
   about where the call goes (`services/llm/providerPrefixes.ts`).
3. `resolveProviderCredential('<type>@<entry>…')` returns the entry's key and
   base URL (`lib/llm/systemCredentials.ts`); `LLMService` builds the client of
   the entry's type. Code that needs the client, the policy or a capability of a
   route asks for its base type (`providerBaseType`); circuits and "same
   provider" checks use the entry without its tag (`providerEntryRef`).
4. `LLMService` reads the area's effort and fallbacks from the route
   (`gatewayRouteProfile`), so the ~40 call sites need no change.

Changes apply to new requests within about 30 seconds (the cache TTL of the
blob and of the entries), with no restart.

## Reasoning effort

Each model of an assignment, primary or fallback, has one: Provider default,
Minimal, Low, Medium, High or Max. A new assignment, and one saved before
efforts existed, uses **Medium**.

- The level is sent with every request to that model and wins over the effort
  the call site or the env asks for (`LLM_<TASK>_REASONING_EFFORT`,
  `LLM_REASONING_EFFORT`).
- It is mapped to the nearest level the provider takes
  (`gatewayEffortFor`, `services/llm/reasoningEffort.ts`): OpenAI-style APIs
  and OpenAI-compatible gateways take minimal…high (Max is sent as high);
  OpenRouter takes the whole ladder; Anthropic low…max (Minimal as low);
  Google minimal…high, per model family; DeepSeek only high and max; Kimi
  none.
- **Provider default** sends none of the gateway's own: the call keeps what its
  caller and the env send, else the provider's default. A level the provider
  has no equivalent for (Medium on DeepSeek) behaves the same way.
- OpenAI direct sends the field only to reasoning models (GPT-5+, o-series).
  When any other endpoint refuses the field (HTTP 400/422 naming it), the
  request is sent once more with the caller's effort, and that entry and model
  get no gateway effort for six hours.

## Fallback models

Up to three per assignment, tried in order. No entry and model may appear
twice in one area. Fallbacks of the Assistant must stream tool calls too.

A call moves to the next model when its model:

- fails on credentials (rejected or out-of-credit key, no key): the
  provider's circuit opens for 10 minutes, as before;
- is down or rate-limited (429, 5xx, timeout, empty output);
- is not served by the endpoint (404, "model not found", OpenRouter's "no
  endpoints found", a new-api gateway's "no available channel"). This one moves
  on only for an area with fallbacks.

After the area's own fallbacks come the configured fallback model
(`fallbackModel` override, else `LLM_FALLBACK_MODEL`) and, on a credential
failure only, `LLM_AUTO_FALLBACK_MODELS` and then the default model. A fallback
on an entry that is removed, disabled or keyless, on the provider whose key just
failed, or refused by the brand policy is skipped. A personal (BYOK) key never
falls back to the platform. A streamed Assistant round moves on only before
anything was shown.

The code once auto-selected four hard-coded models after a dead key
(`AUTO_FALLBACK_PREFERENCE`). That list is gone: set `LLM_AUTO_FALLBACK_MODELS`
(comma-separated selectors; GoApply: `CN_LLM_AUTO_FALLBACK_MODELS`, else the
shared value) or add fallback models in the gateway. `LLM_FALLBACK_AUTO=false`
still turns the credential-failure routes off.

## Rules that are easy to break

- **The gateway first, then the env.** An unassigned area uses Default before
  any per-key setting or env variable. With Default unassigned too, an area
  keeps the setting it has. `LLM_SETTINGS_DB_DISABLED=true` ignores all saved
  settings.
- **A broken entry never blacks out an area.** If an entry is removed, turned
  off, has no key, or its key does not decrypt with this server's
  `FIELD_ENCRYPTION_KEY`, the area resolves as if it were not assigned (so it
  uses Default), and the page says so. An entry cannot be removed while an area
  of either brand uses it, for its model or a fallback.
- **Keys.** Encrypted with `lib/crypto.ts` (AES-256-GCM, `FIELD_ENCRYPTION_KEY`),
  stored in `AppConfig` `llm_providers.{env}`. No response, log or audit row
  carries a key. An update with an empty key keeps the saved one, except when
  the endpoint host changes: then the key must be entered again, so a saved key
  is never sent to a host it was not entered for.
- **`LLM_PROXY_KEY` is never sent to an entry.** It is the secret of the
  deployment's own proxy; an entry's host is whatever an admin typed.
- **Brand policy is unchanged and judged on the entry's host**, for the model
  and for every fallback. RoboApply user data never goes to an entry on a
  mainland-China endpoint. Behind GoApply's domestic-only wall an
  OpenAI-compatible entry is allowed only on an allowlisted mainland host.
- **The Assistant needs tool streaming.** An entry whose type cannot stream
  tool calls (Google, Anthropic) is refused for the Assistant's model and
  fallbacks on save, and `copilot` does not inherit such a Default.
- **Model lists are read-only requests.** `GET <base>/models` (Anthropic and
  Google use their own list endpoints), 8-second timeout, no redirects, at most
  8 MiB, base URL checked against the BYOK SSRF rules. Failures are fixed
  codes; a provider's error text is never shown. A list shows what the provider
  lists, not that the key may generate with each model: a model ID can also be
  typed by hand.
- **No schema change.** Both stores are `AppConfig` rows, per environment.
  Saves write an `AdminAdjustment` audit row (`llm_provider:{env}`,
  `llm_stack_config:{env}`). A route saved before efforts and fallbacks
  existed reads as Medium with no fallbacks.
- **Disclosures.** `features/compliance/disclosures.ts` reads the same order
  (`blobModelSelector`) and lists every fallback model as a destination
  (task `fallback`). A model is listed under the entry's vendor when it uses the
  vendor's own host, else under the entry's host; a mainland host is region CN,
  any other gateway is not listed.

## Files

| Path | Role |
|---|---|
| `server/src/lib/llm/gatewayProviders.ts` | Provider entries: store, cache, save rules, model lists |
| `server/src/lib/llm/gatewayAdmin.ts` | Overview, area assignments, remove guard |
| `server/src/lib/llm/llmStackConfigSchema.ts` | `LLM_AREAS`, `AREA_MODEL_KEYS`, `GATEWAY_EFFORTS`, `routes` in the blob |
| `server/src/lib/llm/llmModels.ts` | Resolution order, `gatewayRouteProfile`, `blobModelSelector` |
| `server/src/services/llm/LLMService.ts`, `fallbackRouting.ts`, `reasoningEffort.ts` | Effort per route, the fallback chain, the retry without effort |
| `server/src/roboapply/v2/routes/adminLlm.ts` | `/api/v1/roboapply/v2/admin/llm` (admin only) |
| `lib/api/adminLlm.ts`, `components/v3/admin/LlmGatewayConsole.tsx` | Client and page |
| `server/src/lib/llm/gateway.test.ts`, `components/v3/admin/__tests__/llmGateway.test.tsx` | Tests |

## Not done

- Token budgets and per-model prices (GoHire-Harness has them).
- Capability detection from model lists (tools, image input). The page states
  what an area needs; it does not verify the chosen model.
- A per-user BYOK key still replaces the platform key by provider type, as
  before, including for an entry of that type.
