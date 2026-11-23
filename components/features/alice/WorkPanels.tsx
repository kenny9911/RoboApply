'use client';

// The Jobs and Applications views of the canvas.
//
// Jobs: the Job scout's matches for the saved profile. Each row leads with what
// the job is missing (R2) before its fit, and the list says once that a fit is
// not a chance of being hired (C5). "Prepare application" is the existing
// one-tap path with its cost sheet (D1: the person submits).
//
// Applications: real counts per stage of the market's ladder (a zero is a
// zero; an unloaded count is a dash, D3), what needs the person (one action
// each), and follow-up dates (set, done).

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import type { AliceApplicationsView, AliceNeedsYouItem, AliceThreadView } from '../../../lib/api/contracts/alice';
import { useAliceApplications, useAliceMatches, useAliceReminder } from '../../../hooks/alice/useAlice';
import { useFlag } from '../../../lib/flags';
import { PrepareApplicationButton } from '../agent/PrepareApplicationButton';
import { columnKey, formatDay, joinList, todayIso } from './model';
import s from './alice.module.css';

// ── Jobs ───────────────────────────────────────────────────────────────────

export function JobsPanel({ thread, onAsk }: { thread: AliceThreadView; onAsk: () => void }) {
  const t = useTranslations('alice');
  const locale = useLocale();
  const agentOn = useFlag('agent');
  const profileId = thread.savedProfile?.id ?? null;
  const matches = useAliceMatches(profileId);
  if (!profileId || !thread.savedProfile) {
    return (
      <div className={s.section}>
        <h2 className={s.h2}>{t('jobs.titleEmpty')}</h2>
        <p className={s.empty}>{t('jobs.noProfile')}</p>
      </div>
    );
  }
  const items = matches.data?.items ?? [];
  return (
    <div className={s.section}>
      <h2 className={s.h2}>{t('jobs.title', { name: thread.savedProfile.name })}</h2>
      <p className={s.meta}>{t('jobs.honesty')}</p>
      {matches.isLoading ? (
        <div className={s.section} aria-busy="true">
          <p className={s.meta}>{t('jobs.loading')}</p>
          <span className={s.skeleton} style={{ width: '70%' }} />
          <span className={s.skeleton} style={{ width: '55%' }} />
        </div>
      ) : matches.isError ? (
        <div className={s.actions}>
          <p className={s.problem}>{t('jobs.error')}</p>
          <button type="button" className={s.textBtn} onClick={() => void matches.refetch()}>
            {t('jobs.retry')}
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className={s.section}>
          <p className={s.empty}>{t('jobs.empty')}</p>
          <div className={s.actions}>
            <button type="button" className={s.btn} onClick={onAsk}>
              {t('jobs.widen')}
            </button>
          </div>
        </div>
      ) : (
        <ul className={s.jobList}>
          {items.map(({ job, meets, atNamedCompany }) => (
            <li key={job.jobId} className={s.job}>
              <div className={s.jobBody}>
                <h3 className={s.jobTitle}>
                  <Link href={`/jobs/${encodeURIComponent(job.jobId)}`}>{job.title}</Link>
                </h3>
                <p className={s.meta}>{[job.company.name, job.location, job.workModel ? t(`values.workModels.${job.workModel}` as never) : null].filter(Boolean).join(' · ')}</p>
                {job.fit?.topGap ? <p className={s.meta}>{t('jobs.missing', { gap: job.fit.topGap })}</p> : null}
                <p className={s.meta}>
                  {[
                    job.fit ? t(`jobs.tier.${job.fit.tier}` as never) : null,
                    meets.length ? t('jobs.meets', { fields: joinList(meets.map((f) => t(`fields.${f}` as never)), locale) }) : null,
                    atNamedCompany ? t('jobs.named') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <div className={s.jobActions}>
                {agentOn ? <PrepareApplicationButton jobId={job.jobId} queueState={job.application?.state ?? null} trackerEntryId={job.application?.trackerEntryId ?? null} variant="default" addedVia="search" /> : null}
                <Link className={`${s.btn} ${s.btnSmall}`} href={`/jobs/${encodeURIComponent(job.jobId)}`}>
                  {t('jobs.view')}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Link className={s.textBtn} href="/jobs">
        {t('jobs.seeAll')}
      </Link>
    </div>
  );
}

// ── Applications ───────────────────────────────────────────────────────────

function needLabel(item: AliceNeedsYouItem, t: ReturnType<typeof useTranslations>): string {
  switch (item.kind) {
    case 'deadline_soon':
      return t('apps.kind.deadline_soon', { days: item.days ?? 0 });
    case 'no_reply_10d':
      return t('apps.kind.no_reply_10d', { days: item.days ?? 10 });
    default:
      return t(`apps.kind.${item.kind}` as never);
  }
}

function ReminderForm({ board }: { board: AliceApplicationsView }) {
  const t = useTranslations('alice');
  const remind = useAliceReminder();
  const [entryId, setEntryId] = useState('');
  const [date, setDate] = useState('');
  const today = todayIso();
  if (board.open.length === 0) return null;
  return (
    <form
      className={s.commentBox}
      onSubmit={(e) => {
        e.preventDefault();
        if (!entryId || !date) return;
        remind.mutate({ entryId, date }, { onSuccess: () => setDate('') });
      }}
    >
      <span className={s.fieldLabel}>{t('apps.set')}</span>
      <div className={s.inputRow}>
        <label className={s.srOnly} htmlFor="alice-remind-entry">
          {t('apps.pick')}
        </label>
        <select id="alice-remind-entry" className={s.input} value={entryId} onChange={(e) => setEntryId(e.target.value)}>
          <option value="">{t('apps.pick')}</option>
          {board.open.map((o) => (
            <option key={o.entryId} value={o.entryId}>
              {[o.company, o.title].filter(Boolean).join(' · ')}
            </option>
          ))}
        </select>
        <label className={s.srOnly} htmlFor="alice-remind-date">
          {t('apps.date')}
        </label>
        <input id="alice-remind-date" className={s.input} type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
        <button type="submit" className={`${s.btn} ${s.primary}`} disabled={!entryId || !date || remind.isPending}>
          {t('apps.save')}
        </button>
      </div>
      {remind.isError ? <p className={s.problem}>{t('apps.saveError')}</p> : null}
    </form>
  );
}

export function ApplicationsPanel() {
  const t = useTranslations('alice');
  const tc = useTranslations('applications.columns');
  const locale = useLocale();
  const board = useAliceApplications();
  const remind = useAliceReminder();
  if (board.isLoading) {
    return (
      <div className={s.section} aria-busy="true">
        <h2 className={s.h2}>{t('apps.title')}</h2>
        <span className={s.skeleton} style={{ width: '60%' }} />
        <span className={s.skeleton} style={{ width: '40%' }} />
      </div>
    );
  }
  if (board.isError || !board.data) {
    return (
      <div className={s.section}>
        <h2 className={s.h2}>{t('apps.title')}</h2>
        <div className={s.actions}>
          <p className={s.problem}>{t('apps.error')}</p>
          <button type="button" className={s.textBtn} onClick={() => void board.refetch()}>
            {t('apps.retry')}
          </button>
        </div>
      </div>
    );
  }
  const data = board.data;
  const stages = data.stages.filter((st) => st.status !== 'rejected');
  return (
    <>
      <div className={s.section}>
        <h2 className={s.h2}>{t('apps.title')}</h2>
        <div className={s.stageStrip} role="list" aria-label={t('apps.stages')}>
          {stages.map((st) => (
            <div key={st.status} className={s.stageCell} role="listitem">
              <span className={s.meta}>{tc(columnKey(st.status) as never)}</span>
              <span className={s.stageValue} data-zero={st.count === 0 ? 'true' : undefined}>
                {st.count}
              </span>
            </div>
          ))}
        </div>
        {data.facts.active === 0 && (data.facts.readyToCheck ?? 0) === 0 ? <p className={s.empty}>{t('apps.empty')}</p> : null}
      </div>

      <section className={s.section} aria-labelledby="alice-needs-title">
        <h3 id="alice-needs-title" className={s.h3}>
          {t('apps.needs')}
        </h3>
        {data.needsYou.length === 0 ? (
          <p className={s.empty}>{t('apps.needsEmpty')}</p>
        ) : (
          <ul className={s.needs}>
            {data.needsYou.map((n) => (
              <li key={`${n.kind}:${n.entryId ?? n.queueItemId}`} className={s.need}>
                <div>
                  <span className={s.needKind}>{needLabel(n, t)}</span>
                  <span className={s.meta}>{[n.company, n.title].filter(Boolean).join(' · ')}</span>
                </div>
                {n.kind === 'ready_to_check' ? (
                  <Link className={`${s.btn} ${s.btnSmall}`} href="/ready">
                    {t('apps.check')}
                  </Link>
                ) : n.entryId ? (
                  <Link className={`${s.btn} ${s.btnSmall}`} href={`/applications?entry=${encodeURIComponent(n.entryId)}`}>
                    {t('apps.open')}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={s.section} aria-labelledby="alice-reminders-title">
        <h3 id="alice-reminders-title" className={s.h3}>
          {t('apps.reminders')}
        </h3>
        {data.reminders.length === 0 ? (
          <p className={s.empty}>{t('apps.remindersEmpty')}</p>
        ) : (
          <ul className={s.reminders}>
            {data.reminders.map((r) => (
              <li key={r.entryId} className={s.need}>
                <div>
                  <span className={s.needKind}>
                    {formatDay(r.date, locale)}
                    {r.due ? ` · ${t('apps.due')}` : ''}
                  </span>
                  <span className={s.meta}>{[r.company, r.title].filter(Boolean).join(' · ')}</span>
                </div>
                <button type="button" className={`${s.btn} ${s.btnSmall}`} disabled={remind.isPending} onClick={() => remind.mutate({ entryId: r.entryId, date: null })}>
                  {t('apps.done')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <ReminderForm board={data} />
      </section>
      <Link className={s.textBtn} href="/applications">
        {t('apps.all')}
      </Link>
    </>
  );
}
