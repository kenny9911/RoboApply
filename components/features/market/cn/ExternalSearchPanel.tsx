'use client';

// ExternalSearchPanel — "search other job sites" with the user's own words
// (CN L-5; wave3 WP-93 #8). GoApply only; renders nothing on RoboApply.
//
// Shown where GoApply has no third-party postings to list (the job listings
// are switched off): the jobs page's empty state and "Added by you". Also
// shown under the list when the result set is thin (`variant="thin"`), so a
// search with few results always leads somewhere (MARKET_STRATEGY §1.4). The user
// types what they are looking for; we show links that open that search on
// BOSS直聘 / 智联招聘 / 猎聘 in a new tab (ExternalSearchLinks; the links are
// built server-side and carry only the query). We never fetch, sign in, fill
// or message on those sites, and nothing found there is shown here: the user
// adds the jobs they like themselves.

import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../../v3/primitives';
import { useBrand } from '../../../../lib/brand/BrandProvider';
import { ExternalSearchLinks } from './ExternalSearchLinks';
import styles from './cnJobs.module.css';

export interface ExternalSearchPanelProps {
  /** Words to start with (the user's saved search); the user can change them. */
  initialQuery?: string | null;
  city?: string | null;
  className?: string;
  /**
   * `empty` (default): nothing is listed here. `thin`: the list above has few
   * results, and the intro says so instead of saying nothing is listed.
   */
  variant?: 'empty' | 'thin';
}

const MAX_QUERY = 80;

export function ExternalSearchPanel({ initialQuery, city, className, variant = 'empty' }: ExternalSearchPanelProps) {
  const brand = useBrand();
  const t = useTranslations('jobsCn.external');
  const id = useId();
  const start = (initialQuery ?? '').trim().slice(0, MAX_QUERY);
  const [draft, setDraft] = useState(start);
  const [query, setQuery] = useState(start);
  // Follow a starting value that arrives after mount (the saved search loads
  // late) until the user types their own words.
  const [seenStart, setSeenStart] = useState(start);
  if (start !== seenStart) {
    setSeenStart(start);
    if (draft === seenStart && query === seenStart) {
      setDraft(start);
      setQuery(start);
    }
  }

  if (brand.market !== 'cn') return null;

  function submit(e: FormEvent) {
    e.preventDefault();
    setQuery(draft.trim());
  }

  return (
    <section className={[styles.searchPanel, className].filter(Boolean).join(' ')} aria-labelledby={`${id}-h`} data-testid="cn-external-search" data-variant={variant}>
      <h2 className={styles.h2} id={`${id}-h`}>
        {t('panel.title')}
      </h2>
      <p className={styles.muted}>{t(variant === 'thin' ? 'panel.thinIntro' : 'panel.intro')}</p>
      <form className={styles.searchRow} onSubmit={submit} role="search" aria-labelledby={`${id}-h`}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-q`}>
            {t('panel.label')}
          </label>
          <input
            id={`${id}-q`}
            className={styles.input}
            type="search"
            value={draft}
            maxLength={MAX_QUERY}
            placeholder={t('panel.placeholder')}
            autoComplete="off"
            enterKeyHint="search"
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <Btn type="submit" disabled={!draft.trim()}>
          {t('panel.submit')}
        </Btn>
      </form>
      <ExternalSearchLinks query={query} city={city} className={styles.externalBare} />
    </section>
  );
}

export default ExternalSearchPanel;
