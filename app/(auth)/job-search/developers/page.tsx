// /job-search/developers — integration keys for the Job Search API (signed in).
//
// A RoboApply product: on GoApply the API answers 404 feature_disabled
// (server/src/job-search/routes.ts), so this page is a 404 there too (R-04).

import { notFound } from 'next/navigation';

import { ApiKeyWorkspace } from '../../../../components/job-search/ApiKeyWorkspace';
import { jobSearchAvailable } from '../../../../components/job-search/metadata';
import '../../../../styles/job-search.css';

export default async function JobSearchDevelopersPage() {
  if (!(await jobSearchAvailable())) notFound();
  return <ApiKeyWorkspace />;
}
