/**
 * The brand of an LLM read or call that names no brand (WP-14, R-13).
 *
 * Kept apart from llmModels.ts so callers (LLMService, llmSelector) can use
 * it without pulling in the model-settings module.
 */

import { BrandContextMissingError } from '../../platform/brand/brandContext.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { DEFAULT_BRAND, type BrandId } from '../../platform/brand/registry.js';
import { allowedBrands, brandLock } from '../../platform/brand/runtime.js';
import { getCurrentBrandId } from '../requestContext.js';

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
 * never reaches the international stack (R-13).
 */
export function contextlessLlmBrand(env: EnvSource = process.env): ContextlessLlmBrand {
  const ambient = ambientBrandId();
  if (ambient) return { brandId: ambient, source: 'context' };
  const lock = brandLock(env);
  if (lock) return { brandId: lock, source: 'lock' };
  return { brandId: DEFAULT_BRAND, source: 'default' };
}

/**
 * Like contextlessLlmBrand, for the moment a prompt is about to be SENT. In
 * production, on a deployment that serves GoApply alongside another brand, a
 * call with no brand cannot be attributed safely: it throws
 * BrandContextMissingError rather than route a possible GoApply user's prompt
 * through the RoboApply stack. Elsewhere it returns the same answer.
 */
export function requireLlmCallBrand(env: EnvSource = process.env): ContextlessLlmBrand {
  const resolved = contextlessLlmBrand(env);
  if (
    resolved.source === 'default' &&
    env.NODE_ENV === 'production' &&
    allowedBrands(env).some((id) => id !== DEFAULT_BRAND)
  ) {
    throw new BrandContextMissingError();
  }
  return resolved;
}
