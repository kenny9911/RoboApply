'use client';

// OnboardingStepPage — the /onboarding/<step> screen (WP-30). Owns routing
// between screens; each screen owns its fields.
//
//   - Reads GET /onboarding/state. A finished user goes to the jobs page; a
//     step beyond where the user is goes to their current step (no jumping
//     ahead; the server refuses it too).
//   - Saving: PUT /onboarding/steps/:step, then the server's `nextRoute`.
//     O7 uses POST /onboarding/confirm. Back goes to the previous screen of
//     this brand and branch and keeps the answers (they are re-read from the
//     server state). Back never lands on O6 (it runs on arrival), so Back on
//     O7 goes to O5.
//   - "Finish later" (POST /onboarding/skip) lands on the jobs page with the
//     "Finish setting up" banner.
//   - GoApply screens (consent … tags, cn confirm) come from
//     components/features/onboarding-cn (WP-31); resume and matching are
//     shared. On GoApply (INT-08):
//       · a cn step saves through its own request, so the page reads the
//         state again before it moves on (the next screen must not see the
//         old stage and bounce back);
//       · the resume screen sits inside `CnResumeGate`: without the AI
//         processing consent there is no upload, and "fill in by hand" skips
//         the step (the gate shows that save's busy state and its error);
//       · the confirm screen gets the real count from "Finding jobs"
//         (`matchSummary`) when the jobs were compared with the profile;
//       · after confirm the first-value screen (`CnFirstValueScreen`: deadline
//         reminders, then the tour) shows here; finishing it completes
//         onboarding and goes to the first-value route.
//   - A finished user goes to the server's `firstValueRoute` (RoboApply: /jobs).
//   - First-party events: onboarding_step_viewed / _completed / _abandoned.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import {
  onboardingErrorReason,
  onboardingKeys,
  useCompleteOnboarding,
  useConfirmOnboarding,
  useLeaveOnboarding,
  useOnboardingState,
  useSaveStep,
  type OnboardingState,
} from '../../../hooks/onboarding/useOnboarding';
import { useAuth } from '../../../lib/auth/useAuth';
import { track } from '../../../lib/analytics';
import { useBrandId } from '../../../lib/brand/BrandProvider';
import { Btn } from '../../v3/primitives/Btn';
import {
  CN_ONBOARDING_STEP_COMPONENTS,
  CnFirstValueScreen,
  CnResumeGate,
  isCnOnboardingStep,
  type CnMatchSummary,
  type CnOnboardingStepProps,
} from '../onboarding-cn';
import { screensFor, stageOrder } from './flow';
import { BasicsStep } from './steps/BasicsStep';
import { ConfirmStep } from './steps/ConfirmStep';
import { GoalStep } from './steps/GoalStep';
import { MatchingStep } from './steps/MatchingStep';
import { PreferencesStep } from './steps/PreferencesStep';
import { ResumeStep } from './steps/ResumeStep';
import { SituationStep } from './steps/SituationStep';
import type { StepScreenProps } from './types';
import styles from './onboarding.module.css';

const ROBOAPPLY_SCREENS: Record<string, ComponentType<StepScreenProps>> = {
  situation: SituationStep,
  basics: BasicsStep,
  goal: GoalStep,
  preferences: PreferencesStep,
  resume: ResumeStep,
  confirm: ConfirmStep,
};

/**
 * The count "Finding jobs" stored, for the GoApply confirm screen. Only a
 * finished run that compared the jobs with the profile AND a resume counts
 * (that screen words it "at Good fit or better"): a run still going in the
 * background, one that did not use the profile (个性化推荐 off:
 * `ranked: false`), or one with no resume to compare (`resumeCompared: false`)
 * leaves the screen on its own index counts.
 */
export function matchSummaryOf(state: Pick<OnboardingState, 'answers'>): CnMatchSummary | null {
  const m = (state.answers as Record<string, unknown>).matching as
    | { jobCount?: unknown; topJobIds?: unknown; continuedInBackground?: unknown; ranked?: unknown; resumeCompared?: unknown }
    | undefined;
  if (!m || typeof m.jobCount !== 'number' || m.continuedInBackground === true || m.ranked === false || m.resumeCompared === false) return null;
  return { jobCount: m.jobCount, ...(Array.isArray(m.topJobIds) ? { topJobIds: m.topJobIds.filter((x): x is string => typeof x === 'string') } : {}) };
}

export function OnboardingStepPage({ step }: { step: string }) {
  const t = useTranslations('onboarding.frame');
  const router = useRouter();
  const brandId = useBrandId();
  const { refresh } = useAuth();
  const stateQuery = useOnboardingState();
  const saveStep = useSaveStep();
  const confirm = useConfirmOnboarding();
  const leave = useLeaveOnboarding();
  const complete = useCompleteOnboarding();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // GoApply: the first-value screen is open (the confirm step was just saved).
  const [cnTour, setCnTour] = useState(false);
  // Onboarding is finished: where to go (wins over every other redirect).
  const [exitRoute, setExitRoute] = useState<string | null>(null);
  const mountedAt = useRef(Date.now());
  const viewed = useRef<string | null>(null);

  const state = stateQuery.data;
  const screens = useMemo(() => (state ? screensFor(state.brand, state.branch) : []), [state]);
  const index = screens.indexOf(step);
  const position = index >= 0 ? { current: index + 1, total: screens.length } : null;

  // Where the user may be: finished → landing; ahead of their stage → their stage.
  const redirect = useMemo(() => {
    if (exitRoute) return exitRoute;
    if (!state) return null;
    if (state.completed) return state.firstValueRoute ?? '/jobs';
    if (state.stage !== 'done' && state.stage !== 'tour' && stageOrder(step) > stageOrder(state.stage) && state.nextRoute) return state.nextRoute;
    if (index < 0 && state.nextRoute) return state.nextRoute;
    return null;
  }, [state, step, index, exitRoute]);

  useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

  useEffect(() => {
    if (!state || redirect || viewed.current === step) return;
    viewed.current = step;
    mountedAt.current = Date.now();
    setError(null);
    track('onboarding_step_viewed', { stage: step, branch: state.branch });
  }, [state, redirect, step]);

  const go = useCallback(
    (route: string | null) => {
      if (!route) return;
      if (!route.startsWith('/onboarding')) void refresh?.();
      router.push(route);
    },
    [refresh, router],
  );

  const onSaved = useCallback(
    (route: string | null, skipped: boolean, s: OnboardingState) => {
      track('onboarding_step_completed', { stage: step, durationMs: Date.now() - mountedAt.current, skipped, branch: s.branch });
      go(route);
    },
    [go, step],
  );

  const save = useCallback(
    (body: Record<string, unknown>, options: { skip?: boolean } = {}) => {
      if (!state) return;
      setError(null);
      const payload = options.skip ? { ...body, skip: true } : body;
      const done = (route: string | null) => onSaved(route, !!options.skip, state);
      const fail = (err: unknown) => setError(t(`errors.${onboardingErrorReason(err)}`));
      if (step === 'confirm' && brandId === 'roboapply') {
        confirm.mutate(payload, { onSuccess: (r) => done(r.nextRoute), onError: fail });
      } else {
        saveStep.mutate({ step, body: payload }, { onSuccess: (r) => done(r.nextRoute), onError: fail });
      }
    },
    [state, step, brandId, confirm, saveStep, onSaved, t],
  );

  // Back skips O6 ("Finding jobs" runs on arrival and moves on by itself), so O7's Back reaches O5.
  const backTarget = useMemo(() => {
    const answerScreens = screens.filter((s) => s !== 'matching');
    const i = answerScreens.indexOf(step);
    return i > 0 ? answerScreens[i - 1] : null;
  }, [screens, step]);
  const onBack = backTarget ? () => router.push(`/onboarding/${backTarget}`) : undefined;
  const onLeave = useCallback(() => {
    if (!state) return;
    leave.mutate(
      { stage: step, branch: state.branch },
      { onSuccess: (r) => go(r.nextRoute ?? '/jobs'), onError: (err) => setError(t(`errors.${onboardingErrorReason(err)}`)) },
    );
  }, [leave, state, step, go, t]);

  const onMatchingDone = useCallback(() => {
    track('onboarding_step_completed', { stage: 'matching', durationMs: Date.now() - mountedAt.current, skipped: false, branch: state?.branch ?? null });
    // Read the new stage (and the stored count) first: the confirm screen must not start from the old one and send the user back here.
    void stateQuery.refetch().finally(() => router.push('/onboarding/confirm'));
  }, [router, state?.branch, stateQuery]);

  // One object per state read (the confirm screen reloads its counts when this changes).
  const cnMatchSummary = useMemo(() => (state ? matchSummaryOf(state) : null), [state]);

  // GoApply steps save through their own request: read the state again, then move on.
  const onCnSaved = useCallback(
    (route: string | null, s: OnboardingState) => {
      void qc
        .invalidateQueries({ queryKey: onboardingKeys.state() })
        .catch(() => undefined)
        .then(() => onSaved(route, false, s));
    },
    [qc, onSaved],
  );

  // GoApply: the confirm step is saved; the first-value screen opens in place.
  const onCnConfirmed = useCallback(
    (s: OnboardingState) => {
      track('onboarding_step_completed', { stage: 'confirm', durationMs: Date.now() - mountedAt.current, skipped: false, branch: s.branch });
      setError(null);
      setCnTour(true);
      void qc.invalidateQueries({ queryKey: onboardingKeys.state() }).catch(() => undefined);
    },
    [qc],
  );

  // GoApply: the tour is finished or dismissed → stage done → the first-value route.
  const onCnTourFinished = useCallback(() => {
    if (complete.isPending) return;
    setError(null);
    complete.mutate(undefined, {
      onSuccess: (r) => {
        void refresh?.();
        setExitRoute(r.nextRoute ?? state?.firstValueRoute ?? '/jobs');
      },
      onError: (err) => setError(t(`errors.${onboardingErrorReason(err)}`)),
    });
  }, [complete, refresh, state?.firstValueRoute, t]);

  if (stateQuery.isLoading) {
    return (
      <p className={styles.frame} role="status">
        {t('loading')}
      </p>
    );
  }
  if (stateQuery.isError || !state) {
    return (
      <div className={styles.frame} role="alert">
        <p className={styles.error}>{t('loadError')}</p>
        <div>
          <Btn type="button" onClick={() => void stateQuery.refetch()} className={styles.touch}>
            {t('retry')}
          </Btn>
        </div>
      </div>
    );
  }
  if (redirect) return null;

  const busy = saveStep.isPending || confirm.isPending || leave.isPending || complete.isPending;

  if (step === 'matching') {
    return <MatchingStep state={state} onDone={onMatchingDone} onLeave={onLeave} position={position} />;
  }

  if (brandId === 'goapply') {
    // After G7: deadline reminders and the tour, here, then on to the first-value page.
    if (step === 'confirm' && (cnTour || state.stage === 'tour')) {
      return <CnFirstValueScreen onFinish={onCnTourFinished} error={error} />;
    }
    if (step === 'resume') {
      // Reading a resume uses AI: without the consent there is no upload, only "fill in by hand" (the step is skipped).
      return (
        <CnResumeGate onManual={() => save({}, { skip: true })} busy={busy} error={error}>
          <ResumeStep state={state} save={save} onBack={onBack} onLeave={onLeave} busy={busy} error={error} position={position} />
        </CnResumeGate>
      );
    }
    if (isCnOnboardingStep(step)) {
      const Cn: ComponentType<CnOnboardingStepProps> = CN_ONBOARDING_STEP_COMPONENTS[step];
      return (
        <Cn
          step={step}
          onDone={(r) => (step === 'confirm' ? onCnConfirmed(state) : onCnSaved(r.nextRoute, state))}
          onBack={onBack}
          onSkip={step === 'tags' ? () => save({}, { skip: true }) : undefined}
          matchSummary={step === 'confirm' ? cnMatchSummary : undefined}
        />
      );
    }
  }

  const Screen = ROBOAPPLY_SCREENS[step] ?? (step === 'resume' ? ResumeStep : null);
  if (!Screen) return null;
  return <Screen state={state} save={save} onBack={onBack} onLeave={onLeave} busy={busy} error={error} position={position} />;
}

export default OnboardingStepPage;
