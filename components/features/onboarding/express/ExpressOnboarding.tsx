'use client';

// ExpressOnboarding — /onboarding/start, RoboApply's two-screen setup
// (docs/agent-driven/REDESIGN.md §4).
//
//   1. "Start with your resume"            ./ExpressResumeScreen.tsx
//   2. "Is this what you're looking for?"  ./ExpressCheckScreen.tsx
//   then "Find my jobs": the answers are saved in the server's step order and
//   the search runs, on this page (./ExpressProgress.tsx), and the user lands
//   on Today (hooks/onboarding/useExpressOnboarding.ts has the sequence).
//
// Who sees it (`expressStartExit`, ../flow.ts): a RoboApply user who has saved
// no step. A finished user goes to Today; anyone else goes to the long screen
// they are at. That is decided ONCE, from the state as it was on arrival:
// "Find my jobs" moves the server stage step by step, and a re-read of the
// state in the middle of that must not send the user away.
//
// Nothing is saved as a step before "Find my jobs". The resume screen only
// asks what the resume suggests (the server keeps that answer too); the second
// screen is filled in from it once, per resume, and after that the values are
// the user's (they survive a trip back to the resume screen and a failed save).
//
// "Finish later" is the long flow's: POST /onboarding/skip, then the jobs page
// with the "Finish setting up" entry.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useExpressOnboarding } from '../../../../hooks/onboarding/useExpressOnboarding';
import { onboardingErrorReason, useLeaveOnboarding, useOnboardingState, useResumeSeedResult } from '../../../../hooks/onboarding/useOnboarding';
import { useTaxonomyLabelState } from '../../../../hooks/search';
import { track } from '../../../../lib/analytics';
import { useAuth } from '../../../../lib/auth/useAuth';
import { Btn } from '../../../v3/primitives/Btn';
import { expressLanding, expressSavePlan, expressStartExit } from '../flow';
import styles from '../onboarding.module.css';
import { ExpressCheckScreen } from './ExpressCheckScreen';
import { ExpressProgress } from './ExpressProgress';
import { ExpressResumeScreen } from './ExpressResumeScreen';
import {
  answersFor,
  blankForm,
  hasMatchedTitles,
  suggestedLevels,
  suggestedTitles,
  titlesAreAiSuggested,
  withSuggestions,
  type ExpressForm,
  type ResumeSuggestions,
} from './model';

/** Analytics names of the two screens (`stage` of the onboarding events). */
const SCREEN_EVENT = { resume: 'start', check: 'start_check' } as const;

export function ExpressOnboarding() {
  const t = useTranslations('onboarding.frame');
  const te = useTranslations('onboarding.express.check');
  const router = useRouter();
  const { refresh } = useAuth();
  const stateQuery = useOnboardingState();
  const leave = useLeaveOnboarding();
  const express = useExpressOnboarding();
  const seeded = useResumeSeedResult();

  const state = stateQuery.data;
  // Decided once, on the first state read (see the header): undefined = not yet.
  const [exit, setExit] = useState<string | null | undefined>(undefined);
  const [screen, setScreen] = useState<'resume' | 'check'>('resume');
  /** The chosen resume; null = none yet. */
  const [resumeId, setResumeId] = useState<string | null>(null);
  /** The resume whose suggestions are in the form. */
  const [filledFor, setFilledFor] = useState<string | null>(null);
  const [form, setForm] = useState<ExpressForm | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const shownAt = useRef(Date.now());
  const landed = useRef(false);

  const current = form ?? blankForm(state?.defaults);
  const change = useCallback(
    (patch: Partial<ExpressForm>) => setForm((f) => ({ ...(f ?? blankForm(state?.defaults)), ...patch })),
    [state?.defaults],
  );

  // What the server said about the chosen resume: this visit's answer, else the copy it keeps in the state.
  const stored = (state?.answers as Record<string, unknown> | undefined)?.resumeSuggestions as ResumeSuggestions | undefined;
  const suggestions: ResumeSuggestions | null = resumeId ? ([seeded, stored].find((s) => !!s && s.resumeVariantId === resumeId) ?? null) : null;
  // Matched titles are shown by their name in the reader's language: that needs the role list.
  const needsNames = hasMatchedTitles(suggestions);
  const names = useTaxonomyLabelState({ enabled: needsNames });

  // State that follows what was just read (set while rendering, so no screen is drawn from the old value).
  if (state && exit === undefined) setExit(expressStartExit(state));
  // The second screen is filled in from a resume once, when its suggestions (and their names) are here.
  const filling = screen === 'check' && !!resumeId && filledFor !== resumeId;
  if (filling && (!needsNames || names.ready)) {
    setForm(withSuggestions(current, suggestions, names.labels));
    setFilledFor(resumeId);
  }

  useEffect(() => {
    if (exit) router.replace(exit);
  }, [exit, router]);

  const showing = exit === null && express.status !== 'running' && express.status !== 'done' ? screen : null;
  useEffect(() => {
    if (!showing) return;
    shownAt.current = Date.now();
    track('onboarding_step_viewed', { stage: SCREEN_EVENT[showing], branch: null });
  }, [showing]);

  // Setup is closed (or left as "finish later" after a failed search): into the product.
  useEffect(() => {
    if (express.status !== 'done' || landed.current) return;
    landed.current = true;
    track('onboarding_step_completed', { stage: SCREEN_EVENT.check, durationMs: Date.now() - shownAt.current, skipped: false, branch: null });
    void refresh?.();
    router.replace(expressLanding(express.nextRoute));
  }, [express.status, express.nextRoute, refresh, router]);

  const toCheck = useCallback((id: string | null) => {
    track('onboarding_step_completed', { stage: SCREEN_EVENT.resume, durationMs: Date.now() - shownAt.current, skipped: id === null, branch: null });
    setLeaveError(null);
    setResumeId(id);
    setScreen('check');
  }, []);
  const onResume = useCallback((id: string) => toCheck(id), [toCheck]);
  const onNoResume = useCallback(() => toCheck(null), [toCheck]);

  const onLeave = useCallback(() => {
    setLeaveError(null);
    leave.mutate(
      { stage: SCREEN_EVENT[screen], branch: null },
      {
        onSuccess: (r) => {
          void refresh?.();
          router.push(r.nextRoute ?? '/jobs');
        },
        onError: (err) => setLeaveError(t(`errors.${onboardingErrorReason(err)}`)),
      },
    );
  }, [leave, screen, refresh, router, t]);

  if (stateQuery.isLoading || (state && exit === undefined)) {
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
  if (exit) return null;

  if (express.status === 'running' || express.status === 'done') {
    return <ExpressProgress stage={express.stage} phases={express.phases} titles={current.titles.map((x) => x.label)} countries={current.countries} />;
  }

  if (screen === 'resume') {
    return (
      <ExpressResumeScreen
        state={state}
        chosenId={resumeId}
        onResume={onResume}
        onNoResume={onNoResume}
        onLeave={onLeave}
        busy={leave.isPending}
        error={leaveError}
      />
    );
  }

  if (filling) {
    return (
      <p className={styles.frame} role="status">
        {te('filling')}
      </p>
    );
  }

  const fromResume = !!resumeId && filledFor === resumeId ? suggestions : null;
  const suggested = {
    titles: suggestedTitles(fromResume, names.labels).length > 0,
    titlesByAi: titlesAreAiSuggested(fromResume),
    levels: suggestedLevels(fromResume).length > 0,
  };
  return (
    <ExpressCheckScreen
      form={current}
      onChange={change}
      source={!resumeId ? 'noResume' : suggested.titles || suggested.levels ? 'suggested' : 'nothingSuggested'}
      suggested={suggested}
      onSubmit={() => {
        const answers = answersFor(current, resumeId);
        void express.run(answers, expressSavePlan(answers.situation.timing));
      }}
      onBack={() => {
        setLeaveError(null);
        // A failure belongs to the try it came from; the answers may change before the next one.
        express.clearFailure();
        setScreen('resume');
      }}
      onLeave={onLeave}
      busy={leave.isPending}
      failure={express.failure}
      leaveError={leaveError}
    />
  );
}

export default ExpressOnboarding;
