'use client';

// hooks/onboarding/useExpressOnboarding.ts — "Find my jobs" on /onboarding/start.
//
// The start flow asks everything on one screen, but the server's stage machine
// stays the authority and takes its steps in order. `run(answers, steps)`
// saves them in the order it is given (`expressSavePlan` in
// components/features/onboarding/flow.ts, the web copy of the stage order):
//
//   situation     PUT  /onboarding/steps/situation     { timing, seekerType }
//   basics        PUT  /onboarding/steps/basics        { jobFunctions, jobTypes, countries, … }
//   goal          PUT  /onboarding/steps/goal          { skip: true }   explore branch only: these two
//   preferences   PUT  /onboarding/steps/preferences   { skip: true }   stages come before `resume`
//   resume        PUT  /onboarding/steps/resume        { resumeVariantId } | { skip: true }
//   matching      POST /onboarding/match               the real phases, as the server reports them
//   confirm       POST /onboarding/confirm             { experienceLevels, alertFrequency }
//   complete      POST /onboarding/complete            → stage `done`
//
// Failure: the run stops, says which part failed and why, and keeps what was
// done. `run` again with the same answers goes on from the step that failed
// (the search is never repeated for the same answers: it is limited per hour);
// with changed answers it starts over, which the server allows (saving an
// earlier step again is an idempotent upsert).
//
// The search is best effort. A run that goes on in the background has already
// moved the stage, so setup finishes as usual. A search that failed has not:
// the server is still at `matching` and refuses `confirm` (409). The user is
// not kept here for that: setup is left as "finish later" (POST
// /onboarding/skip), so they land in the product and "Finish setting up"
// leads back to the search.

import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { completeOnboarding, confirmOnboarding, putOnboardingStep, skipOnboarding } from '../../lib/api/onboarding';
import type * as O from '../../lib/api/contracts/onboarding';
import { apiErrorCode, type In } from '../../lib/api/contracts/wire';
import { onboardingErrorReason, onboardingKeys, useOnboardingMatch, type MatchRunState } from './useOnboarding';

/** Everything "Find my jobs" saves. */
export interface ExpressAnswers {
  situation: In<typeof O.SituationStepSchema>;
  basics: In<typeof O.BasicsStepSchema>;
  /** The resume the user chose; null = none yet (the step is saved as skipped). */
  resumeVariantId: string | null;
  confirm: In<typeof O.OnboardingConfirmBodySchema>;
}

/** What is running now. */
export type ExpressRunStage = 'saving' | 'searching' | 'finishing';
/** The part of the run that failed, in the user's terms. */
export type ExpressFailedPart = 'answers' | 'resume' | 'finish';
export interface ExpressFailure {
  part: ExpressFailedPart;
  reason: ReturnType<typeof onboardingErrorReason>;
}

export interface ExpressRun {
  status: 'idle' | 'running' | 'failed' | 'done';
  stage: ExpressRunStage | null;
  /** The search's lines: each is `done` or `skipped` only once the server said so. */
  phases: MatchRunState['phases'];
  failure: ExpressFailure | null;
  /**
   * Once `status` is `done`: the route POST /onboarding/complete named, or null
   * when it named none or setup was left as "finish later".
   */
  nextRoute: string | null;
  run: (answers: ExpressAnswers, steps: readonly string[]) => Promise<void>;
  /** Forget the last failure's message (what was saved is still remembered). */
  clearFailure: () => void;
}

const PART_OF: Readonly<Record<string, ExpressFailedPart>> = {
  situation: 'answers',
  basics: 'answers',
  goal: 'answers',
  preferences: 'answers',
  resume: 'resume',
};

interface RunMemory {
  /** The answers these steps were saved for. */
  key: string;
  saved: Set<string>;
  /** The search ran for these answers and did not finish. */
  searchFailed: boolean;
}

export function useExpressOnboarding(): ExpressRun {
  const qc = useQueryClient();
  const match = useOnboardingMatch();
  const startMatch = match.start;
  const [status, setStatus] = useState<ExpressRun['status']>('idle');
  const [stage, setStage] = useState<ExpressRunStage | null>(null);
  const [failure, setFailure] = useState<ExpressFailure | null>(null);
  const [nextRoute, setNextRoute] = useState<string | null>(null);
  const memory = useRef<RunMemory>({ key: '', saved: new Set(), searchFailed: false });
  const running = useRef(false);

  const run = useCallback(
    async (answers: ExpressAnswers, steps: readonly string[]) => {
      if (running.current) return;
      running.current = true;
      const key = JSON.stringify(answers);
      if (memory.current.key !== key) memory.current = { key, saved: new Set(), searchFailed: false };
      const mem = memory.current;
      setFailure(null);
      setStatus('running');

      let at = steps[0] ?? '';
      let route: string | null = null;
      try {
        plan: for (const step of steps) {
          if (mem.saved.has(step)) continue;
          at = step;
          switch (step) {
            case 'situation':
              setStage('saving');
              await putOnboardingStep('situation', answers.situation);
              break;
            case 'basics':
              setStage('saving');
              await putOnboardingStep('basics', answers.basics);
              break;
            case 'goal':
            case 'preferences':
              // Not asked here; saved as skipped so the stage can reach `resume`.
              setStage('saving');
              await putOnboardingStep(step, { skip: true });
              break;
            case 'resume':
              setStage('saving');
              await putOnboardingStep('resume', answers.resumeVariantId ? { resumeVariantId: answers.resumeVariantId } : { skip: true });
              break;
            case 'matching': {
              setStage('searching');
              const outcome = await startMatch();
              // Cancelled by leaving the page: nothing more to do or to say.
              if (outcome.status === 'aborted') return;
              mem.searchFailed = outcome.status !== 'done';
              break;
            }
            case 'confirm':
              setStage('finishing');
              try {
                await confirmOnboarding(answers.confirm);
              } catch (err) {
                // The search did not finish, so the server is still at
                // `matching` and refuses this step. Leave setup as "finish
                // later" rather than keep the user on this screen.
                if (!(mem.searchFailed && apiErrorCode(err) === 'conflict')) throw err;
                await skipOnboarding();
                break plan;
              }
              break;
            case 'complete':
              setStage('finishing');
              route = (await completeOnboarding()).nextRoute;
              break;
            default:
              throw new Error(`Unknown setup step "${step}"`);
          }
          mem.saved.add(step);
        }
        await qc.invalidateQueries({ queryKey: onboardingKeys.state() }).catch(() => undefined);
        setNextRoute(route);
        setStatus('done');
      } catch (err) {
        setFailure({ part: PART_OF[at] ?? 'finish', reason: onboardingErrorReason(err) });
        setStatus('failed');
      } finally {
        running.current = false;
      }
    },
    [qc, startMatch],
  );

  const clearFailure = useCallback(() => {
    if (running.current) return;
    setFailure(null);
    setStatus((s) => (s === 'failed' ? 'idle' : s));
  }, []);

  return { status, stage, phases: match.phases, failure, nextRoute, run, clearFailure };
}
