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
import { decryptField } from '../crypto.js';
import { logger } from '../../services/LoggerService.js';
import { isDbConfigDisabled } from './llmStackConfigSchema.js';
import { parseReasoningEffort, type ReasoningEffort } from '../../services/llm/reasoningEffort.js';
import { openRouterBaseUrlFromEnv } from '../../platform/llm/openRouterBaseUrl.js';
import { providerBaseType, providerEntryId } from '../../services/llm/providerPrefixes.js';
import { effectiveProviderBaseUrl, getGatewayProviderSync } from './gatewayProviders.js';
import {
  BYOK_PROVIDERS,
  baseUrlRequirement,
  isByokProvider,
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
  /** Reasoning effort for models that expose one; each provider filters it to
   *  its own ladder (see services/llm/reasoningEffort.ts). */
  reasoningEffort?: ReasoningEffort;
}

export interface ResolvedProviderCredential {
  apiKey: string;
  baseUrl?: string;
  tuning: ProviderTuning;
  /** `gateway`: a named provider entry of the LLM gateway (gatewayProviders.ts). */
  source: 'system' | 'env' | 'gateway';
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

// DeepSeek's own effort var. The global LLM_REASONING_EFFORT is NOT read here —
// it applies to every provider, so DeepSeekProvider/OpenAI/OpenRouter resolve it
// themselves as the last tier (see services/llm/reasoningEffort.ts). Keeping it
// out of the credential keeps this resolver "what the DeepSeek key configures".
function parseEnvEffort(): ReasoningEffort | undefined {
  const e = parseReasoningEffort(process.env.DEEPSEEK_REASONING_EFFORT);
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
      return base(process.env.OPENROUTER_API_KEY || '', openRouterBaseUrlFromEnv());
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
    // Domestic OpenAI-compatible vendors (WP-14). Vendor-only keys stay
    // unprefixed (TASK_PLAN R-03). They have no SystemLLMKey/BYOK row, so the
    // env is their only credential tier. The proxy key is NOT attached: these
    // endpoints are the vendors' own hosts.
    case 'qwen':
    case 'dashscope':
      return { apiKey: process.env.DASHSCOPE_API_KEY || '', baseUrl: trimmed('DASHSCOPE_BASE_URL'), tuning: {}, source: 'env' };
    case 'glm':
    case 'zhipu':
      return { apiKey: process.env.GLM_API_KEY || '', baseUrl: trimmed('GLM_API_BASE_URL'), tuning: {}, source: 'env' };
    case 'doubao':
    case 'ark':
      return { apiKey: process.env.ARK_API_KEY || '', baseUrl: trimmed('ARK_BASE_URL'), tuning: {}, source: 'env' };
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

/* ── The 3-tier resolver entry point (system → env) ─────────────────────────
 * NOTE: user BYOK sits ABOVE this, in LLMService.chat()'s existing swap. */

/**
 * The credential of a provider entry (`<type>@<entry>`): the entry's own key
 * and base URL, never the provider type's system key or env key. The base URL
 * is always explicit (the entry's, else the type's own host) so an env proxy
 * override of the type does not redirect the entry. `LLM_PROXY_KEY` is NOT
 * sent (`proxyKey: ''`): it is the secret of the deployment's own proxy, and an
 * entry's host is whatever an admin typed. An entry that cannot be used
 * (removed, disabled, unreadable key, cold cache) resolves to an empty key,
 * which callers treat as a missing credential and reroute.
 */
function gatewayCredential(providerType: string, entryId: string): ResolvedProviderCredential {
  const baseType = providerBaseType(providerType);
  const { proxyKey: _proxyKey, ...typeTuning } = envCredential(baseType).tuning;
  void _proxyKey;
  const entry = getGatewayProviderSync(entryId);
  const usable = entry && entry.type === normalizeProviderForSystemKey(baseType) ? entry : null;
  return {
    apiKey: usable?.apiKey ?? '',
    baseUrl: usable ? effectiveProviderBaseUrl(usable.type, usable.baseUrl) ?? undefined : undefined,
    tuning: { ...typeTuning, proxyKey: '' },
    source: 'gateway',
  };
}

export function resolveProviderCredential(providerType: string): ResolvedProviderCredential {
  const entryId = providerEntryId(providerType);
  if (entryId) return gatewayCredential(providerType, entryId);
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

export { BYOK_PROVIDERS, isByokProvider, baseUrlRequirement };
