/**
 * Central per-purpose LLM model accessor — the single seam that replaces the
 * ~18 scattered inline `process.env.LLM_*` reads.
 *
 * `getModelSetting(key)` returns the LEAF value for one setting:
 *     DB override (admin) ?? env var ?? undefined.
 * It deliberately does NOT bake in multi-level fallback chains — each call site
 * keeps its own chain (e.g. fast → quickJob → defaultModel; resumeTag →
 * matchScreen) by composing these leaf reads. This keeps the migration faithful:
 * with an empty DB, `getModelSetting(k)` returns exactly the legacy env value, so
 * every call site behaves byte-for-byte like today (the §2 invariant).
 */

import { getLlmStackSync } from './llmStackConfigResolver.js';
import {
  MODEL_ENV,
  PURPOSE_KEYS,
  isDbConfigDisabled,
  type ModelKey,
  type PurposeKey,
} from './llmStackConfigSchema.js';

function clean(v: string | null | undefined): string | undefined {
  return v && v.trim() ? v.trim() : undefined;
}

function overrideFor(key: ModelKey): string | undefined {
  if (isDbConfigDisabled()) return undefined;
  const blob = getLlmStackSync();
  if (key === 'defaultModel') return clean(blob.defaultModel);
  if (key === 'fallbackModel') return clean(blob.fallbackModel);
  return clean(blob.purposes[key as PurposeKey]);
}

function envFor(key: ModelKey): string | undefined {
  return clean(process.env[MODEL_ENV[key]]);
}

/** Leaf resolution for one model setting: DB override ?? env ?? undefined. */
export function getModelSetting(key: ModelKey): string | undefined {
  return overrideFor(key) ?? envFor(key);
}

/* ── Core (non-purpose) convenience getters ─────────────────────────────────── */

/** LLM_PROVIDER override ?? env ?? undefined. */
export function getProviderSetting(): string | undefined {
  if (!isDbConfigDisabled()) {
    const p = clean(getLlmStackSync().provider);
    if (p) return p;
  }
  return clean(process.env.LLM_PROVIDER);
}

export const getDefaultModel = (): string | undefined => getModelSetting('defaultModel');
export const getFallbackModelSetting = (): string | undefined => getModelSetting('fallbackModel');

/* ── Tuning getters (DB override ?? env ?? code default at call site) ────────── */

function tuningNum(field: 'retryAttempts' | 'retryBaseMs' | 'retryMaxMs' | 'timeoutMs', envName: string): number | undefined {
  if (!isDbConfigDisabled()) {
    const v = getLlmStackSync().tuning[field];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  const e = parseInt((process.env[envName] ?? '').trim(), 10);
  return Number.isFinite(e) ? e : undefined;
}

export const getRetryAttempts = (): number | undefined => tuningNum('retryAttempts', 'LLM_RETRY_ATTEMPTS');
export const getRetryBaseMs = (): number | undefined => tuningNum('retryBaseMs', 'LLM_RETRY_BASE_MS');
export const getRetryMaxMs = (): number | undefined => tuningNum('retryMaxMs', 'LLM_RETRY_MAX_MS');
export const getTimeoutMs = (): number | undefined => tuningNum('timeoutMs', 'LLM_TIMEOUT_MS');

/* ── Admin UI introspection ─────────────────────────────────────────────────── */

export interface ModelKeyResolution {
  key: ModelKey;
  override: string | null; // admin-set DB value (null = inherit)
  env: string | null; // what env provides for this key
  effective: string | null; // override ?? env (the leaf that runs)
  source: 'override' | 'env' | 'none';
}

export function resolveModelKey(key: ModelKey): ModelKeyResolution {
  const override = overrideFor(key) ?? null;
  const env = envFor(key) ?? null;
  const effective = override ?? env;
  return { key, override, env, effective, source: override ? 'override' : env ? 'env' : 'none' };
}

/** Every model key resolved — for the admin page's effective-value display. */
export function getAllModelResolutions(): ModelKeyResolution[] {
  const keys: ModelKey[] = ['defaultModel', 'fallbackModel', ...PURPOSE_KEYS];
  return keys.map(resolveModelKey);
}
