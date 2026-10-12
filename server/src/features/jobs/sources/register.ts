// server/src/features/jobs/sources/register.ts — registers the job sources of
// this folder with the adapter registry (side-effect module; MKT-3E, MKT-5D).
//
//   tw_open_data   the 台灣就業通 open-data sweep (./twOpenData.ts)
//   tw_gov_jobs    事求人 public-sector vacancies (./twGovJobs.ts)
//   usajobs        USAJOBS, US federal vacancies (./usaJobs.ts; off until a
//                  key is set)
//
// All three serve the international market only, so they are RoboApply's and
// never GoApply's (sources/registry.ts: an adapter joins a brand through its
// market). Imported by ./twHooks.ts, which features/jobs/marketHooks.ts imports
// statically; the ingest pipeline imports marketHooks, so the adapters are in
// the registry before any jobs-plan / jobs-ingest run asks
// `adaptersForBrand()`. Registering is idempotent: importing this module
// twice, or calling an `ensure…` function again, changes nothing, and an
// adapter another module already registered for the provider is left alone.
// (The employer boards register themselves the same way in
// ./atsPublic/register.ts.)

import { getSourceAdapter, registerSourceAdapter } from './index.js';
import { createTwGovJobsAdapter, TW_GOV_JOBS_PROVIDER } from './twGovJobs.js';
import { createTwOpenDataAdapter, TW_OPEN_DATA_PROVIDER } from './twOpenData.js';
import { createUsaJobsAdapter, USAJOBS_PROVIDER } from './usaJobs.js';

export const twOpenDataAdapter = createTwOpenDataAdapter();
export const twGovJobsAdapter = createTwGovJobsAdapter();
export const usaJobsAdapter = createUsaJobsAdapter();

/** Idempotent: (re-)registers the adapter unless another one already holds the provider. */
export function ensureTwOpenDataAdapter(): void {
  if (!getSourceAdapter(TW_OPEN_DATA_PROVIDER)) registerSourceAdapter(twOpenDataAdapter);
}

/** Idempotent, as above. */
export function ensureTwGovJobsAdapter(): void {
  if (!getSourceAdapter(TW_GOV_JOBS_PROVIDER)) registerSourceAdapter(twGovJobsAdapter);
}

/** Idempotent, as above. */
export function ensureUsaJobsAdapter(): void {
  if (!getSourceAdapter(USAJOBS_PROVIDER)) registerSourceAdapter(usaJobsAdapter);
}

/** Every source of this folder, in the order ingest lists them. */
export function ensureSourceAdapters(): void {
  ensureTwOpenDataAdapter();
  ensureTwGovJobsAdapter();
  ensureUsaJobsAdapter();
}

ensureSourceAdapters();
