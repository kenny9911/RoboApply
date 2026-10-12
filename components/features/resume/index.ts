// components/features/resume — resume check UI (WP-22), the keyword check,
// hub/layout (WP-36b) and the builder, editor tools and tour (WP-65).
// Cross-area imports go through this file (TASK_PLAN.md §2.1 rule 4).

export { ResumeCheckReport, Comparison, editorHrefFor, type ResumeCheckReportProps } from './ResumeCheckReport';
export { IssueCard, type IssueCardProps } from './IssueCard';
export { KeywordReport, KeywordReportView, type KeywordReportProps } from './KeywordReport';
export { ResumeCheckEntry, resumeCheckHref, type ResumeCheckEntryProps } from './ResumeCheckEntry';
export { EditorCheckSummary } from './EditorCheckSummary';
export { issueText, issueTypeName, issueParams } from './issueText';
// WP-36b: hub, layout and export pieces.
export { LayoutPanel, type LayoutPanelProps } from './LayoutPanel';
export {
  ResumeHubTabs,
  BaseSlots,
  ResumeHubMeta,
  TailoredVersions,
  groupTailored,
  isBaseSlot,
  type HubTab,
  type ResumeHubMetaProps,
  type TailoredGroup,
  type TailoredVersionsProps,
} from './ResumeHub';
export {
  TEMPLATES,
  RECOMMENDED_TEMPLATE,
  WARN_TEMPLATES,
  SPACING_PRESETS,
  ACCENTS,
  DATE_FORMATS,
  formatDatesIn,
  isSidebarSection,
  layoutPatch,
  normalizeTemplate,
  pageAspect,
  resolveLayout,
  spacingPresetOf,
  type DateFormat,
  type ResolvedLayout,
  type SpacingPreset,
} from './layout';
// WP-65: editor tools, the check tour, the guided builder.
export {
  AskAssistantButton,
  FitToPageControl,
  ResumeDetailsPanel,
  SectionOrderPanel,
  docLanguageOf,
  personalLineFor,
} from './EditorTools';
// Sign-out / session-expired cleanup of the builder's unsent draft and draft photo.
export { clearResumeBuilderDeviceData } from '../../../hooks/resume/useResumePhoto';
export { ResumeTour, ResumeTourCard, RESUME_TOUR_STEPS, type ResumeTourProps } from './ResumeTour';
export { ResumeBuilder, ResumeBuilderView } from './builder/ResumeBuilder';
