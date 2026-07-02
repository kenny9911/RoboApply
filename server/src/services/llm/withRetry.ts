import { logger } from '../LoggerService.js';
import { getRetryAttempts, getRetryBaseMs, getRetryMaxMs } from '../../lib/llm/llmModels.js';

/**
 * Shared retry wrapper for LLM calls. Most provider errors are transient
 * (429 rate limits, 5xx incidents, socket resets under load). Before this,
 * a single hiccup translated to a failed resume upload for a paid user.
 *
 * Strategy: up to N attempts with exponential backoff + jitter, retrying
 * only on signals we know are transient. Auth / bad-request errors bail
 * out immediately so we don't burn budget re-hitting a broken prompt.
 *
 * Tunable (resolved PER CALL so an admin edit on /product/admin/llm-settings
 * applies without a redeploy):
 *   attempts  = DB override (llm_stack tuning.retryAttempts) ?? env LLM_RETRY_ATTEMPTS ?? 3
 *   baseMs    = DB override (tuning.retryBaseMs)             ?? env LLM_RETRY_BASE_MS   ?? 800
 *   maxMs     = DB override (tuning.retryMaxMs)              ?? env LLM_RETRY_MAX_MS    ?? 6000
 * The DB-override ?? env resolution lives in getRetry* (lib/llm/llmModels.ts);
 * with an empty DB these collapse to the exact legacy env values.
 */

export interface LLMRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
  requestId?: string;
  // Let callers veto retry for specific request shapes (e.g. small
  // vision calls where re-running costs more than failing fast).
  isRetryable?: (err: unknown) => boolean;
  // The request-lifecycle AbortSignal (e.g. from clientDisconnectSignal). When
  // it fires — client/proxy disconnected — we stop immediately rather than
  // burning the remaining retry budget. Providers that honour `options.signal`
  // already throw AbortError (which isTransientLLMError rejects), but this guard
  // is belt-and-suspenders: it also short-circuits BEFORE the next attempt's
  // backoff sleep, and covers a provider that surfaces the abort as a plain
  // "timeout"/"fetch failed" message (which would otherwise read as retryable).
  signal?: AbortSignal;
}

// Code-default backstops. The LIVE values are resolved per call via getRetry*
// (DB admin override ?? env ?? these), NOT baked as module constants — that is
// what lets an admin tuning edit take effect without a process restart.
const FALLBACK_ATTEMPTS = 3;
const FALLBACK_BASE_MS = 800;
const FALLBACK_MAX_MS = 6_000;

export function isTransientLLMError(error: unknown): boolean {
  if (!error) return false;

  // User-initiated aborts (AbortController) must never retry — the caller
  // already decided the operation is over budget. Without this guard the
  // 'aborted' / 'timed out' substring matches below would burn 3 retry
  // attempts after a hydrator timeout fires.
  if (typeof error === 'object') {
    const e = error as { name?: string; code?: string; nonRetryable?: boolean };
    // Structured veto set by providers for deterministic failures — e.g.
    // OpenRouterProvider marks empty-content responses with
    // finish_reason=length (whole max_tokens budget consumed by reasoning):
    // identical params reproduce the identical failure while billing real
    // tokens each attempt, so fail fast.
    if (e.nonRetryable === true) return false;
    if (e.name === 'AbortError') return false;
    if (e.code === 'ABORT_ERR') return false;
  }

  // Duck-type common SDK error shapes (OpenAI, Google, fetch-based libs)
  const maybe = error as { status?: number | string; statusCode?: number | string; code?: number | string; message?: string };
  const rawStatus = maybe.status ?? maybe.statusCode ?? maybe.code;
  const status = typeof rawStatus === 'string' ? Number(rawStatus) : rawStatus;
  if (typeof status === 'number' && Number.isFinite(status)) {
    // 408 Request Timeout, 425 Too Early, 429 Too Many Requests, 500/502/503/504
    if (status === 408 || status === 425 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
  }

  const message = (typeof maybe.message === 'string' ? maybe.message : String(error)).toLowerCase();

  // Deterministic truncation that lost its structured `nonRetryable` field
  // (e.g. the error was re-wrapped or crossed a serialization boundary).
  // Keeps the 'no content in' match below from retrying a max_tokens burn.
  if (message.includes('finish_reason=length') || message.includes('native_finish_reason=max_tokens')) {
    return false;
  }

  // Fold the underlying cause's message into the matched text. The OpenAI SDK
  // (and the OpenRouter/DeepSeek/Kimi/OpenAI-compatible providers built on it)
  // wraps a transport-level failure in `APIConnectionError`, whose own message
  // is the opaque literal "Connection error." while the REAL network signal
  // (e.g. "fetch failed", ECONNRESET, ETIMEDOUT) lives on `error.cause`. Match
  // against both so a wrapped connection drop is recognised even when only the
  // cause carries the diagnostic substring.
  const causeMessage = (() => {
    const c = (error as { cause?: unknown }).cause;
    if (c && typeof c === 'object' && typeof (c as { message?: unknown }).message === 'string') {
      return (c as { message: string }).message.toLowerCase();
    }
    return '';
  })();
  const haystack = causeMessage ? `${message} ${causeMessage}` : message;

  return (
    haystack.includes('timeout') ||
    haystack.includes('timed out') ||
    // OpenAI-SDK `APIConnectionError` message when the request never reached a
    // definitive HTTP response (TLS/DNS failure, socket reset before headers).
    // status/code/name are all undefined on this error, so neither the numeric
    // branch above nor any other substring would catch it. By definition no
    // tokens were billed and no answer was produced — safe and correct to
    // retry. Disabling the SDK's own retries (LLM_SDK_MAX_RETRIES=0) made
    // `withLLMRetry` the only layer that can absorb these, so it must match
    // them (observed: openrouter/z-ai/glm-5.2 eval-stream failing at ~3s with
    // zero retries, req_1782, 2026-06-26).
    haystack.includes('connection error') ||
    haystack.includes('fetch failed') ||
    haystack.includes('econnreset') ||
    haystack.includes('econnrefused') ||
    haystack.includes('econnaborted') ||
    haystack.includes('etimedout') ||
    haystack.includes('socket hang up') ||
    haystack.includes('epipe') ||
    // undici/openai-node surface a mid-stream connection drop as
    // "Invalid response body while trying to fetch <url>: Premature close".
    // The server closed the socket before the body finished — no tokens were
    // returned, so a retry is safe and usually succeeds (observed as 4 burst
    // failures at the start of a match:calibration-eval run, 2026-06-16).
    haystack.includes('premature close') ||
    haystack.includes('service unavailable') ||
    haystack.includes('high demand') ||
    haystack.includes('rate limit') ||
    haystack.includes('too many requests') ||
    haystack.includes('overloaded') ||
    haystack.includes('quota exceeded') ||
    // Empty completion — providers (esp. *-preview / reasoning models) sometimes
    // return no content after a long think. Usually transient (upstream hiccup,
    // content filter); a retry often succeeds. Matches "No content in <Provider>
    // response" from every provider. The deterministic exception —
    // finish_reason=length — is vetoed above before reaching this match.
    haystack.includes('no content in')
  );
}

export async function withLLMRetry<T>(fn: () => Promise<T>, opts: LLMRetryOptions = {}): Promise<T> {
  // Resolve fresh each call: explicit caller opt → DB admin override ?? env ?? backstop.
  const attempts = opts.attempts ?? getRetryAttempts() ?? FALLBACK_ATTEMPTS;
  const baseMs = opts.baseDelayMs ?? getRetryBaseMs() ?? FALLBACK_BASE_MS;
  const maxMs = opts.maxDelayMs ?? getRetryMaxMs() ?? FALLBACK_MAX_MS;
  const label = opts.label ?? 'LLM call';
  const requestId = opts.requestId;
  const isRetryable = opts.isRetryable ?? isTransientLLMError;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // The caller already went away — don't even start another attempt.
    if (opts.signal?.aborted) {
      throw lastErr ?? new DOMException('The operation was aborted', 'AbortError');
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // A fired signal vetoes retry regardless of how the error reads.
      const canRetry = attempt < attempts && isRetryable(err) && !opts.signal?.aborted;
      if (!canRetry) {
        if (attempt > 1) {
          logger.warn('LLM_RETRY', `${label}: giving up after ${attempt} attempts`, {
            attempt,
            error: err instanceof Error ? err.message : String(err),
          }, requestId);
        }
        throw err;
      }

      // Exponential backoff with equal jitter.
      const expDelay = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const jitter = Math.random() * expDelay * 0.5;
      const delayMs = Math.round(expDelay / 2 + jitter);

      logger.warn('LLM_RETRY', `${label}: attempt ${attempt} failed, retrying in ${delayMs}ms`, {
        attempt,
        nextDelayMs: delayMs,
        error: err instanceof Error ? err.message : String(err),
      }, requestId);

      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr;
}
