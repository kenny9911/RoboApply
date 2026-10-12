// server/src/features/jobs/sources/atsPublic/register.ts — registers the
// `ats_public` ingest adapter with WP-16b's registry (side-effect module).
//
// Imported by ./hooks.ts, which features/jobs/marketHooks.ts imports
// statically; the ingest pipeline imports marketHooks, so the adapter is in the
// registry before any jobs-plan / jobs-ingest run asks `adaptersForBrand()`.
// Registering the same object twice is a no-op.

import { getSourceAdapter, registerSourceAdapter } from '../index.js';
import { createAtsPublicAdapter } from './adapter.js';

export const atsPublicAdapter = createAtsPublicAdapter();

/** Idempotent: (re-)registers the adapter unless another one already holds the provider. */
export function ensureAtsPublicAdapter(): void {
  if (!getSourceAdapter('ats_public')) registerSourceAdapter(atsPublicAdapter);
}

ensureAtsPublicAdapter();
