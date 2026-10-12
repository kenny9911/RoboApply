// /jobs/added — "Added by you" (WP-35; PRODUCT_PLAN.md F-TRK-04, §3.4): jobs
// the user imported from other sites. Renders inside the (auth) app shell.
// The page body is a client component (forms, list, credits). It reads
// `?import=<importId>` (an unfinished add to reopen), and `useSearchParams`
// needs a Suspense boundary in the App Router.

import { Suspense } from 'react';

import { JobsAddedPage } from '../../../../components/features/jobimport';

export default function JobsAddedRoute() {
  return (
    <Suspense fallback={null}>
      <JobsAddedPage />
    </Suspense>
  );
}
