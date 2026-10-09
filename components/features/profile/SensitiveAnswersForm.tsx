'use client';

// Sensitive answers editor (RASensitiveAnswers; F-ACCT-04 and the GoApply
// 基本信息 optional fields). One stored document holds both parts, so saving
// one part sends the other part unchanged. Every question is optional, and
// "delete" removes the part. These answers are encrypted, shown only to their
// owner, never used to rank jobs and never sent to AI.
//
// `deleteOnly`: the questions no longer apply (e.g. the person no longer
// targets the US, or the EEO flag is off) but answers are still stored. The
// form then offers only "Delete these answers", so stored answers are always
// reachable. A stored row that can't be read (`unreadable`) can be re-entered
// or deleted; either replaces the whole row.

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import type { SensitiveAnswers } from '../../../lib/api/contracts/profile';
import { usePutSensitiveAnswers, useSensitiveAnswers } from '../../../hooks/profile/useProfile';
import { EEO_OPTIONS, type EeoQuestion } from './options';
import { SaveRow, SelectField, TextField, useDraft, type SaveState } from './parts';
import s from './profile.module.css';

type Eeo = NonNullable<SensitiveAnswers['eeo']>;
type Cn = NonNullable<SensitiveAnswers['cn']>;
type Family = NonNullable<Cn['familyMembers']>[number];

const EEO_QUESTIONS = Object.keys(EEO_OPTIONS) as EeoQuestion[];

function compactEeo(e: Record<EeoQuestion, string>): Eeo | undefined {
  const out = Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Eeo;
  return Object.keys(out).length ? out : undefined;
}

function compactCn(c: { nativePlace: string; politicalStatus: string; familyMembers: Family[]; photoAssetId?: string }): Cn | undefined {
  const family = c.familyMembers
    .map((f) => ({ relation: f.relation.trim(), name: f.name.trim(), employer: f.employer?.trim() || undefined, title: f.title?.trim() || undefined }))
    .filter((f) => f.relation && f.name);
  const out: Cn = {};
  if (c.nativePlace.trim()) out.nativePlace = c.nativePlace.trim();
  if (c.politicalStatus.trim()) out.politicalStatus = c.politicalStatus.trim();
  if (family.length) out.familyMembers = family;
  if (c.photoAssetId) out.photoAssetId = c.photoAssetId;
  return Object.keys(out).length ? out : undefined;
}

export function SensitiveAnswersForm({ part, deleteOnly = false }: { part: 'eeo' | 'cn'; deleteOnly?: boolean }) {
  const t = useTranslations('profile');
  const query = useSensitiveAnswers();
  const put = usePutSensitiveAnswers();
  const [state, setState] = useState<SaveState>('idle');
  const view = query.data;
  const answers = view?.answers ?? {};

  const eeo = useDraft(view?.updatedAt ?? view, () => {
    const e = answers.eeo ?? {};
    return Object.fromEntries(EEO_QUESTIONS.map((q) => [q, e[q] ?? ''])) as Record<EeoQuestion, string>;
  });
  const cn = useDraft(view?.updatedAt ?? view, () => ({
    nativePlace: answers.cn?.nativePlace ?? '',
    politicalStatus: answers.cn?.politicalStatus ?? '',
    familyMembers: (answers.cn?.familyMembers ?? []) as Family[],
    photoAssetId: answers.cn?.photoAssetId,
  }));

  if (query.isLoading) return <p className={s.note}>{t('page.loading')}</p>;
  if (!view) return null;

  const configured = view.configured;
  const unreadable = view.unreadable === true;

  async function send(next: SensitiveAnswers) {
    setState('saving');
    try {
      await put.mutateAsync(next);
      eeo.markClean();
      cn.markClean();
      setState('saved');
    } catch {
      setState('error');
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const nextEeo = part === 'eeo' ? compactEeo(eeo.draft) : answers.eeo;
    const nextCn = part === 'cn' ? compactCn(cn.draft) : answers.cn;
    void send({ ...(nextEeo ? { eeo: nextEeo } : {}), ...(nextCn ? { cn: nextCn } : {}) });
  }

  function deletePart() {
    // An unreadable row can't be split by part: deleting removes all of it.
    const keep: SensitiveAnswers = unreadable ? {} : part === 'eeo' ? (answers.cn ? { cn: answers.cn } : {}) : answers.eeo ? { eeo: answers.eeo } : {};
    void send(keep).then(() => (part === 'eeo' ? eeo.reset() : cn.reset()));
  }

  const hasStored = unreadable || (part === 'eeo' ? !!answers.eeo : !!answers.cn);

  if (deleteOnly) {
    if (!hasStored) return null;
    return (
      <div className={s.page}>
        <p className={s.note}>{t('eeo.storedNotAsked')}</p>
        <div className={s.actions}>
          <Btn variant="ghost" onClick={deletePart} disabled={state === 'saving'}>
            {t('eeo.deleteAll')}
          </Btn>
          <p className={s.status} role="status" aria-live="polite">
            {state === 'error' ? t('eeo.deleteError') : state === 'saved' ? t('eeo.deleted') : ''}
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={save} noValidate className={s.page}>
      {part === 'cn' ? (
        <div>
          <h3 className={s.cardTitle}>{t('basics.optionalTitle')}</h3>
          <p className={s.cardIntro}>{t('basics.optionalIntro')}</p>
        </div>
      ) : null}
      {!configured ? (
        <p className={s.error} role="status">
          {t('eeo.notConfigured')}
        </p>
      ) : unreadable ? (
        <p className={s.note} role="status">
          {t('sensitive.unreadable')}
        </p>
      ) : null}

      {part === 'eeo' ? (
        <div className={s.grid}>
          {EEO_QUESTIONS.map((q) => (
            <SelectField
              key={q}
              label={t(`eeo.${q}`)}
              value={eeo.draft[q]}
              onChange={(v) => {
                eeo.update((d) => ({ ...d, [q]: v }));
                setState('idle');
              }}
              placeholder={t('eeo.notAnswered')}
              options={EEO_OPTIONS[q].map((v) => ({ value: v, label: t(`eeo.options.${v}`) }))}
            />
          ))}
        </div>
      ) : (
        <>
          <div className={s.grid}>
            <TextField
              label={t('basics.nativePlace')}
              value={cn.draft.nativePlace}
              onChange={(v) => cn.update((d) => ({ ...d, nativePlace: v }))}
              maxLength={60}
            />
            <TextField
              label={t('basics.politicalStatus')}
              value={cn.draft.politicalStatus}
              onChange={(v) => cn.update((d) => ({ ...d, politicalStatus: v }))}
              maxLength={60}
            />
          </div>
          <fieldset className={s.fieldset}>
            <legend className={s.legend}>{t('basics.familyMembers')}</legend>
            <p className={s.hint}>{t('basics.familyIntro')}</p>
            <ul className={s.rows}>
              {cn.draft.familyMembers.map((f, i) => (
                <li key={i} className={s.row}>
                  <div className={s.grid}>
                    {(['relation', 'name', 'employer', 'title'] as const).map((k) => (
                      <TextField
                        key={k}
                        label={t(`basics.family${k[0]!.toUpperCase()}${k.slice(1)}` as 'basics.familyRelation')}
                        value={f[k] ?? ''}
                        maxLength={k === 'employer' ? 120 : 60}
                        onChange={(v) =>
                          cn.update((d) => ({ ...d, familyMembers: d.familyMembers.map((m, j) => (j === i ? { ...m, [k]: v } : m)) }))
                        }
                      />
                    ))}
                  </div>
                  <div className={s.rowActions}>
                    <Btn variant="ghost" onClick={() => cn.update((d) => ({ ...d, familyMembers: d.familyMembers.filter((_, j) => j !== i) }))}>
                      {t('actions.delete')}
                    </Btn>
                  </div>
                </li>
              ))}
            </ul>
            {cn.draft.familyMembers.length < 10 ? (
              <div className={s.actions}>
                <Btn onClick={() => cn.update((d) => ({ ...d, familyMembers: [...d.familyMembers, { relation: '', name: '' }] }))}>{t('basics.addFamily')}</Btn>
              </div>
            ) : null}
          </fieldset>
          {!view.availability.cnPhoto ? <p className={s.note}>{t('basics.photoUnavailable')}</p> : null}
        </>
      )}

      <div className={s.actions}>
        <SaveRow state={state} disabled={!configured} />
        {hasStored ? (
          <Btn variant="ghost" onClick={deletePart} disabled={state === 'saving'}>
            {t('eeo.deleteAll')}
          </Btn>
        ) : null}
      </div>
    </form>
  );
}
