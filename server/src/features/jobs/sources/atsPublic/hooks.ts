// server/src/features/jobs/sources/atsPublic/hooks.ts — STUB (FND-5). Owner: WP-42.
//
// Public ATS job-board / Taiwan market hooks, statically imported by
// features/jobs/marketHooks.ts. WP-42 fills them: `sourceName` = company +
// ATS, TW card meta (面議 wording kept, permit tags only with a quote; never
// claims a 面議 job pays ≥ NT$40,000). Until then every hook is a no-op.

import type { MarketHookSet } from '../../marketHooks.js';

export const atsPublicHooks: MarketHookSet = {
  id: 'ats_public',
  appliesTo: (job) => job.provider === 'ats_public' || job.locationCountry === 'TW',
  afterNormalize: (job) => job,
  afterEnrich: () => undefined,
  cardMeta: () => null,
};
