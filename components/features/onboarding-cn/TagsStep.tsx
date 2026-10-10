'use client';

// G5 更看重什么 (/onboarding/tags, skippable) — PRODUCT_PLAN.md §4.5 G5.
// Employer types (都可以 by default, and it stands alone) and "希望能解决户口".
// These are preferences, not filters: a job carries 央国企 / 外企 / 可落户 only
// when its official information says so (D3), and nothing is hidden for them.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { CnOnboardingStepProps } from './types';
import { MultiChips, StepFrame, SwitchRow, useSaveStep, useStoredAnswers } from './parts';
import { CN_EMPLOYER_TYPES, stepAnswers, toggleMulti } from './logic';
import styles from './OnboardingCn.module.css';

type EmployerType = (typeof CN_EMPLOYER_TYPES)[number];

export function TagsStep({ onDone, onBack }: CnOnboardingStepProps) {
  const t = useTranslations('onboardingCn');
  const { answers, loaded } = useStoredAnswers();
  const [types, setTypes] = useState<EmployerType[]>(['any']);
  const [hukou, setHukou] = useState(false);
  const { save, saving, error } = useSaveStep('tags', onDone);

  useEffect(() => {
    if (!loaded) return;
    const prev = stepAnswers(answers, 'tags');
    if (Array.isArray(prev.employerTypes) && prev.employerTypes.length) setTypes(prev.employerTypes as EmployerType[]);
    if (typeof prev.wantsHukou === 'boolean') setHukou(prev.wantsHukou);
  }, [answers, loaded]);

  function toggle(v: EmployerType) {
    const next = toggleMulti(types, v, { max: CN_EMPLOYER_TYPES.length, exclusive: 'any' });
    setTypes(next.length ? next : ['any']);
  }

  return (
    <StepFrame
      title={t('tags.title')}
      subtitle={t('tags.subtitle')}
      onBack={onBack}
      onSkip={() => void save({ skip: true })}
      saving={saving}
      error={error}
      onSubmit={() => void save({ employerTypes: types, wantsHukou: hukou })}
    >
      <MultiChips label={t('tags.employerLabel')} options={CN_EMPLOYER_TYPES} value={types} onToggle={toggle} render={(v) => t(`tags.employer.${v}`)} />
      <SwitchRow label={t('tags.hukou')} hint={t('tags.hukouHint')} checked={hukou} onChange={setHukou} />
      <p className={styles.note}>{t('tags.note')}</p>
    </StepFrame>
  );
}
