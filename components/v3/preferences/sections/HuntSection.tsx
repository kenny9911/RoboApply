'use client';

// /settings#search — the route's two pieces around the saved searches
// (INT-12 / WP-93; WP-20 rework).
//
// The section's content is `SearchSettingsSection` (components/features/search,
// registered in components/features/settings/sectionComponents.ts): the saved
// searches are the one preference store (RASearchProfile; ARCHITECTURE.md
// §2.8), edited with the same drawer the job list uses, so the list, alerts
// and this page can never disagree. Around it the settings route renders:
//
//   <SearchIntro />   above: the one setup sentence as the section's H1
//                     (ruling C21) and where the filters went.
//   <SearchNotes />   below: the free-text notes that are NOT filters and stay
//                     in the preferences blob (the intent statement and two
//                     lists). They are never parsed into filters (D3) and do
//                     not hide or reorder jobs, and the copy says so.
//
// Gone since WP-20: the seniority ladder, salary slider, company-stage grid
// (no funding data) and the US-only work-authorization select. Level and pay
// are filters; work authorization is a per-country question on the profile
// (WP-19, TW-09).

import { useTranslations } from 'next-intl';

import { PrefHeader, PrefGroup, PrefRow, ChipInput } from '../controls';
import type { RAPreferences } from '../../../../lib/api/v2';

/** The section header: the one setup sentence (C21) and the pointer to the saved searches. */
export function SearchIntro() {
  const t = useTranslations('settings');
  const tf = useTranslations('filters');
  return (
    <>
      <PrefHeader
        eyebrow={t('hunt.eyebrow')}
        title={`${t('hunt.title_before')} ${t('hunt.title_em')} ${t('hunt.title_after')}`}
        sub={t('hunt.sub')}
      />
      <p className="pref-sub">{tf('hunt.moved')}</p>
    </>
  );
}

/** The draft-backed free-text notes (preferences blob). */
export function SearchNotes({ p, set }: { p: RAPreferences; set: (path: string, value: unknown) => void }) {
  const t = useTranslations('settings');
  const tn = useTranslations('nav.settingsNotes');

  return (
    <>
      <PrefGroup label={t('hunt.group_intent')}>
        <PrefRow label={t('hunt.intent_label')} sub={tn('intent_sub')} align="top">
          <textarea
            className="pref-textarea"
            value={p.intentMarkdown}
            onChange={(e) => set('intentMarkdown', e.target.value)}
            rows={3}
            aria-label={t('hunt.intent_label')}
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={tn('group_lists')}>
        <PrefRow label={t('hunt.musthaves_label')} sub={tn('lists_sub')} align="top">
          <ChipInput
            values={p.mustHaves}
            onAdd={(v) => set('mustHaves', [...p.mustHaves, v])}
            onRemove={(v) => set('mustHaves', p.mustHaves.filter((x) => x !== v))}
            placeholder={t('hunt.musthaves_ph')}
          />
        </PrefRow>
        <PrefRow label={t('hunt.dealbreakers_label')} sub={tn('lists_sub')} align="top">
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
