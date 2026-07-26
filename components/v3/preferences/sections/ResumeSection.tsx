'use client';

// Settings § Resume — the default-résumé picker.
//
// Extracted from IdentitySection when the eight-screen /preferences route
// collapsed into the single /settings page (OVERHAUL_RULINGS R1/D2). The picker
// is its own settings section because "which résumé does everything start
// from?" is a question about the résumé, not about who the user is. Reads the
// résumé library (useResumeList, passed in by the page) and writes
// `defaultResumeId` to preferences.

import { useTranslations } from 'next-intl';
import { PrefHeader, PrefGroup } from '../controls';
import type { RAPreferences } from '../../../../lib/api/v2';
import type { RAResumeVariantSummary } from '../../../../hooks/useResumes';

export function ResumeSection({
  p,
  set,
  resumes,
}: {
  p: RAPreferences;
  set: (path: string, value: unknown) => void;
  resumes: RAResumeVariantSummary[];
}) {
  const t = useTranslations('settings');

  return (
    <>
      <PrefHeader
        eyebrow={t('identity.group_default_resume')}
        title={t('identity.group_default_resume')}
        sub={t('identity.sub')}
      />

      <PrefGroup label={t('identity.group_default_resume')}>
        {resumes.length === 0 ? (
          <div className="pref-row-sub">{t('identity.no_resumes')}</div>
        ) : (
          <div className="pref-resume-picker">
            {resumes.map((r) => (
              <label
                key={r.id}
                className={`pref-resume-card ${p.defaultResumeId === r.id ? 'on' : ''}`}
              >
                <input
                  type="radio"
                  name="defaultResume"
                  checked={p.defaultResumeId === r.id}
                  onChange={() => set('defaultResumeId', r.id)}
                />
                <div className="pref-resume-mini">
                  <div className="rb-mini-name">{r.name}</div>
                  <div className="rb-mini-line" style={{ width: '60%' }} />
                  <div className="rb-mini-spacer" />
                  <div className="rb-mini-section">EXP</div>
                  <div className="rb-mini-line" style={{ width: '85%' }} />
                  <div className="rb-mini-line" style={{ width: '70%' }} />
                </div>
                <div className="pref-resume-name">{r.name}</div>
                <div className="pref-resume-meta">
                  {r.targetJobCompany
                    ? `→ ${r.targetJobCompany}`
                    : t('identity.resume_base')}
                  {r.matchScoreCached != null ? ` · ${r.matchScoreCached}/100` : ''}
                </div>
              </label>
            ))}
          </div>
        )}
      </PrefGroup>
    </>
  );
}
