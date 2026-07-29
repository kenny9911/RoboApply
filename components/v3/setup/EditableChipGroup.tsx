'use client';

// EditableChipGroup + TogglePillGroup — the two chip controls step 2 is made
// of. Everything on that screen is one of these, which is the point: a confirm
// screen that mixes selects, sliders and text fields is an interrogation with
// better manners.
//
// THREE VISUAL CLASSES, and the difference is load-bearing:
//
//   applied + read      filled chip. "This is on your resume."
//   applied + inferred  filled chip, DASHED outline, an uncertainty marker.
//                       "This was guessed." A guess dressed as a fact is where
//                       fast-and-respectful flips to presumptuous.
//   suggested           outline chip, UNSELECTED. Not a value yet. This is how
//                       the resume's city arrives: as a question, because
//                       `location` is a substring filter and a wrong city
//                       returns an empty feed with no explanation.
//
// Removing a chip removes it — `POST /confirm` replaces list fields rather
// than unioning them, so the × is real.
//
// No stylesheet: the panel is built from existing `.chip` / `.btn` classes plus
// inline token values, so it lands without touching a shared CSS file. Every
// inline fontSize is a `var(--fs-*)` token and every weight is 400/500/600/700
// (`npm run check:design` reads these files).

import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';

import { IconX } from '../primitives/Iconset';
import type { OnboardingSeedSource } from '../../../lib/api/v2/types';

/** One selectable value: a stable machine id plus the string a person reads. */
export interface ChipOption {
  id: string;
  label: string;
}

interface GroupShellProps {
  label: string;
  /** The `why_*` evidence line, when the resume actually said something. */
  evidence?: string | null;
  /** Provenance of the seeded values, when there are any. */
  source?: OnboardingSeedSource | null;
  children: React.ReactNode;
}

/** Label + provenance + evidence, shared by both controls. */
function GroupShell({ label, evidence, source, children }: GroupShellProps) {
  const t = useTranslations('jobs.setup');
  return (
    <section style={{ marginBottom: 'var(--sp-5)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 'var(--sp-2)',
          flexWrap: 'wrap',
          marginBottom: 'var(--sp-2)',
        }}
      >
        <h3
          style={{
            fontSize: 'var(--fs-body)',
            fontWeight: 600,
            color: 'var(--text)',
            margin: 0,
            letterSpacing: 'var(--ls-body)',
          }}
        >
          {label}
        </h3>
        {source ? (
          <span
            style={{
              fontSize: 'var(--fs-label)',
              fontWeight: 500,
              color: source === 'inferred' ? 'var(--warn)' : 'var(--text-muted)',
            }}
          >
            {source === 'inferred' ? t('uncertain') : t('source_resume')}
          </span>
        ) : null}
      </div>
      {evidence ? (
        <p
          style={{
            fontSize: 'var(--fs-meta)',
            color: 'var(--text-2)',
            margin: '0 0 var(--sp-2)',
            lineHeight: 'var(--lh-meta)',
          }}
        >
          {evidence}
        </p>
      ) : null}
      {children}
    </section>
  );
}

/** Filled-chip styling. Inferred values carry the dashed outline. */
function appliedChipStyle(inferred: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    padding: 'var(--sp-2) var(--sp-3)',
    borderRadius: 'var(--r-pill)',
    background: 'var(--action-subtle)',
    border: `1px ${inferred ? 'dashed' : 'solid'} var(--action)`,
    color: 'var(--text)',
    fontSize: 'var(--fs-meta)',
    fontWeight: 500,
    maxWidth: '100%',
  };
}

interface EditableChipGroupProps {
  label: string;
  /** Applied values, in the order they render. */
  values: string[];
  /** Machine id → readable label, for closed enums. Identity by default. */
  renderValue?: (value: string) => string;
  onRemove: (value: string) => void;
  /** Omit to make the group read-only (no add input). */
  onAdd?: (value: string) => void;
  /** Unselected suggestions rendered under the values. */
  suggestions?: ChipOption[];
  onSelectSuggestion?: (id: string) => void;
  /** Placeholder for the add input. Defaults to `chip_input_placeholder`. */
  addPlaceholder?: string;
  /** Shown INSTEAD of an apology when the group is empty. An unfilled row is
   *  not a failure — it means every option stays in. */
  emptyPrompt: string;
  evidence?: string | null;
  source?: OnboardingSeedSource | null;
}

export function EditableChipGroup({
  label,
  values,
  renderValue = (v) => v,
  onRemove,
  onAdd,
  suggestions = [],
  onSelectSuggestion,
  addPlaceholder,
  emptyPrompt,
  evidence,
  source,
}: EditableChipGroupProps) {
  const t = useTranslations('jobs.setup');
  const [pending, setPending] = useState('');
  const inputId = useId();
  const inferred = source === 'inferred';

  function commit() {
    const value = pending.trim();
    if (!value || !onAdd) return;
    onAdd(value);
    setPending('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    // The panel is inside a form-less card, but Enter in a text field still
    // reaches the primary button in some browsers. Adding a chip must never
    // submit the whole screen.
    e.preventDefault();
    commit();
  }

  return (
    <GroupShell
      label={label}
      evidence={evidence}
      source={values.length > 0 ? source : null}
    >
      {values.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--sp-2)',
            marginBottom: 'var(--sp-2)',
          }}
        >
          {values.map((value) => (
            <span key={value} style={appliedChipStyle(inferred)}>
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {renderValue(value)}
              </span>
              <button
                type="button"
                onClick={() => onRemove(value)}
                aria-label={t('chip_remove', { value: renderValue(value) })}
                style={{
                  display: 'inline-grid',
                  placeItems: 'center',
                  width: 18,
                  height: 18,
                  borderRadius: 'var(--r-pill)',
                  border: 0,
                  background: 'transparent',
                  color: 'var(--text-2)',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                <IconX size={13} strokeWidthValue={2.4} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p
          style={{
            fontSize: 'var(--fs-meta)',
            color: 'var(--text-muted)',
            margin: '0 0 var(--sp-2)',
          }}
        >
          {emptyPrompt}
        </p>
      )}

      {suggestions.length > 0 && onSelectSuggestion ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 'var(--sp-2)',
            marginBottom: 'var(--sp-2)',
          }}
        >
          <span
            style={{
              fontSize: 'var(--fs-label)',
              color: 'var(--text-muted)',
              fontWeight: 500,
            }}
          >
            {t('chip_suggested')}
          </span>
          {suggestions.map((option) => (
            <button
              key={option.id}
              type="button"
              className="chip"
              onClick={() => onSelectSuggestion(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}

      {onAdd ? (
        <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <label htmlFor={inputId} className="sr-only">
            {label}
          </label>
          <input
            id={inputId}
            type="text"
            value={pending}
            onChange={(e) => setPending(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={addPlaceholder ?? t('chip_input_placeholder')}
            style={{
              flex: 1,
              minWidth: 0,
              border: '1px solid var(--rule)',
              borderRadius: 'var(--r-sm)',
              background: 'var(--surface)',
              color: 'var(--text)',
              padding: 'var(--sp-2) var(--sp-3)',
              fontFamily: 'inherit',
              fontSize: 'var(--fs-meta)',
              fontWeight: 400,
              minHeight: 'var(--control-md)',
            }}
          />
          <button
            type="button"
            className="btn ghost"
            onClick={commit}
            disabled={!pending.trim()}
          >
            {t('chip_add')}
          </button>
        </div>
      ) : null}
    </GroupShell>
  );
}

interface TogglePillGroupProps {
  label: string;
  options: ChipOption[];
  selected: string[];
  onToggle: (id: string) => void;
  /** Rendered when nothing is selected — "Nothing set. Every option stays in."
   *  Empty is a legitimate answer here and must not read as an omission. */
  emptyPrompt: string;
  evidence?: string | null;
  source?: OnboardingSeedSource | null;
  /** Extra content under the pills (the city suggestion, the add-a-place row). */
  children?: React.ReactNode;
}

export function TogglePillGroup({
  label,
  options,
  selected,
  onToggle,
  emptyPrompt,
  evidence,
  source,
  children,
}: TogglePillGroupProps) {
  const inferred = source === 'inferred';
  return (
    <GroupShell
      label={label}
      evidence={evidence}
      source={selected.length > 0 ? source : null}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--sp-2)',
          marginBottom: 'var(--sp-2)',
        }}
      >
        {options.map((option) => {
          const on = selected.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              role="switch"
              aria-checked={on}
              onClick={() => onToggle(option.id)}
              className={on ? undefined : 'chip'}
              style={on ? { ...appliedChipStyle(inferred), cursor: 'pointer' } : undefined}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {selected.length === 0 ? (
        <p
          style={{
            fontSize: 'var(--fs-meta)',
            color: 'var(--text-muted)',
            margin: '0 0 var(--sp-2)',
          }}
        >
          {emptyPrompt}
        </p>
      ) : null}
      {children}
    </GroupShell>
  );
}
