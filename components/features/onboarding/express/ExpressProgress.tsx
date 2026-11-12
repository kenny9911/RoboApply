'use client';

// What the start flow shows after "Find my jobs": one line that says what is
// running now (saving the answers, searching, finishing), and the search's
// five lines as the long "Finding jobs" screen shows them
// (../steps/MatchingStep.tsx: same list, same words). A line is checked only
// when the server reported that step; there is no timer and no made-up step.

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';

import type { ExpressRunStage } from '../../../../hooks/onboarding/useExpressOnboarding';
import type { MatchRunState } from '../../../../hooks/onboarding/useOnboarding';
import { IconCheck } from '../../../v3/primitives/Iconset';
import { MATCH_PHASES } from '../options';
import { StepFrame } from '../StepFrame';
import styles from '../onboarding.module.css';
import x from './express.module.css';

export interface ExpressProgressProps {
  stage: ExpressRunStage | null;
  phases: MatchRunState['phases'];
  /** The job titles being searched, for the "Searching…" line. */
  titles: string[];
  /** The chosen countries (codes), for the same line. */
  countries: string[];
}

export function ExpressProgress({ stage, phases, titles, countries }: ExpressProgressProps) {
  const t = useTranslations('onboarding.matching');
  const tc = useTranslations('onboarding.countries');
  const te = useTranslations('onboarding.express.progress');
  const status = useRef<HTMLParagraphElement | null>(null);

  // The button that started this is gone: put the keyboard and the reader on the status line.
  useEffect(() => {
    status.current?.focus();
  }, []);

  const title = titles.join(', ');
  const place = countries.map((c) => tc(c)).join(', ');
  const label = (phase: (typeof MATCH_PHASES)[number]) => {
    if (phase === 'reading' && phases.reading === 'skipped') return t('phases.readingSkipped');
    if (phase === 'searching') return title ? t('phases.searching', { title, place: place || t('anywhere') }) : t('phases.searchingGeneric');
    return t(`phases.${phase}`);
  };

  return (
    <StepFrame title={t('title')} subtitle={t('subtitle')} position={{ current: 2, total: 2 }} busy hideFooter>
      <p ref={status} tabIndex={-1} role="status" className={x.status} data-stage={stage ?? undefined}>
        {te(stage ?? 'saving')}
      </p>
      <ol className={styles.phases} aria-live="polite">
        {MATCH_PHASES.map((phase) => {
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
