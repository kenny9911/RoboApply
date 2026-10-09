'use client';

// MarketJobMeta — the market slot on job cards and the job page (TASK_PLAN.md
// R-21; CN_TW_LAUNCH_PLAN.md §4.1(3)). Shared cards render this ONE component
// and never branch on market themselves; each market fills its own folder:
//
//   brand.market 'cn'   → market/cn  JobMetaCn  (WP-41)
//   brand.market 'intl' → market/tw  JobMetaTw  (WP-42; nothing for non-TW jobs)
//
// The dispatch is final (FND-6b); both targets are stubs that render nothing
// until their owners fill them.

import { useBrand } from '../../../lib/brand/BrandProvider';
import { JobMetaCn } from './cn';
import { JobMetaTw } from './tw';
import type { MarketJobMetaProps } from './types';

export type { MarketJobMetaProps } from './types';

export function MarketJobMeta(props: MarketJobMetaProps) {
  const brand = useBrand();
  return brand.market === 'cn' ? <JobMetaCn {...props} /> : <JobMetaTw {...props} />;
}

export default MarketJobMeta;
