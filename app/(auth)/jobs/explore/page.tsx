'use client';

// /jobs/explore — Explore: kinds of work with live counts and the
// plain-language search (PRODUCT_PLAN.md §3.4, F-FEED-13, F-FEED-17;
// TASK_PLAN.md WP-33). It replaces the /job-search workspace; next.config.mjs
// redirects the bare /job-search here (/job-search/developers stays).

import { Suspense } from 'react';

import { Explore } from '../../../../components/features/feed';

export default function JobsExplorePage() {
  return (
    <Suspense fallback={null}>
      <Explore />
    </Suspense>
  );
}
