'use client';

// ResumeLane — the "Resume" lane of /today (docs/agent-driven/REDESIGN.md §5.5).
//
//   the main resume    the one every job fit is read for (the hub's own rule:
//                      the primary, else the newest base resume)
//   its latest check   the same summary the /resume library card shows
//                      (CheckStatus): a checklist score, never a chance of
//                      hearing back. Reading it here does not mark it opened.
//   what jobs ask for  required skills the top jobs of the search ask for and
//                      the PROFILE does not list (GET /feed/skills-check: the
//                      server compares with profile skills, so the line says
//                      "your profile", not "your resume"). No request that
//                      spends a credit is made for it; the block is left out
//                      when there is nothing to list or it did not load.
//   Improve my resume  → /resume
//
// With no resume the lane says so and offers the way to add one. The same fact
// is a card under "Waiting for you", which carries the primary button.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type { Loadable, SkillAsk } from '../../../hooks/today';
import type { ResumeSummary } from '../../../lib/api/resumes';
import { CheckStatus, mainResumeOf, sortBases, type CheckState } from '../resume';
import { FailedNote, Lane } from './parts';
import styles from './today.module.css';

/** Skills the lane lists at most (the server sends its top five). */
export const ASKED_LIMIT = 5;

export interface ResumeLaneProps {
  resumes: Loadable<ResumeSummary[]>;
  /** The main resume's latest check; null when there is no main resume. */
  check: CheckState | null;
  skills: Loadable<SkillAsk[]>;
}

export function ResumeLane({ resumes, check, skills }: ResumeLaneProps) {
  const t = useTranslations('today');
  const main = resumes.status === 'ready' ? mainResumeOf(sortBases(resumes.data)) : null;
  const asked = skills.status === 'ready' ? skills.data.slice(0, ASKED_LIMIT) : [];

  return (
    <Lane title={t('resume.title')} agent busy={resumes.status === 'loading'} testId="today-resume">
      {resumes.status === 'loading' || resumes.status === 'off' ? (
        <div role="status">
          <span className={styles.srOnly}>{t('resume.loading')}</span>
          <div className={styles.skeletonRow} aria-hidden="true" />
        </div>
      ) : resumes.status === 'error' ? (
        <FailedNote message={t('resume.failed')} onRetry={resumes.retry} />
      ) : main ? (
        <>
          <div className={styles.resumeHead}>
            <span className={styles.subTitle}>{t('resume.mainLabel')}</span>
            <p className={styles.resumeName} data-testid="today-resume-name">
              {main.name}
            </p>
          </div>
          {check ? <CheckStatus resumeId={main.id} name={main.name} state={check} /> : null}
          {asked.length > 0 ? (
            <div className={styles.asked} data-testid="today-asked">
              <p className={styles.note}>{t('resume.asked')}</p>
              <ul className={styles.askedList}>
                {asked.map((s) => (
                  <li key={s.skill}>
                    <b>{s.skill}</b> · {t('resume.askedIn', { count: s.askedIn, total: s.outOf })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className={styles.note} data-testid="today-resume-none">
          {t('resume.none')}
        </p>
      )}

      {resumes.status === 'ready' || resumes.status === 'error' ? (
        <div className={styles.laneFoot}>
          <Link href="/resume" className="btn">
            {resumes.status === 'error' ? t('resume.open') : main ? t('resume.improve') : t('resume.add')}
          </Link>
        </div>
      ) : null}
    </Lane>
  );
}
