'use client';

// G3 教育背景 (/onboarding/education) — PRODUCT_PLAN.md §4.5 G3.
//
// 学历 and the school are required for 应届/在校; 社招 may skip. 统招 is an
// optional yes / no question with no preselection: an unanswered question is
// saved as no answer, never as "yes". The school
// typeahead runs over data/schools.json (the 985 / 211 / 双一流 lists; its
// source line says when it has not been checked against the official files);
// free text is always allowed. 下一步 waits until the stored answers load, so
// the required-field rule for 应届/在校 is known. 985 / 211 / 双一流 marks are shown as
// information only — they are never a ranking input. "海外院校" switches the
// field to free text with no marks.

import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { CnSchool } from '../../../lib/api/contracts/onboarding-cn';
import type { CnOnboardingStepProps } from './types';
import { ChoiceChips, StepFrame, SwitchRow, YesNoChips, useSaveStep, useStoredAnswers } from './parts';
import { CN_DEGREE_OPTIONS, identityOf, isStudent, stepAnswers } from './logic';
import { exactSchool, filterSchools, loadCnPlaceData, type CnPlaceData } from './places';
import styles from './OnboardingCn.module.css';

type Degree = (typeof CN_DEGREE_OPTIONS)[number];

export function SchoolTags({ tags }: { tags: readonly string[] }) {
  const t = useTranslations('onboardingCn');
  if (!tags.length) return null;
  return (
    <span className={styles.tags}>
      {tags.map((tag) => (
        <span key={tag} className={styles.tag}>
          {t(`education.tag.${tag === 'double_first_class' ? 'doubleFirstClass' : `t${tag}`}`)}
        </span>
      ))}
    </span>
  );
}

export function EducationStep({ step, onDone, onBack }: CnOnboardingStepProps) {
  const t = useTranslations('onboardingCn');
  const ids = useId();
  const { answers, loaded } = useStoredAnswers();
  const [data, setData] = useState<CnPlaceData | null>(null);
  const [degree, setDegree] = useState<Degree | null>(null);
  const [fullTime, setFullTime] = useState<boolean | null>(null);
  const [overseas, setOverseas] = useState(false);
  const [school, setSchool] = useState('');
  const [picked, setPicked] = useState<CnSchool | null>(null);
  const [major, setMajor] = useState('');
  const [open, setOpen] = useState(false);
  const { save, saving, error } = useSaveStep('education', onDone);

  useEffect(() => {
    let live = true;
    loadCnPlaceData()
      .then((d) => live && setData(d))
      .catch(() => undefined); // Free text still works without the list.
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const prev = stepAnswers(answers, 'education');
    if (prev.skip) return;
    if (typeof prev.degree === 'string') setDegree(prev.degree as Degree);
    if (typeof prev.fullTime === 'boolean') setFullTime(prev.fullTime);
    if (typeof prev.overseas === 'boolean') setOverseas(prev.overseas);
    if (typeof prev.school === 'string') setSchool(prev.school);
    if (typeof prev.major === 'string') setMajor(prev.major);
  }, [answers, loaded]);

  // Re-attach the listed school (marks) when the text equals a listed name.
  useEffect(() => {
    if (!data || overseas) return setPicked(null);
    setPicked(exactSchool(data.schools, school));
  }, [data, school, overseas]);

  const identity = identityOf(answers);
  const student = isStudent(identity);
  const suggestions = useMemo(() => (data && !overseas && open ? filterSchools(data.schools, school) : []), [data, overseas, open, school]);
  const valid = !student || (degree !== null && school.trim().length > 0);

  function body() {
    return {
      ...(degree ? { degree } : {}),
      ...(fullTime !== null ? { fullTime } : {}),
      overseas,
      ...(school.trim() ? { school: school.trim() } : {}),
      ...(picked ? { schoolId: picked.id } : {}),
      ...(major.trim() ? { major: major.trim() } : {}),
    };
  }

  return (
    <StepFrame
      step={step}
      title={t('education.title')}
      subtitle={student ? undefined : t('education.subtitleOptional')}
      onBack={onBack}
      onSkip={identity === 'shezhao' ? () => void save({ skip: true }) : undefined}
      nextDisabled={!loaded || !valid}
      disabledHint={t('common.needRequired')}
      saving={saving}
      error={error}
      onSubmit={() => void save(body())}
    >
      <ChoiceChips label={t('education.degreeLabel')} options={CN_DEGREE_OPTIONS} value={degree} onChange={setDegree} render={(v) => t(`education.degree.${v}`)} required={student} />
      <YesNoChips label={t('education.fullTime')} value={fullTime} onChange={setFullTime} yes={t('education.fullTimeYes')} no={t('education.fullTimeNo')} hint={t('education.fullTimeHint')} />

      <div className={styles.field}>
        <label htmlFor={`${ids}-school`} className={styles.fieldLabel}>
          {t('education.schoolLabel')}
          {student ? <span className={styles.required}>{t('common.required')}</span> : null}
        </label>
        <div className={styles.combo}>
          <input
            id={`${ids}-school`}
            className={styles.input}
            value={school}
            maxLength={120}
            autoComplete="off"
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls={`${ids}-schools`}
            aria-autocomplete="list"
            placeholder={overseas ? t('education.schoolOverseasPlaceholder') : t('education.schoolPlaceholder')}
            onChange={(e) => {
              setSchool(e.target.value);
              setOpen(true);
            }}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
          {suggestions.length ? (
            <ul id={`${ids}-schools`} role="listbox" className={styles.options} aria-label={t('education.schoolLabel')}>
              {suggestions.map((s) => (
                <li key={s.id} role="option" aria-selected={picked?.id === s.id}>
                  <button
                    type="button"
                    className={styles.option}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSchool(s.name);
                      setOpen(false);
                    }}
                  >
                    <span>
                      {s.name} <span className={styles.optionMeta}>{s.province}</span>
                    </span>
                    <SchoolTags tags={s.tags} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {picked ? (
          <p className={styles.note}>
            <SchoolTags tags={picked.tags} /> {t('education.tagNote')}
          </p>
        ) : (
          <p className={styles.note}>{overseas ? t('education.overseasHint') : t('education.freeTextHint')}</p>
        )}
        {data && !overseas ? (
          <p className={styles.note}>
            {data.schoolsSource.verified && data.schoolsSource.asOf
              ? t('education.source', { source: data.schoolsSource.name, date: data.schoolsSource.asOf })
              : t('education.sourceUnverified')}
          </p>
        ) : null}
      </div>

      <SwitchRow label={t('education.overseas')} checked={overseas} onChange={setOverseas} />

      <div className={styles.field}>
        <label htmlFor={`${ids}-major`} className={styles.fieldLabel}>
          {t('education.majorLabel')}
        </label>
        <input id={`${ids}-major`} className={styles.input} value={major} maxLength={120} onChange={(e) => setMajor(e.target.value)} placeholder={t('education.majorPlaceholder')} />
      </div>
    </StepFrame>
  );
}
