// components/features/seo — public surface of the SEO area (WP-56).
// Client-safe views only; the server pieces (JobTicker, loaders) live in
// './server' so message bundles and next/cache never reach a client bundle.
// Other areas import from here (TASK_PLAN.md §2.1 rule 4).

export { BrowsePage, type BrowsePageProps } from './BrowsePage';
export { BrowseHub, BrowseLinkList, BrowseUnknown } from './BrowseHub';
export { JobPage, JobNotFound, type JobPageProps } from './JobPage';
export { JobCard } from './JobCard';
export { JobTickerView, foundAgo, type JobTickerViewProps } from './JobTickerView';
export { browseTitle, cityLabel, countryLabel, roleLabel } from './names';
