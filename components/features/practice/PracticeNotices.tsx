'use client';

// PracticeNotices — the one-line setup notices on /practice (WP-43):
//   jobNotFound       the ?job= id is unknown here (wrong market, not yours)
//   firstEmail/Phone  the free first practice waits on verification (C42)
//   gatePhone         GoApply: bind a phone before AI practice
//   gateConsent       GoApply: AI processing consent is off
//   voiceUnavailable  GoApply without voice: practice runs in writing
// Each is a plain sentence plus at most one link.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import styles from './practice.module.css';

export type PracticeNoticeKind =
  | 'jobNotFound'
  | 'firstEmail'
  | 'firstPhone'
  | 'gatePhone'
  | 'gateConsent'
  | 'voiceUnavailable';

/** Where each notice's link goes. */
export const PRACTICE_NOTICE_LINKS: Partial<Record<PracticeNoticeKind, string>> = {
  firstEmail: '/settings#account',
  firstPhone: '/bind-phone',
  gatePhone: '/bind-phone',
  gateConsent: '/settings#consents',
};

export function PracticeNotices({ kinds }: { kinds: PracticeNoticeKind[] }) {
  const t = useTranslations('practice');
  if (kinds.length === 0) return null;

  const text: Record<PracticeNoticeKind, { body: string; action?: string; warn?: boolean }> = {
    jobNotFound: { body: t('job.notFound'), warn: true },
    firstEmail: { body: t('first.email'), action: t('first.emailAction') },
    firstPhone: { body: t('first.phone'), action: t('first.phoneAction') },
    gatePhone: { body: t('gate.phone'), action: t('gate.phoneAction'), warn: true },
    gateConsent: { body: t('gate.consent'), action: t('gate.consentAction'), warn: true },
    voiceUnavailable: { body: t('gate.voiceUnavailable') },
  };

  return (
    <div className={styles.notices} data-testid="practice-notices">
      {kinds.map((kind) => {
        const item = text[kind];
        const href = PRACTICE_NOTICE_LINKS[kind];
        return (
          <p key={kind} className={`${styles.notice} ${item.warn ? styles.noticeWarn : ''}`} data-notice={kind}>
            <span>{item.body}</span>
            {href && item.action ? (
              <Link className={styles.link} href={href}>{item.action}</Link>
            ) : null}
          </p>
        );
      })}
    </div>
  );
}

export default PracticeNotices;
