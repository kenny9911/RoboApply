// server/src/features/jobs/ingest/providers.ts — which sources a brand's ingest runs (ARCH §4.2).
//
//   RoboApply (intl): activejobs (10) → bank_robohire (15) → linkedin (20) → jsearch (30)
//                     + any registered adapter for the market (WP-42's ats_public)
//   GoApply   (cn):   bank_gohire (15); CN_EXTERNAL_PROVIDERS=jsearch adds JSearch
//                     with country=cn for testing only. Never scraped boards.
// `user_import` is not an ingest source (WP-35 writes those rows).

import type { EnvSource, ProductBrand } from '../../../platform/brand/index.js';
import { getSourceAdapter, registerSourceAdapter, sourceAdaptersForMarket } from '../sources/index.js';
import type { IngestProvider, JobSourceAdapter } from '../sources/index.js';
import { createBankAdapter } from './adapters/bank.js';
import { createRapidApiAdapter } from './adapters/rapidApi.js';
import { cnExternalProviders } from './config.js';

let builtinsRegistered = false;

/** Registers the built-in adapters once (idempotent). */
export function ensureBuiltinAdapters(): void {
  if (builtinsRegistered && getSourceAdapter('activejobs')) return;
  for (const adapter of [
    createRapidApiAdapter('activejobs'),
    createRapidApiAdapter('linkedin'),
    createRapidApiAdapter('jsearch'),
    createBankAdapter('robohire'),
    createBankAdapter('gohire'),
  ]) {
    if (!getSourceAdapter(adapter.provider)) registerSourceAdapter(adapter);
  }
  builtinsRegistered = true;
}

/** Providers the brand's ingest uses, in priority order. */
export function ingestProvidersForBrand(brand: ProductBrand, env: EnvSource = process.env): IngestProvider[] {
  const out: IngestProvider[] = brand.jobProviders.filter((p) => p !== 'user_import');
  if (brand.market === 'cn') for (const p of cnExternalProviders(env)) if (!out.includes(p)) out.push(p);
  return out;
}

/**
 * Registered adapters for the brand: its own providers first (registry
 * order), then extra adapters registered for the market (ats_public).
 */
export function adaptersForBrand(brand: ProductBrand, env: EnvSource = process.env): JobSourceAdapter[] {
  ensureBuiltinAdapters();
  const wanted = ingestProvidersForBrand(brand, env);
  const own = wanted.map((p) => getSourceAdapter(p)).filter((a): a is JobSourceAdapter => !!a && a.markets.includes(brand.market));
  const builtin = new Set<IngestProvider>(['activejobs', 'linkedin', 'jsearch', 'bank_robohire', 'bank_gohire', 'user_import']);
  const extra = sourceAdaptersForMarket(brand.market).filter((a) => !builtin.has(a.provider) && !own.includes(a));
  return [...own, ...extra];
}

/** Test seam. */
export function resetBuiltinAdaptersForTests(): void {
  builtinsRegistered = false;
}
