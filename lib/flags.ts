'use client';

// lib/flags.ts — capability flags on the client (TASK_PLAN.md R-04).
//
// The one resolver lives on the server (server/src/platform/flags.ts):
//   enabled(key) = requirements met (credentials, env, legal mode)
//                  AND (per-user override ?? FLAG_<BRAND>_<KEY> env ?? registry default)
// The browser never recomputes that. It reads the result:
//   - `GET /api/v1/public/brand` (any visitor; cached 5 min), and
//   - `/auth/me.flags` for a signed-in user (per-user beta overrides), which
//     the auth layer publishes with `useSetUserFlags()` (WP-10).
//
//   const showCoaching = useFlag('coaching');
//   const { flags, brand, status } = useCapabilities();
//
// **Fail closed.** Until the flags arrive (first render, SSR, a failed
// request), every boolean flag is false and `hiringContacts` is 'off'. A
// disabled feature has no UI entry (R-04), so a feature may appear a moment
// late but never shows when it is off.

import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';

import { PUBLIC_BRAND_PATH, roboApi } from './api/client';
import { useBrandRuntime } from './brand/BrandProvider';
import type { HiringContactsMode } from './brand/registry.generated';
import type { PublicBrand } from '../server/src/features/brand/contract';
import type { FlagKey, ResolvedFlags } from '../server/src/platform/flags';

export type { FlagKey, ResolvedFlags, PublicBrand, HiringContactsMode };

/** React Query key for the public brand payload of one brand. */
export function publicBrandQueryKey(brandId: string): readonly unknown[] {
  return ['brand', 'public', brandId] as const;
}

/** Five minutes, matching the API's Cache-Control (PUBLIC_BRAND_MAX_AGE_SEC). */
export const PUBLIC_BRAND_STALE_MS = 5 * 60 * 1000;

export type CapabilitiesStatus = 'loading' | 'ready' | 'error';

export interface CapabilitiesValue {
  /** Resolved flags (per-user when signed in), or null until known. */
  flags: ResolvedFlags | null;
  /** The public brand payload (configured auth methods, live rails, …), or null until known. */
  brand: PublicBrand | null;
  status: CapabilitiesStatus;
}

/**
 * The resolved capabilities of the current brand. Shares one cached request
 * per brand across the tree.
 */
export function useCapabilities(): CapabilitiesValue {
  const { brand, initialCapabilities, userFlags } = useBrandRuntime();
  const query = useQuery<PublicBrand>({
    queryKey: publicBrandQueryKey(brand.id),
    queryFn: () => roboApi.get<PublicBrand>(PUBLIC_BRAND_PATH),
    staleTime: PUBLIC_BRAND_STALE_MS,
    retry: 1,
    ...(initialCapabilities ? { initialData: initialCapabilities as unknown as PublicBrand } : {}),
  });

  const publicPayload = query.data ?? null;
  // Never trust a payload for another brand (a cached response from before a
  // dev override switch).
  const matchingPayload = publicPayload && publicPayload.id === brand.id ? publicPayload : null;
  const flags = (userFlags ?? matchingPayload?.flags ?? null) as ResolvedFlags | null;
  const status: CapabilitiesStatus = flags ? 'ready' : query.isError ? 'error' : 'loading';
  return { flags, brand: matchingPayload, status };
}

/** True only when the flag is resolved and on (fail closed). */
export function useFlag(key: FlagKey): boolean {
  const { flags } = useCapabilities();
  return flags?.[key] === true;
}

/** The hiring-contacts mode ('off' until known). */
export function useHiringContactsMode(): HiringContactsMode {
  const { flags } = useCapabilities();
  return flags?.hiringContacts ?? 'off';
}

/**
 * Publish (or clear, with null) the per-user flags from `/auth/me`. They take
 * precedence over the public payload because they include per-user beta
 * overrides. Call on sign-in/refresh and with null on sign-out.
 */
export function useSetUserFlags(): (flags: ResolvedFlags | null) => void {
  const { setUserFlags } = useBrandRuntime();
  return useCallback(
    (flags: ResolvedFlags | null) => setUserFlags(flags as Record<string, boolean | string> | null),
    [setUserFlags],
  );
}
