// components/features/market/tw — Taiwan job-card lines from public job
// boards: 待遇 as posted (面議 / 依公司規定), source board (TASK_PLAN.md WP-42).
//
// STUB (FND-6b). Owner: WP-42. Renders nothing. Reached only through
// components/features/market/MarketJobMeta.tsx on RoboApply (market 'intl');
// reads `meta.ats_public` and renders nothing for non-Taiwan jobs.

import type { MarketJobMetaSlotProps } from '../types';

export function JobMetaTw(_props: MarketJobMetaSlotProps): null {
  return null;
}
