// server/src/features/jobs/ingest/providers.ts — which sources a brand's ingest runs
// (ARCH §4.2; GOAPPLY_PARITY_PLAN.md §3.9).
//
// The list itself is the job source registry's (../sources/registry.ts):
//
//   RoboApply (intl): activejobs (10) → bank_robohire (15) → jsearch (30)
//                     + adapters registered for the market (ats_public)
//   GoApply   (cn):   bank_gohire + adapters registered for the market
//                     (ats_public: employer-board postings in mainland China).
//                     No search provider: the RapidAPI adapters serve market
//                     intl only, so JSearch can never be a GoApply source
//                     (MARKET_STRATEGY M-6). Never scraped boards.
//
// JOB_PROVIDERS_<BRAND> narrows a brand's list (a subset only).
// `user_import` is not an ingest source (job import writes those rows).
// This module registers the built-in adapters and hands ingest the adapters
// of a brand; it adds no rule of its own.
//
// Two lists, one rule each:
//   adaptersForBrand        every adapter the brand has, on or off. The planner
//                           and maintenance take this one: they must know a
//                           source that is off (its queries are left alone,
//                           not retired, and it is reported as skipped).
//   listEnabledAdaptersFor  the ones that are on for the brand's market right
//                           now (`adapterEnabledFor`: key present, kill switch
//                           off, quota gate open). Whoever is about to CALL a
//                           source takes this one: the ingest tick and the
//                           targeted ingest of one search profile.

import type { EnvSource, ProductBrand } from '../../../platform/brand/index.js';
import { adapterEnabledFor, getSourceAdapter, jobSourcesForBrand, registerSourceAdapter, sourceProvidersForBrand } from '../sources/index.js';
import type { IngestProvider, JobSourceAdapter, JobSourceDescription } from '../sources/index.js';
import { createBankAdapter } from './adapters/bank.js';
import { createRapidApiAdapter } from './adapters/rapidApi.js';

let builtinsRegistered = false;

/** Registers the built-in adapters once (idempotent). */
export function ensureBuiltinAdapters(): void {
  if (builtinsRegistered && getSourceAdapter('activejobs')) return;
  for (const adapter of [
    createRapidApiAdapter('activejobs'),
    createRapidApiAdapter('jsearch'),
    createBankAdapter('robohire'),
    createBankAdapter('gohire'),
  ]) {
    if (!getSourceAdapter(adapter.provider)) registerSourceAdapter(adapter);
  }
  builtinsRegistered = true;
}

/** Providers the brand's ingest uses, in priority order (the registry list without `user_import`). */
export function ingestProvidersForBrand(brand: ProductBrand, env: EnvSource = process.env): IngestProvider[] {
  return sourceProvidersForBrand(brand, env).filter((p) => p !== 'user_import');
}

/** The brand's sources as the registry describes them, with the built-in adapters registered (admin sources panel). */
export function sourcesForBrand(brand: ProductBrand, env: EnvSource = process.env): JobSourceDescription[] {
  ensureBuiltinAdapters();
  return jobSourcesForBrand(brand, env);
}

/**
 * Registered adapters for the brand: its own providers first (registry
 * order), then the adapters registered for its market (ats_public). An
 * adapter of another market is never returned, whatever a list says.
 */
export function adaptersForBrand(brand: ProductBrand, env: EnvSource = process.env): JobSourceAdapter[] {
  return sourcesForBrand(brand, env)
    .map((s) => s.adapter)
    .filter((a): a is JobSourceAdapter => !!a);
}

/**
 * The brand's adapters that are on for its market right now, in registry
 * order. An adapter that serves two markets and is on for the other one only
 * is not in the list.
 */
export function listEnabledAdaptersFor(brand: ProductBrand, env: EnvSource = process.env): JobSourceAdapter[] {
  return adaptersForBrand(brand, env).filter((a) => adapterEnabledFor(a, brand.market));
}

/** Test seam. */
export function resetBuiltinAdaptersForTests(): void {
  builtinsRegistered = false;
}
