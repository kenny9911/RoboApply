'use client';

// Education and Work: lists of rows with inline add / edit / delete.

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import type { ProfileEducationView, ProfileExperienceView, ProfileView } from '../../../lib/api/contracts/profile';
import { useProfileMutations } from '../../../hooks/profile/useProfile';
import { YM } from './options';
import { Checkbox, SaveRow, SectionCard, SelectField, TextArea, TextField, str, type SaveState } from './parts';
import s from './profile.module.css';

function span(start: string | null, end: string | null, current: boolean, present: string): string {
  if (!start && !end && !current) return '';
  return `${start ?? '…'} – ${current ? present : (end ?? '…')}`;
}

/** Validate a 'YYYY' / 'YYYY-MM' input; '' is fine (unknown). */
const dateOk = (v: string) => v.trim() === '' || YM.test(v.trim());

// ── Education ──────────────────────────────────────────────────────────

interface EduDraft {
  school: string;
  degree: string;
  major: string;
  gpa: string;
  location: string;
  startDate: string;
  endDate: string;
  current: boolean;
}

const eduDraft = (e?: ProfileEducationView): EduDraft => ({
  school: str(e?.school),
  degree: str(e?.degree),
  major: str(e?.major),
  gpa: str(e?.gpa),
  location: str(e?.location),
  startDate: str(e?.startDate),
  endDate: str(e?.endDate),
  current: e?.current ?? false,
});

function EducationForm({ row, onDone }: { row?: ProfileEducationView; onDone: () => void }) {
  const t = useTranslations('profile');
  const { saveEducation } = useProfileMutations();
  const [d, setD] = useState<EduDraft>(() => eduDraft(row));
  const [state, setState] = useState<SaveState>('idle');
  const set = <K extends keyof EduDraft>(k: K) => (v: EduDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const datesValid = dateOk(d.startDate) && dateOk(d.endDate);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!d.school.trim() || !datesValid) {
      setState('error');
      return;
    }
    setState('saving');
    try {
      await saveEducation.mutateAsync({
        id: row?.id ?? null,
        body: {
          school: d.school.trim(),
          degree: d.degree,
          major: d.major,
          gpa: d.gpa,
          location: d.location,
          startDate: d.startDate.trim() || null,
          endDate: d.current ? null : d.endDate.trim() || null,
          current: d.current,
        },
      });
      onDone();
    } catch {
      setState('error');
    }
  }

  return (
    <form onSubmit={save} noValidate className={s.row}>
      <div className={s.grid}>
        <TextField label={t('education.school')} value={d.school} onChange={set('school')} maxLength={160} error={state === 'error' && !d.school.trim() ? t('actions.saveError') : null} />
        <TextField label={t('education.degree')} value={d.degree} onChange={set('degree')} maxLength={120} />
        <TextField label={t('education.major')} value={d.major} onChange={set('major')} maxLength={120} />
        <TextField label={t('education.gpa')} value={d.gpa} onChange={set('gpa')} maxLength={20} />
        <TextField label={t('education.start')} value={d.startDate} onChange={set('startDate')} hint={t('education.dateHint')} error={dateOk(d.startDate) ? null : t('education.dateHint')} maxLength={7} />
        {d.current ? null : (
          <TextField label={t('education.end')} value={d.endDate} onChange={set('endDate')} hint={t('education.dateHint')} error={dateOk(d.endDate) ? null : t('education.dateHint')} maxLength={7} />
        )}
        <TextField label={t('education.location')} value={d.location} onChange={set('location')} maxLength={160} />
        <div className={s.field}>
          <Checkbox label={t('education.current')} checked={d.current} onChange={set('current')} />
        </div>
      </div>
      <SaveRow state={state} onCancel={onDone} />
    </form>
  );
}

export function EducationSection({ profile }: { profile: ProfileView }) {
  const t = useTranslations('profile');
  const { removeEducation } = useProfileMutations();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const missing = profile.missing.some((m) => m.section === 'education');

  return (
    <SectionCard id="education" title={t('sections.education')} missing={missing}>
      {profile.education.length === 0 && editing !== 'new' ? <p className={s.empty}>{t('education.empty')}</p> : null}
      <ul className={s.rows}>
        {profile.education.map((e) =>
          editing === e.id ? (
            <li key={e.id}>
              <EducationForm row={e} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={e.id} className={s.row}>
              <div className={s.rowHead}>
                <div>
                  <p className={s.rowTitle}>{e.school}</p>
                  <p className={s.rowMeta}>{[[e.degree, e.major].filter(Boolean).join(', '), span(e.startDate, e.endDate, e.current, t('education.present'))].filter(Boolean).join(' · ')}</p>
                </div>
                <div className={s.rowActions}>
                  <Btn variant="ghost" onClick={() => setEditing(e.id)} aria-label={`${t('actions.edit')}: ${e.school}`}>
                    {t('actions.edit')}
                  </Btn>
                  <Btn
                    variant="ghost"
                    aria-label={`${t('actions.delete')}: ${e.school}`}
                    disabled={removeEducation.isPending}
                    onClick={() => {
                      if (window.confirm(t('actions.deleteConfirm'))) removeEducation.mutate(e.id);
                    }}
                  >
                    {t('actions.delete')}
                  </Btn>
                </div>
              </div>
            </li>
          ),
        )}
        {editing === 'new' ? (
          <li>
            <EducationForm onDone={() => setEditing(null)} />
          </li>
        ) : null}
      </ul>
      {editing === null ? (
        <div className={s.actions}>
          <Btn onClick={() => setEditing('new')}>{t('education.add')}</Btn>
        </div>
      ) : null}
    </SectionCard>
  );
}

// ── Work ───────────────────────────────────────────────────────────────

interface WorkDraft {
  company: string;
  title: string;
  location: string;
  startDate: string;
  endDate: string;
  current: boolean;
  kind: 'work' | 'internship';
  description: string;
  bullets: string;
}

const workDraft = (x?: ProfileExperienceView): WorkDraft => ({
  company: str(x?.company),
  title: str(x?.title),
  location: str(x?.location),
  startDate: str(x?.startDate),
  endDate: str(x?.endDate),
  current: x?.current ?? false,
  kind: x?.kind ?? 'work',
  description: str(x?.description),
  bullets: (x?.bullets ?? []).join('\n'),
});

function WorkForm({ row, onDone }: { row?: ProfileExperienceView; onDone: () => void }) {
  const t = useTranslations('profile');
  const { saveExperience } = useProfileMutations();
  const [d, setD] = useState<WorkDraft>(() => workDraft(row));
  const [state, setState] = useState<SaveState>('idle');
  const set = <K extends keyof WorkDraft>(k: K) => (v: WorkDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const datesValid = dateOk(d.startDate) && dateOk(d.endDate);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!d.company.trim() || !d.title.trim() || !datesValid) {
      setState('error');
      return;
    }
    setState('saving');
    try {
      await saveExperience.mutateAsync({
        id: row?.id ?? null,
        body: {
          company: d.company.trim(),
          title: d.title.trim(),
          location: d.location,
          kind: d.kind,
          description: d.description,
          bullets: d.bullets
            .split('\n')
            .map((b) => b.trim())
            .filter(Boolean)
            .slice(0, 30),
          startDate: d.startDate.trim() || null,
          endDate: d.current ? null : d.endDate.trim() || null,
          current: d.current,
        },
      });
      onDone();
    } catch {
      setState('error');
    }
  }

  return (
    <form onSubmit={save} noValidate className={s.row}>
      <div className={s.grid}>
        <TextField label={t('work.title')} value={d.title} onChange={set('title')} maxLength={160} error={state === 'error' && !d.title.trim() ? t('actions.saveError') : null} />
        <TextField label={t('work.company')} value={d.company} onChange={set('company')} maxLength={160} error={state === 'error' && !d.company.trim() ? t('actions.saveError') : null} />
        <SelectField label={t('work.kind')} value={d.kind} onChange={(v) => set('kind')(v === 'internship' ? 'internship' : 'work')} options={(['work', 'internship'] as const).map((k) => ({ value: k, label: t(`work.kinds.${k}`) }))} />
        <TextField label={t('work.location')} value={d.location} onChange={set('location')} maxLength={160} />
        <TextField label={t('work.start')} value={d.startDate} onChange={set('startDate')} hint={t('education.dateHint')} error={dateOk(d.startDate) ? null : t('education.dateHint')} maxLength={7} />
        {d.current ? null : (
          <TextField label={t('work.end')} value={d.endDate} onChange={set('endDate')} hint={t('education.dateHint')} error={dateOk(d.endDate) ? null : t('education.dateHint')} maxLength={7} />
        )}
        <div className={`${s.field} ${s.wide}`}>
          <Checkbox label={t('work.current')} checked={d.current} onChange={set('current')} />
        </div>
        <TextArea label={t('work.description')} value={d.description} onChange={set('description')} maxLength={8000} rows={3} />
        <TextArea label={t('work.bullets')} hint={t('work.bulletsHint')} value={d.bullets} onChange={set('bullets')} rows={4} />
      </div>
      <SaveRow state={state} onCancel={onDone} />
    </form>
  );
}

export function WorkSection({ profile }: { profile: ProfileView }) {
  const t = useTranslations('profile');
  const { removeExperience } = useProfileMutations();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const missing = profile.missing.some((m) => m.section === 'work');

  return (
    <SectionCard id="work" title={t('sections.work')} missing={missing}>
      {profile.experience.length === 0 && editing !== 'new' ? <p className={s.empty}>{t('work.empty')}</p> : null}
      <ul className={s.rows}>
        {profile.experience.map((x) =>
          editing === x.id ? (
            <li key={x.id}>
              <WorkForm row={x} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={x.id} className={s.row}>
              <div className={s.rowHead}>
                <div>
                  <p className={s.rowTitle}>
                    {x.title} · {x.company}
                  </p>
                  <p className={s.rowMeta}>
                    {[x.kind === 'internship' ? t('work.kinds.internship') : null, x.location, span(x.startDate, x.endDate, x.current, t('work.present'))].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className={s.rowActions}>
                  <Btn variant="ghost" onClick={() => setEditing(x.id)} aria-label={`${t('actions.edit')}: ${x.title}, ${x.company}`}>
                    {t('actions.edit')}
                  </Btn>
                  <Btn
                    variant="ghost"
                    aria-label={`${t('actions.delete')}: ${x.title}, ${x.company}`}
                    disabled={removeExperience.isPending}
                    onClick={() => {
                      if (window.confirm(t('actions.deleteConfirm'))) removeExperience.mutate(x.id);
                    }}
                  >
                    {t('actions.delete')}
                  </Btn>
                </div>
              </div>
              {x.bullets.length ? (
                <ul className={s.bullets}>
                  {x.bullets.slice(0, 5).map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ),
        )}
        {editing === 'new' ? (
          <li>
            <WorkForm onDone={() => setEditing(null)} />
          </li>
        ) : null}
      </ul>
      {editing === null ? (
        <div className={s.actions}>
          <Btn onClick={() => setEditing('new')}>{t('work.add')}</Btn>
        </div>
      ) : null}
    </SectionCard>
  );
}
