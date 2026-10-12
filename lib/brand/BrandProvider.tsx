'use client';

// lib/brand/BrandProvider.tsx
//
// Client brand context (ARCHITECTURE.md §1.5). app/layout.tsx resolves the
// brand on the server (lib/server/brand.ts → the proxy's `x-ra-brand`) and
// hands `publicBrand(brand)` to <Providers>, which wraps the tree in this.
//
//   const brand = useBrand();   // { id, name, market, locales, assets, … }
//
// Outside a provider (unit tests that render a component bare) useBrand()
// returns RoboApply, the default brand, instead of throwing, so existing
// tests keep working.
//
// Capability flags are NOT on the brand: use `useFlag(key)` from lib/flags.ts.
// This provider only carries the state those hooks share: optional seeded
// capabilities (SSR, tests) and the per-user flags `/auth/me` returns.

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { clientBrandFor, type ClientBrand } from './client';
import type { BrandId } from './registry.generated';

/**
 * The public capability payload (`GET /api/v1/public/brand`) or the resolved
 * per-user flags from `/auth/me`. Kept structural here so this module does not
 * depend on the server contract; lib/flags.ts types it precisely.
 */
export interface SeedCapabilities {
  flags: Record<string, boolean | string>;
  [key: string]: unknown;
}

export interface BrandRuntimeValue {
  brand: ClientBrand;
  /** Seeded public capabilities (SSR or tests); null = fetch on the client. */
  initialCapabilities: SeedCapabilities | null;
  /** Per-user resolved flags from `/auth/me` (WP-10 publishes them); null until known. */
  userFlags: Record<string, boolean | string> | null;
  setUserFlags: (flags: Record<string, boolean | string> | null) => void;
}

const DEFAULT_VALUE: BrandRuntimeValue = {
  brand: clientBrandFor(),
  initialCapabilities: null,
  userFlags: null,
  setUserFlags: () => {},
};

const BrandContext = createContext<BrandRuntimeValue | null>(null);

export interface BrandProviderProps {
  brand: ClientBrand;
  /** Seed for `useCapabilities()` (skips the first fetch while fresh). */
  initialCapabilities?: SeedCapabilities | null;
  children: ReactNode;
}

export function BrandProvider({ brand, initialCapabilities = null, children }: BrandProviderProps) {
  const [userFlags, setUserFlags] = useState<Record<string, boolean | string> | null>(null);
  const value = useMemo<BrandRuntimeValue>(
    () => ({ brand, initialCapabilities, userFlags, setUserFlags }),
    [brand, initialCapabilities, userFlags],
  );
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

/** The current brand (RoboApply outside a provider). */
export function useBrand(): ClientBrand {
  return (useContext(BrandContext) ?? DEFAULT_VALUE).brand;
}

/** The current brand id. */
export function useBrandId(): BrandId {
  return useBrand().id;
}

/** Internal: the shared runtime state lib/flags.ts reads. */
export function useBrandRuntime(): BrandRuntimeValue {
  return useContext(BrandContext) ?? DEFAULT_VALUE;
}
