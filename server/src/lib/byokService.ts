/**
 * BYOK (Bring-Your-Own-Key) service.
 *
 * Single source of truth for: per-user LLM key storage + resolution +
 * provider validation. See docs/prd-byok.md.
 *
 * Plaintext keys never leave this module:
 *   - INPUT  via upsert / validate (one-shot, never persisted plaintext)
 *   - STORED via lib/crypto.ts AES-256-GCM
 *   - OUTPUT only as `{ apiKey, baseUrl }` from resolve(), handed directly
 *     to a provider client; never logged, never returned to the frontend.
 */

import { prisma } from './prisma.js';
import { encryptField, decryptField } from './crypto.js';
import { logger } from '../services/LoggerService.js';

// ---------------------------------------------------------------------------
// Provider catalog
// ---------------------------------------------------------------------------

export const BYOK_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'moonshot',
  'minimax',
  'openrouter',
  'ollama',
  'newapi',
] as const;

export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

export function isByokProvider(value: unknown): value is ByokProvider {
  return typeof value === 'string' && (BYOK_PROVIDERS as readonly string[]).includes(value);
}

/** Some providers require a baseUrl; for others it's an optional override. */
export function baseUrlRequirement(provider: ByokProvider): 'required' | 'optional' | 'forbidden' {
  switch (provider) {
    case 'ollama':
    case 'newapi':
    case 'minimax':
      return 'required';
    case 'openrouter':
    case 'openai':
    case 'anthropic':
    case 'google':
    case 'deepseek':
    case 'moonshot':
      return 'optional';
  }
}

// ---------------------------------------------------------------------------
// Key preview — what the frontend sees instead of the plaintext.
// ---------------------------------------------------------------------------

/**
 * Returns a never-confidential preview like `sk-…ab12`. Suitable to render
 * in the UI so the user can confirm which key is configured without
 * re-revealing the secret.
 */
export function previewFor(plaintext: string): string {
  if (!plaintext) return '';
  const trimmed = plaintext.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// SSRF guard for baseUrl
// ---------------------------------------------------------------------------

// Providers that are LEGITIMATELY self-hosted and therefore allowed to point at
// private/loopback hosts (an on-prem Ollama, a private new-api gateway). Every
// other provider must target a public host, or it is treated as an SSRF attempt.
const SELF_HOSTED_PROVIDERS = new Set<ByokProvider>(['ollama', 'newapi']);

/**
 * Conservative SSRF block-list. Returns true when `host` points at the local
 * machine, a private/RFC1918 network, link-local (incl. the 169.254.169.254
 * cloud-metadata endpoint), CGNAT, or an IPv6 loopback/ULA/link-local address —
 * i.e. anything an admin's browser/key should never be pointed at for a public
 * LLM provider. Hostname-literal based (covers typed IPs + obvious internal
 * names); DNS-rebinding is a residual risk accepted for this admin-only surface.
 */
function isPrivateLikeHostname(host: string): boolean {
  let lower = host.toLowerCase().trim();
  // Strip IPv6 brackets: "[::1]" -> "::1".
  if (lower.startsWith('[') && lower.endsWith(']')) lower = lower.slice(1, -1);

  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::' || lower === '::1') return true;
  if (lower.endsWith('.local') || lower.endsWith('.internal') || lower.endsWith('.localhost')) return true;

  // IPv4 literals.
  if (/^127\./.test(lower)) return true;                          // loopback /8
  if (/^10\./.test(lower)) return true;                           // RFC1918
  if (/^192\.168\./.test(lower)) return true;                     // RFC1918
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(lower)) return true;  // RFC1918
  if (/^169\.254\./.test(lower)) return true;                     // link-local + 169.254.169.254 metadata
  if (/^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./.test(lower)) return true; // CGNAT 100.64/10

  // IPv6: loopback (::1), ULA (fc00::/7 → fc/fd prefix), link-local (fe80::/10).
  if (/^fc[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 etc.) — re-check the embedded v4 tail.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateLikeHostname(mapped[1]);

  return false;
}

export function validateBaseUrl(provider: ByokProvider, raw: string | null | undefined): {
  ok: boolean;
  error?: string;
  normalized?: string;
} {
  const requirement = baseUrlRequirement(provider);
  const trimmed = (raw ?? '').trim();

  if (!trimmed) {
    if (requirement === 'required') {
      return { ok: false, error: `${provider} requires a base URL` };
    }
    return { ok: true, normalized: undefined };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Base URL is not a valid URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'Base URL must use http:// or https://' };
  }

  const isSelfHosted = SELF_HOSTED_PROVIDERS.has(provider);
  const isPrivate = isPrivateLikeHostname(url.hostname);

  if (url.protocol === 'http:') {
    // Plaintext http:// is only ever allowed for self-hosted gateways, and only
    // against a private/loopback host (an on-prem box, never a public one).
    if (!isSelfHosted) {
      return { ok: false, error: 'http:// is only permitted for self-hosted gateways (ollama, newapi)' };
    }
    if (!isPrivate) {
      return {
        ok: false,
        error: 'http:// is only permitted against localhost / .local / .internal / RFC1918 hosts',
      };
    }
  } else {
    // https:// — SSRF guard: a public provider must never point at a private,
    // loopback, link-local (169.254.169.254 metadata), or RFC1918 host. Only the
    // self-hosted gateways may target an internal host over https.
    if (isPrivate && !isSelfHosted) {
      return {
        ok: false,
        error: 'Base URL host is private/internal (loopback, link-local, or RFC1918) and not allowed for this provider',
      };
    }
  }

  // Strip trailing slash for consistency.
  const normalized = trimmed.replace(/\/+$/, '');
  return { ok: true, normalized };
}

// ---------------------------------------------------------------------------
// resolve() — used by LLMService at request time.
// ---------------------------------------------------------------------------

export interface ResolvedByok {
  rowId: string;
  apiKey: string;
  baseUrl: string | null;
}

/**
 * Returns the user's BYOK config for `provider` if one exists and is
 * active, with the API key decrypted in-memory. Returns null when no
 * row matches — callers should fall back to platform credentials.
 *
 * Caller is responsible for making the LLM call with the returned key
 * and stamping `byok=true` on the resulting log row.
 */
export async function resolveByok(
  userId: string | null | undefined,
  provider: ByokProvider,
): Promise<ResolvedByok | null> {
  if (!userId) return null;
  try {
    const row = await prisma.userLLMKey.findUnique({
      where: { userId_provider: { userId, provider } },
      select: { id: true, encryptedKey: true, baseUrl: true, isActive: true },
    });
    if (!row || !row.isActive) return null;
    const apiKey = decryptField(row.encryptedKey);
    return { rowId: row.id, apiKey, baseUrl: row.baseUrl };
  } catch (err) {
    // Encryption errors should NOT silently fall back to the platform
    // key — that would route the user's call through platform billing
    // unexpectedly. Throw and let the caller surface the error.
    logger.error('BYOK', 'resolve failed', {
      userId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`BYOK key for "${provider}" could not be decrypted; check FIELD_ENCRYPTION_KEY or remove the key in Settings.`);
  }
}

/** Bump `lastUsedAt` after a successful call. Best-effort; never throws. */
export async function touchByok(rowId: string): Promise<void> {
  try {
    await prisma.userLLMKey.update({
      where: { id: rowId },
      data: { lastUsedAt: new Date() },
    });
  } catch {
    // Non-fatal; UI will just show a slightly stale timestamp.
  }
}

// ---------------------------------------------------------------------------
// list() — non-secret summaries for the frontend.
// ---------------------------------------------------------------------------

export interface ByokSummary {
  id: string;
  provider: ByokProvider;
  label: string | null;
  baseUrl: string | null;
  isActive: boolean;
  keyPreview: string;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listByokForUser(userId: string): Promise<ByokSummary[]> {
  const rows = await prisma.userLLMKey.findMany({
    where: { userId },
    orderBy: { provider: 'asc' },
  });
  return rows.map((row) => {
    let preview = '';
    try {
      preview = previewFor(decryptField(row.encryptedKey));
    } catch {
      preview = '••••';
    }
    return {
      id: row.id,
      provider: row.provider as ByokProvider,
      label: row.label,
      baseUrl: row.baseUrl,
      isActive: row.isActive,
      keyPreview: preview,
      lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
      lastTestStatus: row.lastTestStatus,
      lastTestError: row.lastTestError,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// upsert() — encrypt + persist.
// ---------------------------------------------------------------------------

export interface UpsertByokInput {
  userId: string;
  provider: ByokProvider;
  plaintextKey: string;
  baseUrl?: string | null;
  label?: string | null;
  isActive?: boolean;
  // If a probe was just run, persist the result alongside the key.
  testResult?: { ok: boolean; error?: string };
}

export async function upsertByok(input: UpsertByokInput): Promise<void> {
  const baseValidation = validateBaseUrl(input.provider, input.baseUrl);
  if (!baseValidation.ok) {
    throw new Error(baseValidation.error);
  }

  const trimmedKey = input.plaintextKey.trim();
  if (!trimmedKey) {
    throw new Error('API key cannot be empty');
  }

  const encryptedKey = encryptField(trimmedKey);

  await prisma.userLLMKey.upsert({
    where: { userId_provider: { userId: input.userId, provider: input.provider } },
    create: {
      userId: input.userId,
      provider: input.provider,
      label: input.label ?? null,
      encryptedKey,
      baseUrl: baseValidation.normalized ?? null,
      isActive: input.isActive ?? true,
      lastTestedAt: input.testResult ? new Date() : null,
      lastTestStatus: input.testResult ? (input.testResult.ok ? 'ok' : 'failed') : null,
      lastTestError: input.testResult?.error ?? null,
    },
    update: {
      label: input.label ?? null,
      encryptedKey,
      baseUrl: baseValidation.normalized ?? null,
      ...(typeof input.isActive === 'boolean' ? { isActive: input.isActive } : {}),
      ...(input.testResult
        ? {
            lastTestedAt: new Date(),
            lastTestStatus: input.testResult.ok ? 'ok' : 'failed',
            lastTestError: input.testResult.error ?? null,
          }
        : {}),
    },
  });
}

export async function deleteByok(userId: string, provider: ByokProvider): Promise<void> {
  await prisma.userLLMKey.deleteMany({ where: { userId, provider } });
}

// ---------------------------------------------------------------------------
// validate() — provider probe with the supplied key.
// ---------------------------------------------------------------------------

export interface ValidateInput {
  provider: ByokProvider;
  plaintextKey: string;
  baseUrl?: string | null;
}

/**
 * Cheap probe to confirm the provided credentials work. Each provider
 * has a slightly different check, but the shape is always:
 *
 *   - `{ ok: true }` on success (HTTP 2xx + a parseable response shape)
 *   - `{ ok: false, error: '...' }` on auth/network/parse failure
 *
 * Never throws — always returns a result. Timeout is 8s.
 */
export async function validateByok(input: ValidateInput): Promise<{ ok: boolean; error?: string }> {
  const baseValidation = validateBaseUrl(input.provider, input.baseUrl ?? null);
  if (!baseValidation.ok) {
    return { ok: false, error: baseValidation.error };
  }

  const apiKey = input.plaintextKey.trim();
  if (!apiKey) return { ok: false, error: 'API key is empty' };

  const baseUrl = baseValidation.normalized;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  try {
    switch (input.provider) {
      case 'anthropic':
        return await probeAnthropic(apiKey, baseUrl ?? 'https://api.anthropic.com', ctrl.signal);
      case 'google':
        return await probeGoogle(apiKey, baseUrl ?? 'https://generativelanguage.googleapis.com', ctrl.signal);
      // All OpenAI-compatible providers (and OpenAI itself) — `/v1/models`.
      case 'openai':
        return await probeOpenAICompat(apiKey, baseUrl ?? 'https://api.openai.com', ctrl.signal);
      case 'openrouter':
        return await probeOpenAICompat(apiKey, baseUrl ?? 'https://openrouter.ai/api', ctrl.signal);
      case 'deepseek':
        return await probeOpenAICompat(apiKey, baseUrl ?? 'https://api.deepseek.com', ctrl.signal);
      case 'moonshot':
        return await probeOpenAICompat(apiKey, baseUrl ?? 'https://api.moonshot.cn', ctrl.signal);
      case 'minimax':
        // MiniMax requires a baseUrl (region-specific).
        return await probeOpenAICompat(apiKey, baseUrl!, ctrl.signal);
      case 'ollama':
        return await probeOpenAICompat(apiKey || 'ollama', baseUrl!, ctrl.signal);
      case 'newapi':
        return await probeOpenAICompat(apiKey, baseUrl!, ctrl.signal);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Probe failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function probeOpenAICompat(
  apiKey: string,
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
    // Do not follow redirects — a 3xx to an internal host would bypass the
    // validateBaseUrl SSRF front-door check performed on the original URL.
    redirect: 'manual',
  });
  if (res.ok) return { ok: true };
  const body = await safeReadBody(res);
  return { ok: false, error: `${res.status} ${res.statusText}${body ? ` — ${body}` : ''}` };
}

async function probeAnthropic(
  apiKey: string,
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  // 1-token completion. Cheaper than /v1/models which requires the SDK.
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    redirect: 'manual',
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 24000,
      messages: [{ role: 'user', content: 'hi' }],
    }),
    signal,
  });
  if (res.ok) return { ok: true };
  const body = await safeReadBody(res);
  return { ok: false, error: `${res.status} ${res.statusText}${body ? ` — ${body}` : ''}` };
}

async function probeGoogle(
  apiKey: string,
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { method: 'GET', signal, redirect: 'manual' });
  if (res.ok) return { ok: true };
  const body = await safeReadBody(res);
  return { ok: false, error: `${res.status} ${res.statusText}${body ? ` — ${body}` : ''}` };
}

async function safeReadBody(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return null;
  }
}
