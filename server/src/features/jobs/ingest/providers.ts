// server/src/features/jobs/ingest/providers.ts — which sources a brand's ingest runs
// (ARCH §4.2; GOAPPLY_PARITY_PLAN.md §3.9; MARKET_STRATEGY M-2, M-6, JI-7, JC-6).
//
// The list itself is the job source registry's (../sources/registry.ts):
//
//   RoboApply (intl): activejobs (10) → bank_robohire (15) → jsearch (30)
//                     + adapters registered for the market (ats_public, the
//                     Taiwan open data, the licensed feed `activejobs_feed`)
//   GoApply   (cn):   bank_gohire + adapters registered for the market
//                     (ats_public: employer-board postings in mainland China;
//                     `activejobs_feed`) + Active Jobs DB's search adapter.
//                     JSearch can never be a GoApply source (MARKET_STRATEGY
//                     M-6), and LinkedIn is a source of no brand (M-4). Never
//                     scraped boards.
//
// Active Jobs DB for the mainland (JC-6, finding K7). The brand registry
// (platform/brand/registry.ts, which no change may edit) lists `activejobs`
// for RoboApply only, and the source registry lets a built-in provider join a
// brand only through that list. The rule that lets it reach GoApply lives
// here: a built-in adapter registered for the brand's market is one of the
// brand's sources even when the brand's own list does not name it, except
// `jsearch` and `linkedin` for market cn.
//
// A source behind a plan. A metered source the brand's own list does not name
// (`activejobs_feed` on both brands, `activejobs` on GoApply) is there because
// of a paid plan, not because the brand always has it. Such a source is:
//   - always DESCRIBED (`sourcesForBrand`): the admin panels show it with its
//     state, 'gated' until the plan allows at least 20,000 postings a month;
//   - an ingest ADAPTER of the brand (`adaptersForBrand`) only while it is on
//     for the brand's market. While its gate is closed nothing is planned or
//     leased for it and maintenance does not see it, so a deployment without
//     a paid plan plans, leases and reports exactly what it did before;
//   - still a SOURCE of the brand while its gate is closed
//     (`knownIngestProvidersForBrand`): the planner retires the queries of a
//     provider the brand does not have, never those of one that is waiting
//     for its gate. A gate that is closed for an hour (the month's quota
//     spent, a process that asked before it loaded the stored quota reading)
//     must not switch the feed's standing query off for a day.
//
// The gate reads the quota reading this process holds in memory (../quota.ts
// `feedGate`). A caller that lists a brand's adapters for a run loads the
// stored reading first (`hydrateProviderQuota`), or a new process answers
// "no plan size known" for a plan another process read.
//
// JOB_PROVIDERS_<BRAND> narrows a brand's list (a subset only).
// `user_import` is not an ingest source (job import writes those rows).
//
// Five lists, one rule each:
//   sourcesForBrand         every source of the brand as the registry
//                           describes it, on or off (the admin panels).
//   adaptersForBrand        every adapter the brand's ingest knows. A source
//                           of the brand's own list is in it on or off: the
//                           planner and maintenance must know a source that is
//                           off (its queries are left alone, not retired, and
//                           it is reported as skipped). A source behind a
//                           plan is in it only while it is on (above).
//   knownIngestProvidersForBrand
//                           the ids of every ingest source the brand has, on
//                           or off, a source behind a closed gate included:
//                           what the planner may not retire.
//   planAdaptersOnNow       the brand's sources behind a plan that are on at
//                           the moment of asking. The planner completes the
//                           list it was handed with these, so a list made
//                           before the stored quota reading was loaded cannot
//                           make it plan as if the feed were off (and buy SEO
//                           seeds on the search adapter for a day).
//   listEnabledAdaptersFor  the ones that are on for the brand's market right
//                           now (`adapterEnabledFor`: key present, kill switch
//                           off, quota gate open). Whoever is about to CALL a
//                           source takes this one: the ingest tick and the
//                           targeted ingest of one search profile.

import type { EnvSource, JobProvider, ProductBrand } from '../../../platform/brand/index.js';
import { adapterEnabledFor, getSourceAdapter, jobProvidersNarrowedTo, jobSourcesForBrand, registerSourceAdapter } from '../sources/index.js';
import type { IngestProvider, JobSourceAdapter, JobSourceDescription } from '../sources/index.js';
import { createBankAdapter } from './adapters/bank.js';
import { FEED_PROVIDER, createFantasticFeedAdapter } from './adapters/fantasticFeed.js';
import { createRapidApiAdapter } from './adapters/rapidApi.js';

let builtinsRegistered = false;

/** Registers the built-in adapters once (idempotent). */
export function ensureBuiltinAdapters(): void {
  if (builtinsRegistered && getSourceAdapter('activejobs') && getSourceAdapter(FEED_PROVIDER)) return;
  for (const adapter of [
    createRapidApiAdapter('activejobs'),
    createFantasticFeedAdapter(),
    createRapidApiAdapter('jsearch'),
    createBankAdapter('robohire'),
    createBankAdapter('gohire'),
  ]) {
    if (!getSourceAdapter(adapter.provider)) registerSourceAdapter(adapter);
  }
  builtinsRegistered = true;
}

/**
 * Built-in providers that may join a brand through their adapter's market
 * although the brand's own list does not name them (the header's K7 rule).
 */
const MARKET_BUILTINS: readonly JobProvider[] = ['activejobs', 'jsearch'];

/** Never a source of market cn, whatever is registered or set (MARKET_STRATEGY M-6, M-4, §1.6). */
const NEVER_MAINLAND: ReadonlySet<string> = new Set(['jsearch', 'linkedin']);

/**
 * The brand as the source registry must see it: its own list, plus the
 * built-in providers whose registered adapter serves the brand's market. The
 * narrowing variable still applies to the result (it narrows, it never adds),
 * and the brand registry itself is not touched.
 */
function withMarketBuiltins(brand: ProductBrand, env: EnvSource): ProductBrand {
  const own = brand.jobProviders as readonly string[];
  const narrow = jobProvidersNarrowedTo(brand.id, env);
  const extra = MARKET_BUILTINS.filter((id) => {
    if (own.includes(id)) return false;
    if (brand.market === 'cn' && NEVER_MAINLAND.has(id)) return false;
    if (narrow && !narrow.includes(id)) return false;
    return getSourceAdapter(id)?.markets.includes(brand.market) === true;
  });
  if (extra.length === 0) return brand;
  // Ingest sources first, the user's own import last (as the brand lists it).
  const ingest = own.filter((p) => p !== 'user_import');
  const rest = own.filter((p) => p === 'user_import');
  return { ...brand, jobProviders: [...ingest, ...extra, ...rest] as ProductBrand['jobProviders'] };
}

/** The licensed feed directly after the search adapter of the same plan (they address the same rows); every other source keeps its place. */
function feedAfterSearch<T extends { provider: IngestProvider }>(sources: T[]): T[] {
  const feed = sources.find((s) => s.provider === FEED_PROVIDER);
  const search = sources.findIndex((s) => s.provider === 'activejobs');
  if (!feed || search < 0) return sources;
  const rest = sources.filter((s) => s !== feed);
  rest.splice(rest.findIndex((s) => s.provider === 'activejobs') + 1, 0, feed);
  return rest;
}

/** The brand's sources as the registry describes them, with the built-in adapters registered (admin sources panel). On or off: a source behind a plan is listed with its state. */
export function sourcesForBrand(brand: ProductBrand, env: EnvSource = process.env): JobSourceDescription[] {
  ensureBuiltinAdapters();
  return feedAfterSearch(jobSourcesForBrand(withMarketBuiltins(brand, env), env));
}

/**
 * Is the source there because of a paid plan rather than because the brand
 * always has it? A metered source the brand's own list does not name.
 */
function behindPlan(source: JobSourceDescription, brand: ProductBrand): boolean {
  return source.costModel !== 'free' && !(brand.jobProviders as readonly string[]).includes(source.provider);
}

/**
 * The sources the brand's ingest knows, in order: every source of the brand
 * except the user's own import, and except a source behind a plan that is not
 * on for the brand's market right now (see the header).
 */
function ingestSources(brand: ProductBrand, env: EnvSource): JobSourceDescription[] {
  return sourcesForBrand(brand, env).filter((source) => {
    if (source.kind === 'import') return false;
    if (!behindPlan(source, brand)) return true;
    return !!source.adapter && adapterEnabledFor(source.adapter, brand.market);
  });
}

/**
 * Every ingest source the brand has, on or off, whose adapter is registered
 * for the brand's market (never `user_import`). Unlike `adaptersForBrand` it
 * holds a source behind a plan while its gate is closed. A provider narrowed
 * away by JOB_PROVIDERS_<BRAND>, one of another market and one no brand has
 * (`linkedin`; `jsearch` for the mainland) are not in it.
 */
export function knownIngestProvidersForBrand(brand: ProductBrand, env: EnvSource = process.env): IngestProvider[] {
  return sourcesForBrand(brand, env)
    .filter((source) => source.kind !== 'import' && !!source.adapter)
    .map((source) => source.provider);
}

/**
 * The adapters of the brand's sources behind a plan that are on for its
 * market right now (the licensed feed; Active Jobs DB for the mainland). The
 * same answer `adaptersForBrand` gives for them, asked at this moment.
 */
export function planAdaptersOnNow(brand: ProductBrand, env: EnvSource = process.env): JobSourceAdapter[] {
  return sourcesForBrand(brand, env)
    .filter((source) => source.kind !== 'import' && behindPlan(source, brand) && !!source.adapter && adapterEnabledFor(source.adapter, brand.market))
    .map((source) => source.adapter)
    .filter((a): a is JobSourceAdapter => !!a);
}

/** Providers the brand's ingest uses, in priority order (never `user_import`; a source behind a plan only while it is on). */
export function ingestProvidersForBrand(brand: ProductBrand, env: EnvSource = process.env): IngestProvider[] {
  return ingestSources(brand, env).map((source) => source.provider);
}

/**
 * Registered adapters the brand's ingest knows: its own providers first
 * (registry order), then the adapters registered for its market (ats_public).
 * A source behind a plan is in the list only while it is on for the brand's
 * market (see the header). An adapter of another market is never returned,
 * whatever a list says; `jsearch` never for market cn.
 */
export function adaptersForBrand(brand: ProductBrand, env: EnvSource = process.env): JobSourceAdapter[] {
  return ingestSources(brand, env)
    .map((source) => source.adapter)
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
