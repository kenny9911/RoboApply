'use client';

// EditorCheckSummary — the server resume check, shown at the top of the
// editor's analyzer popover (WP-22: AnalyzerPanel moves from the local
// heuristic to the server report; the heuristic stays below as the quick,
// offline view). Shows the last check's grade and "Fix first" count, or an
// invitation to run one, and links to /resume/[id]/check.

import { useTranslations } from 'next-intl';

import { useLatestResumeCheck } from '../../../hooks/resume/useResumeCheck';
import { resumeCheckHref } from './ResumeCheckEntry';
import styles from './ResumeCheck.module.css';

export function EditorCheckSummary({ resumeId }: { resumeId: string }) {
  const t = useTranslations('resumeCheck');
  const q = useLatestResumeCheck(resumeId);
  const grade = q.data?.grade?.status === 'done' ? q.data.grade : null;
  return (
    <div className={styles.editorCheck} data-server-check={grade ? 'done' : 'none'}>
      <span className={styles.detailLabel}>{t('editor.title')}</span>
      {grade && grade.label ? (
        <>
          <span className={styles.body}>{t('editor.last', { label: t(`label.${grade.label}`), urgent: grade.counts?.urgent ?? 0 })}</span>
          {q.data?.stale ? <span className={styles.muted}>{t('editor.staleNote')}</span> : null}
          <a className={styles.linkBtn} href={resumeCheckHref(resumeId)}>
            {t('editor.open')}
          </a>
        </>
      ) : (
        <a className={styles.linkBtn} href={resumeCheckHref(resumeId)}>
          {t('editor.run')}
        </a>
      )}
      <span className={styles.muted}>{t('editor.quick')}</span>
    </div>
  );
}
