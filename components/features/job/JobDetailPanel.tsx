'use client';

// JobDetailPanel — one job's detail: header, Overview, Company, People and
// the "Get ready for this job" checklist (PRODUCT_PLAN.md §5.5 F-JOB;
// TASK_PLAN.md WP-34).
//
// STUB (FND-6b). Owner: WP-34. Renders nothing. Two consumers share it:
//   - the feed's desktop split view, `/jobs?job=<id>` (WP-33)  → mode 'split'
//   - the full page `/jobs/[id]` (app/(auth)/jobs/[id]/page.tsx) → mode 'page'
// The panel loads its own data from `jobId` (lib/api/jobs.ts); callers pass
// nothing else, so the feed never fetches detail on the panel's behalf.

export interface JobDetailPanelProps {
  jobId: string;
  /** 'split' = beside the feed list (desktop); 'page' = the whole page. */
  mode: 'split' | 'page';
  /** Split view only: close the panel (the feed drops `?job=`). */
  onClose?: () => void;
}

export function JobDetailPanel(_props: JobDetailPanelProps): null {
  return null;
}

export default JobDetailPanel;
