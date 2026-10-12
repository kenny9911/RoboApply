// /jobs/report — "You and what employers ask" (PRODUCT F-MATCH-04; TASK_PLAN.md
// WP-77; flag `competitiveness`). Linked from the /jobs header (WP-33) and the
// Assistant's competitiveness card (`?job=<id>`); `?search=<id>` picks the
// saved search. Renders inside the (auth) app shell.

import { Suspense } from 'react';

import { CompetitivenessReport } from '../../../../components/features/match';

export default function JobsReportPage() {
  return (
    <Suspense fallback={null}>
      <CompetitivenessReport />
    </Suspense>
  );
}
