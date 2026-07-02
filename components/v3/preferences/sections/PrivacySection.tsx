'use client';

// §06 Privacy & blocklist — profile visibility, company blocklist (the first
// entry is the auto-blocked current employer), blocked-recruiter count, data
// export, and retention window. All preferences-owned (profileVisibility,
// blockedCompanies, blockedRecruiters, dataRetention).

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  PrefHeader,
  PrefGroup,
  PrefRow,
  Segmented,
  Select,
} from '../controls';
import { Btn, IconX } from '../../primitives';
import type { RAPreferences } from '../../../../lib/api/v2';

export function PrivacySection({
  p,
  set,
}: {
  p: RAPreferences;
  set: (path: string, value: unknown) => void;
}) {
  const t = useTranslations('preferences');
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
    <>
      <PrefHeader
        eyebrow={t('privacy.eyebrow')}
        title={
          <>
            {t('privacy.title_before')} <em>{t('privacy.title_em')}</em>
            {t('privacy.title_after')}
          </>
        }
        sub={t('privacy.sub')}
      />

      <PrefGroup label={t('privacy.group_visibility')}>
        <PrefRow label={t('privacy.visibility_label')} sub={t('privacy.visibility_sub')}>
          <Segmented
            value={p.profileVisibility}
            onChange={(v) => set('profileVisibility', v)}
            options={[
              { value: 'private', label: `🔒 ${t('privacy.vis_stealth')}` },
              { value: 'matched', label: `◐ ${t('privacy.vis_matched')}` },
              { value: 'public', label: `◯ ${t('privacy.vis_everyone')}` },
            ]}
          />
        </PrefRow>
      </PrefGroup>

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

      <PrefGroup label={t('privacy.group_data')}>
        <PrefRow label={t('privacy.export_label')} sub={t('privacy.export_sub')}>
          <Btn>{t('privacy.download_archive')}</Btn>
        </PrefRow>
        <PrefRow label={t('privacy.retention_label')} sub={t('privacy.retention_sub')}>
          <Select
            value={p.dataRetention}
            onChange={(v) => set('dataRetention', v)}
            ariaLabel={t('privacy.retention_label')}
            options={[
              { value: '30', label: t('privacy.retention_30') },
              { value: '90', label: t('privacy.retention_90') },
              { value: '365', label: t('privacy.retention_365') },
              { value: 'forever', label: t('privacy.retention_forever') },
            ]}
          />
        </PrefRow>
      </PrefGroup>
    </>
  );
}
