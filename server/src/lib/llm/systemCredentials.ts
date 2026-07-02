/**
 * System-level LLM provider credentials — the "system DB key" tier.
 *
 * Resolution precedence (whole app):  user BYOK → SYSTEM DB key (here) → env.
 * This module owns the middle tier + the env fallback, exposed through
 * `resolveProviderCredential()`, which LLMService.createProvider() calls instead
 * of reading provider env vars directly.
 *
 * SAFETY (see docs/llm-settings-db/):
 *  - Decrypted keys live ONLY in an in-memory cache + are handed straight to a
 *    provider SDK client. They are NEVER logged, serialized, or returned.
 *  - A DECRYPT FAILURE degrades to ENV (logged, not thrown) — the OPPOSITE of
 *    user BYOK — so a wrong/rotated FIELD_ENCRYPTION_KEY can never black out all
 *    platform LLM traffic.
 *  - The system tier NEVER sets the request `byok` flag (that stays exclusive to
 *    user BYOK), so platform calls keep being billed/metered normally.
 *  - LLM_PROXY_KEY stays ENV-ONLY (a secret never stored in the plaintext
 *    SystemLLMKey.tuning JSON); a DB base URL pairs with the env proxy key.
 */

import { prisma } from '../prisma.js';
import { encryptField, decryptField } from '../crypto.js';
import { logger } from '../../services/LoggerService.js';
import { isDbConfigDisabled } from './llmStackConfigSchema.js';
import {
  BYOK_PROVIDERS,
  baseUrlRequirement,
  isByokProvider,
  previewFor,
  validateBaseUrl,
  validateByok,
  type ByokProvider,
} from '../byokService.js';

/** Behavioural tuning that travels with the credential (independent of WHICH key). */
export interface ProviderTuning {
  /** Custom-proxy shared secret — ALWAYS sourced from env (never stored in DB). */
  proxyKey?: string;
  /** Request timeout (ms) — google path. */
  timeoutMs?: number;
  /** DeepSeek thinking mode. */
  thinkingMode?: 'enabled' | 'disabled';
  /** DeepSeek reasoning effort. */
  reasoningEffort?: 'high' | 'max';
}

export interface ResolvedProviderCredential {
  apiKey: string;
  baseUrl?: string;
  tuning: ProviderTuning;
  source: 'system' | 'env';
}

/**
 * Map the LLM stack's internal provider TYPE to the SystemLLMKey/BYOK provider
 * key. The stack uses 'kimi'; the key catalog uses 'moonshot'. Identity for the
 * rest. Returns null for unknown types (→ caller uses env).
 */
export function normalizeProviderForSystemKey(providerType: string): ByokProvider | null {
  const lower = (providerType || '').toLowerCase();
  if (lower === 'kimi' || lower === 'moonshot') return 'moonshot';
  return isByokProvider(lower) ? (lower as ByokProvider) : null;
}

/* ── ENV fallback (the single place the provider env vars are read for the
 *    resolver path — mirrors the historical LLMService.createProvider reads) ── */

function parseEnvThinking(): 'enabled' | 'disabled' | undefined {
  const v = process.env.DEEPSEEK_THINKING_MODE;
  if (v === undefined) return undefined;
  const n = v.trim().toLowerCase();
  if (['1', 'true', 'enabled', 'on', 'yes'].includes(n)) return 'enabled';
  if (['0', 'false', 'disabled', 'off', 'no'].includes(n)) return 'disabled';
  return undefined;
}

function parseEnvEffort(): 'high' | 'max' | undefined {
  const e = (process.env.DEEPSEEK_REASONING_EFFORT || '').trim().toLowerCase();
  return e === 'high' || e === 'max' ? e : undefined;
}

function trimmed(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function envCredential(providerType: string): ResolvedProviderCredential {
  const p = (providerType || '').toLowerCase();
  const proxyKey = trimmed('LLM_PROXY_KEY');
  const base = (apiKey: string, baseUrl?: string, tuning: ProviderTuning = {}): ResolvedProviderCredential => ({
    apiKey,
    baseUrl,
    tuning: { ...(proxyKey ? { proxyKey } : {}), ...tuning },
    source: 'env',
  });
  switch (p) {
    case 'openai':
      return base(process.env.OPENAI_API_KEY || '', trimmed('OPENAI_BASE_URL'));
    case 'openrouter':
      return base(process.env.OPENROUTER_API_KEY || '', trimmed('OPENROUTER_API_BASE_URL'));
    case 'google': {
      const t = parseInt((process.env.GOOGLE_LLM_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS || '').trim(), 10);
      // GEMINI_API_KEY fallback: .env.example documents "one Google key serves
      // both Agent Alex and the broader LLM stack" — deployments configured
      // with only GEMINI_API_KEY must work through llmService too (the
      // candidate-chat /ask path and the eval judge depend on this).
      return base(
        process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '',
        trimmed('GEMINI_BASE_URL'),
        Number.isFinite(t) ? { timeoutMs: t } : {},
      );
    }
    case 'kimi':
    case 'moonshot':
      return base(process.env.KIMI_API_KEY || '', trimmed('KIMI_API_BASE_URL'));
    case 'deepseek':
      return base(process.env.DEEPSEEK_API_KEY || '', trimmed('DEEPSEEK_API_BASE_URL'), {
        ...(parseEnvThinking() ? { thinkingMode: parseEnvThinking() } : {}),
        ...(parseEnvEffort() ? { reasoningEffort: parseEnvEffort() } : {}),
      });
    case 'anthropic':
      return base(process.env.ANTHROPIC_API_KEY || '', trimmed('ANTHROPIC_BASE_URL'));
    case 'minimax':
      return base(process.env.MINIMAX_API_KEY || '', trimmed('MINIMAX_BASE_URL'));
    case 'ollama':
      return base(process.env.OLLAMA_API_KEY || 'ollama', trimmed('OLLAMA_BASE_URL'));
    case 'newapi':
      return base(process.env.NEWAPI_API_KEY || '', trimmed('NEWAPI_BASE_URL'));
    default:
      return base('', undefined);
  }
}

/* ── In-memory decrypted-credential cache (30s TTL, warmup, invalidate) ─────── */

interface CachedSystemCred {
  apiKey: string;
  baseUrl: string | null;
  tuning: ProviderTuning;
}

interface CredCache {
  map: Map<ByokProvider, CachedSystemCred>;
  fetchedAt: number;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
let credCache: CredCache | null = null;

// Providers we've already warned about a decrypt failure for, so we log ONCE
// per process instead of on every 30s cache refresh. A decrypt failure is a
// persistent config state (the stored ciphertext was encrypted with a different
// FIELD_ENCRYPTION_KEY than the current env — e.g. local dev pointed at the
// prod DB), not a per-call error; re-logging it every refresh just floods.
// Cleared by invalidateSystemCredentials() so a re-saved key re-evaluates.
const decryptWarnedProviders = new Set<string>();

function tuningFromRow(raw: unknown): ProviderTuning {
  const t: ProviderTuning = {};
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (o.thinkingMode === 'enabled' || o.thinkingMode === 'disabled') t.thinkingMode = o.thinkingMode;
    if (o.reasoningEffort === 'high' || o.reasoningEffort === 'max') t.reasoningEffort = o.reasoningEffort;
    if (typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs)) t.timeoutMs = o.timeoutMs;
    // NB: proxyKey is intentionally NOT read from the row — it stays env-only.
  }
  return t;
}

async function refreshCredCache(): Promise<void> {
  const now = Date.now();
  try {
    const rows = await prisma.systemLLMKey.findMany({ where: { isActive: true } });
    const map = new Map<ByokProvider, CachedSystemCred>();
    for (const row of rows) {
      if (!isByokProvider(row.provider)) continue;
      let apiKey = '';
      try {
        apiKey = row.encryptedKey ? decryptField(row.encryptedKey) : '';
      } catch (err) {
        // Decrypt failure ⇒ OMIT this provider so it degrades to env. Never throw.
        // This is an expected, gracefully-handled fallback (warn, not error), and
        // we log it at most once per provider per process to avoid flooding the
        // console every 30s cache refresh — the failure is a persistent state.
        if (!decryptWarnedProviders.has(row.provider)) {
          decryptWarnedProviders.add(row.provider);
          logger.warn('SYSTEM_LLM_KEY', 'decrypt failed — falling back to env for provider', {
            provider: row.provider,
            error: err instanceof Error ? err.message : String(err),
            hint: 'FIELD_ENCRYPTION_KEY must match the key that encrypted the SystemLLMKey rows',
          });
        }
        continue;
      }
      map.set(row.provider as ByokProvider, {
        apiKey,
        baseUrl: row.baseUrl,
        tuning: tuningFromRow(row.tuning),
      });
    }
    credCache = { map, fetchedAt: now, expiresAt: now + CACHE_TTL_MS };
  } catch (err) {
    // DB hiccup — keep last-known-good if any, else leave cold (⇒ env).
    logger.warn('SYSTEM_LLM_KEY', 'cred cache refresh failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (credCache) credCache.expiresAt = now + 10_000;
  }
}

function getSystemCredentialSync(provider: ByokProvider): CachedSystemCred | null {
  if (credCache) {
    if (credCache.expiresAt <= Date.now()) void refreshCredCache();
    return credCache.map.get(provider) ?? null;
  }
  void refreshCredCache(); // cold cache — warm in background, serve env this call
  return null;
}

export function invalidateSystemCredentials(): void {
  credCache = null;
  // Re-arm the decrypt-failure warning: a re-saved key may now decrypt (or
  // still fail), and either way the operator should get a fresh signal.
  decryptWarnedProviders.clear();
}

export async function warmupSystemCredentials(): Promise<void> {
  try {
    await refreshCredCache();
  } catch {
    /* sync readers degrade to env */
  }
}

/* ── The 3-tier resolver entry point (system → env) ─────────────────────────
 * NOTE: user BYOK sits ABOVE this, in LLMService.chat()'s existing swap. */

export function resolveProviderCredential(providerType: string): ResolvedProviderCredential {
  const env = envCredential(providerType);
  if (isDbConfigDisabled()) return env;
  const norm = normalizeProviderForSystemKey(providerType);
  if (!norm) return env;
  const sys = getSystemCredentialSync(norm);
  if (!sys) return env; // cold / absent / inactive / decrypt-failed → env
  return {
    apiKey: sys.apiKey,
    baseUrl: sys.baseUrl ?? env.baseUrl, // system base URL wins, else inherit env
    tuning: { ...env.tuning, ...sys.tuning }, // system tuning overrides env per-field (proxyKey stays from env)
    source: 'system',
  };
}

/* ── Admin CRUD + status (mirrors byokService for UserLLMKey) ────────────────── */

export interface SystemKeySummary {
  provider: ByokProvider;
  label: string | null;
  baseUrl: string | null;
  isActive: boolean;
  keyPreview: string; // never the plaintext
  hasKey: boolean;
  tuning: ProviderTuning;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
  lastUsedAt: string | null;
  updatedAt: string;
}

export async function listSystemKeys(): Promise<SystemKeySummary[]> {
  const rows = await prisma.systemLLMKey.findMany({ orderBy: { provider: 'asc' } });
  return rows.map((row) => {
    let preview = '';
    let hasKey = false;
    try {
      const plain = row.encryptedKey ? decryptField(row.encryptedKey) : '';
      hasKey = !!plain;
      preview = plain ? previewFor(plain) : '';
    } catch {
      preview = '••••';
      hasKey = true; // a row exists; just undecryptable
    }
    return {
      provider: row.provider as ByokProvider,
      label: row.label,
      baseUrl: row.baseUrl,
      isActive: row.isActive,
      keyPreview: preview,
      hasKey,
      tuning: tuningFromRow(row.tuning),
      lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
      lastTestStatus: row.lastTestStatus,
      lastTestError: row.lastTestError,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/**
 * Per-provider resolution status for the UI: does this provider have a usable
 * credential, and from where? Drives the per-field "resolves to X (key ✓/✗)"
 * badges and the user-facing coverage indicator. NEVER returns key material.
 */
export interface ProviderKeyStatus {
  provider: ByokProvider;
  hasSystemKey: boolean; // an active SystemLLMKey row with a non-empty key (or keyless ollama)
  hasEnvKey: boolean; // env provides a key for this provider
  source: 'system' | 'env' | 'none'; // what resolveProviderCredential would use
  baseUrlRequirement: 'required' | 'optional' | 'forbidden';
}

export async function getProviderKeyStatuses(): Promise<ProviderKeyStatus[]> {
  const summaries = await listSystemKeys();
  const byProvider = new Map(summaries.map((s) => [s.provider, s]));
  return BYOK_PROVIDERS.map((provider) => {
    const sum = byProvider.get(provider);
    const env = envCredential(provider);
    // ollama is legitimately keyless — treat its non-empty placeholder as "no real key needed"
    const envHasKey = provider === 'ollama' ? true : !!env.apiKey;
    const sysHasKey = !!sum && sum.isActive && (provider === 'ollama' ? true : sum.hasKey);
    const source: ProviderKeyStatus['source'] = sysHasKey ? 'system' : envHasKey ? 'env' : 'none';
    return {
      provider,
      hasSystemKey: sysHasKey,
      hasEnvKey: envHasKey,
      source,
      baseUrlRequirement: baseUrlRequirement(provider),
    };
  });
}

export interface UpsertSystemKeyInput {
  provider: ByokProvider;
  plaintextKey: string;
  baseUrl?: string | null;
  label?: string | null;
  isActive?: boolean;
  tuning?: ProviderTuning;
  adminId: string;
  testResult?: { ok: boolean; error?: string };
}

export async function upsertSystemKey(input: UpsertSystemKeyInput): Promise<void> {
  const baseValidation = validateBaseUrl(input.provider, input.baseUrl);
  if (!baseValidation.ok) throw new Error(baseValidation.error);

  const trimmedKey = (input.plaintextKey ?? '').trim();
  // ollama may be keyless; everything else needs a key.
  if (!trimmedKey && input.provider !== 'ollama') throw new Error('API key cannot be empty');
  const encryptedKey = trimmedKey ? encryptField(trimmedKey) : '';

  const cleanTuning = tuningFromRow(input.tuning); // strips unknown/secret fields
  await prisma.systemLLMKey.upsert({
    where: { provider: input.provider },
    create: {
      provider: input.provider,
      label: input.label ?? null,
      encryptedKey,
      baseUrl: baseValidation.normalized ?? null,
      isActive: input.isActive ?? true,
      tuning: cleanTuning as object,
      updatedBy: input.adminId,
      lastTestedAt: input.testResult ? new Date() : null,
      lastTestStatus: input.testResult ? (input.testResult.ok ? 'ok' : 'failed') : null,
      lastTestError: input.testResult?.error ?? null,
    },
    update: {
      label: input.label ?? null,
      ...(trimmedKey ? { encryptedKey } : {}), // empty key in an UPDATE = keep existing
      baseUrl: baseValidation.normalized ?? null,
      ...(typeof input.isActive === 'boolean' ? { isActive: input.isActive } : {}),
      tuning: cleanTuning as object,
      updatedBy: input.adminId,
      ...(input.testResult
        ? {
            lastTestedAt: new Date(),
            lastTestStatus: input.testResult.ok ? 'ok' : 'failed',
            lastTestError: input.testResult.error ?? null,
          }
        : {}),
    },
  });
  invalidateSystemCredentials();
}

export async function deleteSystemKey(provider: ByokProvider): Promise<void> {
  await prisma.systemLLMKey.deleteMany({ where: { provider } });
  invalidateSystemCredentials();
}

export async function setSystemKeyActive(provider: ByokProvider, isActive: boolean, adminId: string): Promise<void> {
  await prisma.systemLLMKey.updateMany({ where: { provider }, data: { isActive, updatedBy: adminId } });
  invalidateSystemCredentials();
}

/** Re-run the validation probe for a stored (or override) system key. Persists status. */
export async function testSystemKey(
  provider: ByokProvider,
  override?: { apiKey?: string; baseUrl?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  let plaintextKey = override?.apiKey;
  let resolvedBaseUrl = override?.baseUrl ?? null;

  if (!plaintextKey) {
    const existing = await prisma.systemLLMKey.findUnique({
      where: { provider },
      select: { encryptedKey: true, baseUrl: true },
    });
    if (!existing) return { ok: false, error: 'No system key configured for this provider' };
    try {
      plaintextKey = existing.encryptedKey ? decryptField(existing.encryptedKey) : (provider === 'ollama' ? 'ollama' : '');
      resolvedBaseUrl = existing.baseUrl;
    } catch {
      return { ok: false, error: 'Stored key could not be decrypted (check FIELD_ENCRYPTION_KEY)' };
    }
  }

  const result = await validateByok({ provider, plaintextKey: plaintextKey ?? '', baseUrl: resolvedBaseUrl });

  await prisma.systemLLMKey
    .updateMany({
      where: { provider },
      data: { lastTestedAt: new Date(), lastTestStatus: result.ok ? 'ok' : 'failed', lastTestError: result.error ?? null },
    })
    .catch(() => {});
  return result;
}

export { BYOK_PROVIDERS, isByokProvider, baseUrlRequirement };
