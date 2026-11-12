'use client';

// Screen 2 of the start flow — "Is this what you're looking for?".
//
// One screen for everything the search needs, filled in from the resume when
// there is one, every value changeable:
//   job titles (1–3)   the long flow's picker (../steps/TitlePicker.tsx)
//   experience level   the confirm screen's levels (at least one)
//   where              ./WhereFields.tsx (countries, cities, work permit, remote)
//   job type           at least one; full-time to start with
//   how soon           "As soon as possible" to start with
//   about you          one quiet line; it follows the level until the user picks
// One primary button, "Find my jobs". A missing field gets its message next to
// it and the first one gets the focus. The words of every field are the long
// screens' own (already in every language).
//
// The values live in the caller (so they survive a trip back to the resume
// screen and a failed save). A failed save is said at the top, with the way on.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { ExpressFailure } from '../../../../hooks/onboarding/useExpressOnboarding';
import { Btn } from '../../../v3/primitives/Btn';
import { EXPERIENCE_LEVELS, JOB_TYPES, SEEKER_TYPES, TIMINGS } from '../options';
import { StepFrame } from '../StepFrame';
import { TitlePicker } from '../steps/TitlePicker';
import styles from '../onboarding.module.css';
import x from './express.module.css';
import { missingFields, seekerTypeForLevels, toggled, type ExpressForm, type RequiredField } from './model';
import { WhereFields } from './WhereFields';

export interface ExpressCheckScreenProps {
  form: ExpressForm;
  onChange: (patch: Partial<ExpressForm>) => void;
  /** Where the values came from: a resume that suggested some, a resume that suggested none, or no resume. */
  source: 'suggested' | 'nothingSuggested' | 'noResume';
  /** Which fields the resume filled in (each is labelled as a suggestion). */
  suggested: { titles: boolean; titlesByAi: boolean; levels: boolean };
  /** The form is complete: save and search. */
  onSubmit: () => void;
  /** Back to the resume screen. */
  onBack: () => void;
  onLeave: () => void;
  busy: boolean;
  /** The last "Find my jobs" stopped here. */
  failure: ExpressFailure | null;
  /** A "Finish later" failure, already in plain words. */
  leaveError: string | null;
}

const SUBTITLE = { suggested: 'subtitleSuggested', nothingSuggested: 'subtitleNothingSuggested', noResume: 'subtitleNoResume' } as const;

export function ExpressCheckScreen({ form, onChange, source, suggested, onSubmit, onBack, onLeave, busy, failure, leaveError }: ExpressCheckScreenProps) {
  const t = useTranslations('onboarding.express');
  const tb = useTranslations('onboarding.basics');
  const tl = useTranslations('onboarding.confirm');
  const ts = useTranslations('onboarding.situation');
  // Messages follow the fields as they are now: each goes away when its field is filled.
  const [attempted, setAttempted] = useState(false);
  const titlesRef = useRef<HTMLDivElement | null>(null);
  const levelsRef = useRef<HTMLFieldSetElement | null>(null);
  const placesRef = useRef<HTMLFieldSetElement | null>(null);
  const typesRef = useRef<HTMLFieldSetElement | null>(null);
  const failureRef = useRef<HTMLDivElement | null>(null);

  // A failed save brings this screen back: say it where the eye and the keyboard land.
  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  const missing = attempted ? missingFields(form) : [];
  const errors = {
    titles: missing.includes('titles') ? tb('functionsRequired') : null,
    levels: missing.includes('levels') ? tl('levelsRequired') : null,
    countries: missing.includes('countries') ? tb('countriesRequired') : null,
    jobTypes: missing.includes('jobTypes') ? tb('jobTypesRequired') : null,
  };

  function submit() {
    setAttempted(true);
    const first: RequiredField | undefined = missingFields(form)[0];
    if (!first) return onSubmit();
    const group = { titles: titlesRef, levels: levelsRef, countries: placesRef, jobTypes: typesRef }[first].current;
    group?.querySelector<HTMLElement>('input, button')?.focus();
  }

  const seekerType = form.seekerType ?? seekerTypeForLevels(form.levels);

  return (
    <StepFrame
      title={t('check.title')}
      subtitle={t(`check.${SUBTITLE[source]}`)}
      position={{ current: 2, total: 2 }}
      busy={busy}
      error={leaveError}
      onBack={onBack}
      onLeave={onLeave}
      onNext={submit}
      nextLabel={t('check.submit')}
    >
      {failure ? (
        <div ref={failureRef} tabIndex={-1} role="alert" className={x.failure} data-failed={failure.part}>
          <p>
            {t(`failed.${failure.part}`)} {t(`why.${failure.reason}`)}
          </p>
          <Btn type="button" onClick={submit} disabled={busy} className={x.failureAction}>
            {t('check.retry')}
          </Btn>
        </div>
      ) : null}

      <div ref={titlesRef}>
        <TitlePicker value={form.titles} onChange={(titles) => onChange({ titles })} error={errors.titles} />
        {suggested.titles ? <p className={styles.hint}>{suggested.titlesByAi ? tl('aiSuggested') : tl('suggested')}</p> : null}
      </div>

      <fieldset className={styles.fieldset} ref={levelsRef}>
        <legend className={styles.legend}>{tl('levelsLabel')}</legend>
        {suggested.levels ? <p className={styles.hint}>{tl('suggested')}</p> : null}
        <div className={styles.chips}>
          {EXPERIENCE_LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={form.levels.includes(l)}
              className={styles.chip}
              // Kept in the list's order, whatever order they were picked in.
              onClick={() => onChange({ levels: EXPERIENCE_LEVELS.filter((v) => (v === l ? !form.levels.includes(l) : form.levels.includes(v))) })}
            >
              {tl(`levels.${l}`)}
            </button>
          ))}
        </div>
        {errors.levels ? (
          <p className={styles.fieldError} role="alert">
            {errors.levels}
          </p>
        ) : null}
      </fieldset>

      <WhereFields
        value={{ countries: form.countries, cities: form.cities, remoteOk: form.remoteOk, sponsorship: form.sponsorship }}
        onChange={onChange}
        error={errors.countries}
        groupRef={placesRef}
      />

      <fieldset className={styles.fieldset} ref={typesRef}>
        <legend className={styles.legend}>{tb('jobTypesLabel')}</legend>
        <div className={styles.chips}>
          {JOB_TYPES.map((v) => (
            <button key={v} type="button" aria-pressed={form.jobTypes.includes(v)} className={styles.chip} onClick={() => onChange({ jobTypes: toggled(form.jobTypes, v) })}>
              {tb(`jobTypes.${v}`)}
            </button>
          ))}
        </div>
        {errors.jobTypes ? (
          <p className={styles.fieldError} role="alert">
            {errors.jobTypes}
          </p>
        ) : null}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{ts('timingLabel')}</legend>
        <div className={styles.chips} role="radiogroup" aria-label={ts('timingLabel')}>
          {TIMINGS.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={form.timing === v} className={styles.chip} onClick={() => onChange({ timing: v })}>
              {ts(`timing.${v}`)}
            </button>
          ))}
        </div>
      </fieldset>

      <details className={x.more}>
        <summary className={x.moreSummary}>{t('check.aboutYou', { value: ts(`seekerType.${seekerType}`) })}</summary>
        <fieldset className={`${styles.fieldset} ${x.moreBody}`}>
          <legend className={styles.label}>{ts('seekerLabel')}</legend>
          <div className={styles.chips} role="radiogroup" aria-label={ts('seekerLabel')}>
            {SEEKER_TYPES.map((v) => (
              <button key={v} type="button" role="radio" aria-checked={seekerType === v} className={styles.chip} onClick={() => onChange({ seekerType: v })}>
                {ts(`seekerType.${v}`)}
              </button>
            ))}
          </div>
        </fieldset>
      </details>

      <p className={styles.hint}>{t('check.email')}</p>
    </StepFrame>
  );
}
