'use client';

// components/features/filters/FilterControls.tsx — the small native controls
// the filters drawer and quick-filter sheets are built from (WP-20):
// multi-select toggles, a segmented single choice, a checkbox row, a number
// range, and TagField (chips + an accessible combobox with suggestions and a
// custom entry). Every control has a visible label or an accessible name.

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { IconX } from '../../v3/primitives/Iconset';
import { cn } from '../../../lib/utils';
import styles from './filters.module.css';

export interface Option<T extends string | number> {
  value: T;
  label: string;
}

export function FieldShell({ label, help, children, as = 'fieldset' }: { label: string; help?: ReactNode; children: ReactNode; as?: 'fieldset' | 'div' }) {
  const helpId = useId();
  if (as === 'div') {
    return (
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{label}</span>
        {help ? <p className={styles.help}>{help}</p> : null}
        {children}
      </div>
    );
  }
  return (
    <fieldset className={styles.field} aria-describedby={help ? helpId : undefined}>
      <legend className={styles.fieldLabel}>{label}</legend>
      {help ? (
        <p id={helpId} className={styles.help}>
          {help}
        </p>
      ) : null}
      {children}
    </fieldset>
  );
}

/** Several of a fixed set (aria-pressed buttons). An empty selection means "any". */
export function OptionToggles<T extends string>({
  label,
  help,
  options,
  selected,
  onChange,
}: {
  label: string;
  help?: ReactNode;
  options: Option<T>[];
  selected: readonly T[] | undefined;
  onChange: (next: T[] | undefined) => void;
}) {
  const current = selected ?? [];
  const toggle = (v: T) => {
    const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
    onChange(next.length ? next : undefined);
  };
  return (
    <FieldShell label={label} help={help}>
      <div className={styles.toggles}>
        {options.map((o) => {
          const on = current.includes(o.value);
          return (
            <button key={o.value} type="button" aria-pressed={on} className={cn(styles.toggle, on && styles.toggleOn)} onClick={() => toggle(o.value)}>
              {o.label}
            </button>
          );
        })}
      </div>
    </FieldShell>
  );
}

/** One of a set (native radios styled as a segmented control). */
export function SegmentedChoice<T extends string>({
  label,
  help,
  options,
  value,
  onChange,
  hideLegend = false,
}: {
  label: string;
  help?: ReactNode;
  options: Option<T>[];
  value: T;
  onChange: (next: T) => void;
  hideLegend?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className={styles.field}>
      <legend className={hideLegend ? styles.hidden : styles.fieldLabel}>{label}</legend>
      {help ? <p className={styles.help}>{help}</p> : null}
      <div className={styles.segmented}>
        {options.map((o) => (
          <label key={o.value} className={cn(styles.segment, value === o.value && styles.segmentOn)}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CheckRow({ label, help, checked, onChange }: { label: string; help?: ReactNode; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className={styles.checkRow}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={styles.checkText}>
        <span>{label}</span>
        {help ? <span className={styles.help}>{help}</span> : null}
      </span>
    </label>
  );
}

function toInt(raw: string, min: number, max: number): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** min–max integers; both optional. */
export function NumberRange({
  label,
  help,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  help?: ReactNode;
  value: { min?: number; max?: number } | undefined;
  min: number;
  max: number;
  unit: string;
  onChange: (next: { min?: number; max?: number } | undefined) => void;
}) {
  const t = useTranslations('filters.controls');
  const set = (part: 'min' | 'max', raw: string) => {
    const next = { ...(value ?? {}), [part]: toInt(raw, min, max) };
    if (next.min !== undefined && next.max !== undefined && next.min > next.max) {
      if (part === 'min') next.max = next.min;
      else next.min = next.max;
    }
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as { min?: number; max?: number };
    onChange(Object.keys(clean).length ? clean : undefined);
  };
  return (
    <FieldShell label={label} help={help}>
      <div className={styles.row}>
        <label className={styles.row}>
          <span className={styles.unit}>{t('min')}</span>
          <input
            className={cn(styles.input, styles.numberInput)}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={value?.min ?? ''}
            onChange={(e) => set('min', e.target.value)}
          />
        </label>
        <label className={styles.row}>
          <span className={styles.unit}>{t('max')}</span>
          <input
            className={cn(styles.input, styles.numberInput)}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={value?.max ?? ''}
            onChange={(e) => set('max', e.target.value)}
          />
        </label>
        <span className={styles.unit}>{unit}</span>
      </div>
    </FieldShell>
  );
}

export interface Suggestion {
  value: string;
  label: string;
  context?: string | null;
  group?: string;
}

/**
 * Chips + a combobox. Suggestions come from the caller (typed at ≥2
 * characters, debounced by the hooks); Enter adds the active suggestion or,
 * when `allowCustom`, the typed text.
 */
export function TagField({
  label,
  help,
  values,
  onChange,
  query,
  onQueryChange,
  suggestions,
  placeholder,
  allowCustom = true,
  renderValue,
}: {
  label: string;
  help?: ReactNode;
  values: readonly string[] | undefined;
  onChange: (next: string[] | undefined) => void;
  query: string;
  onQueryChange: (q: string) => void;
  suggestions: Suggestion[];
  placeholder?: string;
  allowCustom?: boolean;
  /** Display text for a stored value (e.g. a taxonomy id → its label). */
  renderValue?: (value: string) => string;
}) {
  const t = useTranslations('filters.controls');
  const inputId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const current = values ?? [];
  const has = (v: string) => current.some((x) => x.toLowerCase() === v.toLowerCase());

  const typed = query.trim();
  const options: Suggestion[] = suggestions.filter((s) => !has(s.value));
  const customRow = allowCustom && typed && !has(typed) && !options.some((s) => s.label.toLowerCase() === typed.toLowerCase());
  const rows: Suggestion[] = customRow ? [...options, { value: typed, label: t('addCustom', { text: typed }) }] : options;
  const showList = open && typed.length > 0;

  const add = (v: string) => {
    const value = v.trim();
    if (!value || has(value)) return;
    onChange([...current, value]);
    onQueryChange('');
    setActive(-1);
  };
  const remove = (v: string) => {
    const next = current.filter((x) => x !== v);
    onChange(next.length ? next : undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(-1, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = active >= 0 ? rows[active] : undefined;
      if (row) add(row.value);
      else if (allowCustom && typed) add(typed);
    } else if (e.key === 'Escape') {
      if (showList) {
        e.stopPropagation();
        setOpen(false);
      }
    } else if (e.key === 'Backspace' && !query && current.length) {
      remove(current[current.length - 1]);
    }
  };

  let lastGroup: string | undefined;
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={inputId}>
        {label}
      </label>
      {help ? <p className={styles.help}>{help}</p> : null}
      {current.length ? (
        <ul className={styles.tags} aria-label={label}>
          {current.map((v) => {
            const text = renderValue ? renderValue(v) : v;
            return (
              <li key={v} className={styles.tag}>
                <span className={styles.tagText}>{text}</span>
                <button type="button" className={styles.chipRemove} aria-label={t('remove', { label: text })} onClick={() => remove(v)}>
                  <IconX size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className={styles.combo}>
        <input
          ref={inputRef}
          id={inputId}
          className={styles.input}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            onQueryChange(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
        {showList ? (
          <ul id={listId} role="listbox" className={styles.listbox} aria-label={t('suggestionsLabel')}>
            {rows.length === 0 ? (
              <li className={styles.optionContext} role="presentation">
                {t('noSuggestions')}
              </li>
            ) : (
              rows.map((s, i) => {
                const header = s.group && s.group !== lastGroup ? s.group : null;
                lastGroup = s.group;
                return (
                  <li key={`${s.group ?? ''}:${s.value}`} role="presentation">
                    {header ? (
                      <div className={styles.groupLabel} aria-hidden="true">
                        {header}
                      </div>
                    ) : null}
                    <div
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={cn(styles.option, i === active && styles.optionActive)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        add(s.value);
                        inputRef.current?.focus();
                      }}
                    >
                      <span>{s.label}</span>
                      {s.context ? <span className={styles.optionContext}>{s.context}</span> : null}
                    </div>
                  </li>
                );
              })
            )}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
