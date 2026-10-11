'use client';

// Settings § Your search — the main-resume picker.
//
// "Which resume does everything start from?" Reads the resume library
// (useResumeList, passed in by the page) and writes `defaultResumeId` to
// preferences. One group under the saved searches: the section already has
// its H1 (the setup sentence, SearchIntro), so this block has no header of
// its own (INT-12 removed a second H1 that repeated the group label).

import { useTranslations } from 'next-intl';
import { PrefGroup } from '../controls';
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
                </div>
              </label>
            ))}
          </div>
        )}
      </PrefGroup>
    </>
  );
}
