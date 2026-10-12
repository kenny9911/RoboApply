/**
 * Domestic (mainland-China) OpenAI-compatible vendors — WP-14, TASK_PLAN R-13,
 * CN_TW_LAUNCH_PLAN WP-LLM-CN.
 *
 *   qwen   (alias dashscope) Alibaba Model Studio  DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL
 *   glm    (alias zhipu)     Zhipu BigModel        GLM_API_KEY / GLM_API_BASE_URL
 *   doubao (alias ark)       Volcano Engine Ark    ARK_API_KEY / ARK_BASE_URL
 *
 * All three speak the OpenAI chat-completions protocol, so they run on
 * OpenAICompatibleProvider (chat) and the shared tool-streaming path. What
 * differs is the thinking switch, which each vendor spells differently. When
 * thinking is ON, reasoning tokens are generated before the answer and a
 * small answer budget can be spent entirely on them (the "empty content" 502
 * wall, memory note reasoning-token-budget-starvation), so the answer budget
 * gets reasoning headroom added on top — the same rule DeepSeekProvider
 * applies to DeepSeek V4 thinking.
 *
 * Model ids are never chosen here (operators set CN_LLM_*_MODEL).
 */

export type DomesticVendor = 'qwen' | 'glm' | 'doubao';
export type ThinkingMode = 'enabled' | 'disabled';

export interface DomesticVendorConfig {
  /** Default OpenAI-compatible base URL (mainland endpoint). */
  baseURL: string;
  /** Vendor-only env switch for the thinking mode (unprefixed, R-03). */
  thinkingEnv: string;
}

export const DOMESTIC_VENDORS: Record<DomesticVendor, DomesticVendorConfig> = {
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', thinkingEnv: 'DASHSCOPE_THINKING_MODE' },
  glm: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', thinkingEnv: 'GLM_THINKING_MODE' },
  doubao: { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', thinkingEnv: 'ARK_THINKING_MODE' },
};

export function isDomesticVendor(provider: string): provider is DomesticVendor {
  return provider === 'qwen' || provider === 'glm' || provider === 'doubao';
}

/** Default reasoning reserve, matching DeepSeekProvider's (sized from the widest structured-output agent). */
export const DEFAULT_THINKING_HEADROOM_TOKENS = 8_000;

/** 'true'|'enabled'|… → 'enabled', 'false'|'disabled'|… → 'disabled', else undefined. */
export function parseThinkingMode(value: string | undefined | null): ThinkingMode | undefined {
  if (value === undefined || value === null) return undefined;
  const n = value.trim().toLowerCase();
  if (['1', 'true', 'enabled', 'on', 'yes'].includes(n)) return 'enabled';
  if (['0', 'false', 'disabled', 'off', 'no'].includes(n)) return 'disabled';
  return undefined;
}

/** Per-call override ?? vendor env switch ?? undefined (vendor default applies). */
export function resolveThinkingMode(
  vendor: DomesticVendor,
  callOverride?: ThinkingMode,
  env: Record<string, string | undefined> = process.env,
): ThinkingMode | undefined {
  return callOverride ?? parseThinkingMode(env[DOMESTIC_VENDORS[vendor].thinkingEnv]);
}

/** The request fields that switch thinking on or off, per vendor. */
export function thinkingParams(vendor: DomesticVendor, mode: ThinkingMode | undefined): Record<string, unknown> {
  if (!mode) return {};
  if (vendor === 'qwen') return { enable_thinking: mode === 'enabled' };
  // GLM (4.5 and later) and Doubao (seed) share the `thinking.type` shape.
  return { thinking: { type: mode } };
}

/**
 * Reasoning headroom for one call: the agent's explicit `reasoningMaxTokens`
 * wins, else LLM_THINKING_HEADROOM_TOKENS, else the default.
 */
export function thinkingHeadroomTokens(
  explicit?: number,
  env: Record<string, string | undefined> = process.env,
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit;
  const raw = parseInt((env.LLM_THINKING_HEADROOM_TOKENS || '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THINKING_HEADROOM_TOKENS;
}

/**
 * `max_tokens` for one call: the answer budget, plus reasoning headroom when
 * thinking is explicitly ON. With thinking unknown (vendor default) nothing is
 * added: an over-large max_tokens beyond the model's output cap is a hard 400
 * on these APIs, so the reserve is only taken when we know it is needed.
 */
export function maxTokensWithThinking(
  maxTokens: number | undefined,
  mode: ThinkingMode | undefined,
  reasoningMaxTokens?: number,
): number | undefined {
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) return undefined;
  return mode === 'enabled' ? maxTokens + thinkingHeadroomTokens(reasoningMaxTokens) : maxTokens;
}
