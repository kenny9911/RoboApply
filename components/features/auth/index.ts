// components/features/auth — public surface of the auth area (WP-10).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).

export { SettingsSection as AuthSettingsSection } from './SettingsSection';
export { AuthEntryView } from './AuthEntryView';
export { EmailVerificationLine, SignInMethods, SignedInSessions } from './SecuritySettings';
export { InAppBrowserNotice } from './InAppBrowserNotice';
export { OtherBrandNotice } from './OtherBrandNotice';
export { AgreementsFields } from './AgreementsFields';
