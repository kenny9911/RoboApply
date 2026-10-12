'use client';

// components/features/filters/SearchTypeahead.tsx — title / company search
// with typeahead (PRODUCT F-FILT-06): suggestions after 2 characters (1 for
// Chinese), 300 ms debounce, job titles from our taxonomy and companies from
// our index. Picking a title adds the role to the function filter; picking a
// company limits the list to it; Enter searches the typed words (`q`). Each
// is one PATCH with `baseVersion`.

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';

import { toast } from '../../v3/primitives/Toast';
import { cn } from '../../../lib/utils';
import { useApplyFilters, useOptimisticFilters } from '../../../hooks/search/useApplyFilters';
import { typeaheadReady, useCompanySuggestions, useTitleSuggestions } from '../../../hooks/search/useFilterQueries';
import type { FilterSetPatch } from '../../../hooks/search/filterModel';
import type { SearchProfile } from '../../../hooks/search/useSearchProfiles';
import { useEditorContext } from './FilterSections';
import styles from './filters.module.css';

interface Row {
  kind: 'title' | 'company' | 'keyword';
  value: string;
  label: string;
  context?: string | null;
}

export interface SearchTypeaheadProps {
  profile: SearchProfile | null;
  onApplied?: (profile: SearchProfile) => void;
}

export function SearchTypeahead({ profile: saved, onApplied }: SearchTypeaheadProps) {
  const t = useTranslations('filters.search');
  const tDrawer = useTranslations('filters.drawer');
  const ctx = useEditorContext();
  const { apply } = useApplyFilters();
  // A pick is added to the filters as the user just left them (a change still being saved included).
  const { profile } = useOptimisticFilters(saved);
  const listId = useId();
  const [text, setText] = useState(profile?.filters.q ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  useEffect(() => setText(profile?.filters.q ?? ''), [profile?.filters.q]);

  const titles = useTitleSuggestions(text);
  const companies = useCompanySuggestions(text);
  const typed = text.trim();
  const rows: Row[] = typeaheadReady(typed)
    ? [
        ...(titles.data ?? []).slice(0, 6).map((s) => ({ kind: 'title' as const, value: s.id, label: s.label, context: s.context })),
        ...(companies.data ?? []).slice(0, 5).map((c) => ({ kind: 'company' as const, value: c.name, label: c.name, context: c.domain })),
        { kind: 'keyword' as const, value: typed, label: t('keyword', { q: typed }) },
      ]
    : [];
  const showList = open && rows.length > 0;

  const save = async (patch: FilterSetPatch) => {
    if (!profile) return;
    const result = await apply({ profile, patch, defaultCountry: ctx.defaultCountry });
    if (result.ok) onApplied?.(result.profile);
    else toast({ message: result.conflict ? tDrawer('conflict') : tDrawer('saveFailed'), tone: 'warn' });
  };

  const choose = (row: Row) => {
    setOpen(false);
    setActive(-1);
    if (!profile) return;
    const fs = profile.filters;
    if (row.kind === 'title') {
      setText('');
      if ((fs.taxonomyIds ?? []).includes(row.value)) return;
      void save({ taxonomyIds: [...(fs.taxonomyIds ?? []), row.value], q: null });
    } else if (row.kind === 'company') {
      setText('');
      if ((fs.companies ?? []).some((c) => c.toLowerCase() === row.value.toLowerCase())) return;
      void save({ companies: [...(fs.companies ?? []), row.value], q: null });
    } else {
      void save({ q: row.value || null });
    }
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
      const row = active >= 0 ? rows[active] : null;
      if (row) choose(row);
      else if (profile && typed !== (profile.filters.q ?? '')) {
        setOpen(false);
        void save({ q: typed || null });
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  let lastKind: Row['kind'] | null = null;
  return (
    <div className={`${styles.combo} ${styles.searchCombo}`} role="search">
      <label htmlFor={`${listId}-input`} className={styles.hidden}>
        {t('label')}
      </label>
      <input
        id={`${listId}-input`}
        className={styles.input}
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder={t('placeholder')}
        value={text}
        disabled={!profile}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <ul id={listId} role="listbox" className={styles.listbox} aria-label={t('label')}>
          {rows.map((r, i) => {
            const header = r.kind !== lastKind && r.kind !== 'keyword' ? (r.kind === 'title' ? t('titles') : t('companies')) : null;
            lastKind = r.kind;
            return (
              <li key={`${r.kind}:${r.value}`} role="presentation">
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
                    choose(r);
                  }}
                >
                  <span>{r.label}</span>
                  {r.context ? <span className={styles.optionContext}>{r.context}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
