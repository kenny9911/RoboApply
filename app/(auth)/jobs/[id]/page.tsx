// /jobs/[id] — the full job page (PRODUCT_PLAN.md §3.4, F-JOB-01; WP-34).
// The feed's desktop split view renders the same panel in mode 'split'.
// Renders inside the (auth) app shell; the panel loads its own data.
// CommandPalette job hits land here once INT flips
// `SURFACES_READY.jobDetail` in components/v3/shell/destinations.ts.

import { JobDetailPanel } from '../../../../components/features/job';

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JobDetailPanel jobId={id} mode="page" />;
}
