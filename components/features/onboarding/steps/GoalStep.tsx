'use client';

// O3 — Your goal (explore branch only; PRODUCT §4.3). One choice in three
// groups. Next with nothing chosen says "Pick one, or skip this step."

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { GOAL_GROUPS } from '../options';
import { StepFrame } from '../StepFrame';
import { answersOf, type StepScreenProps } from '../types';
import styles from '../onboarding.module.css';

export function GoalStep({ state, save, onBack, onLeave, busy, error, position }: StepScreenProps) {
  const t = useTranslations('onboarding.goal');
  const [goal, setGoal] = useState<string | null>(answersOf<{ goal: string }>(state, 'goal').goal ?? null);
  const [missing, setMissing] = useState(false);

  return (
    <StepFrame
      title={t('title')}
      position={position}
      busy={busy}
      error={error}
      onBack={onBack}
      onLeave={onLeave}
      onSkip={() => save({}, { skip: true })}
      onNext={() => {
        if (!goal) {
          setMissing(true);
          return;
        }
        save({ goal });
      }}
    >
      {GOAL_GROUPS.map((g) => (
        <fieldset key={g.id} className={styles.fieldset}>
          <legend className={styles.groupTitle}>{t(`groups.${g.id}`)}</legend>
          <div className={styles.cards} role="radiogroup" aria-label={t(`groups.${g.id}`)}>
            {g.options.map((o) => (
              <button
                key={o}
                type="button"
                role="radio"
                aria-checked={goal === o}
                className={styles.card}
                onClick={() => {
                  setGoal(o);
                  setMissing(false);
                }}
              >
                {t(`options.${o}`)}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      {missing ? (
        <p className={styles.fieldError} role="alert">
          {t('required')}
        </p>
      ) : null}
    </StepFrame>
  );
}
