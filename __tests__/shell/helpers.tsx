// Shared helpers for the FND-6a shell tests: seed a brand and its resolved
// capability flags exactly the way the app does (BrandProvider +
// initialCapabilities), on top of the suite's renderWithProviders.

import type { ReactElement } from 'react';

import { BrandProvider } from '../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../lib/brand/client';
import type { BrandId } from '../../lib/brand/registry.generated';
import { FLAG_KEYS, type ResolvedFlags } from '../../server/src/platform/flags';
import { renderWithProviders } from '../utils/renderWithProviders';

/** Every flag false (fail closed), then the overrides. */
export function flagsWith(on: Partial<ResolvedFlags> = {}): ResolvedFlags {
  const all = Object.fromEntries(FLAG_KEYS.map((k) => [k, false])) as Record<string, boolean>;
  return { ...all, hiringContacts: 'off', ...on } as ResolvedFlags;
}

export function capsFor(brandId: BrandId, on: Partial<ResolvedFlags> = {}) {
  return { id: brandId, flags: flagsWith(on) };
}

export function renderWithBrand(
  ui: ReactElement,
  { brand = 'roboapply', flags = {} }: { brand?: BrandId; flags?: Partial<ResolvedFlags> | null } = {},
) {
  return renderWithProviders(
    <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={flags === null ? null : capsFor(brand, flags)}>
      {ui}
    </BrandProvider>,
  );
}
