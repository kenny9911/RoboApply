// /jobs/explore — route shell (FND-6b; PRODUCT_PLAN.md §3.4: Explore absorbs
// /job-search).
//
// Owner: WP-33, who replaces it with Explore (20 categories with live counts
// and the search box). Until then it renders the existing job search
// workspace that /job-search served, so the redirect added in FND-6a lands on
// a working page.

import { JobSearchWorkspace } from '../../../../components/job-search/JobSearchWorkspace';
import '../../../../styles/job-search.css';

export default function JobsExplorePage() {
  return <JobSearchWorkspace />;
}
