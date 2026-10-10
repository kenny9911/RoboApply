// Settings section components + shared form controls.
//
// These were built for the eight-screen /preferences route; that route is gone
// and app/(auth)/settings/page.tsx re-mounts the survivors as sections of one
// page (OVERHAUL_RULINGS D2 — Settings is not a destination). Nothing outside
// /settings imports from here.
//
// Gone with auto-apply and the recruiter-profile claim (rulings R1, C19):
// AgentSection (aggressiveness + daily cap), PlanSection and IntegSection,
// IntegrationCard, and the profile-visibility control. Gone with INT-12: the
// DataSection wrapper (#privacy is the compliance area's section).

export { SaveBar } from './SaveBar';
export { WipeDataModal } from './WipeDataModal';
export * from './controls';

export { IdentitySection } from './sections/IdentitySection';
export { SearchIntro, SearchNotes } from './sections/HuntSection';
export { ResumeSection } from './sections/ResumeSection';
export { BlocklistSection } from './sections/PrivacySection';
export { DangerSection } from './sections/DangerSection';
// Not exported any more (INT-12): AppearanceSection and NotifSection. Their
// sections render the brand and notifications area components; the two files
// stay only for the tests outside this folder that still import them.
