// server/src/platform/billing/origins.ts
//
// Brand-aware origins for payment redirects and provider callbacks
// (TASK_PLAN.md WP-21a: rail and URLs from the brand, never from `?region=`).
//   appOrigin:      where the user returns after paying (the brand's web app).
//   callbackOrigin: where a payment worker posts its notify (the brand's API).
// RoboApply keeps the env names it already uses (NEXT_PUBLIC_ROBOAPPLY_URL /
// ROBOAPPLY_URL, BACKEND_URL); GoApply reads only `CN_` names (R-03, no
// fallback to the international ones).

import { brandEnv, type EnvSource } from '../brand/brandEnv.js';
import type { ProductBrand } from '../brand/registry.js';

function trimSlash(v: string): string {
  return v.replace(/\/+$/, '');
}

export function appOrigin(brand: ProductBrand, env: EnvSource = process.env): string {
  if (brand.market === 'cn') return trimSlash(brandEnv(brand, 'CANONICAL_ORIGIN', env) || brand.canonicalOrigin);
  return trimSlash(
    env.NEXT_PUBLIC_ROBOAPPLY_URL?.trim() || env.ROBOAPPLY_URL?.trim() || brandEnv(brand, 'CANONICAL_ORIGIN', env) || brand.canonicalOrigin,
  );
}

export function callbackOrigin(brand: ProductBrand, env: EnvSource = process.env): string {
  return trimSlash(brandEnv(brand, 'BACKEND_URL', env) || brand.canonicalOrigin);
}

/**
 * A caller-supplied return path, only when it is a same-origin relative path
 * (starts with one '/', no scheme, no backslash). Anything else → undefined.
 */
export function safeReturnPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const p = raw.trim();
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('://') || p.includes('\\')) return undefined;
  return p.slice(0, 200);
}

export function withQueryParam(path: string, key: string, value: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${key}=${value}`;
}
