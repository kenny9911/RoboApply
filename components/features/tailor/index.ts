// components/features/tailor — tailoring v2 UI (WP-36a; F-RES-09, F-RES-10,
// F-RES-15). Cross-area imports go through this file (TASK_PLAN.md §2.1 rule 4).
//
//   <TailorButton jobId=… />              entry on any job surface (hidden when AI is off)
//   <TailorLaunchHost resumeId=… />       runs the flow from `?tailor=<jobId>` (resume pages)
//   <TailorSheet open jobId=… />          the flow in a sheet (with the base-resume picker; with no
//                                         jobId the user picks a saved job or pastes the posting)
//   <TailorFlow resumeId=… jobId=… />     the flow inline

export { TailorFlow, type TailorFlowProps } from './TailorFlow';
export { TailorSheet, BasePicker, type TailorSheetProps } from './TailorSheet';
export { TailorLaunchHost, TAILOR_QUERY, TAILOR_SESSION_QUERY, type TailorLaunchHostProps } from './TailorLaunchHost';
export { TailorButton, type TailorButtonProps } from './TailorButton';
export { TailorSetup, INSTRUCTION_MAX, type TailorSetupProps, type TailorSetupValue } from './TailorSetup';
export { TailorResult, type TailorResultProps } from './TailorResult';
export { ClaimCard, type ClaimCardProps } from './ClaimCard';
export { TailorError } from './TailorError';
export { TailorTarget, postingOf, POSTING_TEXT_MIN, type PastedPosting, type TailorTargetProps, type TailorTargetValue } from './TailorTarget';
