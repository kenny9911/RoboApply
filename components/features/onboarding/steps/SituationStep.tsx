'use client';

// O1 — Your situation (PRODUCT §4.3). Two single-select questions, no Skip;
// Next is enabled once both are answered. Timing decides the branch
// (as soon as possible → urgent; otherwise explore).

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { SEEKER_TYPES, TIMINGS } from '../options';
import { StepFrame } from '../StepFrame';
import { answersOf, type StepScreenProps } from '../types';
import styles from '../onboarding.module.css';

type Answers = { timing: (typeof TIMINGS)[number]; seekerType: (typeof SEEKER_TYPES)[number] };

export function SituationStep({ state, save, onLeave, busy, error, position }: StepScreenProps) {
  const t = useTranslations('onboarding.situation');
  const prev = answersOf<Answers>(state, 'situation');
  const [timing, setTiming] = useState<Answers['timing'] | null>(prev.timing ?? null);
  const [seekerType, setSeekerType] = useState<Answers['seekerType'] | null>(prev.seekerType ?? null);
  const ready = !!timing && !!seekerType;

  return (
    <StepFrame
      title={t('title')}
      position={position}
      busy={busy}
      error={error}
      onLeave={onLeave}
      nextDisabled={!ready}
      onNext={() => ready && save({ timing, seekerType })}
    >
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('timingLabel')}</legend>
        <div className={styles.cards} role="radiogroup" aria-label={t('timingLabel')}>
          {TIMINGS.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={timing === v} className={styles.card} onClick={() => setTiming(v)}>
              {t(`timing.${v}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('seekerLabel')}</legend>
        <div className={styles.chips} role="radiogroup" aria-label={t('seekerLabel')}>
          {SEEKER_TYPES.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={seekerType === v} className={styles.chip} onClick={() => setSeekerType(v)}>
              {t(`seekerType.${v}`)}
            </button>
          ))}
        </div>
      </fieldset>
      {!ready ? <p className={styles.hint}>{t('required')}</p> : null}
    </StepFrame>
  );
}
