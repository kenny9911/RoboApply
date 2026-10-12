// /job-search/developers — integration keys for the Job Search API (signed in).
//
// Offered on both brands (D5): RoboApply searches its job-source providers,
// GoApply searches its own index of mainland postings. The page states it
// when the site's job listings are switched off.

import { ApiKeyWorkspace } from '../../../../components/job-search/ApiKeyWorkspace';
import '../../../../styles/job-search.css';

export default function JobSearchDevelopersPage() {
  return <ApiKeyWorkspace />;
}
