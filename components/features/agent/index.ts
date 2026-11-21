// components/features/agent — Ready to apply UI (WP-53; PRODUCT §5.8).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).
//
//   ReadyPage        /ready: intro, allowance, progress, search, To prepare · Ready · Done
//   SetupWizard      /ready/setup: five steps (#profile #calibrate #answers #weekly #extension)
//   KitReview        /ready/[jobId]: one kit — resume (Verify details), letter, answers,
//                    files, Open application + Undo, practice, history
//   AnswersEditor    the answer bank editor (also reachable from the profile via /ready/setup#answers)
//   ReadySearchCard  the search the weekly list comes from (F-FILT-07 question)
//   PrepareApplicationButton  one tap from a job to a kit being prepared (Today, job cards)
//   AutoPrepareSetting / AutoPrepareState  "Prepare my weekly list automatically": the opt-in
//                    (cost stated first) and what it did (Getting ready, the Dashboard's lane)

export { ReadyPage, ReadyUnavailable } from './ReadyPage';
export { ReadyIntro, type ReadyIntroProps } from './ReadyIntro';
export { SetupWizard, initialStep, wizardSteps, type WizardStep } from './SetupWizard';
export { KitReview, type KitReviewProps } from './KitReview';
export { KitRow, type KitRowProps } from './KitRow';
export { KitAllowance } from './KitAllowance';
export { AutoPrepareSetting, autoPrepareCostLines, autoPrepareLeft } from './AutoPrepareSetting';
export { AutoPrepareState, type AutoPrepareStateProps } from './AutoPrepareState';
export { PrepareSheet, CostLine, noTailorKey, type PrepareSheetProps } from './PrepareSheet';
export { PrepareApplicationButton, placeOf, type PrepareApplicationButtonProps, type PreparedPlace } from './PrepareApplicationButton';
export { ReadySearchCard, type ReadySearchCardProps } from './ReadySearchCard';
export { AnswersEditor, type AnswersEditorProps, type StepFormHandle } from './AnswersEditor';
export { WeeklySettingsForm, DEFAULT_SETTINGS, type WeeklySettingsFormProps } from './WeeklySettingsForm';
export { customQuestionKey, isCustomKey, questionsFor } from './questions';
export { previewFileName, type FileNameParts } from './fileName';
export { STATE_TONE, SETUP_HREF, applicationHref, kitHref, setupStepHref } from './states';
