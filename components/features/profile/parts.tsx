'use client';

// Small building blocks shared by the profile sections: the section card,
// labelled fields with "Missing" / "Optional" tags, and the save row.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import type { ProfileSection } from '../../../lib/api/contracts/profile';
import { cn } from '../../../lib/utils';
import s from './profile.module.css';

export function MissingTag() {
  const t = useTranslations('profile');
  return <span className={cn(s.tag, s.tagMissing)}>{t('missingTag')}</span>;
}

export function OptionalTag() {
  const t = useTranslations('profile');
  return <span className={cn(s.tag, s.tagOptional)}>{t('optionalTag')}</span>;
}

export function SectionCard({
  id,
  title,
  intro,
  missing = false,
  optional = false,
  children,
}: {
  id: ProfileSection | string;
  title: ReactNode;
  intro?: ReactNode;
  missing?: boolean;
  optional?: boolean;
  children: ReactNode;
}) {
  const headingId = `profile-${id}-title`;
  return (
    <section id={id} className={s.card} aria-labelledby={headingId}>
      <div className={s.cardHead}>
        <h2 id={headingId} className={s.cardTitle}>
          {title}
        </h2>
        {missing ? <MissingTag /> : null}
        {optional ? <OptionalTag /> : null}
      </div>
      {intro ? <p className={s.cardIntro}>{intro}</p> : null}
      {children}
    </section>
  );
}

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  missing?: boolean;
  wide?: boolean;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** A label + control + hint/error, wired for screen readers. */
export function Field({ label, hint, error, missing, wide, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn(s.field, wide && s.wide)}>
      <label htmlFor={id} className={s.label}>
        {label}
        {missing ? <MissingTag /> : null}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {hint ? (
        <span id={hintId} className={s.hint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className={s.error} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  missing,
  wide,
  type = 'text',
  autoComplete,
  inputMode,
  maxLength,
  placeholder,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  error?: string | null;
  missing?: boolean;
  wide?: boolean;
  type?: 'text' | 'email' | 'tel' | 'url' | 'number';
  autoComplete?: string;
  inputMode?: 'text' | 'email' | 'tel' | 'url' | 'numeric';
  maxLength?: number;
  placeholder?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error} missing={missing} wide={wide}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          className={s.input}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          autoComplete={autoComplete}
          inputMode={inputMode}
          maxLength={maxLength}
          placeholder={placeholder}
        />
      )}
    </Field>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  hint,
  missing,
  rows = 4,
  maxLength,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  missing?: boolean;
  rows?: number;
  maxLength?: number;
}) {
  return (
    <Field label={label} hint={hint} missing={missing} wide>
      {({ id, describedBy }) => (
        <textarea id={id} className={s.textarea} rows={rows} value={value} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} aria-describedby={describedBy} />
      )}
    </Field>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  missing,
  wide,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  missing?: boolean;
  wide?: boolean;
}) {
  return (
    <Field label={label} missing={missing} wide={wide}>
      {({ id, describedBy }) => (
        <select id={id} className={s.select} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={describedBy}>
          {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function Checkbox({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={s.check}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** A radio group rendered as tappable choices (44 px). */
export function Choices<V extends string>({
  legend,
  name,
  value,
  onChange,
  options,
}: {
  legend: ReactNode;
  name: string;
  value: V | '';
  onChange: (v: V | '') => void;
  options: ReadonlyArray<{ value: V | ''; label: string }>;
}) {
  return (
    <fieldset className={s.fieldset}>
      <legend className={s.legend}>{legend}</legend>
      <div className={s.choices}>
        {options.map((o) => (
          <label key={o.value || 'none'} className={s.choice}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Save (and optional cancel) with a live status line. */
export function SaveRow({
  state,
  disabled,
  onSave,
  onCancel,
  saveLabel,
  errorText,
}: {
  state: SaveState;
  disabled?: boolean;
  onSave?: () => void;
  onCancel?: () => void;
  saveLabel?: string;
  errorText?: string | null;
}) {
  const t = useTranslations('profile.actions');
  return (
    <div className={s.actions}>
      <Btn variant="primary" type={onSave ? 'button' : 'submit'} onClick={onSave} disabled={disabled || state === 'saving'}>
        {state === 'saving' ? t('saving') : (saveLabel ?? t('save'))}
      </Btn>
      {onCancel ? (
        <Btn variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Btn>
      ) : null}
      <span className={state === 'error' ? s.error : s.status} role="status" aria-live="polite">
        {state === 'saved' ? t('saved') : state === 'error' ? (errorText ?? t('saveError')) : ''}
      </span>
    </div>
  );
}

/** '' → undefined is not what PATCH wants: the server clears a field on ''. Keep strings as typed. */
export const str = (v: string | null | undefined) => v ?? '';

/**
 * A form draft seeded from server data. It follows the server while the user
 * has not touched it, and stops following once they edit (so a save in
 * another section never wipes unsaved typing here).
 */
export function useDraft<D>(source: unknown, make: () => D) {
  const [draft, setDraft] = useState<D>(make);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setDraft(make());
    // `make` closes over `source`; re-run only when the server data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);
  return {
    draft,
    update(fn: (d: D) => D) {
      dirty.current = true;
      setDraft(fn);
    },
    /** After a successful save: follow the server again. */
    markClean() {
      dirty.current = false;
    },
    reset() {
      dirty.current = false;
      setDraft(make());
    },
  };
}
