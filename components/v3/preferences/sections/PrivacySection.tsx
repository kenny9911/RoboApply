'use client';

// Settings § Your search — the company blocklist.
//
// Companies the user does not want to see jobs from. The list lives in the
// preferences blob and the server mirrors every addition and removal into the
// active saved search's `excludedCompanies` (features/search/legacyBridge.ts),
// so the job list really hides them.
//
// What used to share this file:
//   • DataSection (the #privacy wrapper) — deleted by INT-12: #privacy renders
//     the compliance area's section (sectionComponents.ts).
//   • "Blocked recruiters · Manage the list" — deleted by INT-12: the count was
//     always 0, the button did nothing, and no recruiter can contact a user
//     here, so the row promised protection from an exposure that does not
//     exist (the same reason ruling C19 removed the visibility switch).
//   • The "Your current employer" tag on the first row — deleted by INT-12:
//     nothing blocks a current employer automatically, so every row is one
//     the user added.
// `profileVisibility` and `blockedRecruiters` survive on the blob untouched;
// nothing reads or writes them.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PrefGroup, PrefRow } from '../controls';
import { Btn, IconX } from '../../primitives';
import type { RAPreferences } from '../../../../lib/api/v2';

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
          {p.blockedCompanies.map((c) => (
            <div key={c} className="pref-blocked-row">
              <span className="pref-blocked-name">{c}</span>
              <span className="pref-blocked-reason">{t('privacy.reason_byyou')}</span>
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
    </PrefGroup>
  );
}
