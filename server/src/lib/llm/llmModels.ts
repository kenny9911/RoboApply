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
 * Per brand, per key (owner ruling D5; GOAPPLY_PARITY_PLAN.md §3.3; it
 * supersedes TASK_PLAN R-03 / R-13). Every read is made for the brand of the
 * current unit of work (or the `brand` argument):
 *
 *   RoboApply   llm_stack.{env} blob  ??  <NAME>
 *   GoApply     llm_stack.goapply.{env} blob  ??  CN_<NAME>
 *               ??  llm_stack.{env} blob (RoboApply's)  ??  <NAME>
 *
 * So a China-specific model is an optional override: with no `CN_LLM_*` and
 * no GoApply blob, every model key and the provider mode resolve to the same
 * strings for both brands. RoboApply never reads a `CN_` value or GoApply's
 * blob.
 *
 * Mixed case. A selector is read in the context of the stack it comes from.
 * When GoApply has routing settings of its own (a provider or a default
 * model) and one model setting comes from the shared stack, the shared
 * selector is qualified to a full `<provider>/<model>` route
 * (`qualifySelector`), so it goes where it goes for RoboApply and never to
 * GoApply's own provider. The other way round, a GoApply selector written in
 * the domestic dialect (`qwen/…` = DashScope) keeps that meaning while
 * GoApply runs on the shared, global profile (`pinDomesticSelector`).
 *
 * Behind the domestic-only wall (`CN_LLM_DOMESTIC_ONLY`, or
 * `CN_RESIDENCY_STRICT`) GoApply uses a shared value only when it names a
 * mainland vendor by itself (`deepseek/…`, `dashscope/…`, a provider mode of
 * `deepseek`). Any other shared value is set aside and the key counts as
 * unset, so a task falls back to GoApply's own default model instead of to a
 * route the wall would refuse. A gateway (`newapi`) cannot be judged from its
 * name: behind the wall GoApply names it in its own settings.
 */

import { brandEnvName, brandOwnEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import { DEFAULT_BRAND, getBrand, type BrandId, type LlmProfile, type ProductBrand } from '../../platform/brand/registry.js';
import { isGoApplyDirectProvider, llmDomesticOnlyApplies } from '../../platform/llm/brandPolicy.js';
import {
  DEFAULT_PROVIDER_MODE,
  normalizeProviderType,
  pinDomesticSelector,
  qualifySelector,
  resolveSelectorRoute,
} from '../../services/llm/providerPrefixes.js';
import { contextlessLlmBrand, effectiveLlmProfile } from './llmBrand.js';
import { getLlmStackSync } from './llmStackConfigResolver.js';
import {
  MODEL_ENV,
  PURPOSE_KEYS,
  isDbConfigDisabled,
  type LlmStackConfigBlob,
  type ModelKey,
  type PurposeKey,
} from './llmStackConfigSchema.js';

/** A brand id or registry entry; omitted → the brand of the current unit of work. */
export type LlmBrandArg = BrandId | ProductBrand | undefined;

function clean(v: string | null | undefined): string | undefined {
  return v && v.trim() ? v.trim() : undefined;
}

export { contextlessLlmBrand, effectiveLlmProfile, requireLlmCallBrand, type ContextlessLlmBrand } from './llmBrand.js';

/** The brand an LLM setting is read for. */
export function llmBrand(brand?: LlmBrandArg): ProductBrand {
  if (!brand) return getBrand(contextlessLlmBrand().brandId);
  return typeof brand === 'string' ? getBrand(brand) : brand;
}

/* ── Layered resolution: own override → own env → shared override → shared env ─ */

/** The brand whose settings are "the shared stack" (the unprefixed names, the historical blob). */
const SHARED_STACK_BRAND: BrandId = DEFAULT_BRAND;

/**
 * Where a setting comes from:
 *  - `override`: the brand's own admin blob;
 *  - `env`: the brand's own variable (`CN_<NAME>` on GoApply, `<NAME>` on RoboApply);
 *  - `shared`: the shared stack (RoboApply's blob, else `<NAME>`), read by GoApply
 *    for a setting it has not overridden;
 *  - `none`: nothing is set.
 */
export type LlmSettingSource = 'override' | 'env' | 'shared' | 'none';

type BlobPick = (blob: LlmStackConfigBlob) => string | null | undefined;

const PICK_PROVIDER: BlobPick = (blob) => blob.provider;
function pickModel(key: ModelKey): BlobPick {
  if (key === 'defaultModel') return (blob) => blob.defaultModel;
  if (key === 'fallbackModel') return (blob) => blob.fallbackModel;
  return (blob) => blob.purposes[key as PurposeKey];
}

function blobValue(brandId: BrandId, pick: BlobPick | null): string | undefined {
  if (!pick || isDbConfigDisabled()) return undefined;
  return clean(pick(getLlmStackSync(brandId)));
}

interface Layers {
  /** The brand's own admin override. */
  override: string | undefined;
  /** The brand's own variable. */
  env: string | undefined;
  /** The shared stack's value, for a brand that falls back to it (never for RoboApply). */
  shared: string | undefined;
  /** A shared value the domestic-only wall set aside (it names no mainland vendor); never used. */
  walledOff: string | undefined;
}

/** What a setting holds: a model selector, or the provider mode. */
type SettingKind = 'selector' | 'provider';

/**
 * Does a value of the shared stack name a mainland vendor by itself? A
 * selector is judged on the route it has on the shared stack (its provider
 * mode and default model), a provider mode on its own name.
 */
function sharedValueIsDomestic(value: string, kind: SettingKind, env: EnvSource): boolean {
  if (kind === 'provider') return isGoApplyDirectProvider(normalizeProviderType(value));
  const context = sharedRoutingContext(env);
  return isGoApplyDirectProvider(resolveSelectorRoute(value, context.providerMode, context.defaultModel, 'global').providerType);
}

function layersOf(brand: ProductBrand, envName: string, pick: BlobPick | null, env: EnvSource, kind: SettingKind = 'selector'): Layers {
  const own = { override: blobValue(brand.id, pick), env: brandOwnEnv(brand, envName, env) };
  if (brand.id === SHARED_STACK_BRAND) return { ...own, shared: undefined, walledOff: undefined };
  const shared = blobValue(SHARED_STACK_BRAND, pick) ?? clean(env[envName]);
  // Behind the wall the shared stack is no fallback for a value that would
  // leave the mainland: the key counts as unset (see the header).
  if (shared && llmDomesticOnlyApplies(brand, env) && !sharedValueIsDomestic(shared, kind, env)) {
    return { ...own, shared: undefined, walledOff: shared };
  }
  return { ...own, shared, walledOff: undefined };
}

function sourceOf(layers: Layers): LlmSettingSource {
  if (layers.override) return 'override';
  if (layers.env) return 'env';
  return layers.shared ? 'shared' : 'none';
}

/** The shared stack's own routing context, for qualifying one of its selectors. */
function sharedRoutingContext(env: EnvSource): { providerMode: string; defaultModel: string | undefined } {
  const shared = getBrand(SHARED_STACK_BRAND);
  const provider = layersOf(shared, 'LLM_PROVIDER', PICK_PROVIDER, env, 'provider');
  const model = layersOf(shared, MODEL_ENV.defaultModel, pickModel('defaultModel'), env);
  return {
    providerMode: normalizeProviderType(provider.override ?? provider.env ?? '') || DEFAULT_PROVIDER_MODE,
    defaultModel: model.override ?? model.env,
  };
}

/**
 * The brand reads selectors in a context of its own: its effective profile is
 * not the shared one, or it has a provider or a default model of its own. A
 * selector that comes from the shared stack must then be qualified.
 */
function hasOwnRoutingContext(brand: ProductBrand, env: EnvSource): boolean {
  if (brand.id === SHARED_STACK_BRAND) return false;
  if (effectiveLlmProfile(brand, env) !== getBrand(SHARED_STACK_BRAND).llmProfile) return true;
  const provider = layersOf(brand, 'LLM_PROVIDER', PICK_PROVIDER, env, 'provider');
  const model = layersOf(brand, MODEL_ENV.defaultModel, pickModel('defaultModel'), env);
  return Boolean(provider.override ?? provider.env ?? model.override ?? model.env);
}

/** The selector that runs for the brand, given where each layer's value comes from. */
function effectiveSelector(brand: ProductBrand, layers: Layers, env: EnvSource): string | undefined {
  const own = layers.override ?? layers.env;
  if (own) {
    // Written for GoApply, so in its dialect; keep the meaning on the global profile.
    return brand.llmProfile === 'domestic_cn' && effectiveLlmProfile(brand, env) !== 'domestic_cn' ? pinDomesticSelector(own) : own;
  }
  if (!layers.shared) return undefined;
  if (!hasOwnRoutingContext(brand, env)) return layers.shared;
  const context = sharedRoutingContext(env);
  return qualifySelector(layers.shared, context.providerMode, context.defaultModel);
}

/** Leaf resolution for one model setting, per brand and per key (see the header). */
export function getModelSetting(key: ModelKey, brand?: LlmBrandArg, env: EnvSource = process.env): string | undefined {
  const b = llmBrand(brand);
  return effectiveSelector(b, layersOf(b, MODEL_ENV[key], pickModel(key), env), env);
}

/**
 * A model selector kept in a variable outside the stack table
 * (`LLM_CAMPUS_MODEL`, `LLM_INTERVIEW_BLUEPRINT_MODEL`, …), read with the same
 * per-key rule and the same qualification as a table key. There is no admin
 * override for such a name: `CN_<NAME>` for GoApply, else `<NAME>`.
 */
export function getEnvModelSetting(envName: string, brand?: LlmBrandArg, env: EnvSource = process.env): string | undefined {
  const b = llmBrand(brand);
  return effectiveSelector(b, layersOf(b, envName, null, env), env);
}

/* ── Core (non-purpose) convenience getters ─────────────────────────────────── */

export interface ProviderSettingResolution {
  value: string | undefined;
  source: LlmSettingSource;
}

/**
 * The provider mode with its source: own blob ?? own env ?? shared blob ??
 * LLM_PROVIDER. Behind the domestic-only wall GoApply takes the shared mode
 * only when it names a mainland vendor.
 */
export function resolveProviderSetting(brand?: LlmBrandArg, env: EnvSource = process.env): ProviderSettingResolution {
  const layers = layersOf(llmBrand(brand), 'LLM_PROVIDER', PICK_PROVIDER, env, 'provider');
  return { value: layers.override ?? layers.env ?? layers.shared, source: sourceOf(layers) };
}

/** LLM_PROVIDER for the brand (GoApply: its blob, CN_LLM_PROVIDER, then the shared stack's). */
export function getProviderSetting(brand?: LlmBrandArg, env: EnvSource = process.env): string | undefined {
  return resolveProviderSetting(brand, env).value;
}

export const getDefaultModel = (brand?: LlmBrandArg, env: EnvSource = process.env): string | undefined =>
  getModelSetting('defaultModel', brand, env);
export const getFallbackModelSetting = (brand?: LlmBrandArg, env: EnvSource = process.env): string | undefined =>
  getModelSetting('fallbackModel', brand, env);

export interface LlmRoutingDefaults {
  /** The profile the brand runs on (`effectiveLlmProfile`). */
  profile: LlmProfile;
  /**
   * The provider mode a selector WITHOUT a routing prefix is sent through:
   *  - global profile: the configured mode, else `openrouter`. Behind the
   *    domestic-only wall there is no such default: GoApply's own mode, else a
   *    shared mode that names a mainland vendor, else '' (no route);
   *  - domestic profile: the brand's OWN provider only (its blob or
   *    CN_LLM_PROVIDER), else '' (a bare id then has no route). The shared
   *    provider mode is not used there: every selector GoApply reads from the
   *    shared stack arrives qualified, and a bare GoApply model id must never
   *    be sent through a provider it was not written for.
   */
  providerMode: string;
  /** The brand's default model selector. */
  model: string | undefined;
}

/** How a selector is routed for a brand: the one rule LLMService and the route checks share. */
export function getLlmRoutingDefaults(brand?: LlmBrandArg, env: EnvSource = process.env): LlmRoutingDefaults {
  const b = llmBrand(brand);
  const profile = effectiveLlmProfile(b, env);
  const provider = resolveProviderSetting(b, env);
  const model = getDefaultModel(b, env);
  if (profile === 'domestic_cn') {
    return { profile, providerMode: normalizeProviderType(provider.source === 'shared' ? '' : provider.value || ''), model };
  }
  const fallbackMode = llmDomesticOnlyApplies(b, env) ? '' : DEFAULT_PROVIDER_MODE;
  return { profile, providerMode: normalizeProviderType(provider.value || '') || fallbackMode, model };
}

/**
 * True when any routing setting of the brand (the provider mode or a model
 * key) comes from the shared stack, admin overrides included. For GoApply
 * that means some AI task is processed where RoboApply's is.
 * `brandUsesSharedStack` (platform/brand) sees the environment only; a
 * disclosure or consent decision ORs it with this.
 *
 * False behind the domestic-only wall, as in `brandUsesSharedStack`: every
 * route is a mainland one then, whichever variable names it, so nothing is
 * processed where RoboApply's prompts are.
 */
export function llmUsesSharedStack(brand?: LlmBrandArg, env: EnvSource = process.env): boolean {
  const b = llmBrand(brand);
  if (b.id === SHARED_STACK_BRAND) return true;
  if (llmDomesticOnlyApplies(b, env)) return false;
  const keys: ModelKey[] = ['defaultModel', 'fallbackModel', ...PURPOSE_KEYS];
  if (keys.some((key) => resolveModelKey(key, b, env).source === 'shared')) return true;
  // No provider of its own and no model of its own: every call uses the shared defaults.
  return effectiveLlmProfile(b, env) !== 'domestic_cn';
}

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
  /** The brand's own variable for the key (`CN_…` on GoApply). */
  envName: string;
  /** The shared variable GoApply falls back to; null for RoboApply (its own name is the shared one). */
  sharedEnvName: string | null;
  override: string | null; // the brand's own admin-set DB value (null = inherit)
  env: string | null; // what the brand's own variable provides
  /** What the shared stack provides (its blob, else its variable); null for RoboApply. */
  shared: string | null;
  /**
   * A shared value the domestic-only wall set aside for this brand because it
   * names no mainland vendor. It is never used: the key counts as unset.
   */
  sharedWalledOff: string | null;
  /** The selector that runs: override ?? env ?? shared, qualified or pinned where the header says. */
  effective: string | null;
  source: LlmSettingSource;
}

export function resolveModelKey(key: ModelKey, brand?: LlmBrandArg, env: EnvSource = process.env): ModelKeyResolution {
  const b = llmBrand(brand);
  const layers = layersOf(b, MODEL_ENV[key], pickModel(key), env);
  const envName = brandEnvName(b, MODEL_ENV[key]);
  return {
    key,
    envName,
    sharedEnvName: envName === MODEL_ENV[key] ? null : MODEL_ENV[key],
    override: layers.override ?? null,
    env: layers.env ?? null,
    shared: layers.shared ?? null,
    sharedWalledOff: layers.walledOff ?? null,
    effective: effectiveSelector(b, layers, env) ?? null,
    source: sourceOf(layers),
  };
}

/** Every model key resolved — for the admin page's effective-value display. */
export function getAllModelResolutions(brand?: LlmBrandArg, env: EnvSource = process.env): ModelKeyResolution[] {
  const keys: ModelKey[] = ['defaultModel', 'fallbackModel', ...PURPOSE_KEYS];
  return keys.map((k) => resolveModelKey(k, brand, env));
}
