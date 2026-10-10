// /jobs/added — "Added by you" (WP-35; PRODUCT_PLAN.md F-TRK-04, §3.4): jobs
// the user imported from other sites. Renders inside the (auth) app shell.
// The page body is a client component (forms, list, credits).

import { JobsAddedPage } from '../../../../components/features/jobimport';

export default function JobsAddedRoute() {
  return <JobsAddedPage />;
}
