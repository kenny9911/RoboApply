'use client';

// TailorError — plain copy for every tailor failure (WP-36a). A GoApply
// WeChat account without a phone gets the bind-phone notice (WP-11);
// content-safety refusals and outages get their own lines (WP-24).

import { useTranslations } from 'next-intl';

import { PhoneBindingNotice } from '../auth-cn';
import { tailorErrorKind, type TailorErrorKind } from '../../../hooks/tailor';
import styles from './Tailor.module.css';

const MESSAGE_KEY: Record<TailorErrorKind, string> = {
  credits_exhausted: 'creditsExhausted',
  ai_unavailable: 'aiUnavailable',
  ai_failed: 'aiFailed',
  content_blocked: 'contentBlocked',
  safety_unavailable: 'safetyUnavailable',
  phone_binding_required: 'generic',
  unverified_claims: 'generic',
  in_progress: 'inProgress',
  not_reviewable: 'notReviewable',
  conflict: 'conflict',
  not_found: 'notFound',
  failed: 'generic',
};

export function TailorError({ error }: { error: unknown }) {
  const t = useTranslations('tailor.error');
  if (!error) return null;
  const kind = tailorErrorKind(error);
  if (kind === 'phone_binding_required') return <PhoneBindingNotice error={error} />;
  return (
    <p className={styles.error} role="alert" data-error={kind}>
      {t(MESSAGE_KEY[kind])}
    </p>
  );
}
