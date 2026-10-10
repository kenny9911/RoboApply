// server/src/features/jobs/ingest/index.ts — public surface of the inventory pipeline (WP-16b).
//
// Seams other areas call:
//   - ingestForProfile(searchProfileId, budgetMs)   onboarding O6 (WP-30 / WP-31)
//   - bankClients                                   WP-54's contacts-sync reads opted-in
//                                                   recruiters from the bank DBs through it
//   - rapidApiSearchParams / rapidApiCountry        the planner seam WP-42 asserts (country=tw)
//   - registerSourceAdapter (re-exported from ../sources) for WP-42's `ats_public`

import prisma from '../../../lib/prisma.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/index.js';
import {
  bankForMarket,
  bankMarket,
  bankTlsSatisfied,
  bankTransport,
  getBankClient,
  isBankEnabled,
  listEnabledBanks,
} from '../../../roboapply/v2/lib/raBankClients.js';
import { adaptersForBrand } from './providers.js';
import { emptyTally, ingestForProfileWith, type TargetedIngestResult } from './run.js';
import { ingestAllowed } from './cron.js';

export { runJobsIngest, runJobsMaintain, runJobsPlan, ingestAllowed } from './cron.js';
/** A provider's daily call limit from env (admin "Limits" page reads it here, never from a copy). */
export { dailyCallLimit } from './config.js';
export { JOBS_INGEST_WORK_KINDS, workers } from './workers.js';
export { rapidApiCountry, rapidApiSearchParams } from './adapters/rapidApi.js';
export { bankPublicPageState, readBankEmployerSignals, isSyncableBankJob } from './adapters/bank.js';
export { adaptersForBrand, ingestProvidersForBrand, sourcesForBrand } from './providers.js';
export { readSourceStatuses, sourceStatusKey } from './status.js';
export type { SourceRunStatus, SourceStatusDoc } from './status.js';
export { registerSourceAdapter, getSourceAdapter } from '../sources/index.js';
export type { JobSourceAdapter, JobSourceDescription, IngestProvider, IngestQueryParams, SourceQuery, SourceFetchResult } from '../sources/index.js';
export type { TargetedIngestResult } from './run.js';

/**
 * The recruiter-bank client seam (read-only Prisma clients for RoboHire /
 * GoHire). Honors the kill switches, the cross-tenant guard and the GoHire
 * TLS rule. A bank read over HTTPS (`bankTransport` 'api') has no client:
 * `getBankClient` answers null for it. WP-54 must still read consent only
 * from the bank's opt-in records.
 */
export const bankClients = {
  getBankClient,
  isBankEnabled,
  listEnabledBanks,
  bankForMarket,
  bankMarket,
  bankTlsSatisfied,
  bankTransport,
} as const;

/**
 * Targeted ingest for onboarding (O6): plans the search profile's queries and
 * runs the due ones within `budgetMs` in the current brand; the rest are
 * queued. Never calls a provider whose key or budget is missing.
 */
export async function ingestForProfile(searchProfileId: string, budgetMs: number): Promise<TargetedIngestResult> {
  const brand = getCurrentBrandOrDefault();
  if (!ingestAllowed(brand)) return { ...emptyTally(), planned: 0, deferred: 0 };
  return ingestForProfileWith({ db: prisma, brand, adapters: adaptersForBrand(brand) }, searchProfileId, budgetMs);
}
