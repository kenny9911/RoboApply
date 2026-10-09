// server/src/features/cn/jobs/hooks.ts — STUB (FND-5). Owner: WP-41.
//
// GoApply market hooks, statically imported by features/jobs/marketHooks.ts.
// WP-41 fills them: GoHire mapping (source + licence line through
// `{sourceName}`, expiry, `salaryDisclosed`, verbatim `salaryText`), the
// fraud classifier on afterEnrich (keywords + cheap CN LLM; flags excluded
// from ranking; warnings on user imports; employer blacklist), market tags
// only with an `evidenceQuote`, and CnCardMeta for JobMetaCn.
// Until then every hook is a no-op: jobs pass through unchanged.

import type { MarketHookSet } from '../../jobs/marketHooks.js';

export const cnJobsHooks: MarketHookSet = {
  id: 'cn',
  appliesTo: (job) => job.market === 'cn',
  afterNormalize: (job) => job,
  afterEnrich: () => undefined,
  cardMeta: () => null,
};
