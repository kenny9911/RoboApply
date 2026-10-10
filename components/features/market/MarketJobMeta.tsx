'use client';

// MarketJobMeta — the market slot on job cards and the job page (TASK_PLAN.md
// R-21; CN_TW_LAUNCH_PLAN.md §4.1(3)). Shared cards render this ONE component
// and never branch on market themselves; each market fills its own folder:
//
//   brand.market 'cn'   → market/cn  JobMetaCn  (WP-41)
//   brand.market 'intl' → market/tw  JobMetaTw  (WP-42; nothing for non-TW jobs)
//
// The dispatch is final (FND-6b).
//
// `marketMetaCoversBasics` tells the shared card and job page when the slot
// already prints the pay, the posting's date, "Last checked" and the source
// (GoApply's JobMetaCn does, in its own words), so they do not print those
// lines a second time.

import { useBrand } from '../../../lib/brand/BrandProvider';
import { JobMetaCn, readCnMeta } from './cn';
import { JobMetaTw } from './tw';
import type { MarketCardMeta, MarketJobMetaProps } from './types';

export type { MarketJobMetaProps } from './types';

export function MarketJobMeta(props: MarketJobMetaProps) {
  const brand = useBrand();
  return brand.market === 'cn' ? <JobMetaCn {...props} /> : <JobMetaTw {...props} />;
}

/**
 * True when the market slot for this job prints pay, dates and source itself:
 * GoApply (market 'cn') with a readable `meta.cn`. False everywhere else,
 * including GoApply jobs the server sent no `cn` meta for, so nothing is ever
 * dropped without its replacement on screen. Pure.
 */
export function marketMetaCoversBasics(market: 'intl' | 'cn', meta: MarketCardMeta | null | undefined): boolean {
  return market === 'cn' && readCnMeta(meta) !== null;
}

export default MarketJobMeta;
