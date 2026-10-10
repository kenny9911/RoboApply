'use client';

// O2 job-title typeahead over the role taxonomy (GET /onboarding/title-suggest).
// 1–3 titles; Enter adds the typed text as a custom title; a broad (level-1)
// title shows "This is broad…" and offers its more specific children as chips.
//
// Names in the reader's language: the taxonomy has English and Simplified
// Chinese labels only, so for every other locale the server answers in
// English. Categories and role groups are in the web bundle in all nine
// locales (`taxonomy.categories.<id>` / `taxonomy.groups.<id>`), so those
// names, and the "role group · category" line under a role, are read from the
// bundle by id. A role's own name stays as the server sent it until the
// taxonomy carries it in that language. The "too many titles" message goes
// away as soon as a title is removed or the field is edited.

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
  const tt = useTranslations('taxonomy');
  const locale = useLocale();
  /** A category (level 1) or role group (level 2) in the reader's language; anything else as given. */
  const nameOf = (nodeId: string, level: number | null, fallback: string): string => {
    const keys = level === 1 ? ['categories'] : level === 2 ? ['groups'] : level === null ? ['groups', 'categories'] : [];
    for (const k of keys) if (tt.has(`${k}.${nodeId}`)) return tt(`${k}.${nodeId}`);
    return fallback;
  };
  const id = useId();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [broad, setBroad] = useState<BroadHint | null>(null);
  // "Pick up to 3 titles" was raised; it shows only while the list is still full.
  const [limitRaised, setLimitHit] = useState(false);
  const limitHit = limitRaised && value.length >= LIMITS.titles;

  useEffect(() => {
    const h = setTimeout(() => setDebounced(text), 200);
    return () => clearTimeout(h);
  }, [text]);

  const suggest = useTitleSuggest(debounced, locale);
  // Suggestions belong to the text they were fetched for. While the box holds
  // something newer (the 200 ms before the next fetch), none are offered:
  // Enter on a freshly typed title used to pick the first suggestion of the
  // previous query instead of adding what was typed.
  const current = debounced.trim() === text.trim();
  const items = (current ? (suggest.data?.items ?? []) : []).filter((s) => !value.some((v) => v.taxonomyId === s.taxonomyId));
  const custom = text.trim();
  const options: Array<{ key: string; label: string; context?: string | null; pick: () => void }> = [
    ...items.map((s) => {
      const label = nameOf(s.taxonomyId, s.level, s.label);
      // The line under a role: its role group and category, by id when the server sent them.
      const context = s.contextIds?.length ? s.contextIds.map((cid) => nameOf(cid, null, '')).filter(Boolean).join(' · ') || s.context : s.context;
      return {
        key: s.taxonomyId,
        label,
        context,
        pick: () => {
          add({ taxonomyId: s.taxonomyId, label });
          setBroad(s.tooGeneral ? { label, children: s.children.map((c) => ({ taxonomyId: c.taxonomyId, label: nameOf(c.taxonomyId, c.level, c.label) })) } : null);
        },
      };
    }),
    ...(custom.length >= 2 && !items.some((s) => s.label.toLowerCase() === custom.toLowerCase() || nameOf(s.taxonomyId, s.level, s.label).toLowerCase() === custom.toLowerCase())
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
            // Clearing the box after a refused fourth title also clears the message.
            if (!e.target.value.trim()) setLimitHit(false);
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
