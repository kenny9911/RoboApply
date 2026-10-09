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
 *
 * Per brand (WP-14, TASK_PLAN R-03/R-13): every read is made for the brand of
 * the current unit of work (or the `brand` argument). RoboApply reads the
 * unprefixed env and the `llm_stack.{env}` override; GoApply reads `CN_<NAME>`
 * and `llm_stack.goapply.{env}` with NO fallback to RoboApply's values, so a
 * missing CN_LLM_MODEL can never send a mainland user's prompt to the
 * international stack.
 */

import { brandEnv } from '../../platform/brand/brandEnv.js';
import { getBrand, type BrandId, type ProductBrand } from '../../platform/brand/registry.js';
import { contextlessLlmBrand } from './llmBrand.js';
import { getLlmStackSync } from './llmStackConfigResolver.js';
import {
  MODEL_ENV,
  PURPOSE_KEYS,
  isDbConfigDisabled,
  type ModelKey,
  type PurposeKey,
} from './llmStackConfigSchema.js';

/** A brand id or registry entry; omitted → the brand of the current unit of work. */
export type LlmBrandArg = BrandId | ProductBrand | undefined;

function clean(v: string | null | undefined): string | undefined {
  return v && v.trim() ? v.trim() : undefined;
}

export { contextlessLlmBrand, requireLlmCallBrand, type ContextlessLlmBrand } from './llmBrand.js';

/** The brand an LLM setting is read for. */
export function llmBrand(brand?: LlmBrandArg): ProductBrand {
  if (!brand) return getBrand(contextlessLlmBrand().brandId);
  return typeof brand === 'string' ? getBrand(brand) : brand;
}

function overrideFor(key: ModelKey, brand: ProductBrand): string | undefined {
  if (isDbConfigDisabled()) return undefined;
  const blob = getLlmStackSync(brand.id);
  if (key === 'defaultModel') return clean(blob.defaultModel);
  if (key === 'fallbackModel') return clean(blob.fallbackModel);
  return clean(blob.purposes[key as PurposeKey]);
}

function envFor(key: ModelKey, brand: ProductBrand): string | undefined {
  return brandEnv(brand, MODEL_ENV[key]);
}

/** Leaf resolution for one model setting: DB override ?? env ?? undefined (per brand). */
export function getModelSetting(key: ModelKey, brand?: LlmBrandArg): string | undefined {
  const b = llmBrand(brand);
  return overrideFor(key, b) ?? envFor(key, b);
}

/* ── Core (non-purpose) convenience getters ─────────────────────────────────── */

/** LLM_PROVIDER (CN_LLM_PROVIDER on GoApply): override ?? env ?? undefined. */
export function getProviderSetting(brand?: LlmBrandArg): string | undefined {
  const b = llmBrand(brand);
  if (!isDbConfigDisabled()) {
    const p = clean(getLlmStackSync(b.id).provider);
    if (p) return p;
  }
  return brandEnv(b, 'LLM_PROVIDER');
}

export const getDefaultModel = (brand?: LlmBrandArg): string | undefined => getModelSetting('defaultModel', brand);
export const getFallbackModelSetting = (brand?: LlmBrandArg): string | undefined =>
  getModelSetting('fallbackModel', brand);

/* ── Tuning getters (DB override ?? env ?? code default at call site) ────────── */
// Retry and timeout tuning carries no routing decision, so both brands share
// RoboApply's blob and the unprefixed env.

function tuningNum(field: 'retryAttempts' | 'retryBaseMs' | 'retryMaxMs' | 'timeoutMs', envName: string): number | undefined {
  if (!isDbConfigDisabled()) {
    const v = getLlmStackSync('roboapply').tuning[field];
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
  /** The env variable this brand reads for the key (`CN_…` on GoApply). */
  envName: string;
  override: string | null; // admin-set DB value (null = inherit)
  env: string | null; // what env provides for this key
  effective: string | null; // override ?? env (the leaf that runs)
  source: 'override' | 'env' | 'none';
}

export function resolveModelKey(key: ModelKey, brand?: LlmBrandArg): ModelKeyResolution {
  const b = llmBrand(brand);
  const override = overrideFor(key, b) ?? null;
  const env = envFor(key, b) ?? null;
  const effective = override ?? env;
  return {
    key,
    envName: b.llmEnvPrefix + MODEL_ENV[key],
    override,
    env,
    effective,
    source: override ? 'override' : env ? 'env' : 'none',
  };
}

/** Every model key resolved — for the admin page's effective-value display. */
export function getAllModelResolutions(brand?: LlmBrandArg): ModelKeyResolution[] {
  const keys: ModelKey[] = ['defaultModel', 'fallbackModel', ...PURPOSE_KEYS];
  return keys.map((k) => resolveModelKey(k, brand));
}
