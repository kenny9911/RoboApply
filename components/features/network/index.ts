// components/features/network — public surface of the people area (WP-54).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).
//
//   PeoplePanel             job page People tab (WP-34 mounts it)
//   NetworkSettingsSection  /settings#connections
//   FollowUpDraftButton     tracker drawer "Write a follow-up" (mounted by components/features/tracker)
//   ConnectionsList         the user's own contacts with their company, in /settings#connections
//   OutreachComposer        "Write a message" for any job
//   ReferralHub             /referrals (GoApply 内推码 hub)

export { PeoplePanel, type PeoplePanelProps } from './PeoplePanel';
export { SettingsSection as NetworkSettingsSection } from './SettingsSection';
export { FollowUpDraftButton } from './FollowUpDraftButton';
export { ReferralHub } from './ReferralHub';
