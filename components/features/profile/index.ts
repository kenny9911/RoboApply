// components/features/profile — public surface of the profile area (WP-19).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).
//
//   ProfilePage            the /profile route body
//   ProfileCompletionCard  "Complete your profile" stepper (Ready to apply, extension pages; ruling C32)
//   ProfileSettingsSection /settings#sensitive

export { SettingsSection as ProfileSettingsSection } from './SettingsSection';
export { ProfilePage } from './ProfilePage';
export { ProfileCompletionCard, type ProfileCompletionCardProps } from './ProfileCompletionCard';
