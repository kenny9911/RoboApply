'use client';

// Shared pieces of the GoApply steps: the step frame (heading, Back / Skip /
// Next), single- and multi-select chips, a switch row, stored answers and the
// save call. Native controls only (radio semantics for single choice,
// aria-pressed toggles for multi choice); every target is ≥ 44px (CSS).

import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { apiErrorCode, apiErrorDetails } from '../../../lib/api/contracts/wire';
import type { StepResponse } from '../../../lib/api/contracts/onboarding';
import { Btn } from '../../v3/primitives/Btn';
import { useCnOnboardingApi } from './api';
import { ISSUE_CODES } from './logic';
import styles from './OnboardingCn.module.css';

export function StepFrame({
  title,
  subtitle,
  children,
  onBack,
  onSkip,
  nextLabel,
  nextDisabled,
  saving,
  error,
  onSubmit,
  disabledHint,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  onBack?: () => void;
  onSkip?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  saving?: boolean;
  error?: string | null;
  onSubmit: () => void;
  /** Why Next is disabled (read with the button). */
  disabledHint?: string | null;
}) {
  const t = useTranslations('onboardingCn');
  const hintId = useId();
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!nextDisabled && !saving) onSubmit();
  }
  return (
    <form className={styles.step} onSubmit={submit} noValidate>
      <header className={styles.head}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </header>
      {children}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        {onBack ? (
          <Btn variant="ghost" onClick={onBack} disabled={saving}>
            {t('common.back')}
          </Btn>
        ) : null}
        <div className={styles.actionsEnd}>
          {onSkip ? (
            <Btn variant="default" onClick={onSkip} disabled={saving}>
              {t('common.skip')}
            </Btn>
          ) : null}
          <Btn
            variant="primary"
            type="submit"
            disabled={nextDisabled || saving}
            aria-describedby={nextDisabled && disabledHint ? hintId : undefined}
          >
            {saving ? t('common.saving') : (nextLabel ?? t('common.next'))}
          </Btn>
        </div>
      </div>
      {nextDisabled && disabledHint ? (
        <p id={hintId} className={styles.note}>
          {disabledHint}
        </p>
      ) : null}
    </form>
  );
}

/** One choice of several (radio group). */
export function ChoiceChips<T extends string | number>({
  label,
  options,
  value,
  onChange,
  render,
  required,
}: {
  label: string;
  options: readonly T[];
  value: T | null | undefined;
  onChange: (v: T) => void;
  render: (v: T) => string;
  required?: boolean;
}) {
  const t = useTranslations('onboardingCn');
  const id = useId();
  return (
    <div className={styles.section}>
      <span id={id} className={styles.label}>
        {label}
        {required ? <span className={styles.required}>{t('common.required')}</span> : null}
      </span>
      <div className={styles.chips} role="radiogroup" aria-labelledby={id}>
        {options.map((o) => (
          <button key={String(o)} type="button" role="radio" aria-checked={value === o} className={styles.chip} onClick={() => onChange(o)}>
            {render(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Several choices (toggle buttons). */
export function MultiChips<T extends string>({
  label,
  options,
  value,
  onToggle,
  render,
  hint,
}: {
  label: string;
  options: readonly T[];
  value: readonly T[];
  onToggle: (v: T) => void;
  render: (v: T) => string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className={styles.section} role="group" aria-labelledby={id}>
      <span id={id} className={styles.label}>
        {label}
      </span>
      {hint ? <p className={styles.note}>{hint}</p> : null}
      <div className={styles.chips}>
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={value.includes(o)} className={styles.chip} onClick={() => onToggle(o)}>
            {render(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SwitchRow({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.switchRow} htmlFor={id}>
        <span>{label}</span>
        <input id={id} type="checkbox" role="switch" className={styles.switch} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      </label>
      {hint ? <p className={styles.note}>{hint}</p> : null}
    </div>
  );
}

export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  render,
  placeholder,
}: {
  label: string;
  value: T | null | undefined;
  options: readonly T[];
  onChange: (v: T | null) => void;
  render: (v: T) => string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {label}
      </label>
      <select
        id={id}
        className={styles.select}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') return onChange(null);
          const hit = options.find((o) => String(o) === raw);
          onChange(hit === undefined ? null : hit);
        }}
      >
        <option value="">{placeholder ?? '—'}</option>
        {options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {render(o)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The user's stored answers (resume a half-finished onboarding on any device). */
export function useStoredAnswers(): { answers: Record<string, unknown> | null; loaded: boolean } {
  const api = useCnOnboardingApi();
  const [state, setState] = useState<{ answers: Record<string, unknown> | null; loaded: boolean }>({ answers: null, loaded: false });
  useEffect(() => {
    let live = true;
    api
      .getState()
      .then((s) => live && setState({ answers: (s.answers ?? {}) as Record<string, unknown>, loaded: true }))
      .catch(() => live && setState({ answers: {}, loaded: true }));
    return () => {
      live = false;
    };
  }, [api]);
  return state;
}

/** Save a step through PUT /onboarding/steps/:step; maps server issues to copy. */
export function useSaveStep(step: string, onDone: (r: StepResponse) => void) {
  const api = useCnOnboardingApi();
  const t = useTranslations('onboardingCn');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(body: Record<string, unknown>): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const res = await api.saveStep(step, body);
      onDone(res);
      return true;
    } catch (err) {
      setError(saveErrorMessage(err, t));
      return false;
    } finally {
      setSaving(false);
    }
  }
  return { save, saving, error, setError };
}

type T = ReturnType<typeof useTranslations>;

/** First server issue as plain copy, else a generic retry line. */
export function saveErrorMessage(err: unknown, t: T): string {
  const details = apiErrorDetails<{ issues?: Array<{ message?: string }>; reason?: string }>(err);
  const code = details?.issues?.find((i) => typeof i.message === 'string')?.message ?? details?.reason ?? apiErrorCode(err);
  if (code && (ISSUE_CODES as readonly string[]).includes(code)) return t(`errors.${code}` as 'errors.required');
  if (code === 'version_conflict') return t('errors.onboarding_cn_prose_outdated');
  return t('errors.save');
}
