'use client';

// Manual mode of G6 (PRODUCT_PLAN.md §4.5 G1 / G6): with AI processing off
// "手动填写资料" opens THIS form — it used to skip straight to "Finding
// jobs" with no form at all. No file is read, nothing is parsed and no AI is
// called: every field is typed by the user and saved through the profile
// routes (lib/api/profile — name, one education row, one experience row,
// skills). Everything is optional; "稍后填写" continues without saving.
//
//   - Nothing is prefilled except the school, degree and major the user typed
//     on G3, and only while the profile has no education row yet (so a second
//     visit never adds the same school twice).
//   - Saving is in parts (name → education → experience → skills). A part
//     that was saved is not sent again when the user retries after a failure,
//     so a retry never adds a second copy of a row.
//   - After a full save the caller continues (the resume step is saved as
//     skipped: there is no resume).

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import type { ProfileView } from '../../../lib/api/contracts/profile';
import { Btn } from '../../v3/primitives/Btn';
import { useCnOnboardingApi } from './api';
import { stepAnswers } from './logic';
import { StepProgress, SwitchRow, useStoredAnswers } from './parts';
import styles from './OnboardingCn.module.css';

export type ManualExperienceKind = 'internship' | 'work';

export interface ManualProfileFormState {
  lastName: string;
  firstName: string;
  school: string;
  degree: string;
  major: string;
  kind: ManualExperienceKind | null;
  company: string;
  title: string;
  /** The month as the input holds it: 'YYYY-MM' from a month picker, whatever was typed where the browser shows a text box, or ''. */
  start: string;
  end: string;
  current: boolean;
  description: string;
  skills: string;
}

export const EMPTY_MANUAL_PROFILE: Readonly<ManualProfileFormState> = Object.freeze({
  lastName: '',
  firstName: '',
  school: '',
  degree: '',
  major: '',
  kind: null,
  company: '',
  title: '',
  start: '',
  end: '',
  current: false,
  description: '',
  skills: '',
});

/**
 * The month a start/end field means, as 'YYYY-MM', or null when it is empty
 * or not a month. `<input type="month">` is a picker on phones and in
 * Chromium, but a plain text box in Firefox and Safari on desktop, where
 * people type "2024/03", "2024.3", "2024年3月" or "202403". Those are read as
 * the month they mean; anything else is a problem the form reports — a typed
 * date is never dropped without a word.
 */
export function normalizeMonth(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?$/.exec(v) ?? /^(\d{4})(\d{2})$/.exec(v);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12) return null;
  return `${m[1]}-${String(month).padStart(2, '0')}`;
}

/** "Python、SQL, Excel" → ['Python', 'SQL', 'Excel'] (no duplicates, at most 60 characters each). */
export function parseSkills(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，、;；\n]/)) {
    const name = part.trim().slice(0, 60);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export interface ManualProfileParts {
  name: { lastName?: string; firstName?: string } | null;
  education: { school: string; degree?: string; major?: string } | null;
  experience: {
    company: string;
    title: string;
    kind: ManualExperienceKind;
    startDate?: string;
    endDate?: string;
    current?: boolean;
    description?: string;
  } | null;
  skills: string[];
}

/** What would be saved. `includeEducation` is false when the profile already has an education row (or could not be read). */
export function manualProfileParts(f: ManualProfileFormState, includeEducation: boolean): ManualProfileParts {
  const lastName = f.lastName.trim();
  const firstName = f.firstName.trim();
  const school = f.school.trim();
  const company = f.company.trim();
  const title = f.title.trim();
  const start = normalizeMonth(f.start);
  const end = normalizeMonth(f.end);
  return {
    name: lastName || firstName ? { ...(lastName ? { lastName } : {}), ...(firstName ? { firstName } : {}) } : null,
    education: includeEducation && school ? { school, ...(f.degree.trim() ? { degree: f.degree.trim() } : {}), ...(f.major.trim() ? { major: f.major.trim() } : {}) } : null,
    experience:
      company && title && f.kind
        ? {
            company,
            title,
            kind: f.kind,
            ...(start ? { startDate: start } : {}),
            ...(f.current ? { current: true } : end ? { endDate: end } : {}),
            ...(f.description.trim() ? { description: f.description.trim() } : {}),
          }
        : null,
    skills: parseSkills(f.skills),
  };
}

export type ManualProfileProblem = 'empty' | 'experience' | 'dateFormat' | 'dates';

/**
 * Why the form cannot be saved yet. 'experience' = an experience was started
 * but lacks company, title or type; 'dateFormat' = a start or end month was
 * typed that is not a month (so it would otherwise be left out of the save);
 * 'dates' = the end month is before the start month.
 */
export function manualProfileProblems(f: ManualProfileFormState, includeEducation: boolean): ManualProfileProblem[] {
  const out: ManualProfileProblem[] = [];
  const startedExperience = !!(f.company.trim() || f.title.trim() || f.description.trim() || f.start.trim() || f.end.trim() || f.current);
  if (startedExperience && !(f.company.trim() && f.title.trim() && f.kind)) out.push('experience');
  const start = normalizeMonth(f.start);
  // "I still work here" clears and disables the end month, so only the start is read then.
  const endTyped = f.current ? '' : f.end.trim();
  const end = f.current ? null : normalizeMonth(f.end);
  if ((f.start.trim() && !start) || (endTyped && !end)) out.push('dateFormat');
  else if (start && end && end < start) out.push('dates');
  const parts = manualProfileParts(f, includeEducation);
  if (!parts.name && !parts.education && !parts.experience && parts.skills.length === 0 && !startedExperience) out.push('empty');
  return out;
}

export interface ManualProfileFormProps {
  /** Saved (or "稍后填写"): continue setup. The caller saves the resume step as skipped. */
  onContinue: () => void;
  /** Back to the "resume reading is off" notice. */
  onBack: () => void;
  /** The caller is saving the step: every button is off. */
  busy?: boolean;
  /** The caller's save failed (plain language). */
  error?: string | null;
}

type Done = { name: boolean; education: boolean; experience: boolean; skills: boolean };

export function ManualProfileForm({ onContinue, onBack, busy = false, error = null }: ManualProfileFormProps) {
  const t = useTranslations('onboardingCn');
  const api = useCnOnboardingApi();
  const ids = useId();
  const { answers, loaded } = useStoredAnswers();
  const [profile, setProfile] = useState<ProfileView | null | 'loading'>('loading');
  const [form, setForm] = useState<ManualProfileFormState>({ ...EMPTY_MANUAL_PROFILE });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  // Parts already saved in this visit: a retry sends only what is left.
  const done = useRef<Done>({ name: false, education: false, experience: false, skills: false });
  const set = (patch: Partial<ManualProfileFormState>) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    let live = true;
    api
      .getProfile()
      .then((p) => live && setProfile(p))
      .catch(() => live && setProfile(null)); // Unreadable: the form still works; no education row is added (it could be a duplicate).
    return () => {
      live = false;
    };
  }, [api]);

  // An education row is offered only while the profile has none.
  const includeEducation = profile !== 'loading' && profile !== null && profile.education.length === 0;

  // Prefill what the user already typed: their name in the profile, and the G3 school, degree and major.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !loaded || profile === 'loading') return;
    prefilled.current = true;
    const edu = stepAnswers(answers, 'education');
    setForm((f) => ({
      ...f,
      lastName: profile?.lastName ?? '',
      firstName: profile?.firstName ?? '',
      school: typeof edu.school === 'string' ? edu.school : '',
      degree: typeof edu.degree === 'string' ? t(`education.degree.${edu.degree}`) : '',
      major: typeof edu.major === 'string' ? edu.major : '',
    }));
  }, [answers, loaded, profile, t]);

  const problems = useMemo(() => manualProfileProblems(form, includeEducation), [form, includeEducation]);
  const off = busy || saving || profile === 'loading' || !loaded;

  async function save() {
    const parts = manualProfileParts(form, includeEducation);
    setSaving(true);
    setFailed(false);
    try {
      if (parts.name && !done.current.name) {
        await api.patchProfile(parts.name);
        done.current.name = true;
      }
      if (parts.education && !done.current.education) {
        await api.addEducation(parts.education);
        done.current.education = true;
      }
      if (parts.experience && !done.current.experience) {
        await api.addExperience(parts.experience);
        done.current.experience = true;
      }
      if (parts.skills.length && !done.current.skills) {
        // PUT replaces the whole list, so it is merged into the list as it is NOW (read again: an unreadable
        // profile must never be overwritten with only what was typed here; a failed read fails the save).
        const existing = (await api.getProfile()).skills;
        const have = new Set(existing.map((s) => s.name.toLowerCase()));
        await api.putSkills({ skills: [...existing, ...parts.skills.filter((s) => !have.has(s.toLowerCase())).map((name) => ({ name, confirmed: true }))] });
        done.current.skills = true;
      }
      onContinue();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (off) return;
    if (problems.length) return setShowProblems(true);
    void save();
  }

  const problem = showProblems && problems.length ? t(`manual.problem.${problems[0]!}`) : null;
  const field = (key: keyof ManualProfileFormState & string, label: string, opts: { placeholder?: string; max?: number; type?: string; disabled?: boolean } = {}) => (
    <div className={styles.field}>
      <label htmlFor={`${ids}-${key}`} className={styles.fieldLabel}>
        {label}
      </label>
      <input
        id={`${ids}-${key}`}
        className={styles.input}
        type={opts.type ?? 'text'}
        value={form[key] as string}
        maxLength={opts.max ?? 120}
        disabled={opts.disabled}
        placeholder={opts.placeholder}
        autoComplete="off"
        onChange={(e) => set({ [key]: e.target.value } as Partial<ManualProfileFormState>)}
      />
    </div>
  );

  return (
    <form className={styles.step} onSubmit={submit} noValidate aria-labelledby={`${ids}-heading`} data-testid="cn-manual-profile">
      <header className={styles.head}>
        <StepProgress step="resume" />
        <h1 id={`${ids}-heading`} className={styles.title}>
          {t('manual.title')}
        </h1>
        <p className={styles.subtitle}>{t('manual.subtitle')}</p>
      </header>

      <fieldset className={styles.consent}>
        <legend className={styles.label}>{t('manual.nameGroup')}</legend>
        <div className={styles.row}>
          {field('lastName', t('manual.lastName'), { max: 80 })}
          {field('firstName', t('manual.firstName'), { max: 80 })}
        </div>
      </fieldset>

      {includeEducation ? (
        <fieldset className={styles.consent}>
          <legend className={styles.label}>{t('manual.educationGroup')}</legend>
          <p className={styles.note}>{t('manual.educationNote')}</p>
          {field('school', t('education.schoolLabel'), { max: 160 })}
          <div className={styles.row}>
            {field('degree', t('education.degreeLabel'))}
            {field('major', t('education.majorLabel'))}
          </div>
        </fieldset>
      ) : null}

      <fieldset className={styles.consent}>
        <legend className={styles.label}>{t('manual.experienceGroup')}</legend>
        <p className={styles.note}>{t('manual.experienceHint')}</p>
        <div className={styles.section} role="group" aria-labelledby={`${ids}-kind`}>
          <span id={`${ids}-kind`} className={styles.fieldLabel}>
            {t('manual.kindLabel')}
          </span>
          <div className={styles.chips}>
            {(['internship', 'work'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={form.kind === k} className={styles.chip} onClick={() => set({ kind: form.kind === k ? null : k })}>
                {t(`manual.kind.${k}`)}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.row}>
          {field('company', t('manual.company'), { max: 160 })}
          {field('title', t('manual.jobTitle'), { max: 160 })}
        </div>
        <div className={styles.row}>
          {/* The placeholder and the longer limit are for browsers that show a text box instead of a month picker. */}
          {field('start', t('manual.start'), { type: 'month', max: 12, placeholder: t('manual.monthPlaceholder') })}
          {field('end', t('manual.end'), { type: 'month', max: 12, placeholder: t('manual.monthPlaceholder'), disabled: form.current })}
        </div>
        <SwitchRow label={t('manual.current')} checked={form.current} onChange={(current) => set({ current, ...(current ? { end: '' } : {}) })} />
        <div className={styles.field}>
          <label htmlFor={`${ids}-description`} className={styles.fieldLabel}>
            {t('manual.description')}
          </label>
          <textarea
            id={`${ids}-description`}
            className={`${styles.input} ${styles.textarea}`}
            value={form.description}
            maxLength={2000}
            rows={4}
            placeholder={t('manual.descriptionPlaceholder')}
            onChange={(e) => set({ description: e.target.value })}
          />
        </div>
      </fieldset>

      <fieldset className={styles.consent}>
        <legend className={styles.label}>{t('manual.skillsLabel')}</legend>
        {field('skills', t('manual.skillsHint'), { max: 600, placeholder: t('manual.skillsPlaceholder') })}
      </fieldset>

      <p className={styles.note}>{t('resume.optionalFields')}</p>

      {problem ? (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      ) : null}
      {failed ? (
        <p className={styles.error} role="alert">
          {t('manual.saveError')}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.actions}>
        <Btn variant="ghost" onClick={onBack} disabled={busy || saving}>
          {t('common.back')}
        </Btn>
        <div className={styles.actionsEnd}>
          <Btn variant="default" onClick={onContinue} disabled={busy || saving}>
            {t('manual.later')}
          </Btn>
          <Btn variant="primary" type="submit" disabled={off}>
            {saving || busy ? t('common.saving') : t('manual.save')}
          </Btn>
        </div>
      </div>
    </form>
  );
}
