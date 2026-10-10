// /developers/job-search — the Job Search API reference (public).
//
// A RoboApply product: on GoApply the API answers 404 feature_disabled
// (server/src/job-search/routes.ts), so this page is a 404 there too (R-04).

import { notFound } from 'next/navigation';

import { JobSearchDeveloperGuide } from '../../../components/job-search/JobSearchDeveloperGuide';
import { jobSearchAvailable } from '../../../components/job-search/metadata';
import '../../../styles/job-search.css';

export default async function JobSearchApiPage() {
  if (!(await jobSearchAvailable())) notFound();
  return <JobSearchDeveloperGuide />;
}
