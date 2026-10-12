'use client';

// components/features/filters/SavedSearchSwitcher.tsx — pick the saved search
// the feed uses, or save the current filters as a new one (PRODUCT
// F-FEED-03). The number of saved searches is the plan's `saved_searches`
// entitlement (Free 1, Pro 10, from the catalog); at the cap the switcher says
// so with an inline Pro note when Pro is sellable. Rename, delete and alerts
// live in Settings → Your search (SettingsSection).

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { Btn } from '../../v3/primitives/Btn';
import {
  searchErrorReason,
  useActivateSearchProfile,
  useCreateSearchProfile,
  type SearchProfile,
  type SearchProfileList,
} from '../../../hooks/search/useSearchProfiles';
import { searchKeys } from '../../../hooks/search/keys';
import styles from './filters.module.css';

export interface ProfileLabels {
  /** For the unnamed main (default) search. */
  main: string;
  /** For an unnamed other search, by its position in the list (1-based). */
  numbered: (n: number) => string;
  /** For an unnamed other search whose position is unknown. */
  other: string;
}

type Labelled = Pick<SearchProfile, 'id' | 'name' | 'isDefault'>;

/**
 * The name shown for a saved search. An unnamed search is called "Your main
 * search" only when it IS the main one; any other unnamed search is
 * "Saved search {n}" (its place in the list), so two entries never share the
 * main search's label.
 */
export function profileLabel(p: Labelled, labels: ProfileLabels, profiles: ReadonlyArray<Pick<SearchProfile, 'id'>> = []): string {
  const name = p.name.trim();
  if (name) return name;
  if (p.isDefault) return labels.main;
  const n = profiles.findIndex((x) => x.id === p.id) + 1;
  return n > 0 ? labels.numbered(n) : labels.other;
}

/**
 * `profileLabel` bound to the staged copy. Without `profiles` it numbers
 * against the cached saved-search list (no request).
 */
export function useProfileLabel(profiles?: ReadonlyArray<Pick<SearchProfile, 'id'>>): (p: Labelled) => string {
  const t = useTranslations('filters');
  const qc = useQueryClient();
  return useCallback(
    (p: Labelled) =>
      profileLabel(
        p,
        { main: t('unnamed'), numbered: (n) => t('unnamedNumbered', { n }), other: t('unnamedOther') },
        profiles ?? qc.getQueryData<SearchProfileList>(searchKeys.profiles())?.profiles ?? [],
      ),
    [t, qc, profiles],
  );
}

export function SavedSearchNote({ list }: { list: Pick<SearchProfileList, 'maxProfiles' | 'proMaxProfiles' | 'upgradable'> }) {
  const t = useTranslations('filters.saved');
  return (
    <p className={styles.note}>
      <span>{t('capNote', { max: list.maxProfiles })}</span>
      {list.upgradable && list.proMaxProfiles !== null ? (
        <>
          <span>{t('proNote', { proMax: list.proMaxProfiles })}</span>
          <a className={styles.noteLink} href="/pricing">
            {t('seePro')}
          </a>
        </>
      ) : null}
    </p>
  );
}

export interface SavedSearchSwitcherProps {
  list: SearchProfileList | undefined;
  active: SearchProfile | null;
}

export function SavedSearchSwitcher({ list, active }: SavedSearchSwitcherProps) {
  const t = useTranslations('filters');
  const activate = useActivateSearchProfile();
  const create = useCreateSearchProfile();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const label = useProfileLabel(list?.profiles);
  if (!list || !active) return null;

  const atCap = list.profiles.length >= list.maxProfiles;

  const save = () => {
    setError(null);
    create.mutate(
      { name: name.trim(), filters: active.filters, activate: true },
      {
        onSuccess: () => {
          setNaming(false);
          setName('');
        },
        onError: (err) => setError(searchErrorReason(err) === 'saved_search_limit' ? t('saved.limitReached') : t('saved.createFailed')),
      },
    );
  };

  return (
    <div className={styles.switcher}>
      <label className={styles.hidden} htmlFor="saved-search-select">
        {t('saved.label')}
      </label>
      {list.profiles.length > 1 ? (
        <select
          id="saved-search-select"
          className={`${styles.select} ${styles.switcherSelect}`}
          value={active.id}
          disabled={activate.isPending}
          onChange={(e) => activate.mutate(e.target.value)}
        >
          {list.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {label(p)}
              {p.isDefault ? ` · ${t('saved.main')}` : ''}
            </option>
          ))}
        </select>
      ) : (
        <span id="saved-search-select" className={styles.fieldLabel}>
          {label(active)}
        </span>
      )}
      {naming ? (
        <form
          className={styles.inlineForm}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            className={styles.input}
            aria-label={t('saved.namePlaceholder')}
            placeholder={t('saved.namePlaceholder')}
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <Btn type="submit" variant="primary" disabled={create.isPending}>
            {t('saved.save')}
          </Btn>
          <Btn variant="ghost" onClick={() => setNaming(false)}>
            {t('saved.cancel')}
          </Btn>
        </form>
      ) : (
        <Btn variant="ghost" onClick={() => setNaming(true)} disabled={atCap}>
          {t('saved.saveAs')}
        </Btn>
      )}
      {atCap || error ? (
        <div className={styles.inlineForm}>
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
          {atCap ? <SavedSearchNote list={list} /> : null}
        </div>
      ) : null}
    </div>
  );
}
