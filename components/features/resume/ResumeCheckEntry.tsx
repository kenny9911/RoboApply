'use client';

// ResumeCheckEntry — the "Resume check" link from the resume hub cards and
// the editor (WP-22; F-RES-02 hub entry). A plain link to /resume/[id]/check.

import { useTranslations } from 'next-intl';

import styles from './ResumeCheck.module.css';

export function resumeCheckHref(resumeId: string): string {
  return `/resume/${encodeURIComponent(resumeId)}/check`;
}

export interface ResumeCheckEntryProps {
  resumeId: string;
  /** Resume name, for the accessible label. */
  name?: string;
  className?: string;
}

export function ResumeCheckEntry({ resumeId, name, className }: ResumeCheckEntryProps) {
  const t = useTranslations('resumeCheck');
  return (
    <a
      className={[styles.entry, className].filter(Boolean).join(' ')}
      href={resumeCheckHref(resumeId)}
      aria-label={name ? t('entry.aria', { name }) : undefined}
      data-entry="resume-check"
    >
      {t('entry.cta')}
    </a>
  );
}
