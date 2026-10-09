// server/src/interview-engine/prompt/llmFailure.ts
//
// Classify a session-preparation failure. Preparation fails with
// 'llm_unavailable' when the model stack itself is the problem (bad or dead
// key, quota, rate limit, provider outage, timeout, empty or unparseable
// output) and 'prepare_failed' for anything else (DB error, programming bug).
// The frontend shows a different message per code; neither is ever charged.
//
// Pure and dependency-free so it is unit-testable without Prisma or LiveKit.

export type PrepareFailureCode = 'llm_unavailable' | 'prepare_failed';

/** Thrown by the strict prompt pipeline when the blueprint LLM is unusable.
 *  Carries the original provider error as `cause`. */
export class InterviewLlmUnavailableError extends Error {
  readonly code = 'llm_unavailable' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InterviewLlmUnavailableError';
  }
}

// Lower-cased substrings that mark an error as coming from the model stack.
// '401 user not found' is OpenRouter's answer for a revoked/deleted key.
const LLM_MESSAGE_MARKERS = [
  'user not found',
  'unauthorized',
  'unauthorised',
  'invalid api key',
  'invalid_api_key',
  'incorrect api key',
  'authentication',
  'api key',
  'permission denied',
  'forbidden',
  'insufficient credits',
  'insufficient_quota',
  'insufficient balance',
  'quota',
  'payment required',
  'credit balance',
  'rate limit',
  'too many requests',
  'overloaded',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'high demand',
  'timeout',
  'timed out',
  'aborted',
  'fetch failed',
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'socket hang up',
  'no content',
  'empty response',
  'empty content',
  'empty blueprint',
  'unparseable response',
  'no llm model is configured',
  'no default llm model',
  'provider returned error',
];

const LLM_ERROR_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'InterviewLlmUnavailableError',
  // LLMService (server/src/services/llm/fallbackRouting.ts) throws this once
  // every route is dead. It deliberately carries no HTTP `status`.
  'LLMUnavailableError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'AuthenticationError',
  'PermissionDeniedError',
  'RateLimitError',
  'InternalServerError',
]);

/** Walk err → err.cause → … (bounded) collecting every error-ish link. */
function errorChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur != null; i += 1) {
    out.push(cur);
    cur = typeof cur === 'object' ? (cur as { cause?: unknown }).cause : undefined;
  }
  return out;
}

function statusOf(e: unknown): number | null {
  if (!e || typeof e !== 'object') return null;
  const r = e as { status?: unknown; statusCode?: unknown; code?: unknown };
  for (const v of [r.status, r.statusCode, r.code]) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return null;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return typeof e === 'string' ? e : '';
}

/** True when any link in the error chain points at the model stack. */
export function isLlmUnavailableError(err: unknown): boolean {
  for (const e of errorChain(err)) {
    if (e instanceof InterviewLlmUnavailableError) return true;
    if (e && typeof e === 'object') {
      const name = (e as { name?: unknown }).name;
      if (typeof name === 'string' && LLM_ERROR_NAMES.has(name)) return true;
      const code = (e as { code?: unknown }).code;
      // Duck-typed on the shared code so a re-wrapped LLMUnavailableError from
      // LLMService (auth/billing/missing key, no `status`) is still recognised.
      if (code === 'llm_unavailable') return true;
      if (code === 'ABORT_ERR' || code === 'ETIMEDOUT' || code === 'ECONNRESET') return true;
    }
    const status = statusOf(e);
    if (status !== null && (status === 401 || status === 402 || status === 403 || status === 408 || status === 429 || status >= 500)) {
      return true;
    }
    const msg = messageOf(e).toLowerCase();
    if (!msg) continue;
    // Bare HTTP status at the front of a provider message: "401 User not found."
    if (/(^|\b)(401|402|403|408|429|5\d\d)\b/.test(msg) && /\b(status|error|code|http)\b|^\d{3}\b/.test(msg)) {
      return true;
    }
    if (LLM_MESSAGE_MARKERS.some((m) => msg.includes(m))) return true;
  }
  return false;
}

export function classifyPrepareError(err: unknown): PrepareFailureCode {
  return isLlmUnavailableError(err) ? 'llm_unavailable' : 'prepare_failed';
}

/** Short, secret-free description of the failure for logs. */
export function describePrepareError(err: unknown): string {
  return errorChain(err)
    .map((e) => messageOf(e))
    .filter(Boolean)
    .join(' <- ')
    .slice(0, 500);
}
