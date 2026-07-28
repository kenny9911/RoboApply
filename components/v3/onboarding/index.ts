// V3 setup components.
//
// The chat shell that used to live here (OnboardingChat, JobCardStack,
// OnboardingJobCard, ChipRow) is deleted along with the conversational onboarding:
// nothing rendered it — no route imported this barrel — and the NDJSON
// contract it consumed no longer exists.
//
// What remains is the parts the two-step setup panel reuses. They are
// scheduled to MOVE to components/v3/setup/ with the panel rewrite; the
// directory stays until that lands so the move is one commit, not two.

export { OnboardTop, type OnboardingStage } from './OnboardTop';
export { UploadStep } from './UploadStep';
export { ResumeSelectPanel } from './ResumeSelectPanel';
export { IngestRecap } from './IngestRecap';
export { PreferenceTray } from './PreferenceTray';
