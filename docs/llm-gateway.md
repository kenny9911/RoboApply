# LLM gateway

Added 2026-11-22. Admins manage AI providers and choose the provider and model
for each kind of work at **Admin → LLM gateway** (`/admin/llm`). The design
follows GoHire-Harness's gateway (`GoHire-Harness/docs/harness/18-llm-gateway.md`):
named provider entries with a base URL, a key and a fetched model list, and
per-purpose routing that falls back to a default. It is built on RoboApply's
existing per-key model seam, so nothing changes until an area is assigned.

## What an admin sets

**Providers.** Any number of entries (at most 16). Each has:

| Field | Notes |
|---|---|
| Name | Unique. Shown in the area lists. The entry's id is a slug of its first name and never changes. |
| Type | The client that speaks to the endpoint: OpenAI-compatible (`newapi`), OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot, MiniMax, OpenRouter, Ollama. Add the same type twice for two accounts or two gateways. |
| API base URL | Required for OpenAI-compatible, MiniMax and Ollama; otherwise empty means the vendor's own host. Include the version path (`https://gateway.example.com/v1`), no endpoint suffix. |
| API key | Stored encrypted. Never returned: the page shows a preview (`sk-…ab12`). |
| Models | Fetched from the provider with that key (**Fetch models**), saved with the entry. |

**Functionality areas.** Each is assigned one provider entry and one model, or
left to inherit:

| Area | Model keys it owns | Unassigned and unset, it uses |
|---|---|---|
| Default | `defaultModel` | `LLM_MODEL` |
| Match resume | `matching`, `matchResume`, `matchScreen`, `prematchFilter` | the default model |
| Parse resume | `extract`, `resumeTag` | the default model |
| Visual | `vision` (image and scanned-page OCR) | the Parse resume model |
| Evaluation | `evaluation` (interview scorecard, per-question review, recommendations) | the interview model |
| Insights | `insights` (weekly career summary, cross-bank search summary) | the default model |
| Writing | `writing`, `rewrite` | the default model |
| Assistant | `copilot`, `onboarding`, `intentParser` | the default model |
| Job details | `enrich`, `jobTag`, `quickJob` | the default model |

The page shows, under each area, what every one of its keys resolves to now and
where that value comes from (the assignment, an env variable, RoboApply's
setting for GoApply, or the fallback above).

Not assignable: the live voice interview (`interview`), which accepts only the
models LiveKit lists, and the global fallback model (`LLM_FALLBACK_MODEL`).

## How an assignment reaches a call

1. An assignment is stored as `routes.<area> = { providerId, model }` in the
   stack blob (`AppConfig` `llm_stack.{env}`, GoApply: `llm_stack.goapply.{env}`).
2. `getModelSetting(key)` (`server/src/lib/llm/llmModels.ts`) reads, as the
   key's admin override, its area's assignment and then its own per-key
   override. An assignment becomes the selector `<type>@<entry>/<model>`, for
   example `newapi@aigw/gpt-6.1-sol`. The existing order is unchanged:

   ```
   RoboApply   override (area assignment, else per-key)  →  env
   GoApply     its override  →  CN_<NAME>  →  RoboApply's override  →  env
   ```
3. `<type>@<entry>` is a routing prefix (`services/llm/providerPrefixes.ts`). It
   pins the entry under every provider mode and profile.
4. `resolveProviderCredential('<type>@<entry>')` returns the entry's key and
   base URL (`lib/llm/systemCredentials.ts`); `LLMService` builds the client of
   the entry's type with them. Code that needs the client, the policy or a
   capability of a route asks for its base type (`providerBaseType`).

Changes apply to new requests within about 30 seconds (the cache TTL of the
blob and of the entries), with no restart.

## Rules that are easy to break

- **Unassigned means unchanged.** With no assignment, every key resolves exactly
  as before. `LLM_SETTINGS_DB_DISABLED=true` ignores all saved settings.
- **A broken entry never blacks out an area.** If an entry is removed, turned
  off, has no key, or its key does not decrypt with this server's
  `FIELD_ENCRYPTION_KEY`, the area resolves as if it were not assigned, and the
  page says so. An entry cannot be removed while an area of either brand is
  assigned to it.
- **Keys.** Encrypted with `lib/crypto.ts` (AES-256-GCM, `FIELD_ENCRYPTION_KEY`),
  stored in `AppConfig` `llm_providers.{env}`. No response, log or audit row
  carries a key. An update with an empty key keeps the saved one, except when
  the endpoint host changes: then the key must be entered again, so a saved key
  is never sent to a host it was not entered for.
- **`LLM_PROXY_KEY` is never sent to an entry.** It is the secret of the
  deployment's own proxy; an entry's host is whatever an admin typed.
- **Brand policy is unchanged and judged on the entry's host.** RoboApply user
  data never goes to an entry on a mainland-China endpoint. Behind GoApply's
  domestic-only wall an OpenAI-compatible entry is allowed only on an
  allowlisted mainland host, and RoboApply's assignments are not used for
  GoApply.
- **The Assistant needs tool streaming.** An entry whose type cannot stream
  tool calls (Google, Anthropic) is refused for the Assistant area on save.
- **Model lists are read-only requests.** `GET <base>/models` (Anthropic and
  Google use their own list endpoints), 8-second timeout, no redirects, at most
  8 MiB, base URL checked against the BYOK SSRF rules. Failures are fixed
  codes; a provider's error text is never shown. A list shows what the provider
  lists, not that the key may generate with each model: a model ID can also be
  typed by hand.
- **No schema change.** Both stores are `AppConfig` rows, per environment.
  Saves write an `AdminAdjustment` audit row (`llm_provider:{env}`,
  `llm_stack_config:{env}`).
- **Disclosures.** `features/compliance/disclosures.ts` lists an assigned model
  under the entry's vendor when it uses the vendor's own host, else under the
  entry's host; a mainland host is region CN, any other gateway is not listed.

## Behaviour that moved

Three call sites now read their own key first and fall back to what they used
before, so they only change when the new key or its area is set:

- File OCR (`PDFService`): `vision`, else `extract`. `LLM_VISION_MODEL`, if set,
  now applies to OCR.
- Interview report scoring (`HolisticScorecardAgent`, `QuestionDeepDiveAgent`,
  `RecommendationsAgent`): `evaluation`, else `interview`. `LLM_EVALUATION`, if
  set, now applies. The live interviewer and coaching hints stay on `interview`.
- Insights (`RACareerInsightAgent`, `RACrossBankInsightAgent`): the `insights`
  key, whose env variable is the existing `RA_V2_CAREER_INSIGHT_MODEL`.

## Files

| Path | Role |
|---|---|
| `server/src/lib/llm/gatewayProviders.ts` | Provider entries: store, cache, save rules, model lists |
| `server/src/lib/llm/gatewayAdmin.ts` | Overview, area assignments, remove guard |
| `server/src/lib/llm/llmStackConfigSchema.ts` | `LLM_AREAS`, `AREA_MODEL_KEYS`, `routes` in the blob |
| `server/src/roboapply/v2/routes/adminLlm.ts` | `/api/v1/roboapply/v2/admin/llm` (admin only) |
| `lib/api/adminLlm.ts`, `components/v3/admin/LlmGatewayConsole.tsx` | Client and page |
| `server/src/lib/llm/gateway.test.ts`, `components/v3/admin/__tests__/llmGateway.test.tsx` | Tests |

## Not done

- Per-area ordered fallback models, token budgets and per-model prices
  (GoHire-Harness has them). The global `LLM_FALLBACK_MODEL` chain still applies.
- Capability detection from model lists (tools, image input). The page states
  what an area needs; it does not verify the chosen model.
- A per-user BYOK key still replaces the platform key by provider type, as
  before, including for an entry of that type.
