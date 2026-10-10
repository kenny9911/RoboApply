/**
 * The brand of an LLM read or call that names no brand, and the LLM profile a
 * brand really runs on (owner ruling D5; GOAPPLY_PARITY_PLAN.md §3.3).
 *
 * Kept apart from llmModels.ts so callers (LLMService, llmSelector) can use
 * it without pulling in the model-settings module.
 */

import { BrandContextMissingError } from '../../platform/brand/brandContext.js';
import { brandStack, type EnvSource } from '../../platform/brand/brandEnv.js';
import { DEFAULT_BRAND, getBrand, type BrandId, type LlmProfile, type ProductBrand } from '../../platform/brand/registry.js';
import { allowedBrands, brandLock } from '../../platform/brand/runtime.js';
import { llmDomesticOnlyApplies } from '../../platform/llm/brandPolicy.js';
import { getCurrentBrandId } from '../requestContext.js';
import { getLlmStackSync } from './llmStackConfigResolver.js';
import { isDbConfigDisabled } from './llmStackConfigSchema.js';

function toBrand(brand: BrandId | ProductBrand): ProductBrand {
  return typeof brand === 'string' ? getBrand(brand) : brand;
}

/** The provider an admin set in the brand's own `llm_stack` blob, if any. */
function ownBlobProvider(brandId: BrandId): string | undefined {
  if (isDbConfigDisabled()) return undefined;
  const provider = getLlmStackSync(brandId).provider;
  return provider && provider.trim() ? provider.trim() : undefined;
}

/**
 * The LLM profile a brand runs on. RoboApply: its registry profile, always.
 * GoApply: `domestic_cn` only when it has a stack of its own, that is
 * `CN_LLM_PROVIDER` or `CN_LLM_MODEL` is set (`brandStack(brand, 'llm')` is
 * own) or an admin named a provider in the GoApply `llm_stack` blob. With
 * neither it is `global`: the same default provider, selector dialect, models
 * and fallback chain as RoboApply.
 *
 * The profile decides defaults and how a selector is read. It is NOT the
 * domestic-only wall: that is `CN_LLM_DOMESTIC_ONLY`, enforced on every route
 * by platform/llm/brandPolicy.ts whatever the profile is.
 */
export function effectiveLlmProfile(brand: BrandId | ProductBrand, env: EnvSource = process.env): LlmProfile {
  const b = toBrand(brand);
  if (b.llmProfile !== 'domestic_cn') return b.llmProfile;
  if (brandStack(b, 'llm', env) === 'own') return 'domestic_cn';
  return ownBlobProvider(b.id) ? 'domestic_cn' : 'global';
}

/**
 * The registry entry of a brand as the LLM layer sees it: `llmProfile` is the
 * effective one and `llmEnvPrefix` is '' while the brand runs on the shared
 * stack (so messages name the variables that are really read). Everything
 * else, the id included, is the brand's own: content safety, consent and
 * attribution still follow the real brand.
 */
export function llmCallBrand(brand: BrandId | ProductBrand, env: EnvSource = process.env): ProductBrand {
  const b = toBrand(brand);
  const llmProfile = effectiveLlmProfile(b, env);
  if (llmProfile === b.llmProfile) return b;
  return { ...b, llmProfile, llmEnvPrefix: '' };
}

/** The brand of the ambient unit of work, if any (never throws). */
function ambientBrandId(): BrandId | undefined {
  try {
    return getCurrentBrandId();
  } catch {
    return undefined; // a test that mocks requestContext without this export
  }
}

export interface ContextlessLlmBrand {
  brandId: BrandId;
  /** Where the id came from: the unit of work, this deployment's single brand, or the default. */
  source: 'context' | 'lock' | 'default';
}

/**
 * The brand of an LLM read or call that names no brand: the current unit of
 * work, else this deployment's single brand (BRAND_LOCK, or ALLOWED_BRANDS
 * with one entry), else the default. On a GoApply-only deployment a cron or
 * worker that forgot runWithBrand() therefore still routes as GoApply and
 * reads GoApply's own settings.
 */
export function contextlessLlmBrand(env: EnvSource = process.env): ContextlessLlmBrand {
  const ambient = ambientBrandId();
  if (ambient) return { brandId: ambient, source: 'context' };
  const lock = brandLock(env);
  if (lock) return { brandId: lock, source: 'lock' };
  return { brandId: DEFAULT_BRAND, source: 'default' };
}

/**
 * True when a brand of this deployment, other than the default one, would
 * route a prompt differently from the default brand because of a choice the
 * operator made: it has an LLM stack of its own (`effectiveLlmProfile` is not
 * the global one) or the domestic-only wall is on.
 */
function wrongGuessCrossesAWall(env: EnvSource): boolean {
  return allowedBrands(env).some(
    (id) => id !== DEFAULT_BRAND && (effectiveLlmProfile(id, env) !== 'global' || llmDomesticOnlyApplies(getBrand(id), env)),
  );
}

/**
 * Like contextlessLlmBrand, for the moment a prompt is about to be SENT.
 * Production serves both brands by default (D5), and on the shared stack both
 * route the same way, so a call with no brand completes as the default brand
 * (LLMService logs it once). It throws BrandContextMissingError only in
 * production when a wrong guess could cross a wall an operator chose: a brand
 * of this deployment has its own LLM stack, or `CN_LLM_DOMESTIC_ONLY` is on.
 * A GoApply user's prompt would then leave by the wrong route.
 *
 * A call made for a user must still run in that user's brand (runWithBrand or
 * the `brand` option): only there does a GoApply prompt pass the
 * content-safety filter.
 */
export function requireLlmCallBrand(env: EnvSource = process.env): ContextlessLlmBrand {
  const resolved = contextlessLlmBrand(env);
  if (resolved.source === 'default' && env.NODE_ENV === 'production' && wrongGuessCrossesAWall(env)) {
    throw new BrandContextMissingError();
  }
  return resolved;
}
