// components/features/network — public surface of the people area (WP-54).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).
//
//   PeoplePanel             job page People tab (WP-34 mounts it)
//   NetworkSettingsSection  /settings#connections
//   FollowUpDraftButton     tracker drawer "Write a follow-up" (WP-38 seam; INT mounts it)
//   OutreachComposer        "Write a message" for any job
//   ReferralHub             /referrals (GoApply 内推码 hub)

export { PeoplePanel, type PeoplePanelProps } from './PeoplePanel';
export { SettingsSection as NetworkSettingsSection } from './SettingsSection';
export { FollowUpDraftButton, type FollowUpDraftButtonProps } from './FollowUpDraftButton';
export { OutreachComposer, type OutreachComposerProps } from './OutreachComposer';
export { ConnectionsImport } from './ConnectionsImport';
export { ReferralHub, type ReferralHubProps } from './ReferralHub';
export { ReferralCodeCard } from './ReferralCodeCard';
export { mailtoHref, linkedinPeopleSearch } from './links';
