// components/features/feed — public surface of the job feed UI (WP-33).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4):
//   WP-35 (/jobs/added): FeedTabs + feedTabPanelProps for the same tab strip
//   WP-34 (similar jobs), WP-77, WP-78: JobCard for a FeedItem list

export { JobsWorkspace } from './JobsWorkspace';
export { Explore } from './Explore';
export { FeedTabs, feedTabPanelProps } from './FeedTabs';
export {
  cardBadges,
  payText,
  shortDate,
  sourceLine,
  companyInitial,
  type CardBadge,
} from './cardModel';
