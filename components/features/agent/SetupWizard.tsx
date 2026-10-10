'use client';

// SetupWizard — /ready/setup (PRODUCT F-AGENT-02, ruling C13): five steps,
// any of which can be opened again later (Settings on /ready links to
// `#weekly`; the profile's "Application answers" links to `#answers`).
//
//   1 Confirm profile · 2 Check your search · 3 Application answers ·
//   4 Weekly settings · 5 Get the extension (skippable)
//
// "Get the extension" is a step only where the extension can be installed:
// the `extension` capability AND a published extension for this brand
// (`extensionIdFor`). Without one the step would offer nothing but Back and
// Skip. The server may still count it as a step (it only knows the
// capability); finishing the last step shown here then skips it there, so
// setup is finished either way.
//
// The current step starts at the URL hash, else at the step the server says
// is next (`GET /agent/setup`) — read once the answer has ARRIVED: the query
// is disabled until the capabilities are known, and a disabled query is "not
// loading" with no data, which used to open step 1 on every return. A step is
// marked done only from the server's checks (or, for answers, from the saved
// bank).
//
// Continue reports the step to the server (POST /agent/setup/step); "Skip for
// now" on "Get the extension" skips it. "Check your search" needs 3 ratings,
// except when there is nothing to rate (no jobs for the search, or the jobs
// list is off for this account): then the button says "Rate jobs later" and
// the step is left open instead of blocking the steps after it. The last step
// finishes setup on the server, which then makes the first weekly list;
// Finish goes to /ready.
// Leaving the answers or weekly step with unsaved changes saves them first,
// so no edit is dropped silently.
//
// Steps are finished in order on the server. Continue on a later step (for
// example after arriving at `#answers` from the profile) gets
// `setup_step_out_of_order` with the step still open: the wizard says so in
// plain words and offers to go there; what was saved on this step stays saved.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { Btn, HonestyLine, PageHeader, toast } from '../../v3/primitives';
import { useCapabilities, useFlag } from '../../../lib/flags';
import { useBrandId } from '../../../lib/brand/BrandProvider';
import { extensionIdFor } from '../../../hooks/extension';
import { apiErrorDetails, apiErrorReason } from '../../../lib/api/contracts/wire';
import { agentKeys, isUnavailable, useAgentSetup, useAnswerBank, useCompleteSetupStep } from '../../../hooks/agent';
import type { AgentSetupResponse } from '../../../lib/api/contracts/agent';
import { SETUP_STEPS } from './options';
import { cn } from '../../../lib/utils';
import { AnswersEditor, type StepFormHandle } from './AnswersEditor';
import { ReadyUnavailable } from './ReadyPage';
import { SetupCalibrateStep, SetupExtensionStep, SetupProfileStep } from './SetupSteps';
import { WeeklySettingsForm } from './WeeklySettingsForm';
import styles from './ready.module.css';

export type WizardStep = 'profile' | 'calibrate' | 'answers' | 'weekly' | 'extension';

/** Setup checks, plus the optional counts WP-52 adds (mirror until its contract merges). */
type AgentSetupChecks = AgentSetupResponse['checks'] & {
  calibrationCount?: number;
  answersCount?: number;
  weeklySaved?: boolean;
  extensionAvailable?: boolean;
};
const ALL_STEPS: readonly WizardStep[] = ['profile', 'calibrate', 'answers', 'weekly', 'extension'];

/**
 * The steps shown here: "Get the extension" only when the extension can be
 * installed (the `extension` capability and a published extension for the
 * brand). Pure.
 */
export function wizardSteps(extensionInstallable: boolean): WizardStep[] {
  return ALL_STEPS.filter((s) => s !== 'extension' || extensionInstallable);
}

/** Why Continue failed, in the words the wizard shows. Pure. */
export type StepFailure = { kind: 'out_of_order'; step: WizardStep | null } | { kind: 'calibration' } | { kind: 'not_skippable' } | { kind: 'generic' };
export function stepFailureOf(err: unknown, steps: readonly WizardStep[]): StepFailure {
  const reason = apiErrorReason(err);
  if (reason === 'setup_step_out_of_order') {
    const step = apiErrorDetails<{ step?: unknown }>(err)?.step;
    return { kind: 'out_of_order', step: typeof step === 'string' && (steps as readonly string[]).includes(step) ? (step as WizardStep) : null };
  }
  if (reason === 'calibration_incomplete') return { kind: 'calibration' };
  if (reason === 'setup_step_not_skippable') return { kind: 'not_skippable' };
  return { kind: 'generic' };
}

/**
 * The step to open: a valid hash wins, else the server's next step (done →
 * the first step). The server's "Get the extension" where that step is not
 * shown opens the last step: its Finish button closes setup. Pure.
 */
export function initialStep(hash: string, serverStep: string | undefined, steps: readonly WizardStep[]): WizardStep {
  const fromHash = hash.replace(/^#/, '');
  if ((steps as readonly string[]).includes(fromHash)) return fromHash as WizardStep;
  if (serverStep && (steps as readonly string[]).includes(serverStep)) return serverStep as WizardStep;
  if (serverStep === 'extension') return steps[steps.length - 1]!;
  return steps[0]!;
}

function readHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

export function SetupWizard() {
  const t = useTranslations('ready');
  const router = useRouter();
  const qc = useQueryClient();
  const { status } = useCapabilities();
  const on = useFlag('agent');
  const extensionOn = useFlag('extension');
  const brand = useBrandId();
  // The step exists only where there is something to install.
  const extensionInstallable = extensionOn && !!extensionIdFor(brand);
  const setup = useAgentSetup({ enabled: on });
  const bank = useAnswerBank({ enabled: on });
  const complete = useCompleteSetupStep();
  const steps = useMemo(() => wizardSteps(extensionInstallable), [extensionInstallable]);
  /** Jobs still to rate on "Check your search" (null until its list has loaded). */
  const [ratingsLeft, setRatingsLeft] = useState<number | null>(null);
  const [step, setStepState] = useState<WizardStep | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  /** The earlier step the server says is still open (Continue was out of order). */
  const [openStep, setOpenStep] = useState<WizardStep | null>(null);
  const [leaving, setLeaving] = useState(false);
  const formRef = useRef<StepFormHandle | null>(null);

  // Start once the server's step has arrived (or the read failed); follow later hash changes.
  // `isPending` is true for a query that is still disabled, `isLoading` is not.
  const setupSettled = setup.isSuccess || setup.isError;
  useEffect(() => {
    if (step !== null || !on || !setupSettled) return;
    setStepState(initialStep(readHash(), setup.data?.step, steps));
  }, [step, on, setupSettled, setup.data, steps]);
  useEffect(() => {
    const onHash = () => {
      const h = readHash().replace(/^#/, '');
      if ((steps as readonly string[]).includes(h)) setStepState(h as WizardStep);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [steps]);

  const show = useCallback((next: WizardStep) => {
    setStepError(null);
    setOpenStep(null);
    setStepState(next);
    if (typeof window !== 'undefined') window.history.replaceState(null, '', `#${next}`);
  }, []);

  /** Save the current step's form when it has unsaved changes; false keeps the user on the step. */
  const saveCurrent = useCallback(async (): Promise<boolean> => {
    const form = formRef.current;
    if (!form || !form.dirty()) return true;
    const ok = await form.save();
    if (!ok) setStepError(t('setup.errors.unsaved'));
    return ok;
  }, [t]);

  const go = useCallback(
    async (next: WizardStep) => {
      if (await saveCurrent()) show(next);
    },
    [saveCurrent, show],
  );

  if (!on) return status === 'loading' ? null : <ReadyUnavailable />;
  if (isUnavailable(setup.error)) return <ReadyUnavailable />;
  if (step === null) {
    return (
      <p className={styles.muted} role="status">
        {t('loading')}
      </p>
    );
  }

  const serverIndex = setup.data ? SETUP_STEPS.indexOf(setup.data.step) : -1;
  const checks = (setup.data?.checks ?? {}) as Partial<AgentSetupChecks>;
  const done: Record<WizardStep, boolean> = {
    profile: setup.data ? setup.data.checks.profileMissing.length === 0 : false,
    calibrate: checks.calibrationDone === true,
    answers: (checks.answersCount ?? bank.data?.items.length ?? 0) > 0,
    weekly: checks.weeklySaved === true || serverIndex > SETUP_STEPS.indexOf('weekly'),
    extension: checks.extensionConnected === true,
  };

  const index = steps.indexOf(step);
  const last = index === steps.length - 1;
  // "Get the extension" can be skipped; "Check your search" can be left for later when there is nothing to rate.
  const skipping = step === 'extension' && !done.extension;
  const rateLater = step === 'calibrate' && !done.calibrate && ratingsLeft === 0;
  const busy = leaving || complete.isPending;

  const next = async () => {
    setStepError(null);
    setOpenStep(null);
    setLeaving(true);
    try {
      if (!(await saveCurrent())) return;
      let firstListAdded: number | null = null;
      try {
        let r = await complete.mutateAsync({ step, action: skipping || rateLater ? 'skip' : 'complete' });
        // The server still counts "Get the extension", which is not offered here (nothing to install): skip it there.
        if (last && r.step === 'extension' && !steps.includes('extension')) r = await complete.mutateAsync({ step: 'extension', action: 'skip' });
        firstListAdded = r.firstList ? r.firstList.added : null;
      } catch (err) {
        const failure = stepFailureOf(err, steps);
        if (failure.kind === 'out_of_order') {
          setOpenStep(failure.step);
          setStepError(failure.step ? t('setup.errors.outOfOrder', { step: t(`setup.steps.${failure.step}`) }) : t('setup.errors.outOfOrderUnknown'));
        } else if (failure.kind === 'calibration') {
          // Finish found jobs to rate that were not there before: offer the way back to that step.
          if (step !== 'calibrate') setOpenStep('calibrate');
          // The server sees jobs to rate that this list does not show (yet): read the list again.
          void qc.invalidateQueries({ queryKey: agentKeys.suggestions() });
          setStepError(t('setup.errors.calibration'));
        } else if (failure.kind === 'not_skippable') setStepError(t('setup.errors.notSkippable'));
        else setStepError(t('setup.errors.generic'));
        return;
      }
      if (!last) {
        show(steps[index + 1]!);
        return;
      }
      if (firstListAdded !== null && firstListAdded > 0) toast({ message: t('setup.firstList', { count: firstListAdded }), tone: 'ok' });
      router.push('/ready');
    } finally {
      setLeaving(false);
    }
  };
  const back = async () => {
    if (!(await saveCurrent())) return;
    if (index > 0) show(steps[index - 1]!);
    else router.push('/ready');
  };

  return (
    <div className={styles.page}>
      <PageHeader title={t('setup.title')} sub={<HonestyLine kind="you_submit" />} />
      <div className={styles.wizard}>
        <nav aria-label={t('setup.stepsLabel')}>
          <ol className={styles.steps}>
            {steps.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  className={cn(styles.step, s === step && styles.stepCurrent, done[s] && styles.stepDone)}
                  aria-current={s === step ? 'step' : undefined}
                  onClick={() => void go(s)}
                  data-done={done[s] ? 'true' : undefined}
                >
                  <span className={styles.stepNumber} aria-hidden>
                    {i + 1}
                  </span>
                  <span>
                    {t(`setup.steps.${s}`)}
                    {done[s] ? <span className={styles.srOnly}> {t('setup.stepDone')}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <section className={styles.card} aria-labelledby="setup-step-title" id={step}>
          <h2 id="setup-step-title" className={styles.cardTitle}>
            {t('setup.stepHeading', { n: index + 1, total: steps.length, name: t(`setup.steps.${step}`) })}
          </h2>
          {step === 'profile' ? <SetupProfileStep /> : null}
          {step === 'calibrate' ? <SetupCalibrateStep onRemaining={setRatingsLeft} /> : null}
          {step === 'answers' ? <AnswersEditor handleRef={formRef} /> : null}
          {step === 'weekly' ? <WeeklySettingsForm handleRef={formRef} /> : null}
          {step === 'extension' ? <SetupExtensionStep /> : null}
          {stepError ? (
            <div className={styles.stack} role="alert" data-testid="setup-step-error">
              <p className={styles.error}>{stepError}</p>
              {openStep && openStep !== step ? (
                <div className={styles.row}>
                  <Btn onClick={() => void go(openStep)}>{t('setup.errors.goToStep', { step: t(`setup.steps.${openStep}`) })}</Btn>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className={styles.footer}>
            <Btn variant="ghost" onClick={() => void back()} disabled={busy}>
              {index > 0 ? t('setup.back') : t('setup.backToReady')}
            </Btn>
            <Btn variant="primary" onClick={() => void next()} disabled={busy} aria-busy={busy}>
              {skipping ? t('setup.skip') : rateLater ? t('setup.calibrate.later') : last ? t('setup.finish') : t('setup.next')}
            </Btn>
          </div>
        </section>
      </div>
    </div>
  );
}
