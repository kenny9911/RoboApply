// extension/src/env.ts — build-time constants (scripts/build.mjs `define`).
//
// Unit tests run the sources without a build, so every constant has a safe
// default and tests may override them with `setBuildEnvForTests()`.

import { getExtBrand, type BrandId, type ExtBrandConfig } from './brands/index';

declare const __BRAND__: string | undefined;
declare const __DEV__: boolean | undefined;
declare const __API_ORIGIN__: string | undefined;
declare const __EXT_VERSION__: string | undefined;

export interface BuildEnv {
  brand: BrandId;
  dev: boolean;
  /** Origin every API call goes to (`<origin>/api/v1/...`). */
  apiOrigin: string;
  version: string;
}

function initial(): BuildEnv {
  const brand: BrandId = typeof __BRAND__ !== 'undefined' && __BRAND__ === 'goapply' ? 'goapply' : 'roboapply';
  const dev = typeof __DEV__ !== 'undefined' ? Boolean(__DEV__) : true;
  const cfg = getExtBrand(brand);
  const apiOrigin = typeof __API_ORIGIN__ !== 'undefined' && __API_ORIGIN__ ? __API_ORIGIN__ : dev ? cfg.devApiOrigin : cfg.apiOrigin;
  const version = typeof __EXT_VERSION__ !== 'undefined' && __EXT_VERSION__ ? __EXT_VERSION__ : '0.0.0-test';
  return { brand, dev, apiOrigin, version };
}

let current: BuildEnv = initial();

export function buildEnv(): BuildEnv {
  return current;
}

export function brandConfig(): ExtBrandConfig {
  return getExtBrand(current.brand);
}

/** Tests only. Returns a restore function. */
export function setBuildEnvForTests(patch: Partial<BuildEnv>): () => void {
  const prev = current;
  current = { ...current, ...patch };
  return () => {
    current = prev;
  };
}
