'use client';

// ImportFieldsForm — the job fields the user confirms or types before saving
// (WP-35; F-TRK-04). Honesty: values read from a page are suggestions; each
// shows where it came from, the missing ones say so, and nothing is saved
// until the user presses "Save job".

import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, CreditNotice } from '../../v3/primitives';
import { bucketSummary, useCredits } from '../../../hooks/shared/useCredits';
import type { ImportDraft, ImportField, ManualJob } from '../../../lib/api/contracts/jobs/import';
import styles from './JobImport.module.css';

/** Mirror of the server's MIN_DESCRIPTION_CHARS (ManualJobSchema). */
export const MIN_DESCRIPTION_CHARS = 50;

type Values = Record<'title' | 'company' | 'location' | 'applyUrl' | 'description', string>;
type Errors = Partial<Record<keyof Values, string>>;

const HTTP_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

export function validateFields(v: Values): Partial<Record<keyof Values, 'title' | 'company' | 'description' | 'applyUrl'>> {
  const out: Partial<Record<keyof Values, 'title' | 'company' | 'description' | 'applyUrl'>> = {};
  if (!v.title.trim()) out.title = 'title';
  if (!v.company.trim()) out.company = 'company';
  if (v.description.trim().length < MIN_DESCRIPTION_CHARS) out.description = 'description';
  if (v.applyUrl.trim() && !HTTP_RE.test(v.applyUrl.trim())) out.applyUrl = 'applyUrl';
  return out;
}

export function toManualJob(v: Values): ManualJob {
  const job: ManualJob = { title: v.title.trim(), company: v.company.trim(), description: v.description.trim() };
  if (v.location.trim()) job.location = v.location.trim();
  if (v.applyUrl.trim()) job.applyUrl = v.applyUrl.trim();
  return job;
}

export interface ImportFieldsFormProps {
  /** Values read from a page (or just the link); null for a blank form. */
  draft: ImportDraft | null;
  /** Required fields the page did not give. */
  missingFields?: readonly ImportField[];
  /** 'check' = confirm values read from a page; 'manual' = type or paste. */
  mode: 'check' | 'manual';
  saving: boolean;
  onSave: (job: ManualJob) => void;
}

export function ImportFieldsForm({ draft, missingFields = [], mode, saving, onSave }: ImportFieldsFormProps) {
  const t = useTranslations('jobImport.form');
  const id = useId();
  const credits = useCredits();
  const bucket = bucketSummary(credits.data?.summary, 'job_import');
  const [values, setValues] = useState<Values>({
    title: draft?.title ?? '',
    company: draft?.company ?? '',
    location: draft?.location ?? '',
    applyUrl: draft?.applyUrl ?? '',
    description: draft?.description ?? '',
  });
  const [errors, setErrors] = useState<Errors>({});

  const set = (k: keyof Values) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setValues((v) => ({ ...v, [k]: value }));
    if (errors[k]) setErrors((x) => ({ ...x, [k]: undefined }));
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    const found = validateFields(values);
    const next: Errors = {};
    for (const [k, code] of Object.entries(found) as Array<[keyof Values, string]>) {
      next[k] = code === 'description' ? t('errors.description', { min: MIN_DESCRIPTION_CHARS }) : t(`errors.${code}` as 'errors.title');
    }
    setErrors(next);
    if (Object.keys(next).length) {
      const first = (['title', 'company', 'location', 'applyUrl', 'description'] as const).find((k) => next[k]);
      if (first && typeof document !== 'undefined') document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    onSave(toManualJob(values));
  }

  const hint = (field: ImportField) => {
    if (mode !== 'check') return null;
    if (missingFields.includes(field)) return <p className={`${styles.hint} ${styles.hintCheck}`}>{t('missing')}</p>;
    const source = draft?.sources?.[field];
    if (!source) return null;
    const check = source !== 'job_data' && source !== 'link';
    return <p className={check ? `${styles.hint} ${styles.hintCheck}` : styles.hint}>{t(`source.${source}`)}</p>;
  };

  const describedBy = (k: keyof Values, extra?: string) => [errors[k] ? `${id}-${k}-err` : null, extra ?? null].filter(Boolean).join(' ') || undefined;

  const field = (k: 'title' | 'company' | 'location' | 'applyUrl', label: string, opts: { required?: boolean; type?: string; placeholder?: string; autoComplete?: string } = {}) => (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={`${id}-${k}`}>
        {label}
      </label>
      <input
        id={`${id}-${k}`}
        className={styles.input}
        type={opts.type ?? 'text'}
        value={values[k]}
        onChange={set(k)}
        required={opts.required}
        aria-required={opts.required || undefined}
        aria-invalid={errors[k] ? true : undefined}
        aria-describedby={describedBy(k)}
        placeholder={opts.placeholder}
        autoComplete={opts.autoComplete ?? 'off'}
        maxLength={k === 'applyUrl' ? 2000 : 200}
        inputMode={k === 'applyUrl' ? 'url' : undefined}
      />
      {errors[k] ? (
        <p id={`${id}-${k}-err`} className={styles.fieldError}>
          {errors[k]}
        </p>
      ) : (
        hint(k)
      )}
    </div>
  );

  return (
    <form className={styles.form} onSubmit={submit} noValidate aria-busy={saving || undefined}>
      <div>
        <h3 className={styles.heading}>{mode === 'check' ? t('checkTitle') : t('manualTitle')}</h3>
        <p className={styles.sub}>{mode === 'check' ? t('checkSub') : t('manualSub')}</p>
      </div>
      <div className={styles.grid2}>
        {field('title', t('title'), { required: true })}
        {field('company', t('company'), { required: true })}
        {field('location', t('location'), { placeholder: t('locationPlaceholder') })}
        {field('applyUrl', t('applyUrl'), { type: 'url', placeholder: 'https://' })}
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-description`}>
          {t('description')}
        </label>
        <textarea
          id={`${id}-description`}
          className={styles.textarea}
          value={values.description}
          onChange={set('description')}
          required
          aria-required
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={describedBy('description', `${id}-description-help`)}
          maxLength={60_000}
        />
        {errors.description ? (
          <p id={`${id}-description-err`} className={styles.fieldError}>
            {errors.description}
          </p>
        ) : (
          hint('description')
        )}
        <p id={`${id}-description-help`} className={styles.hint}>
          {t('descriptionHelp')}
        </p>
      </div>
      <p className={styles.meta}>{t('privateNote')}</p>
      <CreditNotice bucket={bucket} />
      <div className={styles.actions}>
        <Btn type="submit" variant="primary" disabled={saving}>
          {saving ? t('saving') : t('save')}
        </Btn>
      </div>
    </form>
  );
}
