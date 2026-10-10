'use client';

// Preferences shared form controls — a 1:1 port of the prototype's
// (RoboApply_V3/preferences.jsx) inline form primitives. These are class-driven
// against the `.pref-*` family in styles/v3-preferences.css, so the accent swap
// (data-accent) reaches them for free.
//
// They are NOT in the shared V3 primitives kit because the `.pref-toggle`,
// `.pref-select`, `.pref-slider`, `.pref-chip-input`, `.pref-checkgrid` classes
// are scoped to the Preferences surface. Section components below import these.

import type { ReactNode } from 'react';
import { useState } from 'react';
import { IconCheck } from '../primitives';

// ── Headings ─────────────────────────────────────────────────────────

/** Han, kana and full-width punctuation: written without spaces between words. (Hangul is spaced like Latin.) */
const UNSPACED_SCRIPT = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
/** A part that starts with closing punctuation attaches to the word before it. */
const STARTS_WITH_CLOSER = /^[.,!?;:…)\]}]/;

/**
 * Join the parts of a section heading ("Tell us what" + "you're looking for"
 * + "."). The bundles keep a heading in up to three parts; gluing them with a
 * fixed space (or none) gave "The one-waybuttons." and "looking for ." in
 * English and stray spaces inside Chinese and Japanese headings. One rule for
 * every locale: a space goes between two parts only when both sides are
 * spaced scripts and the next part is not closing punctuation.
 */
export function joinTitle(...parts: string[]): string {
  let out = '';
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    const tight = STARTS_WITH_CLOSER.test(part) || UNSPACED_SCRIPT.test(out[out.length - 1]!) || UNSPACED_SCRIPT.test(part[0]!);
    out += (tight ? '' : ' ') + part;
  }
  return out;
}

/** A part that starts with a Latin letter or a digit is a word of its own. */
const STARTS_WITH_LATIN_WORD = /^[A-Za-z0-9\u00c0-\u024f]/;

/**
 * Join a heading whose third part was written to CONTINUE the accent (Account
 * and Delete: the bundles were translated for `em` + `after` with nothing in
 * between). Script cannot tell a Korean ending from a Korean word: "작업" +
 * "이에요." and "내 정보" + "예요." are one word each, while the search
 * heading's "찾고 있는지" + "알려주세요." are two. So the third part attaches,
 * except when it is a Latin word ("buttons.", "Schaltflächen."), the one case
 * that template got wrong ("The one-waybuttons.").
 */
export function joinTitleTail(before: string, em: string, after: string): string {
  const head = joinTitle(before, em);
  const tail = after.trim();
  if (!head || !tail) return head || tail;
  return head + (STARTS_WITH_LATIN_WORD.test(tail) ? ' ' : '') + tail;
}

// ── Layout scaffolding ────────────────────────────────────────────────

export function PrefHeader({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string;
  title: ReactNode;
  sub?: string;
}) {
  return (
    <header className="pref-head">
      <div className="pref-eyebrow">{eyebrow}</div>
      <h1 className="pref-title">{title}</h1>
      {sub ? <p className="pref-sub">{sub}</p> : null}
    </header>
  );
}

export function PrefGroup({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <section className="pref-group">
      {label ? <div className="pref-group-label">{label}</div> : null}
      <div className="pref-group-body">{children}</div>
    </section>
  );
}

export function PrefRow({
  label,
  sub,
  children,
  span = 1,
  align = 'center',
}: {
  label: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  span?: 1 | 2;
  align?: 'center' | 'top';
}) {
  return (
    <div
      className={`pref-row span-${span}`}
      style={{ alignItems: align === 'top' ? 'flex-start' : 'center' }}
    >
      <div className="pref-row-meta">
        <div className="pref-row-label">{label}</div>
        {sub ? <div className="pref-row-sub">{sub}</div> : null}
      </div>
      <div className="pref-row-control">{children}</div>
    </div>
  );
}

// ── Inputs ──────────────────────────────────────────────────────────────

export function Toggle({
  value,
  onChange,
  ariaLabel,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className={`pref-toggle ${value ? 'on' : ''}`}
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
    >
      <span className="pref-toggle-thumb" />
    </button>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  prefix,
  ariaLabel,
  readOnly = false,
  error,
  maxLength,
  autoComplete,
}: {
  value: string;
  /** Omit together with `readOnly` for a value this page shows but does not edit. */
  onChange?: (v: string) => void;
  placeholder?: string;
  prefix?: ReactNode;
  ariaLabel?: string;
  /** Shown, selectable and announced as read-only; never an input that silently ignores typing. */
  readOnly?: boolean;
  /** What is wrong with the value, in plain words; shown under the field while it applies. */
  error?: string | null;
  maxLength?: number;
  autoComplete?: string;
}) {
  // One wrapper whether or not there is a message: the message sits under the
  // field (the row's control area is a flex row), and the input is never
  // remounted when a message appears while the user is typing.
  return (
    <div className="pref-field">
      <div className="pref-input-wrap">
        {prefix ? <span className="pref-input-prefix">{prefix}</span> : null}
        <input
          className="pref-input"
          value={value || ''}
          placeholder={placeholder}
          aria-label={ariaLabel}
          readOnly={readOnly}
          aria-readonly={readOnly || undefined}
          aria-invalid={error ? true : undefined}
          maxLength={maxLength}
          autoComplete={autoComplete}
          onChange={(e) => onChange?.(e.target.value)}
        />
      </div>
      {error ? (
        <p className="pref-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
}) {
  return (
    <div className="pref-select-wrap">
      <select
        className="pref-select"
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pref-select-caret">▾</span>
    </div>
  );
}

export function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
}) {
  return (
    <div className="pref-seg">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`pref-seg-opt ${value === o.value ? 'on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  fmt,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  suffix?: string;
  fmt?: (v: number) => string | number;
  ariaLabel?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="pref-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          background: `linear-gradient(90deg, var(--action) ${pct}%, var(--surface-3) ${pct}%)`,
        }}
      />
      <div className="pref-slider-val">
        {fmt ? fmt(value) : value}
        {suffix}
      </div>
    </div>
  );
}

export function ChipInput({
  values,
  onAdd,
  onRemove,
  placeholder,
}: {
  values: string[];
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState('');
  const submit = (e?: React.FormEvent | React.KeyboardEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if (trimmed) {
      onAdd(trimmed);
      setInput('');
    }
  };
  return (
    <div className="pref-chip-input">
      <div className="pref-chips">
        {values.map((v, i) => (
          <span key={`${v}-${i}`} className="pref-chip">
            {v}
            <button type="button" onClick={() => onRemove(v)} aria-label={`Remove ${v}`}>
              ×
            </button>
          </span>
        ))}
        <form onSubmit={submit} style={{ display: 'inline-flex' }}>
          <input
            value={input}
            placeholder={placeholder}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === ',') submit(e);
            }}
          />
        </form>
      </div>
    </div>
  );
}

export type CheckGridItem = string | { id: string; label: string; sub?: string };

export function CheckGrid({
  items,
  values,
  onToggle,
  cols = 3,
}: {
  items: CheckGridItem[];
  /** Either an array of selected ids or a Record<id, boolean>. */
  values: string[] | Record<string, boolean>;
  onToggle: (id: string) => void;
  cols?: number;
}) {
  const isObj = !Array.isArray(values);
  const has = (id: string) =>
    isObj ? !!(values as Record<string, boolean>)[id] : (values as string[]).includes(id);
  return (
    <div
      className="pref-checkgrid"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {items.map((it) => {
        const id = typeof it === 'string' ? it : it.id;
        const lbl = typeof it === 'string' ? it : it.label;
        const sub = typeof it === 'object' ? it.sub : null;
        return (
          <label key={id} className={`pref-check ${has(id) ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={has(id)}
              onChange={() => onToggle(id)}
            />
            <span className="pref-check-box">
              {has(id) ? <IconCheck size={11} strokeWidthValue={3.5} /> : null}
            </span>
            <span className="pref-check-body">
              <span className="pref-check-label">{lbl}</span>
              {sub ? <span className="pref-check-sub">{sub}</span> : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}
