'use client';

// NextSteps — "Up next" on the /resume hub: what is waiting on the user, most
// pressing first (hubModel.nextSteps). Each row is a fact and the link that
// settles it (ruling C11): Verify details, or the main resume's check. Nothing
// is listed until the data behind it has loaded: a loading state is never
// shown as "all done".

import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { IconArrow, IconCheck, IconClock, IconInfo } from '../../../v3/primitives';
import { resumeCheckHref } from '../ResumeCheckEntry';
import { verifyDetailsHref } from '../ResumeHub';
import type { NextStep } from './hubModel';
import { resumeHref } from './LibraryCard';
import styles from './Hub.module.css';

export interface NextStepsProps {
  steps: readonly NextStep[];
  loading: boolean;
}

type Tone = 'warn' | 'action' | 'muted';

interface Row {
  key: string;
  tone: Tone;
  icon: ReactNode;
  title: string;
  detail: string;
  href: string;
}

export function NextSteps({ steps, loading }: NextStepsProps) {
  const t = useTranslations('resume.hub');
  const tc = useTranslations('resumeCheck');
  const titleId = useId();

  const row = (step: NextStep): Row => {
    switch (step.kind) {
      case 'verify':
        return {
          key: `verify-${step.resumeId}`,
          tone: 'warn',
          icon: <IconInfo size={16} aria-hidden="true" />,
          title: t('tailored.verify', { count: step.count }),
          detail: t('next.verify_detail', { name: step.name }),
          href: step.sessionId ? verifyDetailsHref(step.sessionId) : resumeHref(step.resumeId),
        };
      case 'check_running':
        return {
          key: 'check',
          tone: 'muted',
          icon: <IconClock size={16} aria-hidden="true" />,
          title: tc('running.title'),
          detail: t('next.check_running_detail', { name: step.name }),
          href: resumeCheckHref(step.resumeId),
        };
      case 'check_stale':
        return {
          key: 'check',
          tone: 'action',
          icon: <IconCheck size={16} aria-hidden="true" />,
          title: tc('stale.cta'),
          detail: t('next.check_stale_detail', { name: step.name }),
          href: resumeCheckHref(step.resumeId),
        };
      case 'check_failed':
        return {
          key: 'check',
          tone: 'warn',
          icon: <IconInfo size={16} aria-hidden="true" />,
          title: tc('failed.title'),
          detail: t('next.check_failed_detail', { name: step.name }),
          href: resumeCheckHref(step.resumeId),
        };
      case 'check_none':
        return {
          key: 'check',
          tone: 'action',
          icon: <IconCheck size={16} aria-hidden="true" />,
          title: t('next.check_none'),
          detail: t('next.check_none_detail', { name: step.name }),
          href: resumeCheckHref(step.resumeId),
        };
      case 'fix_urgent':
      case 'fix_critical':
        return {
          key: 'check',
          tone: step.kind === 'fix_urgent' ? 'warn' : 'action',
          icon: <IconInfo size={16} aria-hidden="true" />,
          title: step.kind === 'fix_urgent' ? t('next.fix_urgent', { count: step.count }) : t('next.fix_critical', { count: step.count }),
          detail: t('next.fix_detail', { name: step.name }),
          href: resumeCheckHref(step.resumeId),
        };
    }
  };

  const rows = steps.map(row);

  return (
    <section className={styles.next} aria-labelledby={titleId} aria-busy={loading || undefined}>
      <div className={styles.nextHead}>
        <h2 className={styles.nextTitle} id={titleId}>
          {t('next.title')}
        </h2>
        {!loading && rows.length > 0 ? <span className={styles.nextCount}>{rows.length}</span> : null}
      </div>
      {loading ? (
        <div role="status">
          <span className={styles.srOnly}>{t('next.loading')}</span>
          <div className={styles.skeletonRow} aria-hidden="true" />
          <div className={styles.skeletonRow} aria-hidden="true" />
        </div>
      ) : rows.length === 0 ? (
        <p className={styles.nextEmpty}>
          <IconCheck size={16} aria-hidden="true" />
          {t('next.empty')}
        </p>
      ) : (
        <ol className={styles.nextList}>
          {rows.map((r) => (
            <li key={r.key}>
              <Link className={styles.step} href={r.href}>
                <span className={styles.stepIcon} data-tone={r.tone}>
                  {r.icon}
                </span>
                <span className={styles.stepText}>
                  <span className={styles.stepTitle}>{r.title}</span>
                  <span className={styles.stepDetail}>{r.detail}</span>
                </span>
                <IconArrow size={16} className={styles.stepArrow} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
