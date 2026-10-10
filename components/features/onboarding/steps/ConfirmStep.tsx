'use client';

// O7 — Check your setup (PRODUCT §4.3). The heading carries ONE number, the
// one "Finding jobs" stored (`onboardingAnswers.matching`), so it is the same
// on every load:
//   - a resume was compared → the jobs at Good fit or better among those
//     compared ("N jobs that fit you"; "N+" when the run stopped at its cap);
//   - no resume was compared (skipped, or 个性化推荐 off) → the size of the
//     saved search as the run stored it (`searchCount`, the feed's own count
//     for the search's filters: the number /jobs lists), "N jobs for your
//     search", never called a fit (D3). `compared` is NOT that number: the
//     comparison looks at titles and countries only, at most 200 jobs, and at
//     nothing when no title was given;
//   - no resume and the search was not counted → no number at all;
//   - the run is still going in the background → no number.
// The screen never asks the feed for a count of its own: with `fitTier` (a
// view of the list, not a filter of the count) that returned the size of the
// whole search under a "fit" heading, and flipped with the stored number.
// N = 0 opens the zero-results help. Fields: experience levels
// (suggested from the resume, labelled; else Student → Internship and Recent
// graduate → Entry level from O1), up to 3 extra titles from the
// resume, an optional LinkedIn link, the job-email frequency (Daily · Weekly
// · Off; Daily is a service message with no upsell), and an optional
// "how did you hear" answer. CTA "Show my jobs".

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useTaxonomyLabels } from '../../../../hooks/search';
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
  compared?: number;
  continuedInBackground?: boolean;
  ranked?: boolean;
  resumeCompared?: boolean;
  comparedCapped?: boolean;
  searchCount?: number;
  searchCountCapped?: boolean;
}

/**
 * What the heading may say. `fit` = Good fit or better among the compared
 * jobs; `search` = the size of the saved search; `uncounted` = no resume was
 * compared and the search was not counted (no number); `pending` = still running.
 */
export type ConfirmCount =
  | { kind: 'pending' }
  | { kind: 'fit'; count: number; capped: boolean; compared: number | null }
  | { kind: 'search'; count: number; capped: boolean }
  | { kind: 'uncounted' };

/**
 * The one number of the confirm heading, from what "Finding jobs" stored.
 * `resumeChosen` stands in for results stored before `resumeCompared` existed.
 */
export function confirmCountOf(matched: MatchResult | null | undefined, resumeChosen: boolean): ConfirmCount {
  if (!matched || matched.continuedInBackground === true) return { kind: 'pending' };
  const capped = matched.comparedCapped === true;
  const compared = typeof matched.compared === 'number' ? matched.compared : null;
  const withResume = matched.ranked !== false && (matched.resumeCompared ?? resumeChosen);
  if (withResume) {
    return typeof matched.jobCount === 'number' ? { kind: 'fit', count: matched.jobCount, capped, compared } : { kind: 'pending' };
  }
  // Nothing was compared with a resume: only the saved search's own size may be called "jobs for your search".
  return typeof matched.searchCount === 'number'
    ? { kind: 'search', count: matched.searchCount, capped: matched.searchCountCapped === true }
    : { kind: 'uncounted' };
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
  // Messages follow the fields as they are now: each goes away when its field is fixed.
  const [attempted, setAttempted] = useState(false);
  const [extraLimitHit, setExtraLimitHit] = useState(false);
  const linkedinBad = !!linkedin.trim() && !LINKEDIN_URL_RE.test(linkedin.trim());
  const errors = {
    levels: attempted && !levels.length ? t('levelsRequired') : undefined,
    linkedin: attempted && linkedinBad ? t('linkedinInvalid') : undefined,
    extra: extraLimitHit && extra.length >= LIMITS.extraTitles ? t('tooManyExtra') : undefined,
  };

  const found = confirmCountOf(matched, !!answersOf<{ resumeVariantId?: string }>(state, 'resume').resumeVariantId);
  const count = found.kind === 'fit' || found.kind === 'search' ? found.count : null;
  // A count from a run that stopped at its cap is a floor, never shown as exact (D3).
  const titleOf = (): string => {
    if (found.kind === 'pending') return t('titlePending');
    if (found.kind === 'uncounted') return t('titleUncounted');
    if (found.kind === 'fit') {
      if (found.count === 0) return t('titleNone');
      return found.capped ? t('titleCapped', { count: found.count }) : t('title', { count: found.count });
    }
    if (found.count === 0) return t('titleSearchNone');
    return found.capped ? t('titleSearchCapped', { count: found.count }) : t('titleSearch', { count: found.count });
  };
  const title = titleOf();
  // No note under a zero: the help below says what to change.
  const note =
    found.kind === 'search' && found.count > 0
      ? t('searchNote')
      : found.kind === 'fit' && found.count > 0
        ? found.compared !== null
          ? t('countNoteCompared', { compared: found.compared })
          : t('countNote')
        : null;

  function submit() {
    setAttempted(true);
    const url = linkedin.trim();
    if (!levels.length || linkedinBad) return;
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
      {note ? <p className={styles.hint}>{note}</p> : null}
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
                  if (extra.length >= LIMITS.extraTitles) return setExtraLimitHit(true);
                  setExtraLimitHit(false);
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
