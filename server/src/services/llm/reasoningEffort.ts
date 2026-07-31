/**
 * Shared reasoning-effort resolution for the LLM providers.
 *
 * `LLM_REASONING_EFFORT` is a GLOBAL dial: set it once (repo-root .env) and
 * every model that exposes a reasoning-effort knob runs at that setting. Models
 * WITHOUT one ignore it — the value is dropped here, before the request body is
 * built, so a non-reasoning model is never sent a field it would 400 on.
 *
 * Precedence, per provider:
 *   DB system-key tuning (`ProviderExtra.reasoningEffort`, admin LLM settings)
 *   → the provider's own env var (e.g. `DEEPSEEK_REASONING_EFFORT`)
 *   → the global `LLM_REASONING_EFFORT`.
 * Unset everywhere ⇒ `undefined` ⇒ the field is omitted entirely and the
 * provider's own default applies — byte-for-byte the pre-existing behaviour.
 *
 * Each provider declares what its API actually ACCEPTS via `allow`, and a value
 * outside that set falls through to the next tier instead of being sent:
 *   • OpenAI chat-completions `reasoning_effort` and OpenRouter's unified
 *     `reasoning.effort` share the minimal|low|medium|high ladder.
 *   • DeepSeek takes high|max only, so a global `medium` is ignored there.
 *
 * Deliberately dependency-free (like providerTuning.ts's model predicates) so
 * it can be unit-tested without the server's nodenext `.js`-specifier world.
 */

/** Every effort value any provider in the stack understands. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';

const ALL_EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'max'];

/** OpenAI's ladder — also what OpenRouter's unified `reasoning.effort` takes. */
export const OPENAI_STYLE_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

/** DeepSeek's ladder (no low/medium; `max` is DeepSeek-only). */
export const DEEPSEEK_EFFORTS: readonly ReasoningEffort[] = ['high', 'max'];

/** The global env dial. Provider-specific vars are passed per call site. */
export const GLOBAL_REASONING_EFFORT_ENV = 'LLM_REASONING_EFFORT';

/** Normalise a raw string (env value / DB tuning JSON) to a known effort. */
export function parseReasoningEffort(raw: unknown): ReasoningEffort | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  return ALL_EFFORTS.includes(v) ? (v as ReasoningEffort) : undefined;
}

/**
 * Resolve the effort to send for one call: the first tier that yields a value
 * this provider's API supports. `envVars` are the provider-specific overrides
 * (checked in order); the global dial is always the last tier.
 */
export function resolveReasoningEffort(args: {
  /** DB system-key tuning — wins over env. */
  tuned?: string;
  /** Provider-specific env var names, highest precedence first. */
  envVars?: readonly string[];
  /** What this provider's API accepts; anything else falls through. */
  allow: readonly ReasoningEffort[];
}): ReasoningEffort | undefined {
  const tiers: unknown[] = [
    args.tuned,
    ...(args.envVars ?? []).map((name) => process.env[name]),
    process.env[GLOBAL_REASONING_EFFORT_ENV],
  ];
  for (const tier of tiers) {
    const parsed = parseReasoningEffort(tier);
    if (parsed && args.allow.includes(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Does this OpenAI model take `reasoning_effort` on chat completions?
 *
 * Only the reasoning families do — the GPT-5+ line and the o-series. Sending
 * the field to gpt-4o / gpt-4.1 is a hard 400, so the OpenAI-DIRECT path gates
 * on this. The OpenRouter path does NOT need the gate: OpenRouter normalises
 * the unified `reasoning` object and drops it for models without reasoning
 * support — the same contract the existing `reasoning.max_tokens` code relies
 * on — and gating there would mean maintaining a list of every reasoning model
 * on the router (Gemini, Claude, DeepSeek, GLM, Grok…).
 */
export function modelSupportsReasoningEffort(model: string | undefined): boolean {
  const id = (model || '').trim().toLowerCase().replace(/^openai\//, '');
  if (!id) return false;
  // gpt-5-chat-latest & friends are the NON-reasoning variants of the line.
  if (id.includes('-chat')) return false;
  const gpt = /^gpt-(\d+)/.exec(id);
  // GPT-5 was the first reasoning-effort generation; later ones inherit it.
  if (gpt && Number(gpt[1]) >= 5) return true;
  // o-series reasoners (o1 / o3-mini / o4…). The leading boundary keeps
  // 'gpt-4o' out — there the 'o' follows a digit, mid-id.
  return /^o[1-9]\d?(-|$)/.test(id);
}
