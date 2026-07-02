'use client';

// RolePicker — Step 01 of the setup flow (proto `InterviewSetup` role section →
// `.iv-step`). Two ways to name the target job:
//   • Browse: search box + category tabs + role chips, backed by the live
//     catalog (`mock.catalog` → roleCategories + totalRoles).
//   • Paste a JD: a textarea the agent rewrites into a structured interview
//     brief. The parent reconciles which one is the effective role.
//
// Search filters across every category's roles (capped at 12). The "+N more"
// hint ONLY appears in search mode when matches exceed that cap — it is no
// longer a phantom cross-category count (the old `totalRoles - shown` math led
// nowhere now that totalRoles equals the real summed role count).

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { IconSearch } from '../primitives/Iconset';
import type { RAMockRoleCategory } from '../../../lib/api/v2/types';
import { useMockRoleLabels } from '../../../lib/mockRoleLabels';

export type RoleSourceMode = 'role' | 'jd';

interface Props {
  categories: RAMockRoleCategory[];
  totalRoles: number;
  query: string;
  onQueryChange: (q: string) => void;
  activeCategory: string;
  onCategoryChange: (name: string) => void;
  selectedRole: string | null;
  onSelectRole: (role: string) => void;
  /** Browse a role vs. paste a job description. */
  sourceMode: RoleSourceMode;
  onSourceModeChange: (mode: RoleSourceMode) => void;
  jdText: string;
  onJdTextChange: (value: string) => void;
}

/** A JD needs at least this many characters before it's worth rewriting. */
export const JD_MIN_CHARS = 40;

const SEARCH_CAP = 12;

export function RolePicker({
  categories,
  totalRoles,
  query,
  onQueryChange,
  activeCategory,
  onCategoryChange,
  selectedRole,
  onSelectRole,
  sourceMode,
  onSourceModeChange,
  jdText,
  onJdTextChange,
}: Props) {
  const t = useTranslations('mock');
  // Catalog category names + role titles stay English (the canonical id); only
  // the on-screen label is localized.
  const { localizeCategory, localizeRole } = useMockRoleLabels();

  const allRoles = useMemo(
    () => categories.flatMap((c) => c.roles),
    [categories],
  );

  // Roles to render + how many search matches were hidden by the cap. Search
  // matches the English title AND its localized label, so a user can type in
  // either language.
  const { roles: filteredRoles, overflow } = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      const matches = allRoles.filter(
        (r) => r.toLowerCase().includes(q) || localizeRole(r).toLowerCase().includes(q),
      );
      return { roles: matches.slice(0, SEARCH_CAP), overflow: Math.max(0, matches.length - SEARCH_CAP) };
    }
    const cat = categories.find((c) => c.name === activeCategory);
    return { roles: cat?.roles ?? [], overflow: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, allRoles, categories, activeCategory]);

  const jdLen = jdText.trim().length;
  const jdHintText = jdLen > 0 && jdLen < JD_MIN_CHARS ? t('setup.role.jdTooShort') : t('setup.role.jdHint');

  return (
    <section className="iv-step">
      <div className="iv-step-head">
        <span className="iv-step-num">01</span>
        <div>
          <div className="iv-step-title">{t('setup.role.title')}</div>
          <div className="iv-step-sub">
            {t('setup.role.sub', { count: totalRoles })}
          </div>
        </div>

        <div className="iv-source-toggle" role="tablist" aria-label={t('setup.role.title')}>
          <button
            type="button"
            role="tab"
            aria-selected={sourceMode === 'role'}
            className={`iv-source-tab ${sourceMode === 'role' ? 'active' : ''}`}
            onClick={() => onSourceModeChange('role')}
          >
            {t('setup.role.tabBrowse')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sourceMode === 'jd'}
            className={`iv-source-tab ${sourceMode === 'jd' ? 'active' : ''}`}
            onClick={() => onSourceModeChange('jd')}
          >
            {t('setup.role.tabPaste')}
          </button>
        </div>

        {sourceMode === 'role' ? (
          <div className="iv-search">
            <IconSearch size={13} />
            <input
              placeholder={t('setup.role.searchPlaceholder')}
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              aria-label={t('setup.role.searchPlaceholder')}
            />
          </div>
        ) : null}
      </div>

      {sourceMode === 'role' ? (
        <>
          {!query.trim() ? (
            <div className="iv-cat-tabs">
              {categories.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  className={`iv-cat-tab ${activeCategory === c.name ? 'active' : ''}`}
                  onClick={() => onCategoryChange(c.name)}
                >
                  {localizeCategory(c.name)}
                  <span className="iv-cat-count">{c.roles.length}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="iv-role-grid">
            {filteredRoles.map((r) => (
              <button
                key={r}
                type="button"
                className={`iv-role-chip ${selectedRole === r ? 'active' : ''}`}
                onClick={() => onSelectRole(r)}
              >
                {localizeRole(r)}
              </button>
            ))}
            {query.trim() && overflow > 0 ? (
              <span className="iv-role-chip more">
                {t('setup.role.more', { count: overflow })}
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <div className="iv-jd">
          <textarea
            className="iv-jd-input"
            value={jdText}
            onChange={(e) => onJdTextChange(e.target.value)}
            placeholder={t('setup.role.jdPlaceholder')}
            aria-label={t('setup.role.jdPlaceholder')}
            rows={8}
          />
          <div className="iv-jd-meta">
            <span className="iv-jd-hint">{jdHintText}</span>
            <span className={`iv-jd-count ${jdLen >= JD_MIN_CHARS ? 'ok' : ''}`}>
              {t('setup.role.jdCount', { count: jdLen })}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
