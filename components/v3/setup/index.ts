// V3 first-run setup — the two-step panel that renders in the /jobs page slot.
//
// Replaces components/v3/onboarding/, which held the conversational flow's
// parts: OnboardTop (a four-dot progress bar for stages that no longer exist),
// PreferenceTray (chips suppressed until an assistant confirmed them),
// ResumeSelectPanel and UploadStep (a drop zone that could not accept a drop).
// Two things survived the move and both were rewritten around them:
// IngestRecap, and `formatDraftFieldValue` out of the tray.

export { SetupPanel, type SetupPanelProps } from './SetupPanel';
export { ResumeStep, ACCEPT_RESUME, MAX_RESUME_BYTES } from './ResumeStep';
export { ConfirmStep } from './ConfirmStep';
export { IngestRecap } from './IngestRecap';
export {
  EditableChipGroup,
  TogglePillGroup,
  type ChipOption,
} from './EditableChipGroup';
export {
  formatDraftFieldValue,
  draftFromPreferences,
  LABELLED_DRAFT_FIELDS,
  ENUM_VALUE_KEYS,
} from './formatDraftField';
