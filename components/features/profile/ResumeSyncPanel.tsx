'use client';

// "Update from a resume" (F-RES-01): pick a resume, review what it would
// change field by field, keep only what you tick. Nothing changes until you
// press the update button, and nothing is ever removed from the profile.
// Only additions start ticked; a change that would overwrite something the
// person entered starts unticked, so overwriting is always opt-in.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import type { ProfileFieldDiff } from '../../../lib/api/contracts/profile';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import { useResumeList } from '../../../hooks/useResumes';
import { useResumeSync } from '../../../hooks/profile/useProfile';
import { cn } from '../../../lib/utils';
import { SectionCard, SelectField } from './parts';
import s from './profile.module.css';

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : typeof v === 'object' && v && 'language' in v ? `${(v as { language: string }).language}` : show(v)))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.school === 'string') return [o.school, o.degree, o.major, [o.startDate, o.endDate].filter(Boolean).join(' – ')].filter(Boolean).join(' · ');
    if (typeof o.company === 'string') return [o.title, o.company, [o.startDate, o.current ? null : o.endDate].filter(Boolean).join(' – ')].filter(Boolean).join(' · ');
    return '';
  }
  return String(value);
}

/** i18n key for a diff path: rows collapse to their list name. */
const fieldKey = (path: string) => (path.startsWith('education[') ? 'education' : path.startsWith('experience[') ? 'experience' : path);

export function ResumeSyncPanel() {
  const t = useTranslations('profile.sync');
  const resumes = useResumeList();
  const { preview, apply } = useResumeSync();
  const [variantId, setVariantId] = useState('');
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  const list = useMemo(() => (resumes.data?.resumes ?? []).filter((r) => r.kind !== 'tailored_for_jd'), [resumes.data]);
  const result = preview.data && preview.data.variantId === variantId ? preview.data : null;
  const diff: ProfileFieldDiff[] = result?.diff ?? [];

  const failure = (err: unknown) => {
    const code = apiErrorCode(err);
    return code === 'conflict' ? t('stale') : code === 'not_found' ? t('resumeGone') : t('error');
  };

  async function compare() {
    if (!variantId) return;
    setMessage(null);
    try {
      const r = await preview.mutateAsync(variantId);
      setAccepted(new Set(r.diff.filter((d) => d.kind === 'add').map((d) => d.path)));
    } catch (err) {
      setAccepted(new Set());
      setMessage(failure(err));
    }
  }

  async function update() {
    if (!variantId || accepted.size === 0) return;
    setMessage(null);
    try {
      await apply.mutateAsync({ variantId, accept: [...accepted] });
      preview.reset();
      setAccepted(new Set());
      setMessage(t('applied'));
    } catch (err) {
      setMessage(failure(err));
    }
  }

  const toggle = (path: string, on: boolean) =>
    setAccepted((cur) => {
      const next = new Set(cur);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });

  return (
    <SectionCard id="sync" title={t('title')} intro={t('intro')}>
      {list.length === 0 && !resumes.isLoading ? (
        <p className={s.empty}>{t('noResumes')}</p>
      ) : (
        <div className={s.grid}>
          <SelectField
            label={t('pick')}
            value={variantId}
            onChange={(v) => {
              setVariantId(v);
              setMessage(null);
            }}
            placeholder={t('pickPlaceholder')}
            options={list.map((r) => ({ value: r.id, label: r.name }))}
          />
          <div className={s.field}>
            <span className={s.label} aria-hidden="true">
              &nbsp;
            </span>
            <Btn onClick={compare} disabled={!variantId || preview.isPending}>
              {preview.isPending ? t('comparing') : t('compare')}
            </Btn>
          </div>
        </div>
      )}

      {result && !result.parsed ? <p className={s.note}>{t('notRead')}</p> : null}
      {result && result.parsed && diff.length === 0 ? <p className={s.note}>{t('nothing')}</p> : null}

      {diff.length > 0 ? (
        <>
          <p className={s.note}>{t('neverRemoves')}</p>
          <ul className={s.diff} aria-label={t('title')}>
            {diff.map((d) => {
              const id = `sync-${d.path}`;
              return (
                <li key={d.path} className={s.diffRow}>
                  <input id={id} type="checkbox" checked={accepted.has(d.path)} onChange={(e) => toggle(d.path, e.target.checked)} />
                  <div>
                    <label htmlFor={id} className={s.diffLabel}>
                      {t(`fields.${fieldKey(d.path)}` as 'fields.firstName')}
                      <span className={cn(s.tag, d.kind === 'add' ? s.tagDone : s.tagOptional)}>{t(`kinds.${d.kind === 'add' ? 'add' : 'change'}`)}</span>
                    </label>
                    <div className={s.diffValues}>
                      {d.kind === 'change' || (Array.isArray(d.current) && d.current.length > 0) ? (
                        <span>
                          <span className={s.diffKey}>{t('current')}: </span>
                          {show(d.current) || t('empty')}
                        </span>
                      ) : null}
                      <span>
                        <span className={s.diffKey}>{t('proposed')}: </span>
                        {show(d.proposed)}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className={s.actions}>
            <Btn variant="primary" onClick={update} disabled={accepted.size === 0 || apply.isPending}>
              {apply.isPending ? t('applying') : t('apply', { count: accepted.size })}
            </Btn>
            <Btn variant="ghost" onClick={() => setAccepted(new Set(diff.map((d) => d.path)))}>
              {t('selectAll')}
            </Btn>
          </div>
        </>
      ) : null}

      <p className={s.status} role="status" aria-live="polite">
        {message ?? ''}
      </p>
    </SectionCard>
  );
}
