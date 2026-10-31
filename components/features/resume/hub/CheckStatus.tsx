'use client';

// CheckStatus — one resume's latest check on its library card: the label and
// the checklist score, the issues by priority, and the one link that fits the
// state (run a check, see the check, check again). The score is a checklist
// score, never a chance of hearing back (resumeCheck.honesty). Reading the
// latest check here does not mark it opened: only the report page does that.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { resumeCheckHref } from '../ResumeCheckEntry';
import type { CheckState } from './hubModel';
import styles from './Hub.module.css';

const SEVERITIES = ['urgent', 'critical', 'optional'] as const;

export interface CheckStatusProps {
  resumeId: string;
  name: string;
  state: CheckState;
}

export function CheckStatus({ resumeId, name, state }: CheckStatusProps) {
  const t = useTranslations('resume.hub.check');
  const tc = useTranslations('resumeCheck');
  const href = resumeCheckHref(resumeId);

  if (state.kind === 'loading') {
    return <div className={styles.checkSkeleton} aria-hidden="true" />;
  }

  if (state.kind === 'unknown') {
    // The read failed: no made-up state, just the way to the check.
    return (
      <div className={styles.check}>
        <Link className={styles.checkLink} href={href} aria-label={tc('entry.aria', { name })}>
          {tc('entry.cta')}
        </Link>
      </div>
    );
  }

  if (state.kind === 'running') {
    return (
      <div className={styles.check} data-state="running">
        <span className={styles.checkTop}>
          <span className={styles.spinner} aria-hidden="true" />
          <span className={styles.checkMuted} role="status">
            {t('running')}
          </span>
        </span>
        <Link className={styles.checkLink} href={href} aria-label={t('open_aria', { name })}>
          {t('open')}
        </Link>
      </div>
    );
  }

  if (state.kind === 'none' || state.kind === 'failed') {
    return (
      <div className={styles.check} data-state={state.kind}>
        <span className={styles.checkMuted}>{state.kind === 'failed' ? tc('failed.title') : t('none')}</span>
        <Link className={styles.checkLink} href={href} aria-label={t('run_aria', { name })}>
          {state.kind === 'failed' ? tc('failed.retry') : t('run')}
        </Link>
      </div>
    );
  }

  const counts = state.counts;
  const issues = counts ? SEVERITIES.filter((s) => counts[s] > 0) : [];
  return (
    <div className={styles.check} data-state="done">
      <div className={styles.checkTop}>
        {state.label ? (
          <span className={styles.grade} data-label={state.label}>
            {tc(`label.${state.label}`)}
          </span>
        ) : null}
        {state.score !== null ? <span className={styles.checkScore}>{tc('score', { score: state.score })}</span> : null}
      </div>
      {counts ? (
        issues.length > 0 ? (
          <ul className={styles.sevList}>
            {issues.map((s) => (
              <li key={s} className={styles.sev} data-sev={s}>
                <b>{counts[s]}</b> {tc(`severity.${s}`)}
              </li>
            ))}
          </ul>
        ) : (
          <span className={styles.checkMuted}>{tc('noIssues')}</span>
        )
      ) : null}
      {state.stale ? <p className={styles.checkStale}>{tc('stale.body')}</p> : null}
      <Link className={styles.checkLink} href={href} aria-label={state.stale ? t('again_aria', { name }) : t('open_aria', { name })}>
        {state.stale ? tc('stale.cta') : t('open')}
      </Link>
    </div>
  );
}
