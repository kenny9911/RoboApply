// server/src/features/jobs/sources/registry.ts — the per-brand job source registry
// (GOAPPLY_PARITY_PLAN.md §3.9; MARKET_STRATEGY M-3, M-4, M-6, JI-2, JC-7).
//
// One place answers "which sources feed this brand, how, what a call costs,
// and are they on":
//
//   RoboApply (intl): activejobs → bank_robohire → jsearch (the brand registry's
//                     order) + adapters registered for the market: ats_public,
//                     the Taiwan open data (tw_open_data, tw_gov_jobs), usajobs
//                     and the licensed feed activejobs_feed (behind its plan
//                     gate)
//   GoApply   (cn):   bank_gohire + adapters registered for the market:
//                     ats_public (employer-board postings located in mainland
//                     China), and Active Jobs DB as a search (activejobs) and
//                     as the licensed feed (activejobs_feed), both behind the
//                     plan gate (JC-6; the rule is ingest/providers.ts). JSearch
//                     and LinkedIn never serve market cn.
//   both:             user_import (a user's own import; not an ingest source)
//
// The provider list is `brand.jobProviders` plus the adapters registered for
// the brand's market, optionally narrowed by JOB_PROVIDERS_<BRAND> (a comma
// list; a subset only: a name the brand does not have is ignored, with one
// warning). CN_EXTERNAL_PROVIDERS is no longer read (one warning when set).
//
// Each source states its cost model (`costModel`: free, per job, per request;
// sources/types.ts `adapterCostModel`). The planner never spends a per-request
// source on SEO seed queries, and the admin console shows the model.
// A source is on for a brand when its adapter says so for the brand's MARKET
// (`adapterEnabledFor`): an adapter that serves two markets may be on for one.
//
// The capability is the same on both brands (feed, search over our own index,
// alerts, similar jobs); only the rows differ. Ingest (features/jobs/ingest)
// and the admin sources panel both read this module, so they cannot disagree.

import type { BrandId, EnvSource, JobProvider, Market, ProductBrand } from '../../../platform/brand/index.js';
import { logger } from '../../../services/LoggerService.js';
import { getSourceAdapter, sourceAdaptersForMarket } from './index.js';
import { adapterCostModel, adapterEnabledFor } from './types.js';
import type { IngestProvider, JobSourceAdapter, SourceCostModel, SourceTransport } from './types.js';

export type JobSourceKind = 'bank' | 'search' | 'ats' | 'import';

/**
 * Providers the brand registry governs: a brand has one only when its
 * `jobProviders` lists it. Any other registered adapter (ats_public) joins a
 * brand through its market.
 */
const REGISTRY_PROVIDERS: ReadonlySet<IngestProvider> = new Set<JobProvider>([
  'activejobs',
  'jsearch',
  'bank_robohire',
  'bank_gohire',
  'user_import',
]);

/**
 * Provider ids that are a source of no brand, whatever a brand list names or
 * an adapter registers: the LinkedIn feed (MARKET_STRATEGY M-4: dropped, not
 * subscribed and not to be). Plain strings, so the rule does not depend on the
 * id staying in the provider unions.
 */
const DROPPED_PROVIDERS: ReadonlySet<string> = new Set(['linkedin']);

/**
 * The kind of every provider ingest knows. A kind says how the source is fed
 * and which panel of the admin console describes it (the web contract has
 * these four): 'bank' a recruiter bank, 'ats' the employer boards, 'import' a
 * user's own import, 'search' every other source read through an API (a
 * search service, the licensed feed, a government job API or open data).
 * How such a source is reached is its transport, below.
 */
const KIND: Readonly<Partial<Record<IngestProvider, JobSourceKind>>> = {
  activejobs: 'search',
  activejobs_feed: 'search',
  jsearch: 'search',
  usajobs: 'search',
  tw_open_data: 'search',
  tw_gov_jobs: 'search',
  bank_robohire: 'bank',
  bank_gohire: 'bank',
  ats_public: 'ats',
  user_import: 'import',
};

export function jobSourceKind(provider: IngestProvider): JobSourceKind {
  return KIND[provider] ?? 'search';
}

/**
 * How a provider is reached when its adapter does not say (`transport()`):
 * the government sources answer on their own public API, never through the
 * search marketplace.
 */
const TRANSPORT: Readonly<Partial<Record<IngestProvider, SourceTransport>>> = {
  usajobs: 'api',
  tw_open_data: 'api',
  tw_gov_jobs: 'api',
  user_import: 'off',
};

/** The default transport of a provider: its own entry, else by kind (boards, bank database, search marketplace). */
export function jobSourceTransport(provider: IngestProvider): SourceTransport {
  const own = TRANSPORT[provider];
  if (own) return own;
  const kind = jobSourceKind(provider);
  if (kind === 'ats') return 'board_api';
  if (kind === 'bank') return 'db';
  return 'rapidapi';
}

/** `JOB_PROVIDERS_ROBOAPPLY` / `JOB_PROVIDERS_GOAPPLY`. */
export function jobProvidersEnvName(brand: BrandId): string {
  return `JOB_PROVIDERS_${brand.toUpperCase()}`;
}

const warned = new Set<string>();

function warnOnce(key: string, message: string, meta: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn('JOB_SOURCES', message, meta);
}

function listEnv(env: EnvSource, name: string): string[] | null {
  const raw = env[name];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * What JOB_PROVIDERS_<BRAND> narrows the brand's sources to (lower case), or
 * null when the variable is unset or empty: the brand then has every source of
 * its list. The one reading of the variable: `sourceProvidersForBrand` filters
 * with it, and a run that does not go through a brand's adapter list (the
 * employer-board sync, which reads a board once for both brands) asks it
 * before it writes a brand's market.
 */
export function jobProvidersNarrowedTo(brand: BrandId, env: EnvSource = process.env): string[] | null {
  return listEnv(env, jobProvidersEnvName(brand));
}

/**
 * Every provider of the brand, in order: its registry list (user_import
 * included), then the adapters registered for its market; never a dropped
 * provider. Narrowed by JOB_PROVIDERS_<BRAND> when that is set (user_import
 * is never narrowed: it is not an ingest source).
 */
export function sourceProvidersForBrand(brand: ProductBrand, env: EnvSource = process.env): IngestProvider[] {
  const own: IngestProvider[] = [...brand.jobProviders];
  const extra = sourceAdaptersForMarket(brand.market)
    .map((a) => a.provider)
    .filter((p) => !REGISTRY_PROVIDERS.has(p) && !own.includes(p));
  const all = [...own, ...extra].filter((p) => !DROPPED_PROVIDERS.has(p));

  if (typeof env.CN_EXTERNAL_PROVIDERS === 'string' && env.CN_EXTERNAL_PROVIDERS.trim()) {
    warnOnce('cn_external_providers', 'CN_EXTERNAL_PROVIDERS is no longer read: GoApply has no search provider. Remove it.', {
      use: `${jobProvidersEnvName('goapply')} narrows the GoApply source list`,
    });
  }

  const name = jobProvidersEnvName(brand.id);
  const narrow = jobProvidersNarrowedTo(brand.id, env);
  if (!narrow) return all;
  const unknown = narrow.filter((p) => !all.includes(p as IngestProvider));
  if (unknown.length) {
    warnOnce(`${name}:${unknown.join(',')}`, `${name} names sources this brand does not have; they are ignored (the variable narrows, it never adds)`, {
      ignored: unknown,
      available: all.filter((p) => p !== 'user_import'),
    });
  }
  return all.filter((p) => p === 'user_import' || narrow.includes(p));
}

export interface JobSourceStatus {
  enabled: boolean;
  transport: SourceTransport;
  /** Short code for why the source is off ('not_registered', 'wrong_market', 'tls_required' …), else null. */
  reason: string | null;
}

/** One source of one brand. */
export interface JobSourceDescription {
  brand: BrandId;
  market: Market;
  provider: IngestProvider;
  kind: JobSourceKind;
  /** How the source is reached right now ('off' when it is not reachable at all). */
  transport: SourceTransport;
  /**
   * What a call to the source costs: the adapter's declared model, else the
   * default for the provider id ('free' for a user's own import). Known for a
   * source whose adapter is not registered too.
   */
  costModel: SourceCostModel;
  /** RAJob.sourceBoard values the source writes (empty for user_import). */
  sourceBoards: readonly string[];
  /** The registered adapter, when the source is an ingest source of this market. */
  adapter: JobSourceAdapter | null;
  enabled(): boolean;
  status(): JobSourceStatus;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function describe(brand: ProductBrand, provider: IngestProvider): JobSourceDescription {
  const kind = jobSourceKind(provider);
  const registered = provider === 'user_import' ? null : getSourceAdapter(provider);
  // An adapter of another market never serves this brand, whatever a list says.
  const adapter = registered && registered.markets.includes(brand.market) ? registered : null;
  const status = (): JobSourceStatus => {
    if (provider === 'user_import') return { enabled: true, transport: 'off', reason: null };
    if (!registered) return { enabled: false, transport: 'off', reason: 'not_registered' };
    if (!adapter) return { enabled: false, transport: 'off', reason: 'wrong_market' };
    // On for THIS brand's market (an adapter may serve two markets and be on for one). Never throws.
    const enabled = adapterEnabledFor(adapter, brand.market);
    const transport = safe(() => adapter.transport?.() ?? jobSourceTransport(provider), 'off' as SourceTransport);
    const reason = enabled ? null : safe(() => adapter.disabledReason?.() ?? null, null) ?? 'disabled';
    return { enabled, transport, reason };
  };
  return {
    brand: brand.id,
    market: brand.market,
    provider,
    kind,
    get transport() {
      return status().transport;
    },
    costModel: adapterCostModel(registered ?? { provider }),
    sourceBoards: adapter?.sourceBoards ?? [],
    adapter,
    enabled: () => status().enabled,
    status,
  };
}

/**
 * The brand's sources, in order (user_import last). Built from the adapters
 * registered at call time: ingest registers its built-in adapters before it
 * asks (`ensureBuiltinAdapters`), and `ats_public` registers itself.
 */
export function jobSourcesForBrand(brand: ProductBrand, env: EnvSource = process.env): JobSourceDescription[] {
  const providers = sourceProvidersForBrand(brand, env);
  const ingest = providers.filter((p) => p !== 'user_import');
  const rest = providers.filter((p) => p === 'user_import');
  return [...ingest, ...rest].map((p) => describe(brand, p));
}

/** Test seam: forget which warnings were logged. */
export function resetJobSourceWarningsForTests(): void {
  warned.clear();
}
