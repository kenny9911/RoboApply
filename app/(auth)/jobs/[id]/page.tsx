// /jobs/[id] — route shell (FND-6b). The full job page (PRODUCT_PLAN.md §3.4;
// the feed's desktop split view renders the same panel in mode 'split').
//
// STUB. Owner: WP-34, who replaces this page. Renders inside the (auth) app
// shell and hands the id to the area's root component, JobDetailPanel (a stub
// that renders nothing until WP-34 fills it). Nothing links here yet:
// `jobHref()` in components/v3/shell/destinations.ts keeps sending job links
// to /jobs until INT flips `SURFACES_READY.jobDetail`.

import { JobDetailPanel } from '../../../../components/features/job';

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <div hidden data-route-stub="/jobs/[id]" data-owner="WP-34" data-param={id} />
      <JobDetailPanel jobId={id} mode="page" />
    </>
  );
}
