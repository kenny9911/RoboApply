'use client';

// LetterError — one plain sentence for each way a cover-letter action can fail
// (WP-37). Content-safety outcomes (`content_blocked`, the safety check being
// down) get their own words; nothing is retried on another model.

import { useTranslations } from 'next-intl';

import type { LetterErrorKind } from '../../../hooks/coverletter/useCoverLetters';
import styles from './CoverLetter.module.css';

/** Rewrites per letter per day (server: REWRITES_PER_LETTER_PER_DAY). */
export const REWRITE_LIMIT = 20;

export function LetterError({ kind }: { kind: LetterErrorKind }) {
  const t = useTranslations('coverLetter.error');
  return (
    <p className={styles.error} role="alert" data-error={kind}>
      {kind === 'rewrite_limit' ? t('rewrite_limit', { limit: REWRITE_LIMIT }) : t(kind)}
    </p>
  );
}
