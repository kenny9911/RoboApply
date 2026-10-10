// server/src/features/jobs/sources/registry.ts — the per-brand job source registry
// (GOAPPLY_PARITY_PLAN.md §3.9; MARKET_STRATEGY M-6, JC-7).
//
// One place answers "which sources feed this brand, how, and are they on":
//
//   RoboApply (intl): activejobs → bank_robohire → jsearch (the brand registry's
//                     order) + adapters registered for the market (ats_public)
//   GoApply   (cn):   bank_gohire + adapters registered for the market
//                     (ats_public: employer-board postings located in mainland
//                     China). Never a search API: the RapidAPI adapters are
//                     international-only, so JSearch can never serve market cn.
//   both:             user_import (a user's own import; not an ingest source)
//
// The provider list is `brand.jobProviders` plus the adapters registered for
// the brand's market, optionally narrowed by JOB_PROVIDERS_<BRAND> (a comma
// list; a subset only: a name the brand does not have is ignored, with one
// warning). CN_EXTERNAL_PROVIDERS is no longer read (one warning when set).
//
// The capability is the same on both brands (feed, search over our own index,
// alerts, similar jobs); only the rows differ. Ingest (features/jobs/ingest)
// and the admin sources panel both read this module, so they cannot disagree.

import type { BrandId, EnvSource, JobProvider, Market, ProductBrand } from '../../../platform/brand/index.js';
import { logger } from '../../../services/LoggerService.js';
import { getSourceAdapter, sourceAdaptersForMarket } from './index.js';
import type { IngestProvider, JobSourceAdapter, SourceTransport } from './types.js';

export type JobSourceKind = 'bank' | 'search' | 'ats' | 'import';

/**
 * Providers the brand registry governs: a brand has one only when its
 * `jobProviders` lists it. Any other registered adapter (ats_public) joins a
 * brand through its market.
 */
const REGISTRY_PROVIDERS: ReadonlySet<IngestProvider> = new Set<JobProvider>([
  'activejobs',
  'linkedin',
  'jsearch',
  'bank_robohire',
  'bank_gohire',
  'user_import',
]);

const KIND: Readonly<Partial<Record<IngestProvider, JobSourceKind>>> = {
  activejobs: 'search',
  linkedin: 'search',
  jsearch: 'search',
  bank_robohire: 'bank',
  bank_gohire: 'bank',
  ats_public: 'ats',
  user_import: 'import',
};

export function jobSourceKind(provider: IngestProvider): JobSourceKind {
  return KIND[provider] ?? 'search';
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
 * Every provider of the brand, in order: its registry list (user_import
 * included), then the adapters registered for its market. Narrowed by
 * JOB_PROVIDERS_<BRAND> when that is set (user_import is never narrowed: it is
 * not an ingest source).
 */
export function sourceProvidersForBrand(brand: ProductBrand, env: EnvSource = process.env): IngestProvider[] {
  const own: IngestProvider[] = [...brand.jobProviders];
  const extra = sourceAdaptersForMarket(brand.market)
    .map((a) => a.provider)
    .filter((p) => !REGISTRY_PROVIDERS.has(p) && !own.includes(p));
  const all = [...own, ...extra];

  if (typeof env.CN_EXTERNAL_PROVIDERS === 'string' && env.CN_EXTERNAL_PROVIDERS.trim()) {
    warnOnce('cn_external_providers', 'CN_EXTERNAL_PROVIDERS is no longer read: GoApply has no search provider. Remove it.', {
      use: `${jobProvidersEnvName('goapply')} narrows the GoApply source list`,
    });
  }

  const name = jobProvidersEnvName(brand.id);
  const narrow = listEnv(env, name);
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

function defaultTransport(provider: IngestProvider, kind: JobSourceKind): SourceTransport {
  if (kind === 'ats') return 'board_api';
  if (kind === 'bank') return 'db';
  if (provider === 'user_import') return 'off';
  return 'rapidapi';
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
    const enabled = safe(() => adapter.isEnabled(), false);
    const transport = safe(() => adapter.transport?.() ?? defaultTransport(provider, kind), 'off' as SourceTransport);
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
