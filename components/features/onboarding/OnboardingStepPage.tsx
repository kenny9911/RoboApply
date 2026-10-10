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
//     shared.
//   - First-party events: onboarding_step_viewed / _completed / _abandoned.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import {
  onboardingErrorReason,
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
import { CN_ONBOARDING_STEP_COMPONENTS, isCnOnboardingStep, type CnOnboardingStepProps } from '../onboarding-cn';
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

export function OnboardingStepPage({ step }: { step: string }) {
  const t = useTranslations('onboarding.frame');
  const router = useRouter();
  const brandId = useBrandId();
  const { refresh } = useAuth();
  const stateQuery = useOnboardingState();
  const saveStep = useSaveStep();
  const confirm = useConfirmOnboarding();
  const leave = useLeaveOnboarding();
  const [error, setError] = useState<string | null>(null);
  const mountedAt = useRef(Date.now());
  const viewed = useRef<string | null>(null);

  const state = stateQuery.data;
  const screens = useMemo(() => (state ? screensFor(state.brand, state.branch) : []), [state]);
  const index = screens.indexOf(step);
  const position = index >= 0 ? { current: index + 1, total: screens.length } : null;

  // Where the user may be: finished → landing; ahead of their stage → their stage.
  const redirect = useMemo(() => {
    if (!state) return null;
    if (state.completed) return '/jobs';
    if (state.stage !== 'done' && state.stage !== 'tour' && stageOrder(step) > stageOrder(state.stage) && state.nextRoute) return state.nextRoute;
    if (index < 0 && state.nextRoute) return state.nextRoute;
    return null;
  }, [state, step, index]);

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
    void stateQuery.refetch();
    track('onboarding_step_completed', { stage: 'matching', durationMs: Date.now() - mountedAt.current, skipped: false, branch: state?.branch ?? null });
    router.push('/onboarding/confirm');
  }, [router, state?.branch, stateQuery]);

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

  const busy = saveStep.isPending || confirm.isPending || leave.isPending;

  if (step === 'matching') {
    return <MatchingStep state={state} onDone={onMatchingDone} onLeave={onLeave} position={position} />;
  }

  if (brandId === 'goapply' && isCnOnboardingStep(step)) {
    const Cn: ComponentType<CnOnboardingStepProps> = CN_ONBOARDING_STEP_COMPONENTS[step];
    return (
      <Cn
        step={step}
        onDone={(r) => onSaved(r.nextRoute, false, state)}
        onBack={onBack}
        onSkip={step === 'tags' ? () => save({}, { skip: true }) : undefined}
      />
    );
  }

  const Screen = ROBOAPPLY_SCREENS[step] ?? (step === 'resume' ? ResumeStep : null);
  if (!Screen) return null;
  return <Screen state={state} save={save} onBack={onBack} onLeave={onLeave} busy={busy} error={error} position={position} />;
}

export default OnboardingStepPage;
