'use client';

// O6 — Finding jobs (PRODUCT §4.3). A progress list where each line is
// checked only when the server reports that step finished (SSE from
// POST /onboarding/match). No timer, no fake steps, no avatar. Side panel:
// three capability cards. On error: Try again · Continue anyway · help.

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';

import { useOnboardingMatch } from '../../../../hooks/onboarding/useOnboarding';
import { Btn } from '../../../v3/primitives/Btn';
import { IconCheck } from '../../../v3/primitives/Iconset';
import { MATCH_PHASES } from '../options';
import { StepFrame } from '../StepFrame';
import { answersOf, type StepScreenProps } from '../types';
import styles from '../onboarding.module.css';

export interface MatchingStepProps extends Pick<StepScreenProps, 'state' | 'onLeave' | 'position'> {
  /** The run finished (or continues in the background): go to the next screen. */
  onDone: () => void;
}

export function MatchingStep({ state, onDone, onLeave, position }: MatchingStepProps) {
  const t = useTranslations('onboarding.matching');
  const tc = useTranslations('onboarding.countries');
  const run = useOnboardingMatch();
  const { start } = run;

  // One run per mount (a remount aborts the old stream and starts again; the
  // server queues any work the aborted run left).
  useEffect(() => {
    void start();
  }, [start]);

  const doneFired = useRef(false);
  useEffect(() => {
    if (run.status === 'done' && !run.result?.continuedInBackground && !doneFired.current) {
      doneFired.current = true;
      onDone();
    }
  }, [run.status, run.result, onDone]);

  const basics = answersOf<{ jobFunctions: Array<{ label: string }>; countries: string[] }>(state, 'basics');
  // GoApply searches the G4 roles and cities (city names are shown as the user chose them; 不限 = no place named).
  const intent = answersOf<{ targetRoles: Array<{ label: string }>; cities: string[] }>(state, 'intent');
  const cn = state.brand === 'goapply';
  const titles = (cn ? (intent.targetRoles ?? []) : (basics.jobFunctions ?? [])).map((f) => f.label).join(', ');
  const places = cn ? (intent.cities ?? []).filter((c) => c !== 'any').join(', ') : (basics.countries ?? []).map((c) => tc(c)).join(', ');

  const label = (phase: (typeof MATCH_PHASES)[number]) => {
    if (phase === 'reading' && run.phases.reading === 'skipped') return t('phases.readingSkipped');
    if (phase === 'searching') {
      return titles ? t('phases.searching', { title: titles, place: places || t('anywhere') }) : t('phases.searchingGeneric');
    }
    return t(`phases.${phase}`);
  };

  const aside = (
    <section className={styles.capCards} aria-label={t('asideTitle')}>
      <h2 className={styles.panelTitle}>{t('asideTitle')}</h2>
      {(['tailor', 'practice', 'ready'] as const).map((k) => (
        <div key={k} className={styles.capCard}>
          <p className={styles.capTitle}>{t(`cards.${k}`)}</p>
          <p className={styles.panelText}>{t(`cards.${k}Body`)}</p>
        </div>
      ))}
    </section>
  );

  return (
    <StepFrame title={t('title')} subtitle={t('subtitle')} position={position} aside={aside} hideFooter>
      <ol className={styles.phases} aria-live="polite">
        {MATCH_PHASES.map((phase) => {
          const s = run.phases[phase];
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

      {run.status === 'done' && run.result?.continuedInBackground ? (
        <>
          <p className={styles.notice} role="status">
            {t('background')}
          </p>
          <div className={styles.row}>
            <Btn type="button" variant="primary" onClick={onDone} className={styles.touch}>
              {t('continue')}
            </Btn>
          </div>
        </>
      ) : null}

      {run.status === 'error' ? (
        <div className={styles.body} role="alert">
          <p className={styles.error}>{t('error')}</p>
          <div className={styles.row}>
            <Btn type="button" variant="primary" onClick={() => void run.start()} className={styles.touch}>
              {t('tryAgain')}
            </Btn>
            <Btn type="button" onClick={onLeave} className={styles.touch}>
              {t('continueAnyway')}
            </Btn>
          </div>
          <p className={styles.hint}>
            <a className={styles.link} href="/help">
              {t('support')}
            </a>
          </p>
        </div>
      ) : null}
    </StepFrame>
  );
}
