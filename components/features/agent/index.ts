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

export { ReadyPage } from './ReadyPage';
export { SetupWizard } from './SetupWizard';
export { KitReview } from './KitReview';
export { KitAllowance } from './KitAllowance';
export { AutoPrepareState } from './AutoPrepareState';
export { CostLine, noTailorKey } from './PrepareSheet';
export { PrepareApplicationButton, placeOf } from './PrepareApplicationButton';
export { STATE_TONE, applicationHref, kitHref } from './states';
