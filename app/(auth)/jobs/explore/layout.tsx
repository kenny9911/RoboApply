// /jobs/explore — metadata for the job search that moved here from
// /job-search (next.config.mjs redirects the bare /job-search to this path;
// /job-search/developers stays where it is). Same title and noindex as before.
//
// Owner: WP-33 (Explore: categories with live counts and the search box).

import type { ReactNode } from 'react';

import { jobSearchMetadata } from '../../../../components/job-search/metadata';

export const generateMetadata = () => jobSearchMetadata('search');

export default function JobsExploreLayout({ children }: { children: ReactNode }) {
  return children;
}
