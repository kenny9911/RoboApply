'use client';

// G2 你的身份 (/onboarding/identity) — PRODUCT_PLAN.md §4.5 G2. No Skip.
// 应届/在校 pick a 届别 (default: the current campus class, Oct 2026 →
// 2027届; 在校 the class after) and month (default 6); 社招 pick years of
// experience and 求职状态.

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { CnOnboardingStepProps } from './types';
import { ChoiceChips, SelectField, StepFrame, useSaveStep, useStoredAnswers } from './parts';
import {
  CN_IDENTITIES,
  CN_JOB_SEARCH_STATUS,
  CN_YEARS_EXPERIENCE,
  CN_DEFAULT_GRADUATION_MONTH,
  classYearOptions,
  defaultGraduationClass,
  isStudent,
  stepAnswers,
  type CnIdentity,
} from './logic';
import styles from './OnboardingCn.module.css';

type Years = (typeof CN_YEARS_EXPERIENCE)[number];
type Status = (typeof CN_JOB_SEARCH_STATUS)[number];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
/** Bundle keys for the years options (message keys avoid '-' and '+'). */
const YEARS_KEY: Record<Years, string> = { lt1: 'lt1', '1-3': 'y1to3', '3-5': 'y3to5', '5-10': 'y5to10', '10+': 'y10plus' };

export function IdentityStep({ onDone, onBack }: CnOnboardingStepProps) {
  const t = useTranslations('onboardingCn');
  const format = useFormatter();
  const { answers, loaded } = useStoredAnswers();
  const [identity, setIdentity] = useState<CnIdentity | null>(null);
  const [classYear, setClassYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number | null>(CN_DEFAULT_GRADUATION_MONTH);
  const [years, setYears] = useState<Years | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const { save, saving, error } = useSaveStep('identity', onDone);

  useEffect(() => {
    if (!loaded) return;
    const prev = stepAnswers(answers, 'identity');
    if (!prev.cnIdentity) return;
    setIdentity(prev.cnIdentity as CnIdentity);
    if (typeof prev.graduationClass === 'number') setClassYear(prev.graduationClass);
    if (typeof prev.graduationMonth === 'number') setMonth(prev.graduationMonth);
    if (typeof prev.yearsExperience === 'string') setYears(prev.yearsExperience as Years);
    if (typeof prev.jobSearchStatus === 'string') setStatus(prev.jobSearchStatus as Status);
  }, [answers, loaded]);

  function pick(id: CnIdentity) {
    setIdentity(id);
    // The default 届别 follows the identity until the user picks one.
    if (isStudent(id) && (classYear === null || identity !== id)) setClassYear(defaultGraduationClass(id));
  }

  const student = isStudent(identity);
  const valid = identity !== null && (student ? classYear !== null : years !== null && status !== null);

  return (
    <StepFrame
      title={t('identity.title')}
      onBack={onBack}
      nextDisabled={!valid}
      disabledHint={identity === null ? t('identity.needIdentity') : t('common.needRequired')}
      saving={saving}
      error={error}
      onSubmit={() =>
        void save(
          student
            ? { cnIdentity: identity, graduationClass: classYear, ...(month ? { graduationMonth: month } : {}) }
            : { cnIdentity: identity, yearsExperience: years, jobSearchStatus: status },
        )
      }
    >
      <div className={styles.cards} role="radiogroup" aria-label={t('identity.title')}>
        {CN_IDENTITIES.map((id) => (
          <button key={id} type="button" role="radio" aria-checked={identity === id} className={styles.card} onClick={() => pick(id)}>
            <span className={styles.cardTitle}>{t(`identity.option.${id}.title`)}</span>
            <span className={styles.cardBody}>{t(`identity.option.${id}.body`)}</span>
          </button>
        ))}
      </div>

      {student ? (
        <div className={styles.row}>
          <SelectField
            label={t('identity.classLabel')}
            value={classYear}
            options={classYearOptions()}
            onChange={setClassYear}
            render={(y) => t('identity.classOption', { year: y })}
          />
          <SelectField
            label={t('identity.monthLabel')}
            value={month}
            options={MONTHS}
            onChange={setMonth}
            render={(m) => format.dateTime(new Date(Date.UTC(2000, m - 1, 15)), { month: 'long', timeZone: 'UTC' })}
          />
        </div>
      ) : null}

      {identity === 'shezhao' ? (
        <>
          <ChoiceChips label={t('identity.yearsLabel')} options={CN_YEARS_EXPERIENCE} value={years} onChange={setYears} render={(v) => t(`identity.years.${YEARS_KEY[v]}`)} required />
          <ChoiceChips label={t('identity.statusLabel')} options={CN_JOB_SEARCH_STATUS} value={status} onChange={setStatus} render={(v) => t(`identity.status.${v}`)} required />
        </>
      ) : null}
    </StepFrame>
  );
}
