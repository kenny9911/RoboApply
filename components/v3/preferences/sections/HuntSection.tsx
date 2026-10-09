'use client';

// /settings#search — "Your search" (WP-20 rework).
//
// Job targeting now lives in the saved searches (RASearchProfile, the one
// preference store; ARCHITECTURE.md §2.8): titles, places, pay, company and
// industry filters are edited with the same drawer the job list uses, so the
// list, alerts and this page can never disagree. This section renders the
// saved-searches manager (components/features/search) and keeps only the
// free-text notes that are NOT filters and stay in the preferences blob: the
// intent statement, must-haves and dealbreakers (never parsed into filters,
// D3). The old seniority ladder, salary slider, company-stage grid (no funding
// data) and the US-only work-authorization select are gone: level and pay are
// filters, and work authorization is a per-country question on the profile
// (WP-19, TW-09).
//
// The props are unchanged so app/(auth)/settings/page.tsx keeps compiling
// until INT moves `#search` to SearchSettingsSection (TASK_PLAN §4.1.e).

import { useTranslations } from 'next-intl';

import { PrefHeader, PrefGroup, PrefRow, ChipInput } from '../controls';
import { SavedSearchesManager } from '../../../features/search';
import type { RAPreferences, RAPreferenceOptions } from '../../../../lib/api/v2';

export function HuntSection({
  p,
  set,
}: {
  p: RAPreferences;
  set: (path: string, value: unknown) => void;
  /** Unused since WP-20 (kept for the settings page's call). */
  options?: RAPreferenceOptions;
  /** Unused since WP-20: level is a search filter. */
  seniorityIndex?: number;
  setSeniorityIndex?: (i: number) => void;
}) {
  const t = useTranslations('settings');
  const tf = useTranslations('filters');

  return (
    <>
      {/* Ruling C21: the one setup sentence stays this section's H1. */}
      <PrefHeader
        eyebrow={t('hunt.eyebrow')}
        title={`${t('hunt.title_before')} ${t('hunt.title_em')} ${t('hunt.title_after')}`}
        sub={t('hunt.sub')}
      />
      <p className="pref-sub">{tf('hunt.moved')}</p>
      <h2 className="pref-sub">{tf('settings.title')}</h2>
      <SavedSearchesManager />

      <PrefGroup label={t('hunt.group_intent')}>
        <PrefRow label={t('hunt.intent_label')} sub={t('hunt.intent_sub')} align="top">
          <textarea
            className="pref-textarea"
            value={p.intentMarkdown}
            onChange={(e) => set('intentMarkdown', e.target.value)}
            rows={3}
            aria-label={t('hunt.intent_label')}
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('hunt.group_hard_rules')}>
        <PrefRow label={t('hunt.musthaves_label')} sub={t('hunt.musthaves_sub')} align="top">
          <ChipInput
            values={p.mustHaves}
            onAdd={(v) => set('mustHaves', [...p.mustHaves, v])}
            onRemove={(v) => set('mustHaves', p.mustHaves.filter((x) => x !== v))}
            placeholder={t('hunt.musthaves_ph')}
          />
        </PrefRow>
        <PrefRow label={t('hunt.dealbreakers_label')} sub={t('hunt.dealbreakers_sub')} align="top">
          <ChipInput
            values={p.dealbreakers}
            onAdd={(v) => set('dealbreakers', [...p.dealbreakers, v])}
            onRemove={(v) => set('dealbreakers', p.dealbreakers.filter((x) => x !== v))}
            placeholder={t('hunt.dealbreakers_ph')}
          />
        </PrefRow>
      </PrefGroup>
    </>
  );
}
