// server/src/features/jobs/sources/index.ts — the job-source adapter registry (WP-16b).
//
// Ingest (features/jobs/ingest) runs every registered adapter whose markets
// include the brand's market and whose provider the brand uses; which
// providers a brand uses is decided in ./registry.ts (one rule for ingest and
// the admin sources panel). The built-in adapters (RapidAPI search,
// recruiter-bank sync) are registered by ingest itself; the public employer
// boards register themselves here as `ats_public`:
//
//   import { registerSourceAdapter } from '../index.js';     // from sources/atsPublic/
//   registerSourceAdapter(atsPublicAdapter);
//
// One adapter per provider. Registering the same object twice is a no-op;
// registering a different adapter for a taken provider throws (no silent
// replacement), unless `{ replace: true }` (tests).

import type { Market } from '../../../platform/brand/index.js';
import type { IngestProvider, JobSourceAdapter } from './types.js';

export type {
  IngestOrigin,
  IngestProvider,
  IngestQueryParams,
  JobSourceAdapter,
  SourceCloseReason,
  SourceClosure,
  SourceFetchContext,
  SourceFetchResult,
  SourceListing,
  SourceQuery,
  SourceTransport,
} from './types.js';
export { jobProvidersEnvName, jobSourceKind, jobSourcesForBrand, resetJobSourceWarningsForTests, sourceProvidersForBrand } from './registry.js';
export type { JobSourceDescription, JobSourceKind, JobSourceStatus } from './registry.js';
// MKT-1C contracts the source phases (M3, M5) read from other areas: the adapter cost model and the
// per-market switch (./types.ts), and the identifying User-Agent (./userAgent.ts). Exported at the
// M1 gate because an area may import another area only through its index (features/boundary.test.ts).
export type { SourceCostModel } from './types.js';
export { adapterCostModel, adapterEnabledFor } from './types.js';
export { JOB_SOURCES_CONTACT_ENV, SOURCE_USER_AGENT_MAX, sourceUserAgent } from './userAgent.js';

const adapters = new Map<IngestProvider, JobSourceAdapter>();

export function registerSourceAdapter(adapter: JobSourceAdapter, options: { replace?: boolean } = {}): void {
  const existing = adapters.get(adapter.provider);
  if (existing && existing !== adapter && !options.replace) {
    throw new Error(`job source adapter for '${adapter.provider}' is already registered`);
  }
  adapters.set(adapter.provider, adapter);
}

export function getSourceAdapter(provider: IngestProvider): JobSourceAdapter | null {
  return adapters.get(provider) ?? null;
}

/** Every registered adapter, in registration order. */
export function registeredSourceAdapters(): JobSourceAdapter[] {
  return [...adapters.values()];
}

/** Registered adapters that may serve a market. */
export function sourceAdaptersForMarket(market: Market): JobSourceAdapter[] {
  return registeredSourceAdapters().filter((a) => a.markets.includes(market));
}

/** Test seam. */
export function resetSourceAdaptersForTests(): void {
  adapters.clear();
}
