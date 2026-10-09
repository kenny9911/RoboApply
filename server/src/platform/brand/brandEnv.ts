// server/src/platform/brand/brandEnv.ts
//
// The one per-brand env rule (TASK_PLAN.md R-03, CN_TW_LAUNCH_PLAN.md §2.2):
//   brandEnv(roboapply, 'S3_BUCKET') → process.env.S3_BUCKET
//   brandEnv(goapply,   'S3_BUCKET') → process.env.CN_S3_BUCKET
// There is NO fallback from CN_X to X. That single rule is what stops a
// missing CN_S3_BUCKET from sending mainland resumes to the intl bucket.
//
// Applies to cookie domain, email From, S3, LiveKit, LLM routing, score and
// assistant budgets, system user id and similar per-brand settings.
// Vendor-only keys stay unprefixed and are read directly
// (DEEPSEEK_API_KEY, DASHSCOPE_API_KEY, WECHAT_*, WECHATPAY_*, ALIYUN_*).

import { getBrand, type BrandId, type ProductBrand } from './registry.js';

export type EnvSource = Record<string, string | undefined>;

function toBrand(brand: BrandId | ProductBrand): ProductBrand {
  return typeof brand === 'string' ? getBrand(brand) : brand;
}

/** The env variable name a brand reads for `name` (`CN_` prefix for GoApply). */
export function brandEnvName(brand: BrandId | ProductBrand, name: string): string {
  if (!name || name !== name.toUpperCase() || name.startsWith('CN_')) {
    throw new Error(`brandEnv: pass the unprefixed UPPER_SNAKE name, got "${name}"`);
  }
  return toBrand(brand).market === 'cn' ? `CN_${name}` : name;
}

/** Trimmed value, or undefined when unset or blank. Never falls back across brands. */
export function brandEnv(
  brand: BrandId | ProductBrand,
  name: string,
  env: EnvSource = process.env,
): string | undefined {
  const raw = env[brandEnvName(brand, name)];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/** 'true' | '1' | 'yes' | 'on' (case-insensitive) → true. Unset → `fallback`. */
export function brandEnvFlag(
  brand: BrandId | ProductBrand,
  name: string,
  fallback = false,
  env: EnvSource = process.env,
): boolean {
  const v = brandEnv(brand, name, env);
  if (v === undefined) return fallback;
  return parseBoolEnv(v);
}

export function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** Non-empty after trimming. */
export function envSet(env: EnvSource, ...names: string[]): boolean {
  return names.every((n) => {
    const v = env[n];
    return typeof v === 'string' && v.trim().length > 0;
  });
}
