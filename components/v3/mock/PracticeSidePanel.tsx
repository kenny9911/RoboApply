'use client';

// /practice setup — the side panel. The right column at desktop widths
// (≥1100px, sticky), after the form below that.
//
// Before a job is chosen it says how a practice works, in four steps, and
// lists the candidate's recent practices (the engine's recent sessions, which
// the page already reads). Once a job is chosen it becomes the summary of what
// is about to start: the job, how the company interviews, the interviewer, the
// focus and the length, all from the plan the prep agents wrote. The launch
// (recording, the reasons Start is off, the cost and Start, the screen's one
// primary button) sits under the steps or the summary. Below 1100px the summary
// folds to a bar pinned to the bottom of the screen: the plan chips above it
// already show the same choices.
//
// Apart from the recent list's own toggles (show all, confirm a delete) this
// component only renders: the page owns the state, PracticeSetupFlow owns the
// launch and passes it in.

import { useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { IconTrash } from '../primitives/Iconset';
import styles from './PracticeSetupFlow.module.css';

/** A finished practice, as the side panel lists it. */
export interface RecentPractice {
  id: string;
  /** The role, with the company when the practice was planned for one. */
  role: string;
  interviewerName: string;
  /** The focus, or the catalog format's label for older sessions. */
  typeLabel: string;
  /** 0..100. Null when the session has no score: shown as "—", never as 0 (D3). */
  score: number | null;
  /** "2 days ago" */
  when: string;
}

/** The plan's choices, as the summary shows them. Every string arrives localized. */
export interface PracticeSummary {
  /** How the company interviews (the plan's company style), when the plan has one. */
  company: { name: string; summary: string; sourced: boolean } | null;
  interviewer: { name: string; detail: string } | null;
  focus: string | null;
  /** "20 min", and the format and language under it. */
  length: { value: string; detail: string };
}

/** Recent practices shown before "Show N earlier". */
const RECENT_LIMIT = 3;

interface Props {
  /** A job, role or post is chosen: the panel is the summary. */
  live: boolean;
  /** The summary's title: the job, with the company when there is one. */
  title: string;
  /** The plan's choices once the plan is ready; null while it is written, failed or not allowed. */
  summary: PracticeSummary | null;
  /** The plan is being written for the chosen job. */
  planPending: boolean;
  /** The practice runs in writing (GoApply without voice): the steps say so. */
  written: boolean;
  recentSessions: RecentPractice[];
  onReplay: (session: RecentPractice) => void;
  onRepeat: (session: RecentPractice) => void;
  onDelete: (session: RecentPractice) => void;
  /** Recording, the reasons Start is off, the cost and Start. */
  launch: ReactNode;
}

export function PracticeSidePanel({
  live,
  title,
  summary,
  planPending,
  written,
  recentSessions,
  onReplay,
  onRepeat,
  onDelete,
  launch,
}: Props) {
  const t = useTranslations('practice');
  const headingId = useId();
  const recentId = useId();
  const [allRecent, setAllRecent] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const steps = [
    { key: 'job', title: t('setup.side.steps.job.title'), body: t('setup.side.steps.job.body') },
    { key: 'plan', title: t('setup.side.steps.plan.title'), body: t('setup.side.steps.plan.body') },
    written
      ? { key: 'written', title: t('setup.side.steps.written.title'), body: t('setup.side.steps.written.body') }
      : { key: 'interview', title: t('setup.side.steps.interview.title'), body: t('setup.side.steps.interview.body') },
    { key: 'report', title: t('setup.side.steps.report.title'), body: t('setup.side.steps.report.body') },
  ];
  const visibleRecent = allRecent ? recentSessions : recentSessions.slice(0, RECENT_LIMIT);

  // One card in both states, with the launch in the same place: choosing a job
  // swaps the steps for the summary but keeps Start the same element.
  return (
    <div className={`${styles.sideColumn} ${live ? styles.sideLive : ''}`}>
      <section className={styles.sideCard} aria-labelledby={headingId}>
        {live ? (
          <>
            <h2 id={headingId} className={styles.sideTitle}>{t('setup.side.summaryTitle')}</h2>
            <p className={styles.summaryJob}>{title}</p>

            {summary ? (
              <dl className={styles.summaryRows}>
                {summary.company ? (
                  <div>
                    <dt>{t('setup.prep.brief.company', { company: summary.company.name })}</dt>
                    <dd>
                      <span>{summary.company.sourced ? t('setup.side.basisSources') : t('setup.side.basisGeneral')}</span>
                      {summary.company.summary ? <small className={styles.summaryClamp}>{summary.company.summary}</small> : null}
                    </dd>
                  </div>
                ) : null}
                {summary.interviewer ? (
                  <div>
                    <dt>{t('setup.launch.interviewer')}</dt>
                    <dd>
                      <span>{summary.interviewer.name}</span>
                      <small>{summary.interviewer.detail}</small>
                    </dd>
                  </div>
                ) : null}
                {summary.focus ? (
                  <div>
                    <dt>{t('setup.flow.chip.focus')}</dt>
                    <dd>
                      <span>{summary.focus}</span>
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t('setup.langDuration.durationLabel')}</dt>
                  <dd>
                    <span>{summary.length.value}</span>
                    {summary.length.detail ? <small>{summary.length.detail}</small> : null}
                  </dd>
                </div>
              </dl>
            ) : planPending ? (
              <p className={styles.summaryPending}>{t('setup.side.planPending')}</p>
            ) : null}
          </>
        ) : (
          <>
            <h2 id={headingId} className={styles.sideTitle}>{t('setup.side.howTitle')}</h2>
            <ol className={styles.steps}>
              {steps.map((step, index) => (
                <li key={step.key}>
                  <span className={styles.stepNumber} aria-hidden>{index + 1}</span>
                  <span className={styles.stepBody}>
                    <strong>{step.title}</strong>
                    <span>{step.body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}

        {launch}
      </section>

      {!live && recentSessions.length > 0 ? (
        <section className={styles.sideCard} aria-labelledby={recentId}>
          <div className={styles.sideHead}>
            <h2 id={recentId} className={styles.sideTitle}>{t('setup.flow.recentTitle')}</h2>
            {recentSessions.length > RECENT_LIMIT ? (
              <button type="button" className={styles.laneToggle} onClick={() => setAllRecent((value) => !value)}>
                {allRecent
                  ? t('setup.recent.showLess')
                  : t('setup.recent.showMore', { count: recentSessions.length - RECENT_LIMIT })}
              </button>
            ) : null}
          </div>

          <ul className={styles.recentList}>
            {visibleRecent.map((session) => (
              <li key={session.id} className={styles.recentItem}>
                <div className={styles.recentTop}>
                  <p className={styles.recentRole}>{session.role}</p>
                  <span className={styles.recentScore}>
                    <span className="sr-only">{t('report.overall')} </span>
                    {session.score ?? '—'}
                  </span>
                </div>
                <p className={styles.recentSub}>
                  <span>{session.typeLabel} · {t('setup.recent.with', { name: session.interviewerName })}</span>
                  {session.when ? <span className={styles.recentWhen}>{session.when}</span> : null}
                </p>

                {confirmDeleteId === session.id ? (
                  <div className={styles.laneConfirm} role="group" aria-label={t('setup.recent.deleteConfirm')}>
                    <span>{t('setup.recent.deleteConfirm')}</span>
                    <div>
                      <button
                        type="button"
                        className={styles.laneDanger}
                        onClick={() => { setConfirmDeleteId(null); onDelete(session); }}
                      >
                        {t('setup.recent.delete')}
                      </button>
                      <button type="button" className={styles.laneGhost} onClick={() => setConfirmDeleteId(null)}>
                        {t('setup.recent.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.laneActions}>
                    <button type="button" className={styles.lanePrimary} onClick={() => onRepeat(session)}>
                      {t('setup.flow.again')}
                    </button>
                    <button type="button" className={styles.laneGhost} onClick={() => onReplay(session)}>
                      {t('setup.flow.viewReport')}
                    </button>
                    <button
                      type="button"
                      className={styles.laneDelete}
                      aria-label={t('setup.recent.deleteAria')}
                      title={t('setup.recent.deleteAria')}
                      onClick={() => setConfirmDeleteId(session.id)}
                    >
                      <IconTrash size={14} aria-hidden />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
