import type { LLMOptions, ProviderExtra } from '../../types/index.js';
import { getTimeoutMs } from '../../lib/llm/llmModels.js';

/**
 * Shared SDK-client tuning for OpenAI-/Anthropic-style providers.
 *
 * Why this exists: every OpenAI/Anthropic SDK client in this codebase used to
 * be constructed with NO `timeout` and NO `maxRetries`, so each inherited the
 * SDK defaults (≈600s timeout, **2 silent retries**). That is fine for a fast
 * model (Gemini Flash finishes in 10-20s) but breaks down with a reasoning
 * model like `deepseek-v4-pro` (thinking mode always on; 60-150s per call):
 *
 *   1. The 2 invisible SDK retries STACK on top of `withLLMRetry` (3 attempts,
 *      wrapped around every BaseAgent LLM call) → up to 2×3 = 6 attempts of a
 *      multi-minute call → 10+ min of wall-clock and multiplied quota burn.
 *      The SDK retries also bypass `withLLMRetry`'s AbortError short-circuit,
 *      so a hydrator timeout can't actually stop them.
 *   2. `ProviderExtra.timeoutMs` (DB/admin-tunable) was plumbed end-to-end via
 *      `LLMService.buildExtra()` but read by ONLY `GoogleProvider` — every
 *      other provider silently ignored the configured timeout.
 *
 * Centralising the resolution here makes `withLLMRetry` the single retry layer
 * and turns `extra.timeoutMs` / `LLM_TIMEOUT_MS` into a real per-provider knob
 * for all providers at once.
 */

/**
 * Default per-call SDK request timeout (ms) for the FAST / non-reasoning path.
 *
 * Lowered from the old 600s SDK default to 90s after the 2026-06-24 parse-resume
 * outage: a slow/unreachable Google-direct call was multiplied by the provider's
 * own internal retry (2) × `withLLMRetry` (3) × `ResumeParseAgent.parseOnce` (2),
 * giving a ~120-min worst-case ceiling — far past Node's headersTimeout /
 * requestTimeout and the proxy's cut, so the request kept burning budget long
 * after the client/proxy had already disconnected. 90s lets the handler fail
 * fast and return a clean 5xx while the connection is still alive.
 *
 * This is the default for ordinary, fast models (e.g. gemini-flash, the
 * résumé-parse + OCR path). REASONING / long-output models keep the higher
 * {@link REASONING_LLM_REQUEST_TIMEOUT_MS} backstop (a legitimate 60-150s
 * `deepseek-v4-pro` think must not be cut) — see {@link isLongRunningModel}.
 * Any explicit config (`extra.timeoutMs` admin DB, a provider env var, or the
 * global `LLM_TIMEOUT_MS` / `llm_stack tuning.timeoutMs`) still wins outright.
 */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Backstop timeout (ms) for reasoning / thinking / large-output models, kept at
 * the old SDK default so a legitimate multi-minute think isn't cut into a false
 * timeout. Applied only when NOTHING is explicitly configured AND the model
 * looks long-running (see {@link isLongRunningModel}) or thinking mode is on.
 */
export const REASONING_LLM_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Conservative detector for models that legitimately run for minutes — reasoning
 * models (thinking mode) and large-output models — so they keep the long
 * {@link REASONING_LLM_REQUEST_TIMEOUT_MS} ceiling while everything else gets the
 * tight {@link DEFAULT_LLM_REQUEST_TIMEOUT_MS}. Deliberately matches only the
 * families we KNOW are slow; an unrecognised model is treated as fast (90s),
 * which is the safe default for the handler-protective ceiling. `gemini-flash`
 * (the default + OCR model) is intentionally NOT matched.
 */
export function isLongRunningModel(modelId?: string): boolean {
  if (!modelId) return false;
  const m = modelId.toLowerCase();
  // All current DeepSeek models are thinking-capable (v4-pro always on,
  // v4-flash default on) and run 60-150s.
  if (m.includes('deepseek')) return true;
  // Kimi K2 family forces thinking mode on (see KimiProvider).
  if (m.includes('kimi-k2')) return true;
  // Explicit reasoning/thinking variants from any vendor.
  if (m.includes('thinking') || m.includes('reasoner') || m.includes('reasoning')) return true;
  // Gemini *pro* uses dynamic thinking and runs long; *flash* does not — so we
  // match 'pro' but never the flash default (whose only 'p' word is "preview").
  if (/gemini[a-z0-9.\-]*pro/.test(m)) return true;
  // OpenAI o-series reasoners (o1 / o3 / o4…). Guard the leading boundary so
  // 'gpt-4o' (the 'o' follows a digit) is NOT matched.
  if (/(^|[\/-])o[1-9]\d?(-|$|\b)/.test(m)) return true;
  // Claude Opus generates up to 24k tokens per call (see AnthropicProvider) and
  // can exceed 90s on long outputs; Sonnet/Haiku are fast and stay on 90s.
  if (m.includes('opus')) return true;
  return false;
}

/**
 * Resolve the SDK request timeout for an OpenAI-/Anthropic-style client.
 * Precedence: per-provider tuning (`extra.timeoutMs`, from a SystemLLMKey row or
 * the Google credential's env) → provider-specific env var → global admin
 * override (`llm_stack` blob's `tuning.timeoutMs`) ?? global `LLM_TIMEOUT_MS`
 * env → purpose-aware default.
 *
 * When NOTHING is explicitly configured, the purpose-aware default kicks in:
 * a long-running model (`opts.model` per {@link isLongRunningModel}, or
 * `extra.thinkingMode === 'enabled'`) keeps {@link REASONING_LLM_REQUEST_TIMEOUT_MS};
 * everything else gets the tight {@link DEFAULT_LLM_REQUEST_TIMEOUT_MS}. Any
 * explicit value (admin/env) always wins, so this never overrides operator intent.
 *
 * The global tier goes through `getTimeoutMs()` (lib/llm/llmModels.ts) so an
 * admin editing "Timeout (ms)" on /product/admin/llm-settings takes effect
 * without a redeploy; with an empty DB it === the old `LLM_TIMEOUT_MS` read.
 * Note: `extra.timeoutMs` already folds in `GOOGLE_LLM_TIMEOUT_MS`/`LLM_TIMEOUT_MS`
 * for the Google credential path (see systemCredentials.ts).
 *
 * `opts.model` is the model the CALL will actually use (not the provider's
 * construction default), so pass it from `provider.chat()` per request — the
 * construction-time client default is just a backstop the per-request value
 * overrides.
 */
export function resolveLlmRequestTimeoutMs(
  extra?: ProviderExtra,
  providerEnvVar?: string,
  opts?: { model?: string },
): number {
  const fromExtra = typeof extra?.timeoutMs === 'number' ? extra.timeoutMs : undefined;
  const providerEnvRaw = providerEnvVar ? (process.env[providerEnvVar] || '').trim() : '';
  const providerEnv = providerEnvRaw ? Number(providerEnvRaw) : undefined;
  // Global tier: DB admin override (llm_stack tuning.timeoutMs) ?? LLM_TIMEOUT_MS env.
  const globalConfigured = getTimeoutMs();

  const candidate = fromExtra ?? providerEnv ?? globalConfigured;
  if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
    return candidate;
  }

  // Nothing explicitly configured → purpose-aware default.
  const longRunning = isLongRunningModel(opts?.model) || extra?.thinkingMode === 'enabled';
  return longRunning ? REASONING_LLM_REQUEST_TIMEOUT_MS : DEFAULT_LLM_REQUEST_TIMEOUT_MS;
}

/**
 * Build the per-request options object for an OpenAI-/Anthropic-SDK `.create()`
 * call: the caller's AbortSignal (so an orphaned request stops burning budget
 * once the client/proxy disconnects) plus a MODEL-AWARE `timeout` that overrides
 * the construction-time client default. Computing the timeout per request from
 * `options.model` is what lets a fast provider client still grant a reasoning
 * model the long ceiling (and vice-versa) — the provider is constructed with the
 * stack DEFAULT model, not the call's model.
 */
export function buildSdkRequestOptions(
  options: LLMOptions | undefined,
  extra: ProviderExtra | undefined,
  providerEnvVar?: string,
): { signal?: AbortSignal; timeout: number } {
  return {
    ...(options?.signal ? { signal: options.signal } : {}),
    timeout: resolveLlmRequestTimeoutMs(extra, providerEnvVar, { model: options?.model }),
  };
}

/**
 * SDK-internal retry count for OpenAI-/Anthropic-style clients. `withLLMRetry`
 * (services/llm/withRetry.ts) is the SINGLE retry orchestrator wrapped around
 * BaseAgent LLM calls; leaving the SDK default (2) on top of it stacks retries
 * (up to 2×3 = 6 attempts of a multi-minute reasoning call) and bypasses
 * `withLLMRetry`'s AbortError short-circuit. Keep retry policy in ONE layer.
 * Override via `LLM_SDK_MAX_RETRIES` only if you have a specific reason.
 */
export const LLM_SDK_MAX_RETRIES = (() => {
  const raw = parseInt((process.env.LLM_SDK_MAX_RETRIES || '').trim(), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
})();
