// components/features/growth — public surface of the growth area (WP-23 → WP-60).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).

export { AnalyticsConsent, type AnalyticsConsentProps } from './AnalyticsConsent';
export { GettingStartedChecklist, type GettingStartedChecklistProps } from './GettingStartedChecklist';
export { InviteFriends, InviteFriendsList, InviteProgress, REFERRAL_TERMS_HREF } from './InviteFriends';
export { InviteLanding, loginHrefFor, normalizeInviteCode, signupHrefFor, type InviteLandingProps } from './InviteLanding';
export { InviteLinkBox, type InviteLinkBoxProps } from './InviteLinkBox';
export { SettingsSection as GrowthSettingsSection } from './SettingsSection';
