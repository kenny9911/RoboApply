'use client';

// components/features/resume/builder/fields.tsx — the builder's form pieces
// (WP-65): labelled fields, a bullet list editor, a tag list, and the AI
// suggestion panel (hidden when AI is unavailable; AiGeneratedBadge on GoApply).

import { useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../../v3/primitives/Btn';
import { AiGeneratedBadge } from '../../market';
import { PhoneBindingNotice, isPhoneBindingRequired } from '../../auth-cn';
import { apiErrorCode, apiErrorReason } from '../../../../lib/api/contracts/wire';
import styles from './Builder.module.css';

export function TextField({
  label,
  value,
  onChange,
  hint,
  type = 'text',
  full,
  required,
  placeholder,
  list,
  maxLength = 120,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  type?: 'text' | 'email' | 'tel' | 'url';
  full?: boolean;
  required?: boolean;
  placeholder?: string;
  list?: string;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <div className={`${styles.field} ${full ? styles.full : ''}`}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        type={type}
        value={value}
        required={required}
        aria-required={required || undefined}
        placeholder={placeholder}
        list={list}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? (
        <span id={`${id}-hint`} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  hint,
  rows = 4,
  maxLength = 1500,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className={`${styles.field} ${styles.full}`}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className={styles.textarea}
        rows={rows}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? (
        <span id={`${id}-hint`} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** Bullet lines with add / remove. */
export function BulletList({ label, items, onChange, hint }: { label: string; items: string[]; onChange: (next: string[]) => void; hint?: string }) {
  const t = useTranslations('resumeBuilder');
  const groupId = useId();
  const rows = items.length ? items : [''];
  return (
    <div className={`${styles.field} ${styles.full}`} role="group" aria-labelledby={groupId}>
      <span id={groupId} className={styles.label}>
        {label}
      </span>
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
      {rows.map((b, i) => (
        <div key={i} className={styles.bulletRow}>
          <input
            className={styles.input}
            value={b}
            maxLength={400}
            aria-label={t('field.bulletN', { n: i + 1 })}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={t('field.removeBullet', { n: i + 1 })}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <div>
        <button type="button" className={styles.btnText} onClick={() => onChange([...rows, ''])}>
          {t('field.addBullet')}
        </button>
      </div>
    </div>
  );
}

/** A list of short tags (skills, certificates) with quick adds. */
export function TagList({
  label,
  items,
  onChange,
  suggestions = [],
  addLabel,
  maxLength = 80,
}: {
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  addLabel: string;
  maxLength?: number;
}) {
  const t = useTranslations('resumeBuilder');
  const id = useId();
  const [value, setValue] = useState('');
  const add = (raw: string) => {
    const parts = raw
      .split(/[,，、\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const next = [...items];
    for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next);
    setValue('');
  };
  return (
    <div className={`${styles.field} ${styles.full}`}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.bulletRow}>
        <input
          id={id}
          className={styles.input}
          value={value}
          maxLength={maxLength}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (value.trim()) add(value);
            }
          }}
        />
        <Btn type="button" onClick={() => value.trim() && add(value)} disabled={!value.trim()}>
          {addLabel}
        </Btn>
      </div>
      {suggestions.length ? (
        <div className={styles.chips} role="group" aria-label={t('field.quickAdd')}>
          {suggestions.map((s) => {
            const on = items.includes(s);
            return (
              <button key={s} type="button" className={styles.chip} aria-pressed={on} onClick={() => onChange(on ? items.filter((x) => x !== s) : [...items, s])}>
                {s}
              </button>
            );
          })}
        </div>
      ) : null}
      {items.length ? (
        <ul className={styles.chips} aria-label={label}>
          {items.map((s) => (
            <li key={s}>
              <button type="button" className={styles.chip} aria-label={t('field.removeTag', { tag: s })} onClick={() => onChange(items.filter((x) => x !== s))}>
                {s} <span aria-hidden="true">✕</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Plain copy for a failed suggestion request. */
export function suggestErrorKey(err: unknown): string {
  const code = apiErrorCode(err);
  const reason = apiErrorReason(err);
  if (code === 'ai_unavailable') return 'ai.errors.unavailable';
  if (code === 'credits_exhausted') return 'ai.errors.credits';
  if (code === 'content_blocked') return 'ai.errors.blocked';
  if (reason === 'citation_guard') return 'ai.errors.citationGuard';
  if (reason === 'no_suggestion') return 'ai.errors.noSuggestion';
  if (code === 'invalid_request' || reason === 'notes_required') return 'ai.notesFirst';
  return 'ai.errors.generic';
}

/**
 * AI suggestions for one field. Renders nothing when AI is unavailable, so
 * the builder works the same without it. Each suggestion is labelled as AI
 * output and must be added by the user.
 */
export function SuggestPanel({
  enabled,
  label,
  busy,
  error,
  suggestions,
  blocked,
  onRun,
  onUse,
  useLabel,
  canRun,
}: {
  enabled: boolean;
  label: string;
  busy: boolean;
  error: unknown;
  suggestions: string[];
  blocked: number;
  onRun: () => void;
  onUse: (text: string) => void;
  useLabel?: string;
  canRun: boolean;
}): ReactNode {
  const t = useTranslations('resumeBuilder');
  if (!enabled) return null;
  return (
    <div className={styles.suggest} data-testid="builder-suggest">
      <div className={styles.suggestHead}>
        <Btn type="button" variant="violet" onClick={onRun} disabled={busy || !canRun} aria-busy={busy || undefined}>
          {busy ? t('ai.busy') : label}
        </Btn>
        {!canRun ? <span className={styles.fieldHint}>{t('ai.notesFirst')}</span> : null}
      </div>
      {error ? (
        isPhoneBindingRequired(error) ? (
          <PhoneBindingNotice error={error} />
        ) : (
          <p className={styles.error} role="alert">
            {t(suggestErrorKey(error))}
          </p>
        )
      ) : null}
      {suggestions.length ? (
        <>
          <div className={styles.suggestHead}>
            <AiGeneratedBadge />
            <span className={styles.fieldHint}>{t('ai.note')}</span>
          </div>
          <ul className={styles.suggestList}>
            {suggestions.map((s) => (
              <li key={s} className={styles.suggestItem}>
                <span>{s}</span>
                <button type="button" className={styles.btnText} onClick={() => onUse(s)} aria-label={`${useLabel ?? t('ai.add')}: ${s}`}>
                  {useLabel ?? t('ai.add')}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {blocked > 0 ? <p className={styles.fieldHint}>{t('ai.blocked', { count: blocked })}</p> : null}
    </div>
  );
}
