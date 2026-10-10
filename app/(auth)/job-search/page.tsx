// /job-search — @deprecated (WP-33). Unreachable: next.config.mjs redirects
// the bare /job-search to /jobs/explore before routing (/job-search/developers
// stays). The file is kept only because scripts/job-search-preview/entry.tsx
// (not owned by WP-33) still imports it; WP-75 deletes this page together with
// that preview entry, the deprecated JobSearchWorkspace and its test.

import { JobSearchWorkspace } from '../../../components/job-search/JobSearchWorkspace';
import '../../../styles/job-search.css';

export default function JobSearchPage() {
  return <JobSearchWorkspace />;
}
