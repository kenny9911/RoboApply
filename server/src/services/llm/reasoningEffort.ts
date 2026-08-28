/**
 * Shared reasoning-effort resolution for the LLM providers.
 *
 * `LLM_REASONING_EFFORT` is the shared fallback dial for providers that opt in.
 * Task-specific calls can supply a higher-precedence explicit value. Providers
 * filter both forms against the ladder their API accepts so unsupported values
 * are omitted rather than causing an upstream 400.
 *
 * Precedence, per provider:
 *   per-call task override (`LLM_*_REASONING_EFFORT`)
 *   → DB system-key tuning (`ProviderExtra.reasoningEffort`, admin LLM settings)
 *   → the provider's own env var (e.g. `DEEPSEEK_REASONING_EFFORT`)
 *   → the global `LLM_REASONING_EFFORT`.
 * Unset everywhere ⇒ `undefined` ⇒ the field is omitted entirely and the
 * provider's own default applies — byte-for-byte the pre-existing behaviour.
 *
 * Each provider declares what its API actually ACCEPTS via `allow`, and a value
 * outside that set falls through to the next tier instead of being sent:
 *   • OpenAI chat-completions uses minimal|low|medium|high.
 *   • OpenRouter's unified `reasoning.effort` also accepts max.
 *   • DeepSeek takes high|max only, so a global `medium` is ignored there.
 *   • Anthropic Messages uses `output_config.effort` with low through max.
 *
 * Deliberately dependency-free (like providerTuning.ts's model predicates) so
 * it can be unit-tested without the server's nodenext `.js`-specifier world.
 */

/** Every effort value any provider in the stack understands. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';

const ALL_EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'max'];

/** OpenAI's ladder — also what OpenRouter's unified `reasoning.effort` takes. */
export const OPENAI_STYLE_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

/** OpenRouter's unified ladder. Its router maps `max` to the upstream model's
 * strongest supported effort, while OpenAI-direct does not accept that value. */
export const OPENROUTER_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'max',
];

/** DeepSeek's ladder (no minimal/low/medium). */
export const DEEPSEEK_EFFORTS: readonly ReasoningEffort[] = ['high', 'max'];

/** Anthropic Messages `output_config.effort` ladder. */
export const ANTHROPIC_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max'];

export type GoogleThinkingLevel = Exclude<ReasoningEffort, 'max'>;
export type GoogleThinkingConfig =
  | { thinkingLevel: GoogleThinkingLevel }
  | { thinkingBudget: number };

/** Convert the shared effort ladder to the model-specific Gemini
 * GenerateContent contract: Gemini 3+ takes thinkingLevel, while 2.5 takes a
 * numeric thinkingBudget. `minimal` on Gemini 3 Pro maps to its closest
 * supported level (`low`). */
export function googleThinkingConfigFor(
  model: string | undefined,
  effort: ReasoningEffort | undefined,
): GoogleThinkingConfig | undefined {
  if (!model || !effort || effort === 'max') return undefined;
  const id = model.toLowerCase().split('/').pop() ?? '';
  if (/^gemini-2\.5(?:[.-]|$)/.test(id)) {
    const thinkingBudget =
      effort === 'high' ? 24_576 : effort === 'medium' ? 8_192 : 1_024;
    return { thinkingBudget };
  }
  if (!/^gemini-3(?:[.-]|$)/.test(id)) return undefined;
  const thinkingLevel =
    effort === 'minimal' && /(?:^|-)pro(?:-|$)/.test(id) ? 'low' : effort;
  return { thinkingLevel };
}

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
  /** Per-call task override — wins over shared provider tuning. */
  explicit?: string;
  /** DB system-key tuning — wins over env. */
  tuned?: string;
  /** Provider-specific env var names, highest precedence first. */
  envVars?: readonly string[];
  /** What this provider's API accepts; anything else falls through. */
  allow: readonly ReasoningEffort[];
}): ReasoningEffort | undefined {
  const tiers: unknown[] = [
    args.explicit,
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
