'use client';

// TrackerDrawer — one application's details (WP-38; PRODUCT F-TRK-02).
//
//   stage (brand ladder; GoApply interview rounds) · how it ended (They said
//   no / I withdrew / Job was pulled, ruling C1) · dates (applied, interview,
//   follow up, deadline) · the salary the user noted · notes · the offer slot
//   (WP-64) · "Practice for this job" · files sent · history + add a note.
//
// Every save is a PATCH that the server records in the history. Nothing here
// applies anywhere (D1); the follow-up draft link arrives with WP-54.

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, Drawer } from '../../v3/primitives';
import { OfferSection } from '../offers';
import { useLaunchPractice } from '../../../hooks/shared/useLaunchPractice';
import { useAddTrackerNote, usePatchTrackerEntry, useTrackerArtifacts, useTrackerEvents } from '../../../hooks/tracker/useTracker';
import type { In } from '../../../lib/api/contracts/wire';
import type * as TR from '../../../lib/api/contracts/tracker';
import {
  entryCompany,
  entryLink,
  entryRole,
  fromDateInput,
  fromDateTimeInput,
  toDateInput,
  toDateTimeInput,
  useDateFormat,
  useStageLabel,
  useTrackerColumns,
} from './shared';
import styles from './tracker.module.css';

const OUTCOMES = ['they_said_no', 'i_withdrew', 'job_pulled'] as const;
const CN_ROUNDS = ['mianshi_1', 'mianshi_2', 'hr_mianshi'] as const;

export interface TrackerDrawerProps {
  /** The entry to show (from the board cache, or fetched by id); null closes the drawer. */
  entry: TR.TrackerEntryView | null;
  /** The linked entry does not exist (deleted, or not this user's): open with a plain note. */
  notFound?: boolean;
  onClose: () => void;
}

export function TrackerDrawer({ entry, notFound = false, onClose }: TrackerDrawerProps) {
  const t = useTranslations('applications');
  const name = entry ? [entryCompany(entry), entryRole(entry)].filter(Boolean).join(' · ') : '';
  return (
    <Drawer open={Boolean(entry) || notFound} onClose={onClose} title={name || t('drawer.title')} ariaLabel={t('drawer.title')} size="wide">
      {entry ? <DrawerBody key={entry.id} entry={entry} /> : null}
      {!entry && notFound ? <p className={styles.muted}>{t('drawer.not_found')}</p> : null}
    </Drawer>
  );
}

interface FormState {
  status: string;
  outcome: string;
  stageDetail: string;
  dateApplied: string;
  interviewAt: string;
  followUpAt: string;
  deadline: string;
  maxSalary: string;
  maxSalaryCurrency: string;
  notesMarkdown: string;
}

function formFrom(e: TR.TrackerEntryView): FormState {
  return {
    status: e.status,
    outcome: e.outcome ?? '',
    stageDetail: e.stageDetail ?? '',
    dateApplied: toDateInput(e.dateApplied),
    interviewAt: toDateTimeInput(e.interviewAt),
    followUpAt: toDateInput(e.followUpAt),
    deadline: e.deadline ?? '',
    maxSalary: e.maxSalary === null ? '' : String(e.maxSalary),
    maxSalaryCurrency: e.maxSalaryCurrency ?? '',
    notesMarkdown: e.notesMarkdown ?? '',
  };
}

/** Only the fields that changed (the server records each one). */
export function buildPatch(entry: TR.TrackerEntryView, f: FormState): In<typeof TR.TrackerPatchBodySchema> {
  const before = formFrom(entry);
  const body: In<typeof TR.TrackerPatchBodySchema> = {};
  if (f.outcome !== before.outcome) {
    if (f.outcome) body.outcome = f.outcome as TR.TrackerOutcome;
    else {
      body.outcome = null;
      // Back to in progress: the stage picker says where.
      body.status = (f.status === before.status && ['rejected', 'withdrawn', 'closed'].includes(f.status) ? 'applied' : f.status) as TR.TrackerStatus;
    }
  } else if (f.status !== before.status) {
    body.status = f.status as TR.TrackerStatus;
  }
  if (f.stageDetail !== before.stageDetail) body.stageDetail = f.stageDetail || null;
  if (f.dateApplied !== before.dateApplied) body.dateApplied = fromDateInput(f.dateApplied);
  if (f.interviewAt !== before.interviewAt) body.interviewAt = fromDateTimeInput(f.interviewAt);
  if (f.followUpAt !== before.followUpAt) body.followUpAt = fromDateInput(f.followUpAt);
  if (f.deadline !== before.deadline) body.deadline = f.deadline || null;
  if (f.maxSalary !== before.maxSalary) {
    const n = Number(f.maxSalary);
    body.maxSalary = f.maxSalary.trim() === '' || !Number.isFinite(n) ? null : Math.max(0, Math.round(n));
  }
  if (f.maxSalaryCurrency !== before.maxSalaryCurrency) {
    const c = f.maxSalaryCurrency.trim().toUpperCase();
    body.maxSalaryCurrency = /^[A-Z]{3}$/.test(c) ? c : null;
  }
  if (f.notesMarkdown !== before.notesMarkdown) body.notesMarkdown = f.notesMarkdown || null;
  return body;
}

function DrawerBody({ entry }: { entry: TR.TrackerEntryView }) {
  const t = useTranslations('applications');
  const { market, columns } = useTrackerColumns();
  const stageLabel = useStageLabel();
  const patch = usePatchTrackerEntry();
  const launchPractice = useLaunchPractice();
  const [form, setForm] = useState<FormState>(() => formFrom(entry));
  const [notice, setNotice] = useState<'saved' | 'error' | null>(null);
  const link = entryLink(entry);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setNotice(null);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const body = buildPatch(entry, form);
  const dirty = Object.keys(body).length > 0;
  const ended = Boolean(form.outcome);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    patch.mutate(
      { id: entry.id, body },
      {
        onSuccess: ({ entry: next }) => {
          setForm(formFrom(next));
          setNotice('saved');
        },
        onError: () => setNotice('error'),
      },
    );
  }

  return (
    <div className={styles.drawerBody}>
      {link ? (
        <a className={styles.postingLink} href={link} target="_blank" rel="noopener noreferrer">
          {t('drawer.open_posting')}
        </a>
      ) : null}

      <form className={styles.form} onSubmit={onSubmit} aria-label={t('drawer.title')}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>{t('drawer.stage')}</span>
            <select className={styles.input} value={ended ? entry.status : form.status} disabled={ended} onChange={(e) => set('status', e.target.value)}>
              {columns
                .filter((c) => !c.terminal)
                .map((c) => (
                  <option key={c.status} value={c.status}>
                    {t(`columns.${c.labelKey}`)}
                  </option>
                ))}
              {ended || !columns.some((c) => c.status === form.status && !c.terminal) ? <option value={form.status}>{stageLabel(form.status)}</option> : null}
            </select>
          </label>
          {market === 'cn' && form.status === 'interviewing' && !ended ? (
            <label className={styles.field}>
              <span className={styles.label}>{t('rounds.label')}</span>
              <select className={styles.input} value={form.stageDetail} onChange={(e) => set('stageDetail', e.target.value)}>
                <option value="">{t('rounds.none')}</option>
                {CN_ROUNDS.map((r) => (
                  <option key={r} value={r}>
                    {t(`rounds.${r}`)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>{t('outcome.label')}</legend>
          <div className={styles.choices}>
            {(['', ...OUTCOMES] as const).map((o) => (
              <label key={o || 'none'} className={styles.choice}>
                <input type="radio" name={`outcome-${entry.id}`} value={o} checked={form.outcome === o} onChange={() => set('outcome', o)} />
                <span>{o ? t(`outcome.${o}`) : t('drawer.outcome_none')}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>{t('drawer.dates')}</legend>
          <div className={styles.grid2}>
            <DateField label={t('drawer.applied_on')} type="date" value={form.dateApplied} onChange={(v) => set('dateApplied', v)} />
            <DateField label={t('drawer.interview_at')} type="datetime-local" value={form.interviewAt} onChange={(v) => set('interviewAt', v)} />
            <DateField label={t('drawer.follow_up_on')} type="date" value={form.followUpAt} onChange={(v) => set('followUpAt', v)} />
            <DateField label={t('drawer.deadline')} type="date" value={form.deadline} onChange={(v) => set('deadline', v)} />
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>{t('drawer.salary')}</legend>
          <div className={styles.grid2}>
            <label className={styles.field}>
              <span className={styles.sublabel}>{t('drawer.salary_amount')}</span>
              <input className={styles.input} inputMode="numeric" value={form.maxSalary} onChange={(e) => set('maxSalary', e.target.value.replace(/[^\d]/g, ''))} />
            </label>
            <label className={styles.field}>
              <span className={styles.sublabel}>{t('drawer.salary_currency')}</span>
              <input className={styles.input} maxLength={3} value={form.maxSalaryCurrency} onChange={(e) => set('maxSalaryCurrency', e.target.value.toUpperCase())} />
            </label>
          </div>
        </fieldset>

        <label className={styles.field}>
          <span className={styles.label}>{t('drawer.notes')}</span>
          <textarea className={styles.textarea} rows={4} placeholder={t('drawer.notes_placeholder')} value={form.notesMarkdown} onChange={(e) => set('notesMarkdown', e.target.value)} />
        </label>

        <div className={styles.actions}>
          <Btn type="submit" variant="primary" disabled={!dirty || patch.isPending}>
            {patch.isPending ? t('drawer.saving') : t('drawer.save')}
          </Btn>
          <span role="status" className={notice === 'error' ? styles.error : styles.muted}>
            {notice === 'saved' ? t('drawer.saved') : notice === 'error' ? t('drawer.error') : null}
          </span>
        </div>
      </form>

      <OfferSection trackerEntryId={entry.id} />

      {entry.jobId ? (
        <div>
          <Btn variant="default" onClick={() => launchPractice({ jobId: entry.jobId!, resumeId: entry.tailoredVariantId, from: 'applications' })}>
            {t('drawer.practice')}
          </Btn>
        </div>
      ) : null}

      <FilesSent entryId={entry.id} />
      <History entryId={entry.id} />
    </div>
  );
}

function DateField({ label, type, value, onChange }: { label: string; type: 'date' | 'datetime-local'; value: string; onChange: (v: string) => void }) {
  return (
    <label className={styles.field}>
      <span className={styles.sublabel}>{label}</span>
      <input className={styles.input} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function FilesSent({ entryId }: { entryId: string }) {
  const t = useTranslations('applications');
  const { day } = useDateFormat();
  const { data, isLoading, isError } = useTrackerArtifacts(entryId);
  const via = (v: string) => (v === 'download' || v === 'extension' || v === 'agent' ? t(`drawer.via_${v}`) : t('drawer.via_other'));
  return (
    <section className={styles.section} aria-labelledby={`files-${entryId}`}>
      <h3 id={`files-${entryId}`} className={styles.sectionTitle}>
        {t('drawer.files')}
      </h3>
      {isLoading ? <p className={styles.muted}>…</p> : null}
      {isError ? <p className={styles.muted}>{t('drawer.load_error')}</p> : null}
      {data && data.length === 0 ? <p className={styles.muted}>{t('drawer.files_empty')}</p> : null}
      {data && data.length > 0 ? (
        <ul className={styles.plainList}>
          {data.map((a) => (
            <li key={a.id} className={styles.fileRow}>
              <span className={styles.strong}>{a.fileName}</span>
              <span className={styles.muted}>{t('drawer.file_line', { format: a.format.toUpperCase(), via: via(a.via), date: day(a.createdAt) })}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function History({ entryId }: { entryId: string }) {
  const t = useTranslations('applications');
  const stageLabel = useStageLabel();
  const { day, dayTime } = useDateFormat();
  const { data, isLoading, isError } = useTrackerEvents(entryId);
  const addNote = useAddTrackerNote(entryId);
  const [note, setNote] = useState('');

  function describe(ev: TR.TrackerEventView): string {
    const p = ev.payload ?? {};
    switch (ev.kind) {
      case 'created':
        return t('events.created', { stage: stageLabel(ev.toValue ?? 'bookmarked') });
      case 'status':
        if (p.removed) return t('events.removed');
        if (p.undo) return t('events.undo', { to: stageLabel(ev.toValue ?? 'bookmarked') });
        return t('events.status', { from: stageLabel(ev.fromValue ?? 'bookmarked'), to: stageLabel(ev.toValue ?? 'bookmarked') });
      case 'stage':
        return t('events.stage');
      case 'note':
        return typeof p.text === 'string' ? p.text : t('events.note');
      case 'interview':
        return ev.toValue ? t('events.interview_set', { date: dayTime(ev.toValue) }) : t('events.interview_cleared');
      case 'offer':
        return ev.toValue === 'cleared' ? t('events.offer_cleared') : t('events.offer_set');
      case 'outcome':
        return ev.toValue && ['they_said_no', 'i_withdrew', 'job_pulled'].includes(ev.toValue)
          ? t('events.outcome', { outcome: t(`outcome.${ev.toValue}`) })
          : t('events.outcome_cleared');
      case 'follow_up':
        return ev.toValue ? t('events.follow_up_set', { date: day(ev.toValue) }) : t('events.follow_up_cleared');
      case 'artifact':
        return t('events.artifact');
      default: {
        const field = typeof p.field === 'string' && ['dateApplied', 'deadline', 'notesMarkdown', 'maxSalary', 'maxSalaryCurrency', 'excitementStars'].includes(p.field) ? p.field : 'other';
        return t('events.field', { field: t(`events.fields.${field}`) });
      }
    }
  }

  return (
    <section className={styles.section} aria-labelledby={`history-${entryId}`}>
      <h3 id={`history-${entryId}`} className={styles.sectionTitle}>
        {t('drawer.timeline')}
      </h3>
      <form
        className={styles.noteForm}
        onSubmit={(e) => {
          e.preventDefault();
          const text = note.trim();
          if (!text) return;
          addNote.mutate(text, { onSuccess: () => setNote('') });
        }}
      >
        <label className={styles.field}>
          <span className={styles.sublabel}>{t('drawer.note_label')}</span>
          <textarea className={styles.textarea} rows={2} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} />
        </label>
        <Btn type="submit" variant="default" disabled={!note.trim() || addNote.isPending}>
          {t('drawer.note_add')}
        </Btn>
      </form>
      {isLoading ? <p className={styles.muted}>…</p> : null}
      {isError ? <p className={styles.muted}>{t('drawer.load_error')}</p> : null}
      {data && data.length === 0 ? <p className={styles.muted}>{t('drawer.timeline_empty')}</p> : null}
      {data && data.length > 0 ? (
        <ol className={styles.timeline}>
          {data.map((ev) => (
            <li key={ev.id} className={styles.timelineItem}>
              <span className={ev.kind === 'note' ? styles.noteText : undefined}>{describe(ev)}</span>
              <time className={styles.muted} dateTime={ev.at}>
                {dayTime(ev.at)}
              </time>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
