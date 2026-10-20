'use client';

// LibraryCard — one base resume in the /resume library: the resume itself as
// the preview, its name and primary state, the job title it is aimed at, its
// latest check, how many versions were made from it, and the actions (edit,
// tailor with AI, make primary, delete). No fit number: a stored fit carries
// no label, kind or date and is not printed here (MARKET_STRATEGY §2.2).

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { cn } from '../../../../lib/utils';
import type { ResumeSummary } from '../../../../lib/api/resumes';
import { useLatestResumeCheck } from '../../../../hooks/resume/useResumeCheck';
import { IconSparkle, IconTrash } from '../../../v3/primitives';
import { CheckStatus } from './CheckStatus';
import { checkStateOf } from './hubModel';
import { ResumeThumb } from './ResumeThumb';
import { TargetTitleField } from './TargetTitleField';
import styles from './Hub.module.css';

export function resumeHref(id: string): string {
  return `/resume/${encodeURIComponent(id)}`;
}

export interface LibraryCardProps {
  resume: ResumeSummary;
  /** Localized "Edited {when}". */
  editedLabel: string;
  /** How the resume began (uploaded file, LinkedIn…), or null when unknown. */
  sourceLabel: string | null;
  /** Versions for specific jobs made from this resume. */
  tailoredCount: number;
  primaryBusy?: boolean;
  onMakePrimary: () => void;
  onSaveTargetTitle: (title: string) => Promise<unknown>;
  onDelete: () => void;
  /** Present only when AI tailoring may run for this user (R-04: no entry otherwise). */
  onTailor?: () => void;
}

export function LibraryCard({
  resume,
  editedLabel,
  sourceLabel,
  tailoredCount,
  primaryBusy,
  onMakePrimary,
  onSaveTargetTitle,
  onDelete,
  onTailor,
}: LibraryCardProps) {
  const t = useTranslations('resume.hub');
  const check = checkStateOf(useLatestResumeCheck(resume.id));
  const href = resumeHref(resume.id);
  const titleId = `resume-card-${resume.id}`;

  return (
    <article className={styles.card} aria-labelledby={titleId} data-primary={resume.isPrimary || undefined}>
      {/* The preview repeats the title link for the pointer; keyboard and
          screen-reader users get the title link alone. */}
      <Link href={href} className={styles.cardThumb} tabIndex={-1} aria-hidden="true">
        <ResumeThumb resumeId={resume.id} />
      </Link>

      <div className={styles.cardBody}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle} id={titleId}>
            <Link href={href}>{resume.name}</Link>
          </h3>
          {resume.isPrimary ? <span className={styles.primaryBadge}>{t('primary.badge')}</span> : null}
        </div>
        <p className={styles.cardMeta}>{sourceLabel ? `${sourceLabel} · ${editedLabel}` : editedLabel}</p>

        <TargetTitleField value={resume.targetTitle} onSave={onSaveTargetTitle} />
        <CheckStatus resumeId={resume.id} name={resume.name} state={check} />
        {tailoredCount > 0 ? <p className={styles.cardTailored}>{t('card.tailored_count', { count: tailoredCount })}</p> : null}

        <div className={styles.cardActions}>
          <Link href={href} className={cn('btn', 'primary', styles.action)} aria-label={t('card.open_aria', { name: resume.name })}>
            {t('card.open')}
          </Link>
          {onTailor ? (
            <button type="button" className={cn('btn', styles.action)} onClick={onTailor} aria-label={t('card.tailor_aria', { name: resume.name })}>
              <IconSparkle size={14} aria-hidden="true" />
              {t('card.tailor')}
            </button>
          ) : null}
          <span className={styles.actionsEnd}>
            {resume.isPrimary ? null : (
              <button type="button" className={styles.textBtn} onClick={onMakePrimary} disabled={primaryBusy} aria-label={t('primary.make_aria', { name: resume.name })}>
                {t('primary.make')}
              </button>
            )}
            <button type="button" className={styles.iconBtn} onClick={onDelete} aria-label={t('card.delete_aria', { name: resume.name })} title={t('card.delete_aria', { name: resume.name })}>
              <IconTrash size={16} aria-hidden="true" />
            </button>
          </span>
        </div>
      </div>
    </article>
  );
}
