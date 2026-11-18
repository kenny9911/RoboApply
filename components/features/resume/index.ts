// components/features/resume — resume check UI (WP-22), the keyword check,
// hub/layout (WP-36b) and the builder, editor tools and tour (WP-65). The
// /resume hub's cards, AI tailoring and "Up next" are in ./hub.
// Cross-area imports go through this file (TASK_PLAN.md §2.1 rule 4).

export { ResumeCheckReport } from './ResumeCheckReport';
export { ResumeCheckEntry, resumeCheckHref } from './ResumeCheckEntry';
export { EditorCheckSummary } from './EditorCheckSummary';
export { issueText } from './issueText';
export {
  ResumeHubTabs,
  BaseSlots,
  TailoredVersions,
  isBaseSlot,
  verifyDetailsHref,
} from './ResumeHub';
// The /resume hub: AI tailoring, "Up next", the library cards, ways to start.
export {
  AskAssistant,
  LibraryCard,
  NewResumeTile,
  NextSteps,
  ResumeStart,
  TailorPanel,
  CheckStatus,
  checkStateOf,
  mainResumeOf,
  nextSteps,
  sortBases,
  untailoredJobs,
  type CheckState,
  type StartMethod,
} from './hub';
// The editor's tabs (Edit · Customize · Review · Tailor), the open one in
// `?tab=`: a link to a tab of a resume. The editor page imports the tab bar
// and the panels from ./editor directly.
export { editorTabHref } from './editor/tabs';
export {
  layoutPatch,
  resolveLayout,
} from './layout';
// WP-65: editor tools, the check tour, the guided builder.
export {
  AskAssistantButton,
  FitToPageControl,
  docLanguageOf,
  personalLineFor,
} from './EditorTools';
