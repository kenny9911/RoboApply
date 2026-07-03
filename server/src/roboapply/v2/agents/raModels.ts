// backend/src/roboapply/v2/agents/raModels.ts
//
// Single source of truth for the RoboApply V2 agent model IDs, grouped by
// capability tier. Each V2 agent imports the tier it needs instead of
// hardcoding a literal, so a model-version bump is a ONE-LINE change here —
// not a copy-paste sweep across 8 agent files. (That duplication is exactly
// how the Opus default drifted to a stale 4.7 while Sonnet/Haiku stayed
// current — fixed by centralising here.)
//
// Format note — these are OpenRouter model SLUGS (the backend runs in
// `LLM_PROVIDER=openrouter` mode). Two durable rules:
//   1. KEEP the `openrouter/` OUTER prefix. A bare `anthropic/…` slug is a
//      recognised DIRECT-provider prefix (DIRECT_PROVIDER_PREFIXES in
//      services/llm/LLMService.ts) and pins the call to Anthropic's NATIVE
//      API regardless of providerMode — which 404s on these dotted slugs
//      (native ids are dashed, e.g. claude-sonnet-4-6). The `openrouter/`
//      prefix is stripped by normalizeModel, leaving the real OpenRouter id.
//      Same failure class as the 2026-06-24 google/ default-model outage.
//   2. Copy each slug VERBATIM from openrouter.ai/anthropic — OpenRouter
//      versions Anthropic models with DOTS (`claude-opus-4.8`,
//      `claude-sonnet-4.6`, `claude-haiku-4.5`), NOT dashes. Don't hand-write.
// NB: these are OpenRouter slugs, NOT the bare Anthropic-API ids used on the
// direct path (Agent Alex's configSchema.ts, modelPricing.ts lookup keys,
// byok), which stay DASHED (e.g. `claude-opus-4-8`). Don't unify the two —
// modelPricing.ts normalises the dotted slugs back to its dashed keys.
//
// These are only the FALLBACK defaults — each agent's per-call env override
// (RA_V2_*_MODEL) still wins at runtime (see each agent's pick*Model()).

/** Highest-capability / highest-cost tier — deep resume rewrites, cover letters. */
export const RA_MODEL_OPUS = 'openrouter/anthropic/claude-opus-4.8';

/** Balanced narrative + scoring tier — career insights, match scoring, standard tailoring. */
export const RA_MODEL_SONNET = 'openrouter/anthropic/claude-sonnet-4.6';

/** Cheapest / fastest tier — JD parsing, keyword extraction, lightweight rewrites, mock interview. */
export const RA_MODEL_HAIKU = 'openrouter/anthropic/claude-haiku-4.5';
