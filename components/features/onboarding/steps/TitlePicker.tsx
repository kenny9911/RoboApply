'use client';

// O2 job-title typeahead over the role taxonomy (GET /onboarding/title-suggest).
// 1–3 titles; Enter adds the typed text as a custom title; a broad (level-1)
// title shows "This is broad…" and offers its more specific children as chips.

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { useTitleSuggest } from '../../../../hooks/onboarding/useOnboarding';
import { IconX } from '../../../v3/primitives/Iconset';
import { LIMITS } from '../options';
import styles from '../onboarding.module.css';

export interface PickedTitle {
  taxonomyId?: string;
  label: string;
}

interface BroadHint {
  label: string;
  children: Array<{ taxonomyId: string; label: string }>;
}

export function TitlePicker({ value, onChange, error }: { value: PickedTitle[]; onChange: (v: PickedTitle[]) => void; error?: string | null }) {
  const t = useTranslations('onboarding.basics');
  const locale = useLocale();
  const id = useId();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [broad, setBroad] = useState<BroadHint | null>(null);
  const [limitHit, setLimitHit] = useState(false);

  useEffect(() => {
    const h = setTimeout(() => setDebounced(text), 200);
    return () => clearTimeout(h);
  }, [text]);

  const suggest = useTitleSuggest(debounced, locale);
  const items = (suggest.data?.items ?? []).filter((s) => !value.some((v) => v.taxonomyId === s.taxonomyId));
  const custom = text.trim();
  const options: Array<{ key: string; label: string; context?: string | null; pick: () => void }> = [
    ...items.map((s) => ({
      key: s.taxonomyId,
      label: s.label,
      context: s.context,
      pick: () => {
        add({ taxonomyId: s.taxonomyId, label: s.label });
        setBroad(s.tooGeneral ? { label: s.label, children: s.children } : null);
      },
    })),
    ...(custom.length >= 2 && !items.some((s) => s.label.toLowerCase() === custom.toLowerCase())
      ? [{ key: '__custom', label: t('addCustom', { title: custom }), pick: () => add({ label: custom }) }]
      : []),
  ];

  function add(p: PickedTitle) {
    if (value.length >= LIMITS.titles) {
      setLimitHit(true);
      return;
    }
    if (value.some((v) => (p.taxonomyId ? v.taxonomyId === p.taxonomyId : !v.taxonomyId && v.label.toLowerCase() === p.label.toLowerCase()))) return;
    setLimitHit(false);
    onChange([...value, p]);
    setText('');
    setOpen(false);
    setActive(0);
  }

  function remove(i: number) {
    const next = value.filter((_, j) => j !== i);
    setLimitHit(false);
    if (broad && value[i]?.label === broad.label) setBroad(null);
    onChange(next);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(0, options.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && options[active]) options[active].pick();
      else if (custom.length >= 2) add({ label: custom });
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const listId = `${id}-list`;
  return (
    <div className={styles.fieldset}>
      <label className={styles.label} htmlFor={`${id}-input`}>
        {t('functionsLabel')}
      </label>
      {value.length ? (
        <ul className={styles.chips} aria-label={t('functionsLabel')} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {value.map((v, i) => (
            <li key={`${v.taxonomyId ?? 'c'}-${v.label}`} className={styles.chip} aria-pressed="true">
              {v.label}
              <button type="button" className={styles.chipRemove} aria-label={t('remove', { label: v.label })} onClick={() => remove(i)}>
                <IconX size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.combo}>
        <input
          id={`${id}-input`}
          className={styles.input}
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${id}-opt-${active}` : undefined}
          placeholder={t('functionsPlaceholder')}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
        />
        {open && options.length > 0 ? (
          <ul id={listId} role="listbox" className={styles.listbox}>
            {options.map((o, i) => (
              <li
                key={o.key}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={styles.option}
                onMouseDown={(e) => {
                  e.preventDefault();
                  o.pick();
                }}
              >
                <span>{o.label}</span>
                {o.context ? <span className={styles.optionContext}>{o.context}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <p className={styles.hint}>{t('functionsHint')}</p>
      {limitHit ? (
        <p className={styles.fieldError} role="alert">
          {t('tooMany')}
        </p>
      ) : null}
      {broad ? (
        <div className={styles.notice} role="status">
          <p style={{ margin: '0 0 var(--sp-2)' }}>{t('tooBroad')}</p>
          <div className={styles.chips}>
            {broad.children.map((c) => (
              <button
                key={c.taxonomyId}
                type="button"
                className={styles.chip}
                onClick={() => {
                  const without = value.filter((v) => v.label !== broad.label);
                  if (without.length >= LIMITS.titles) {
                    setLimitHit(true);
                    return;
                  }
                  onChange([...without, { taxonomyId: c.taxonomyId, label: c.label }]);
                  setBroad(null);
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
