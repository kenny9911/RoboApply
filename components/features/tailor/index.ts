// components/features/tailor — tailoring v2 UI (WP-36a; F-RES-09, F-RES-10,
// F-RES-15). Cross-area imports go through this file (TASK_PLAN.md §2.1 rule 4).
//
//   <TailorButton jobId=… />              entry on any job surface (hidden when AI is off)
//   <TailorLaunchHost resumeId=… />       runs the flow from `?tailor=<jobId>` (resume pages)
//   <TailorSheet open jobId=… />          the flow in a sheet (with the base-resume picker; with no
//                                         jobId the user picks a saved job or pastes the posting)
//   <TailorFlow resumeId=… jobId=… />     the flow inline

export { TailorFlow } from './TailorFlow';
export { TailorSheet } from './TailorSheet';
export { TailorLaunchHost } from './TailorLaunchHost';
export { TailorButton } from './TailorButton';
export { TailorResult } from './TailorResult';
export { ClaimCard } from './ClaimCard';
export { TailorTarget, postingOf } from './TailorTarget';
