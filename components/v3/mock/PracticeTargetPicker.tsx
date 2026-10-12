'use client';

// "Which job are you interviewing for?" — the practice setup's first input.
//
// The candidate types the job in their own words ("AI FDE", "前端工程师") and
// the search reads it the way employers post it, then lists the roles that
// match and real openings from their job market (our own job list, the job
// boards, open career sites). They pick a posting, a role, or paste a post.
// With nothing typed, they can browse by industry — a listed one or their own.
// A target company is optional; with one, the interview is planned in that
// company's style.
//
// This component only renders: the page owns the state and the queries.

import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import type { PrepIndustry, PrepPosting, PrepRoleSuggestion, PrepSearchResult } from '../../../lib/api/interviewEngine';
import { formatRelativeTime } from '../../../lib/relativeTime';
import { IconArrow, IconRefresh, IconSearch, IconStack, IconX } from '../primitives/Iconset';
import styles from './PracticeSetupFlow.module.css';

/** Find a job (search or browse), or paste the job post itself. */
export type RoleSourceMode = 'role' | 'jd';

export type PracticeTarget =
  | { kind: 'role'; title: string; titleEn: string | null }
  | { kind: 'posting'; posting: PrepPosting };

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** A job post needs at least this many characters before it's worth planning from. */
export const JD_MIN_CHARS = 40;

/** Industries shown before "More industries". */
const TOP_INDUSTRIES = 12;

interface Props {
  sourceMode: RoleSourceMode;
  onSourceModeChange: (value: RoleSourceMode) => void;

  query: string;
  onQueryChange: (value: string) => void;
  company: string;
  onCompanyChange: (value: string) => void;

  industries: PrepIndustry[] | null;
  /** The chosen industry: a listed id, or the text the candidate typed. */
  industry: string | null;
  onIndustryChange: (value: string | null) => void;
  industryRoles: { state: LoadState; roles: PrepRoleSuggestion[] };
  onRetryIndustryRoles: () => void;

  search: { state: LoadState; pending: boolean; result: PrepSearchResult | null };
  onRetrySearch: () => void;

  target: PracticeTarget | null;
  onSelectTarget: (target: PracticeTarget) => void;
  onClearTarget: () => void;

  jdText: string;
  onJdTextChange: (value: string) => void;

  /** A job from `?job=` replaces the picker (the banner says which). */
  jobBanner?: ReactNode;
  /** The taxonomy label of a role id in the UI language, when the bundle has it. */
  localizeTaxonomy?: (id: string, fallback: string) => string;
}

function regionName(country: string | null, locale: string): string | null {
  if (!country) return null;
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(country.toUpperCase()) ?? country;
  } catch {
    return country;
  }
}

function moveFocus(event: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-roving]'));
  if (!items.length) return;
  event.preventDefault();
  const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
  const next =
    event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (current - 1 + items.length) % items.length
          : (current + 1) % items.length;
  items[next]?.focus();
}

export function PracticeTargetPicker({
  sourceMode,
  onSourceModeChange,
  query,
  onQueryChange,
  company,
  onCompanyChange,
  industries,
  industry,
  onIndustryChange,
  industryRoles,
  onRetryIndustryRoles,
  search,
  onRetrySearch,
  target,
  onSelectTarget,
  onClearTarget,
  jdText,
  onJdTextChange,
  jobBanner,
  localizeTaxonomy,
}: Props) {
  const t = useTranslations('practice');
  const locale = useLocale();
  const companyId = useId();
  const otherId = useId();
  const [allIndustries, setAllIndustries] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState('');

  const searching = query.trim().length > 0;
  const result = search.result;
  const listedIndustry = industries?.find((item) => item.id === industry) ?? null;
  const industryLabel = listedIndustry?.label ?? industry ?? '';
  const visibleIndustries = (industries ?? []).filter((item, index) => allIndustries || item.top || index < TOP_INDUSTRIES);
  const jdLength = jdText.trim().length;

  function roleLabel(role: PrepRoleSuggestion): string {
    return role.taxonomyId && localizeTaxonomy ? localizeTaxonomy(role.taxonomyId, role.title) : role.title;
  }

  function sourceLabel(posting: PrepPosting): string {
    if (posting.source === 'index') return t('setup.prep.source.index');
    if (posting.source === 'web') return t('setup.prep.source.web', { host: posting.provider ?? '' });
    return t('setup.prep.source.provider');
  }

  function submitOther(event: FormEvent) {
    event.preventDefault();
    const value = otherText.trim();
    if (!value) return;
    onIndustryChange(value);
    setOtherOpen(false);
  }

  const companyField = (
    <div className={styles.companyField}>
      <label htmlFor={companyId}>{t('setup.prep.target.companyLabel')}</label>
      <div className={styles.search}>
        <IconStack size={15} aria-hidden />
        <input
          id={companyId}
          type="text"
          value={company}
          maxLength={120}
          autoComplete="organization"
          placeholder={t('setup.prep.target.companyPlaceholder')}
          onChange={(event) => onCompanyChange(event.target.value)}
        />
        {company ? (
          <button type="button" className={styles.inputClear} aria-label={t('setup.prep.target.clearCompany')} onClick={() => onCompanyChange('')}>
            <IconX size={13} aria-hidden />
          </button>
        ) : null}
      </div>
      <p className={styles.fieldHint}>{t('setup.prep.target.companyHint')}</p>
    </div>
  );

  // ── The chosen target ──────────────────────────────────────────────────
  function selectedCard(chosen: PracticeTarget) {
    const posting = chosen.kind === 'posting' ? chosen.posting : null;
    const title = posting ? posting.title : chosen.kind === 'role' ? chosen.title : '';
    const meta = posting
      ? [posting.company, posting.location, formatRelativeTime(posting.postedAt, locale) || null].filter(Boolean).join(' · ')
      : t('setup.prep.target.roleOnly');
    return (
      <div className={styles.selectedTarget}>
        <div className={styles.selectedBody}>
          <small>{t('setup.prep.target.selectedTitle')}</small>
          <strong>{title}</strong>
          <span>{meta}</span>
          <span className={styles.selectedActions}>
            {posting?.url ? (
              <a href={posting.url} target="_blank" rel="noopener noreferrer">
                {t('setup.prep.target.viewPost')}
                <IconArrow size={12} aria-hidden />
              </a>
            ) : null}
            {chosen.kind === 'role' ? (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  onQueryChange(chosen.titleEn ?? chosen.title);
                  onClearTarget();
                }}
              >
                {t('setup.prep.target.findJobsForRole')}
              </button>
            ) : null}
          </span>
        </div>
        <button type="button" className={styles.laneGhost} onClick={onClearTarget}>
          {t('setup.prep.target.change')}
        </button>
      </div>
    );
  }

  // ── Search results ─────────────────────────────────────────────────────
  function searchResults() {
    if (search.state === 'error' && !result) {
      return (
        <div className={styles.noMatch} role="alert">
          <p>{t('setup.prep.target.searchError')}</p>
          <button type="button" className={styles.laneGhost} onClick={onRetrySearch}>
            <IconRefresh size={13} aria-hidden /> {t('setup.prep.target.retry')}
          </button>
        </div>
      );
    }
    if (!result) {
      return search.pending ? <p className={styles.searchStatus} aria-live="polite">{t('setup.prep.target.searching')}</p> : null;
    }
    const roles = result.roles;
    const postings = result.postings;
    const boardsDown = result.sources.some((source) => source.id === 'providers' && (source.status === 'unavailable' || source.status === 'error'));
    const market = regionName(result.market.country, locale);
    return (
      <div className={styles.results} aria-busy={search.pending}>
        {search.pending ? <p className={styles.searchStatus} aria-live="polite">{t('setup.prep.target.searching')}</p> : null}

        {roles.length > 0 ? (
          <div className={styles.resultGroup}>
            <h3>{t('setup.prep.target.rolesTitle')}</h3>
            <div className={styles.roleGrid} role="group" aria-label={t('setup.prep.target.rolesTitle')} onKeyDown={moveFocus}>
              {roles.map((role) => (
                <button
                  key={`${role.source}:${role.title}`}
                  type="button"
                  data-roving
                  className={styles.roleChip}
                  onClick={() => onSelectTarget({ kind: 'role', title: roleLabel(role), titleEn: role.titleEn ?? (role.taxonomyId ? role.title : null) })}
                >
                  <span className={styles.optionMark} aria-hidden />
                  <span className={styles.roleChipBody}>
                    <strong>{roleLabel(role)}</strong>
                    {role.titleEn || role.context ? <small>{role.titleEn ?? role.context}</small> : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className={styles.resultGroup}>
          <h3>
            {market ? t('setup.prep.target.postingsTitleIn', { market }) : t('setup.prep.target.postingsTitle')}
          </h3>
          {postings.length === 0 ? (
            <p className={styles.noMatch}>
              {roles.length > 0
                ? t('setup.prep.target.noPostings', { query: result.query })
                : t('setup.prep.target.noResults', { query: result.query })}
            </p>
          ) : (
            <ul className={styles.postings} aria-label={t('setup.prep.target.postingsTitle')} onKeyDown={moveFocus}>
              {postings.map((posting) => {
                const when = formatRelativeTime(posting.postedAt, locale);
                return (
                  <li key={posting.ref} className={styles.posting}>
                    <button
                      type="button"
                      data-roving
                      className={styles.postingMain}
                      aria-label={
                        posting.company
                          ? t('setup.prep.target.practiceFor', { title: posting.title, company: posting.company })
                          : t('setup.prep.target.practiceForRole', { title: posting.title })
                      }
                      onClick={() => onSelectTarget({ kind: 'posting', posting })}
                    >
                      <strong>{posting.title}</strong>
                      <span>{[posting.company, posting.location, when || null].filter(Boolean).join(' · ')}</span>
                      {posting.snippet ? <small>{posting.snippet}</small> : null}
                    </button>
                    <div className={styles.postingSide}>
                      <span className={styles.sourceTag}>{sourceLabel(posting)}</span>
                      {posting.url ? (
                        <a href={posting.url} target="_blank" rel="noopener noreferrer">
                          {t('setup.prep.target.viewPost')}
                          <IconArrow size={12} aria-hidden />
                        </a>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {postings.some((posting) => posting.source === 'web') ? (
            <p className={styles.fieldHint}>{t('setup.prep.target.webNote')}</p>
          ) : null}
          {boardsDown ? <p className={styles.fieldHint}>{t('setup.prep.target.boardsUnavailable')}</p> : null}
        </div>
      </div>
    );
  }

  // ── Browse by industry ─────────────────────────────────────────────────
  function industryBrowser() {
    return (
      <div className={styles.resultGroup}>
        <h3>{t('setup.prep.target.industriesLabel')}</h3>
        <div className={styles.categories} role="group" aria-label={t('setup.prep.target.industriesLabel')}>
          {industries === null ? (
            Array.from({ length: 8 }).map((_, index) => (
              <span key={index} className={styles.shimmer} style={{ width: 96 + (index % 3) * 24, height: 32, borderRadius: 'var(--r-pill)' }} aria-hidden />
            ))
          ) : (
            <>
              {visibleIndustries.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={industry === item.id}
                  className={industry === item.id ? styles.categoryOn : undefined}
                  onClick={() => onIndustryChange(industry === item.id ? null : item.id)}
                >
                  {item.label}
                </button>
              ))}
              {industries.length > visibleIndustries.length || allIndustries ? (
                <button type="button" className={styles.categoryGhost} onClick={() => setAllIndustries((value) => !value)}>
                  {allIndustries ? t('setup.prep.target.fewerIndustries') : t('setup.prep.target.moreIndustries')}
                </button>
              ) : null}
              {industry && !listedIndustry ? (
                <button type="button" aria-pressed className={styles.categoryOn} onClick={() => onIndustryChange(null)}>
                  {industry}
                  <IconX size={12} aria-hidden />
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.categoryGhost}
                  aria-expanded={otherOpen}
                  aria-controls={otherOpen ? otherId : undefined}
                  onClick={() => setOtherOpen((value) => !value)}
                >
                  {t('setup.prep.target.otherIndustry')}
                </button>
              )}
            </>
          )}
        </div>

        {otherOpen ? (
          <form id={otherId} className={styles.otherIndustry} onSubmit={submitOther}>
            <div className={styles.search}>
              <input
                type="text"
                value={otherText}
                maxLength={80}
                autoFocus
                aria-label={t('setup.prep.target.otherIndustryPlaceholder')}
                placeholder={t('setup.prep.target.otherIndustryPlaceholder')}
                onChange={(event) => setOtherText(event.target.value)}
              />
            </div>
            <button type="submit" className={styles.lanePrimary} disabled={!otherText.trim()}>
              {t('setup.prep.target.otherIndustryApply')}
            </button>
          </form>
        ) : null}

        {industry ? (
          <div className={styles.industryRoles}>
            <h3>{t('setup.prep.target.industryRolesTitle', { industry: industryLabel })}</h3>
            {industryRoles.state === 'loading' ? (
              <p className={styles.searchStatus} aria-live="polite">{t('setup.prep.target.industryRolesLoading', { industry: industryLabel })}</p>
            ) : industryRoles.state === 'error' ? (
              <div className={styles.noMatch} role="alert">
                <p>{t('setup.prep.target.industryRolesError')}</p>
                <button type="button" className={styles.laneGhost} onClick={onRetryIndustryRoles}>
                  <IconRefresh size={13} aria-hidden /> {t('setup.prep.target.retry')}
                </button>
              </div>
            ) : (
              <div className={styles.roleGrid} role="group" aria-label={t('setup.prep.target.industryRolesTitle', { industry: industryLabel })} onKeyDown={moveFocus}>
                {industryRoles.roles.map((role) => (
                  <button
                    key={role.title}
                    type="button"
                    data-roving
                    className={styles.roleChip}
                    onClick={() => onSelectTarget({ kind: 'role', title: role.title, titleEn: role.titleEn })}
                  >
                    <span className={styles.optionMark} aria-hidden />
                    <span className={styles.roleChipBody}>
                      <strong>{role.title}</strong>
                      {role.context ? <small>{role.context}</small> : null}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section className={styles.brief} aria-labelledby="practice-role-heading">
      <div className={styles.roleHead}>
        <h2 id="practice-role-heading">{t('setup.flow.roleLegend')}</h2>

        {jobBanner ? null : (
          <div className={styles.sourceToggle} role="radiogroup" aria-label={t('setup.flow.roleLegend')}>
            {(['role', 'jd'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={sourceMode === value}
                tabIndex={sourceMode === value ? 0 : -1}
                className={sourceMode === value ? styles.sourceOn : undefined}
                onClick={() => onSourceModeChange(value)}
                onKeyDown={(event) => {
                  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                    event.preventDefault();
                    onSourceModeChange(value === 'role' ? 'jd' : 'role');
                  }
                }}
              >
                {value === 'role' ? t('setup.prep.target.tabFind') : t('setup.role.tabPaste')}
              </button>
            ))}
          </div>
        )}
      </div>

      {jobBanner ? (
        <>
          {jobBanner}
          {companyField}
        </>
      ) : sourceMode === 'role' ? (
        target ? (
          <>
            {selectedCard(target)}
            {companyField}
          </>
        ) : (
          <>
            <div className={styles.search}>
              <IconSearch size={15} aria-hidden />
              <input
                type="search"
                value={query}
                maxLength={160}
                placeholder={t('setup.prep.target.searchPlaceholder')}
                aria-label={t('setup.prep.target.searchLabel')}
                onChange={(event) => onQueryChange(event.target.value)}
              />
              {search.pending ? <span className={styles.spinner} aria-hidden /> : null}
            </div>
            {companyField}
            {searching ? searchResults() : industryBrowser()}
          </>
        )
      ) : (
        <div className={styles.jd}>
          <textarea
            value={jdText}
            rows={9}
            placeholder={t('setup.role.jdPlaceholder')}
            aria-label={t('setup.role.jdPlaceholder')}
            aria-describedby="practice-jd-hint"
            onChange={(event) => onJdTextChange(event.target.value)}
          />
          <p className={styles.jdMeta}>
            <span id="practice-jd-hint">
              {jdLength > 0 && jdLength < JD_MIN_CHARS ? t('setup.role.jdTooShort') : t('setup.role.jdHint')}
            </span>
            <span className={jdLength >= JD_MIN_CHARS ? styles.jdCountOk : undefined}>
              {t('setup.role.jdCount', { count: jdLength })}
            </span>
          </p>
          {companyField}
        </div>
      )}
    </section>
  );
}
