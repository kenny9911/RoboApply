'use client';

// What the start flow shows after "Find my jobs", for the few seconds it
// takes: one line that says what is running now (saving the answers,
// starting the search, finishing setup), and the search's first two lines
// as the long "Finding jobs" screen words them (../steps/MatchingStep.tsx):
// the resume read and the search saved. A line is checked only when the
// server reported that step; there is no timer and no made-up step.
//
// The page does not wait for the rest of the search (docs/agent-driven/
// REDESIGN.md §9): once the server has saved what the search looks for, setup
// is finished and the Dashboard's Job search lane shows the search until its
// picks arrive. So the three lines that would only finish after the user has
// left (searching, comparing, ranking) are not shown here.

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';

import type { ExpressRunStage } from '../../../../hooks/onboarding/useExpressOnboarding';
import type { MatchRunState } from '../../../../hooks/onboarding/useOnboarding';
import { IconCheck } from '../../../v3/primitives/Iconset';
import { StepFrame } from '../StepFrame';
import styles from '../onboarding.module.css';
import x from './express.module.css';

/** The search lines this screen waits for (the rest run on after it). */
export const EXPRESS_PROGRESS_PHASES = ['reading', 'saving'] as const;

export interface ExpressProgressProps {
  stage: ExpressRunStage | null;
  phases: MatchRunState['phases'];
}

export function ExpressProgress({ stage, phases }: ExpressProgressProps) {
  const t = useTranslations('onboarding.matching');
  const te = useTranslations('onboarding.express.progress');
  const status = useRef<HTMLParagraphElement | null>(null);

  // The button that started this is gone: put the keyboard and the reader on the status line.
  useEffect(() => {
    status.current?.focus();
  }, []);

  const label = (phase: (typeof EXPRESS_PROGRESS_PHASES)[number]) =>
    phase === 'reading' && phases.reading === 'skipped' ? t('phases.readingSkipped') : t(`phases.${phase}`);

  return (
    <StepFrame title={t('title')} subtitle={t('subtitle')} position={{ current: 2, total: 2 }} busy hideFooter>
      <p ref={status} tabIndex={-1} role="status" className={x.status} data-stage={stage ?? undefined}>
        {te(stage ?? 'saving')}
      </p>
      <ol className={styles.phases} aria-live="polite">
        {EXPRESS_PROGRESS_PHASES.map((phase) => {
          const s = phases[phase];
          const done = s === 'done';
          return (
            <li key={phase} className={`${styles.phase} ${done ? styles.phaseDone : ''}`} data-phase={phase} data-state={s}>
              <span className={styles.phaseMark} aria-hidden="true">
                {done ? <IconCheck size={14} /> : null}
              </span>
              <span>{label(phase)}</span>
              <span className={styles.srOnly}>{s === 'done' ? t('phaseDone') : s === 'skipped' ? t('phaseSkipped') : t('phasePending')}</span>
            </li>
          );
        })}
      </ol>
    </StepFrame>
  );
}
