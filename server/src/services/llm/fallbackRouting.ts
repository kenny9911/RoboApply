/**
 * Provider-failure resilience for LLMService: failure classification, the
 * auto-selected fallback route, an in-process circuit breaker, and the error
 * thrown when no route is left.
 *
 * Why it exists: one dead or out-of-credit key used to take down every LLM
 * feature. The fallback check matched only transient text (503, 429, timeout),
 * and LLM_FALLBACK_MODEL was unset. A 401 "User not found." from OpenRouter
 * therefore surfaced directly as a failed interview, resume parse or match.
 *
 * Kept free of provider SDK imports so tests and tooling can use it cheaply.
 */

import { createHash } from 'node:crypto';

/** A credential-class failure: retrying the same key cannot succeed. */
export type CredentialFailureKind = 'auth' | 'billing' | 'missing_key';

/** How long a provider stays "unhealthy" after an auth/billing failure. */
export const CIRCUIT_OPEN_MS = 10 * 60 * 1000;

/**
 * The ordered auto-fallback preference list. When neither LLM_FALLBACK_MODEL
 * nor the admin DB override is set, a credential failure on the primary falls
 * through to the first entry whose provider (a) is not the failed provider,
 * (b) has a key (system DB key or env), and (c) is not circuit-open.
 *
 * Every entry is a DIRECT provider (never openrouter, so OpenRouter can't
 * "fall back" to itself) and has a row in server/src/lib/modelCostTable.ts,
 * so fallback spend is priced correctly. Probed against the live direct APIs
 * on 2026-10-09: gemini-3.8-flash and deepseek-v4-flash answered JSON-mode
 * prompts in under 4s. The Anthropic key was out of credit at the time, so its
 * entry was unverified; the circuit breaker skips it after a billing failure.
 */
export const AUTO_FALLBACK_PREFERENCE: readonly string[] = [
  'google/gemini-3.8-flash',
  'anthropic/claude-sonnet-4-6',
  'deepseek/deepseek-v4-flash',
  'openai/gpt-6-luna',
];

/** LLM_FALLBACK_AUTO=false|0|off|no disables auto-selection (configured fallback still works). */
export function isAutoFallbackEnabled(): boolean {
  const raw = (process.env.LLM_FALLBACK_AUTO || '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw);
}

/* ── Failure classification ─────────────────────────────────────────────── */

/** Best-effort HTTP status from the many SDK error shapes. */
export function errorHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };
  for (const raw of [e.status, e.statusCode, e.response?.status, e.code]) {
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  const message = typeof e.message === 'string' ? e.message : '';
  // OpenAI-SDK family: "401 User not found." / Google SDK: "... [403 Forbidden] ..."
  const m = message.match(/^\s*(\d{3})\b/) || message.match(/\[(\d{3})(?:\s[^\]]*)?\]/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 100 && n <= 599) return n;
  }
  return undefined;
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const msg = (error as { message?: unknown }).message;
    const cause = (error as { cause?: { message?: unknown } }).cause;
    const causeMsg = cause && typeof cause === 'object' && typeof cause.message === 'string' ? cause.message : '';
    return `${typeof msg === 'string' ? msg : String(error)} ${causeMsg}`.toLowerCase();
  }
  return String(error ?? '').toLowerCase();
}

// Billing text is decisive whatever the status: Anthropic reports an empty
// balance as HTTP 400, and OpenAI reports an exhausted quota as HTTP 429.
const BILLING_PATTERNS = [
  'payment required',
  'insufficient credits',
  'insufficient credit',
  'insufficient balance',
  'insufficient_quota',
  'exceeded your current quota',
  'credit balance is too low',
  'requires more credits',
  'out of credits',
  // OpenRouter answers 403 when a key's own credit limit is spent.
  'key limit exceeded',
];

// Auth text is trusted only when no status was exposed, or the status is
// itself an auth status. Otherwise a 404 "model not found or Permission denied"
// would open the circuit on a healthy key.
const AUTH_PATTERNS = [
  'user not found',
  'invalid api key',
  'invalid_api_key',
  'incorrect api key',
  'api key not valid',
  'invalid x-api-key',
  'unauthorized',
  'unauthenticated',
  'authentication_error',
  'authentication failed',
  'no auth credentials',
];

// A 403 is usually a dead/blocked key, but some providers also use it for a
// PER-REQUEST refusal: OpenRouter's moderation ("... was flagged"), region or
// country blocks, or one model the key cannot use. Those say nothing about
// the key, so they must not open a provider-wide circuit (which would move
// every platform call to another model for 10 minutes and replay the flagged
// input there). Matched only for 403; 401/402 stay decisive.
const PER_REQUEST_403_PATTERNS = [
  'flagged',
  'moderation',
  'content policy',
  'safety',
  'region',
  'country',
  'territory',
  'location is not supported',
  'access to model',
  'access to the model',
];

/** Marker set on the "no API key resolved" error LLMService.createProvider throws. */
export const MISSING_CREDENTIAL_FLAG = 'llmMissingCredential';

/**
 * Returns the credential-failure kind, or null when the error is something
 * else (transient, bad request, abort...). Never matches a user abort.
 */
export function classifyCredentialFailure(error: unknown): CredentialFailureKind | null {
  if (!error) return null;
  if (typeof error === 'object') {
    const e = error as { name?: string; code?: string; [MISSING_CREDENTIAL_FLAG]?: boolean };
    if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return null;
    if (e[MISSING_CREDENTIAL_FLAG] === true) return 'missing_key';
    if (error instanceof LLMUnavailableError) return error.reason;
  }
  const status = errorHttpStatus(error);
  const text = errorText(error);
  if (status === 402) return 'billing';
  if (BILLING_PATTERNS.some((p) => text.includes(p))) return 'billing';
  if (status === 401) return 'auth';
  if (status === 403) {
    return PER_REQUEST_403_PATTERNS.some((p) => text.includes(p)) ? null : 'auth';
  }
  if (status === undefined && AUTH_PATTERNS.some((p) => text.includes(p))) return 'auth';
  return null;
}

/** True for auth/billing failures (and a missing key): fallback-worthy, never retry-worthy. */
export function isCredentialFailure(error: unknown): boolean {
  return classifyCredentialFailure(error) !== null;
}

/* ── Error thrown when no route is left ─────────────────────────────────── */

/**
 * Thrown when the primary provider rejected its credentials (or has none) and
 * no fallback route could answer. `code` is 'llm_unavailable' so callers such
 * as the interview control plane can map it to a 503 without string matching.
 * It deliberately carries NO `status` field: a raw upstream 401 must never
 * reach a generic Express handler as an HTTP 401, because the browser client
 * reads that as "your session expired".
 */
export class LLMUnavailableError extends Error {
  readonly code = 'llm_unavailable';
  readonly nonRetryable = true;
  readonly reason: CredentialFailureKind;
  readonly provider: string;
  readonly model: string;
  readonly upstreamStatus?: number;
  readonly attemptedFallbacks: string[];

  constructor(input: {
    message: string;
    reason: CredentialFailureKind;
    provider: string;
    model: string;
    upstreamStatus?: number;
    attemptedFallbacks?: string[];
    cause?: unknown;
  }) {
    super(input.message, input.cause !== undefined ? { cause: input.cause } : undefined);
    this.name = 'LLMUnavailableError';
    this.reason = input.reason;
    this.provider = input.provider;
    this.model = input.model;
    this.upstreamStatus = input.upstreamStatus;
    this.attemptedFallbacks = input.attemptedFallbacks ?? [];
  }
}

/** Duck-typed check that survives module duplication / re-wrapping. */
export function isLLMUnavailableError(error: unknown): error is LLMUnavailableError {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'llm_unavailable';
}

/* ── Circuit breaker ────────────────────────────────────────────────────── */

interface CircuitState {
  openedAt: number;
  until: number;
  keyFingerprint: string;
  kind: CredentialFailureKind;
  reason: string;
  /** "Routing around this provider" has been logged for this open circuit. */
  bypassLogged: boolean;
}

const circuits = new Map<string, CircuitState>();

// The auto-selected chain last announced, so the choice is logged on first use
// and again only when it changes (a key added/rotated, a circuit opened).
let lastAnnouncedAutoFallback: string | null = null;

/** True when `summary` differs from the last announced auto-fallback chain. */
export function noteAutoFallbackChoice(summary: string): boolean {
  if (summary === lastAnnouncedAutoFallback) return false;
  lastAnnouncedAutoFallback = summary;
  return true;
}

/**
 * Non-reversible, in-memory-only fingerprint of the credential a circuit was
 * opened against. Rotating the key closes the circuit immediately instead of
 * waiting out the 10 minutes.
 */
export function credentialFingerprint(apiKey: string | undefined | null): string {
  return createHash('sha256').update(apiKey || '').digest('hex').slice(0, 16);
}

function normProvider(provider: string): string {
  const p = provider.toLowerCase();
  return p === 'moonshot' ? 'kimi' : p;
}

export function openCircuit(
  provider: string,
  keyFingerprint: string,
  kind: CredentialFailureKind,
  reason: string,
  now: number = Date.now(),
): { opened: boolean; until: number } {
  const key = normProvider(provider);
  const existing = circuits.get(key);
  const until = now + CIRCUIT_OPEN_MS;
  const stillOpen = existing && existing.until > now && existing.keyFingerprint === keyFingerprint;
  circuits.set(key, {
    openedAt: stillOpen ? existing.openedAt : now,
    until,
    keyFingerprint,
    kind,
    reason: reason.slice(0, 300),
    bypassLogged: stillOpen ? existing.bypassLogged : false,
  });
  return { opened: !stillOpen, until };
}

/** The open circuit for this provider+credential, or null (expired/rotated circuits are cleared). */
export function getOpenCircuit(
  provider: string,
  keyFingerprint: string,
  now: number = Date.now(),
): Readonly<CircuitState> | null {
  const key = normProvider(provider);
  const state = circuits.get(key);
  if (!state) return null;
  if (state.until <= now || state.keyFingerprint !== keyFingerprint) {
    circuits.delete(key);
    return null;
  }
  return state;
}

/** Marks the bypass as logged; returns true only the first time per open circuit. */
export function markCircuitBypassLogged(provider: string): boolean {
  const state = circuits.get(normProvider(provider));
  if (!state || state.bypassLogged) return false;
  state.bypassLogged = true;
  return true;
}

export function closeCircuit(provider: string): void {
  circuits.delete(normProvider(provider));
}

/** Test seam + admin diagnostics. */
export function resetCircuits(): void {
  circuits.clear();
  lastAnnouncedAutoFallback = null;
}

export function listOpenCircuits(now: number = Date.now()): Array<{ provider: string; until: number; kind: CredentialFailureKind; reason: string }> {
  const out: Array<{ provider: string; until: number; kind: CredentialFailureKind; reason: string }> = [];
  for (const [provider, s] of circuits) {
    if (s.until > now) out.push({ provider, until: s.until, kind: s.kind, reason: s.reason });
  }
  return out;
}

/* ── Fallback option shaping ────────────────────────────────────────────── */

const FALLBACK_REASONING_HEADROOM_TOKENS = 8_000;
const FALLBACK_MAX_OUTPUT_CAP = 64_000;

/**
 * Keep a caller's answer budget intact when a call is rerouted to a provider
 * whose output cap also counts thinking tokens (Gemini maxOutputTokens,
 * Anthropic max_tokens). The OpenRouter/DeepSeek/OpenAI providers already add
 * this headroom themselves. Without it, a 700-token CJK answer budget sent to
 * gemini-3.8-flash is spent on thinking and comes back empty.
 */
export function fallbackMaxTokens(
  providerType: string,
  maxTokens: number | undefined,
  reasoningMaxTokens: number | undefined,
): number | undefined {
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) return maxTokens;
  const p = providerType.toLowerCase();
  if (p !== 'google' && p !== 'anthropic') return maxTokens;
  const headroom =
    typeof reasoningMaxTokens === 'number' && Number.isFinite(reasoningMaxTokens) && reasoningMaxTokens > 0
      ? reasoningMaxTokens
      : FALLBACK_REASONING_HEADROOM_TOKENS;
  return Math.min(FALLBACK_MAX_OUTPUT_CAP, maxTokens + headroom);
}
