'use client';

// O7 — Check your setup (PRODUCT §4.3). The heading carries the REAL number
// of jobs at Good fit or better: the feed count from POST
// /search-profiles/count (fitTier good) when the feed answers, else what O6
// ranked. N = 0 opens the zero-results help. Fields: experience levels
// (suggested from the resume, labelled; else Student → Internship and Recent
// graduate → Entry level from O1), up to 3 extra titles from the
// resume, an optional LinkedIn link, the job-email frequency (Daily · Weekly
// · Off; Daily is a service message with no upsell), and an optional
// "how did you hear" answer. CTA "Show my jobs".

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useActiveSearchProfile, useFilterCount, useTaxonomyLabels } from '../../../../hooks/search';
import { AiGeneratedBadge } from '../../market';
import { ALERT_FREQUENCIES, EXPERIENCE_LEVELS, HEARD_FROM, LIMITS, LINKEDIN_URL_RE } from '../options';
import { StepFrame } from '../StepFrame';
import { answersOf, type StepScreenProps } from '../types';
import styles from '../onboarding.module.css';

type Level = (typeof EXPERIENCE_LEVELS)[number];
type Alert = (typeof ALERT_FREQUENCIES)[number];
type Heard = (typeof HEARD_FROM)[number];
interface ConfirmAnswers {
  experienceLevels: Level[];
  extraFunctions: string[];
  linkedinUrl: string;
  alertFrequency: Alert;
  heardFrom: Heard;
  heardFromNote: string;
}
interface Suggestions {
  suggestedSeniority?: Level[];
  suggestedTaxonomyIds?: string[];
  profileDraft?: { aiSuggested?: boolean };
}
interface MatchResult {
  jobCount?: number;
  continuedInBackground?: boolean;
}

/** O1 seeker type → the O7 levels pre-selected when nothing else suggests one (PRODUCT O1). */
export function levelsForSeekerType(seekerType: string | undefined): Level[] {
  if (seekerType === 'student') return ['internship'];
  if (seekerType === 'recent_graduate') return ['entry'];
  return [];
}

export function ConfirmStep({ state, save, onBack, onLeave, busy, error, position }: StepScreenProps) {
  const t = useTranslations('onboarding.confirm');
  const prev = answersOf<ConfirmAnswers>(state, 'confirm');
  const sugg = (state.answers as Record<string, unknown>).resumeSuggestions as Suggestions | undefined;
  const matched = (state.answers as Record<string, unknown>).matching as MatchResult | undefined;
  const basicsIds = new Set(
    (answersOf<{ jobFunctions: Array<{ taxonomyId?: string }> }>(state, 'basics').jobFunctions ?? []).map((f) => f.taxonomyId).filter(Boolean),
  );
  const extraOptions = (sugg?.suggestedTaxonomyIds ?? []).filter((id) => !basicsIds.has(id));
  const labels = useTaxonomyLabels({ enabled: extraOptions.length > 0 });

  const suggestedLevels = sugg?.suggestedSeniority ?? [];
  const seekerType = answersOf<{ seekerType?: string }>(state, 'situation').seekerType;
  const [levels, setLevels] = useState<Level[]>(
    prev.experienceLevels ?? (suggestedLevels.length ? suggestedLevels : levelsForSeekerType(seekerType)),
  );
  const [extra, setExtra] = useState<string[]>(prev.extraFunctions ?? []);
  const [linkedin, setLinkedin] = useState(prev.linkedinUrl ?? '');
  const [alert, setAlert] = useState<Alert>(prev.alertFrequency ?? 'daily');
  const [heard, setHeard] = useState<Heard | ''>(prev.heardFrom ?? '');
  const [heardNote, setHeardNote] = useState(prev.heardFromNote ?? '');
  const [errors, setErrors] = useState<{ levels?: string; linkedin?: string; extra?: string }>({});

  const { profile } = useActiveSearchProfile();
  const countFilters = useMemo(() => (profile ? { ...profile.filters, fitTier: 'good' as const } : null), [profile]);
  const feedCount = useFilterCount(countFilters);
  const count = feedCount.count ?? (matched && !matched.continuedInBackground ? (matched.jobCount ?? null) : null);
  // A capped feed count is a floor, never shown as exact (D3).
  const capped = feedCount.count !== null && feedCount.capped;

  const title = count === null ? t('titlePending') : count === 0 ? t('titleNone') : capped ? t('titleCapped', { count }) : t('title', { count });

  function submit() {
    const e: typeof errors = {};
    if (!levels.length) e.levels = t('levelsRequired');
    const url = linkedin.trim();
    if (url && !LINKEDIN_URL_RE.test(url)) e.linkedin = t('linkedinInvalid');
    setErrors(e);
    if (e.levels || e.linkedin) return;
    save({
      experienceLevels: levels,
      ...(extra.length ? { extraFunctions: extra } : {}),
      ...(url ? { linkedinUrl: url } : {}),
      alertFrequency: alert,
      ...(heard ? { heardFrom: heard } : {}),
      ...(heard === 'other' && heardNote.trim() ? { heardFromNote: heardNote.trim().slice(0, 200) } : {}),
    });
  }

  return (
    <StepFrame title={title} position={position} busy={busy} error={error} onBack={onBack} onLeave={onLeave} onNext={submit} nextLabel={t('submit')}>
      {count !== null && count > 0 ? <p className={styles.hint}>{t('countNote')}</p> : null}
      {count === 0 ? (
        <section className={styles.notice} aria-labelledby="ob-diag">
          <h2 id="ob-diag" className={styles.doorTitle}>
            {t('diagnosticsTitle')}
          </h2>
          <ul style={{ margin: 'var(--sp-2) 0', paddingLeft: 'var(--sp-5)' }}>
            <li>{t('diagnostics.broaden')}</li>
            <li>{t('diagnostics.places')}</li>
            <li>{t('diagnostics.levels')}</li>
          </ul>
          <Link className={styles.link} href="/onboarding/basics">
            {t('editSearch')}
          </Link>
        </section>
      ) : null}

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('levelsLabel')}</legend>
        {suggestedLevels.length ? <p className={styles.hint}>{t('suggested')}</p> : null}
        <div className={styles.chips}>
          {EXPERIENCE_LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={levels.includes(l)}
              className={styles.chip}
              onClick={() => setLevels(levels.includes(l) ? levels.filter((x) => x !== l) : [...levels, l])}
            >
              {t(`levels.${l}`)}
            </button>
          ))}
        </div>
        {errors.levels ? <p className={styles.fieldError} role="alert">{errors.levels}</p> : null}
      </fieldset>

      {extraOptions.length ? (
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>{t('extraLabel')}</legend>
          {sugg?.profileDraft?.aiSuggested ? (
            <p className={styles.hint}>
              <AiGeneratedBadge /> {t('aiSuggested')}
            </p>
          ) : (
            <p className={styles.hint}>{t('extraHint')}</p>
          )}
          <div className={styles.chips}>
            {extraOptions.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={extra.includes(id)}
                className={styles.chip}
                onClick={() => {
                  if (extra.includes(id)) return setExtra(extra.filter((x) => x !== id));
                  if (extra.length >= LIMITS.extraTitles) return setErrors({ ...errors, extra: t('tooManyExtra') });
                  setErrors({ ...errors, extra: undefined });
                  setExtra([...extra, id]);
                }}
              >
                {labels.get(id) ?? id}
              </button>
            ))}
          </div>
          {errors.extra ? <p className={styles.fieldError} role="alert">{errors.extra}</p> : null}
        </fieldset>
      ) : null}

      <div>
        <label className={styles.label} htmlFor="ob-linkedin">
          {t('linkedinLabel')}
        </label>
        <input
          id="ob-linkedin"
          type="url"
          inputMode="url"
          className={styles.input}
          placeholder={t('linkedinPlaceholder')}
          value={linkedin}
          onChange={(e) => setLinkedin(e.target.value)}
          aria-invalid={!!errors.linkedin}
        />
        {errors.linkedin ? <p className={styles.fieldError} role="alert">{errors.linkedin}</p> : null}
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('alertLabel')}</legend>
        <div className={styles.chips} role="radiogroup" aria-label={t('alertLabel')}>
          {ALERT_FREQUENCIES.map((a) => (
            <button key={a} type="button" role="radio" aria-checked={alert === a} className={styles.chip} onClick={() => setAlert(a)}>
              {t(`alerts.${a}`)}
            </button>
          ))}
        </div>
        <p className={styles.hint}>{t('alertHint')}</p>
      </fieldset>

      <div>
        <label className={styles.label} htmlFor="ob-heard">
          {t('heardLabel')}
        </label>
        <select id="ob-heard" className={styles.select} value={heard} onChange={(e) => setHeard(e.target.value as Heard | '')}>
          <option value="">{t('heardNone')}</option>
          {HEARD_FROM.map((h) => (
            <option key={h} value={h}>
              {t(`heard.${h}`)}
            </option>
          ))}
        </select>
        {heard === 'other' ? (
          <>
            <label className={styles.srOnly} htmlFor="ob-heard-note">
              {t('heardOther')}
            </label>
            <input
              id="ob-heard-note"
              className={styles.input}
              style={{ marginTop: 'var(--sp-2)' }}
              placeholder={t('heardOther')}
              maxLength={200}
              value={heardNote}
              onChange={(e) => setHeardNote(e.target.value)}
            />
          </>
        ) : null}
      </div>
    </StepFrame>
  );
}
