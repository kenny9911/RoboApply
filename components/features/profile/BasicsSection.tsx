'use client';

// GoApply 基本信息: identity, graduation year, degree, school, major and job
// search status (RAProfile.cnFields, shared with GoApply onboarding), plus the
// optional, encrypted 籍贯 / 政治面貌 / 家庭成员 answers (never used to rank
// jobs, never sent to AI). The photo field is not offered in CN-0.

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import type { ProfileView } from '../../../lib/api/contracts/profile';
import { useProfileMutations } from '../../../hooks/profile/useProfile';
import { CN_CLASS_YEAR_RANGE, CN_DEGREE_OPTIONS, CN_IDENTITIES, CN_JOB_SEARCH_STATUS } from './options';
import { SaveRow, SectionCard, SelectField, TextField, useDraft, type SaveState } from './parts';
import { SensitiveAnswersForm } from './SensitiveAnswersForm';
import s from './profile.module.css';

interface Draft {
  identity: string;
  graduationClass: string;
  degree: string;
  /** '' = never answered (sent as null, so nothing is claimed). */
  isFullTimeProgram: '' | 'yes' | 'no';
  schoolName: string;
  major: string;
  jobSearchStatus: string;
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');

function draftOf(p: ProfileView): Draft {
  const f = p.cnFields ?? {};
  return {
    identity: text(f.identity),
    graduationClass: typeof f.graduationClass === 'number' ? String(f.graduationClass) : '',
    degree: text(f.degree),
    isFullTimeProgram: f.isFullTimeProgram === true ? 'yes' : f.isFullTimeProgram === false ? 'no' : '',
    schoolName: text(f.schoolName),
    major: text(f.major),
    jobSearchStatus: text(f.jobSearchStatus),
  };
}

const YEARS = Array.from({ length: CN_CLASS_YEAR_RANGE.max - CN_CLASS_YEAR_RANGE.min + 1 }, (_, i) => String(CN_CLASS_YEAR_RANGE.min + i));

export function BasicsSection({ profile }: { profile: ProfileView }) {
  const t = useTranslations('profile');
  const { patch } = useProfileMutations();
  const { draft, update, markClean } = useDraft(profile, () => draftOf(profile));
  const [state, setState] = useState<SaveState>('idle');
  const missing = new Set(profile.missing.filter((m) => m.section === 'basics').map((m) => m.key));
  const student = draft.identity === 'yingjie' || draft.identity === 'zaixiao';

  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => {
    update((d) => ({ ...d, [key]: value }));
    setState('idle');
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setState('saving');
    // null removes a key from cnFields; the server merges with what onboarding stored.
    const cnFields: Record<string, unknown> = {
      identity: draft.identity || null,
      graduationClass: student && draft.graduationClass ? Number(draft.graduationClass) : null,
      degree: draft.degree || null,
      isFullTimeProgram: draft.isFullTimeProgram === '' ? null : draft.isFullTimeProgram === 'yes',
      schoolName: draft.schoolName.trim() || null,
      major: draft.major.trim() || null,
      jobSearchStatus: !student && draft.jobSearchStatus ? draft.jobSearchStatus : null,
    };
    try {
      await patch.mutateAsync({ cnFields });
      markClean();
      setState('saved');
    } catch {
      setState('error');
    }
  }

  return (
    <SectionCard id="basics" title={t('sections.basics')} intro={t('basics.intro')} missing={missing.size > 0}>
      <form onSubmit={save} noValidate>
        <div className={s.grid}>
          <SelectField
            label={t('basics.identity')}
            value={draft.identity}
            onChange={set('identity')}
            placeholder=""
            options={CN_IDENTITIES.map((v) => ({ value: v, label: t(`basics.identities.${v}`) }))}
            missing={missing.has('cnIdentity')}
          />
          {student ? (
            <SelectField
              label={t('basics.graduationClass')}
              value={draft.graduationClass}
              onChange={set('graduationClass')}
              placeholder=""
              options={YEARS.map((y) => ({ value: y, label: y }))}
              missing={missing.has('graduationClass')}
            />
          ) : (
            <SelectField
              label={t('basics.jobSearchStatus')}
              value={draft.jobSearchStatus}
              onChange={set('jobSearchStatus')}
              placeholder=""
              options={CN_JOB_SEARCH_STATUS.map((v) => ({ value: v, label: t(`basics.statuses.${v}`) }))}
            />
          )}
          <SelectField
            label={t('basics.degree')}
            value={draft.degree}
            onChange={set('degree')}
            placeholder=""
            options={CN_DEGREE_OPTIONS.map((v) => ({ value: v, label: t(`basics.degrees.${v}`) }))}
          />
          <SelectField
            label={t('basics.fullTime')}
            value={draft.isFullTimeProgram}
            onChange={(v) => set('isFullTimeProgram')(v === 'yes' || v === 'no' ? v : '')}
            placeholder={t('basics.notAnswered')}
            options={[
              { value: 'yes', label: t('basics.fullTimeYes') },
              { value: 'no', label: t('basics.fullTimeNo') },
            ]}
          />
          <TextField label={t('basics.schoolName')} value={draft.schoolName} onChange={set('schoolName')} maxLength={120} />
          <TextField label={t('basics.major')} value={draft.major} onChange={set('major')} maxLength={120} />
        </div>
        <SaveRow state={state} />
      </form>

      {profile.availability.cnSensitive ? <SensitiveAnswersForm part="cn" /> : null}
    </SectionCard>
  );
}
