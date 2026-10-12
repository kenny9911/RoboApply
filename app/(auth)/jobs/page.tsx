'use client';

// /jobs — the job feed, "For you" tab (PRODUCT_PLAN.md §3.4, F-FEED-01;
// TASK_PLAN.md WP-33). The whole workspace lives in
// components/features/feed/JobsWorkspace.tsx: tabs, filters, sort, the
// infinite list, the desktop split detail (`?job=<id>`) and the in-feed
// calibration prompts. First-run setup moved to /onboarding (WP-30), so this
// page no longer mounts the old setup panel.
//
// `useSearchParams` needs a Suspense boundary in the App Router.

import { Suspense } from 'react';

import { JobsWorkspace } from '../../../components/features/feed';

export default function JobsPage() {
  return (
    <Suspense fallback={null}>
      <JobsWorkspace />
    </Suspense>
  );
}
