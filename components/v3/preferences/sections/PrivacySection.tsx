'use client';

// Two settings groups that used to live together as "§06 Privacy & blocklist".
//
// They split when /preferences collapsed into /settings, because they answer
// different questions and belong under different headings:
//   • BlocklistSection → "Your search"  — companies you don't want to see jobs
//     from (the first entry is the auto-blocked current employer).
//   • DataSection      → "Account"      — WP-13: data export, personal-information
//                                          requests, the retention schedule.
//
// The profile-visibility control ("Hidden from recruiters") that used to open
// this file is DELETED per OVERHAUL_RULINGS C19: no recruiter-visible profile
// ships this cycle, so a switch promising protection from an exposure that does
// not exist is a claim we cannot keep. `profileVisibility` survives on the
// preferences blob untouched; nothing writes it any more.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PrefGroup, PrefRow } from '../controls';
import { Btn, IconX } from '../../primitives';
import type { RAPreferences } from '../../../../lib/api/v2';
import { PrivacyPanel } from '../../../features/compliance';

export function BlocklistSection({
  p,
  set,
}: {
  p: RAPreferences;
  set: (path: string, value: unknown) => void;
}) {
  const t = useTranslations('settings');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  const removeCompany = (c: string) =>
    set('blockedCompanies', p.blockedCompanies.filter((x) => x !== c));
  const addCompany = () => {
    const v = draft.trim();
    if (v && !p.blockedCompanies.includes(v)) {
      set('blockedCompanies', [...p.blockedCompanies, v]);
    }
    setDraft('');
    setAdding(false);
  };

  return (
    <PrefGroup label={t('privacy.group_blocklist')}>
      <PrefRow label={t('privacy.blocked_label')} sub={t('privacy.blocked_sub')} align="top">
        <div className="pref-blocked">
          {p.blockedCompanies.map((c, i) => (
            <div key={c} className="pref-blocked-row">
              <span className="pref-blocked-name">{c}</span>
              <span className="pref-blocked-reason">
                {i === 0 ? t('privacy.reason_employer') : t('privacy.reason_byyou')}
              </span>
              <button
                type="button"
                className="iv-coach-close"
                onClick={() => removeCompany(c)}
                aria-label={`${t('privacy.remove')} ${c}`}
              >
                <IconX size={11} />
              </button>
            </div>
          ))}
          {adding ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input
                className="pref-input"
                autoFocus
                value={draft}
                placeholder={t('privacy.add_ph')}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addCompany();
                  if (e.key === 'Escape') {
                    setDraft('');
                    setAdding(false);
                  }
                }}
              />
              <Btn variant="primary" onClick={addCompany}>
                {t('privacy.add_confirm')}
              </Btn>
            </div>
          ) : (
            <button
              type="button"
              className="pref-blocked-add"
              onClick={() => setAdding(true)}
            >
              {t('privacy.add_company')}
            </button>
          )}
        </div>
      </PrefRow>
      <PrefRow
        label={t('privacy.blocked_recruiters_label')}
        sub={t('privacy.blocked_recruiters_sub', { count: p.blockedRecruiters })}
      >
        <Btn>{t('privacy.manage_list')}</Btn>
      </PrefRow>
    </PrefGroup>
  );
}

/**
 * Settings → Privacy and data (WP-13). The props are kept for the settings
 * page's existing renderer; the section no longer reads the preferences blob:
 * the old "download archive" button did nothing and the per-user retention
 * select was never enforced, so both are replaced by the real export,
 * personal-information requests and the published retention schedule
 * (components/features/compliance/PrivacyPanel.tsx).
 */
export function DataSection(_props: {
  p: RAPreferences;
  set: (path: string, value: unknown) => void;
}) {
  return <PrivacyPanel />;
}
