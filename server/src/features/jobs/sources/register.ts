// server/src/features/jobs/sources/register.ts — registers the job sources of
// this folder with the adapter registry (side-effect module; MKT-3E).
//
// Today: `tw_open_data`, the 台灣就業通 open-data sweep (./twOpenData.ts).
// Imported by ./twHooks.ts, which features/jobs/marketHooks.ts imports
// statically; the ingest pipeline imports marketHooks, so the adapter is in
// the registry before any jobs-plan / jobs-ingest run asks
// `adaptersForBrand()`. Registering is idempotent: importing this module
// twice, or calling `ensureTwOpenDataAdapter()` again, changes nothing, and an
// adapter another module already registered for the provider is left alone.
// (The employer boards register themselves the same way in
// ./atsPublic/register.ts.)

import { getSourceAdapter, registerSourceAdapter } from './index.js';
import { createTwOpenDataAdapter, TW_OPEN_DATA_PROVIDER } from './twOpenData.js';

export const twOpenDataAdapter = createTwOpenDataAdapter();

/** Idempotent: (re-)registers the adapter unless another one already holds the provider. */
export function ensureTwOpenDataAdapter(): void {
  if (!getSourceAdapter(TW_OPEN_DATA_PROVIDER)) registerSourceAdapter(twOpenDataAdapter);
}

ensureTwOpenDataAdapter();
