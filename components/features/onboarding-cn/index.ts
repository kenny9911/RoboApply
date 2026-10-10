// components/features/onboarding-cn — GoApply onboarding step screens
// G1–G5 and the cn confirm page (PRODUCT_PLAN.md §4.4–§4.5; TASK_PLAN.md
// WP-31). Public surface; other areas import from here only (§2.1 rule 4).
//
// WP-30's `/onboarding/[step]` page (app/(onboarding)/onboarding/[step]) owns
// routing and the shared stages (resume, matching); on GoApply it renders
// `CN_ONBOARDING_STEP_COMPONENTS[step]` for the steps below, wraps the shared
// resume screen in `CnResumeGate`, and shows `CnFirstValueScreen` after the
// confirm step. A step saves its
// own answers (PUT /onboarding/steps/:step through lib/api/onboarding.ts,
// validated server-side by features/onboarding-cn) and then calls `onDone`
// with the server's response; the page navigates to `nextRoute`.
//
// Also exported for the shared stages and the first-value screen:
//   CnResumeGate      — wraps the resume screen on GoApply (AI consent → upload; else 手动填写)
//   CnFirstValueTour  — "开启网申截止提醒" + the tour (stage `tour`); pass `campusCalendar`
//                       and `aiAllowed` so features that are off are not advertised
//   CnFirstValueScreen — the same tour with its props read for the signed-in user
//                       (stored 届别 and cities, the campus-calendar capability, the AI consent)
//   CnOnboardingApiProvider — inject the requests (tests, previews)

import type { ComponentType } from 'react';

import { CnConfirmStep } from './CnConfirmStep';
import { ConsentStep } from './ConsentStep';
import { EducationStep } from './EducationStep';
import { IdentityStep } from './IdentityStep';
import { IntentStep } from './IntentStep';
import { TagsStep } from './TagsStep';
import type { CnOnboardingStep, CnOnboardingStepProps } from './types';

export { CN_ONBOARDING_STEPS, isCnOnboardingStep } from './types';
export type { CnMatchSummary, CnOnboardingStep, CnOnboardingStepProps } from './types';
export { ConsentStep, INITIAL_CONSENT_STATE, type ConsentFormState } from './ConsentStep';
export { IdentityStep } from './IdentityStep';
export { EducationStep, SchoolTags } from './EducationStep';
export { IntentStep, intentBody, intentProblems, type IntentForm } from './IntentStep';
export { TagsStep } from './TagsStep';
export { CnConfirmStep, classOfProgram } from './CnConfirmStep';
export { CnResumeGate, type CnResumeGateProps } from './CnResumeGate';
export { CnFirstValueTour, tourCards, type CnFirstValueTourProps, type CnTourCard } from './CnFirstValueTour';
export { CnFirstValueScreen, useCnAiAllowed, type CnFirstValueScreenProps } from './CnFirstValueScreen';
export { OpportunityPanel } from './OpportunityPanel';
export {
  CnOnboardingApiProvider,
  campusOpenFrom,
  cnSnapshotView,
  defaultCnOnboardingApi,
  payFromOnboarding,
  snapshotScope,
  useCnOnboardingApi,
  type CnOnboardingApi,
  type CnPayView,
  type CnProgramList,
  type CnSnapshotQuery,
  type CnSnapshotScope,
  type CnSnapshotView,
} from './api';
export { defaultGraduationClass, currentCampusClass, formatMonthlyK } from './logic';

export const CN_ONBOARDING_STEP_COMPONENTS: Readonly<Record<CnOnboardingStep, ComponentType<CnOnboardingStepProps>>> = {
  consent: ConsentStep,
  identity: IdentityStep,
  education: EducationStep,
  intent: IntentStep,
  tags: TagsStep,
  confirm: CnConfirmStep,
};
