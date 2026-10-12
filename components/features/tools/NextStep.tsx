'use client';

// After a free-tool report (WP-57):
//   - signed out → create an account (carries `from` and `next`) or sign in;
//     the full report comes with the account. Clicking either link is the
//     request to keep this result (its id is remembered for this tab only,
//     never put in the link);
//   - signed in → "Keep it": the checked resume goes into the account
//     (POST /results/:id/claim) and the full report replaces the short one.

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useAuth } from '../../../lib/auth/useAuth';
import { apiErrorCode, apiErrorReason } from '../../../lib/api/contracts/wire';
import type { ClaimToolResultResponse, ToolReport } from '../../../lib/api/contracts/tools';
import { Btn } from '../../v3/primitives';
import { resumeCheckHref } from '../resume';
import { signupHref, toolByKind } from './catalog';
import { useClaimToolResult } from './hooks';
import { armPendingResult, clearPendingResult } from './pendingResult';
import styles from './tools.module.css';

export interface NextStepProps {
  report: ToolReport;
  /** Called with the claim response (the full report and the new resume id). */
  onClaimed: (res: ClaimToolResultResponse) => void;
  claimed: ClaimToolResultResponse | null;
}

export function NextStep({ report, onClaimed, claimed }: NextStepProps) {
  const t = useTranslations('tools');
  const { status } = useAuth();
  const claim = useClaimToolResult();
  const [error, setError] = useState<string | null>(null);
  const entry = toolByKind(report.kind);
  const isCheck = report.kind === 'resume_check';

  if (claimed) {
    return (
      <section className={styles.next} data-next="claimed">
        <p className={styles.ok} role="status">
          {t('claim.done')}
        </p>
        <div className={styles.actions}>
          {isCheck ? (
            <Link className={`${styles.linkBtn} ${styles.linkPrimary}`} href={resumeCheckHref(claimed.resumeId)}>
              {t('claim.openCheck')}
            </Link>
          ) : null}
          <Link className={`${styles.linkBtn} ${isCheck ? styles.linkSecondary : styles.linkPrimary}`} href="/resume">
            {t('claim.openResumes')}
          </Link>
        </div>
      </section>
    );
  }

  if (status === 'authenticated') {
    const keep = () => {
      setError(null);
      claim.mutate(report.resultId, {
        onSuccess: (res) => {
          clearPendingResult();
          onClaimed(res);
        },
        onError: (err) => {
          const reason = apiErrorReason(err);
          if (reason === 'resume_limit') setError(t('claim.limit'));
          else if (reason === 'result_expired' || apiErrorCode(err) === 'not_found') setError(t('claim.gone'));
          else setError(t('claim.error'));
        },
      });
    };
    return (
      <section className={styles.next} aria-labelledby="tool-keep" data-next="keep">
        <h3 id="tool-keep" className={styles.sectionTitle}>
          {t('claim.title')}
        </h3>
        <p className={styles.body}>{t('claim.body')}</p>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Btn variant="primary" onClick={keep} disabled={claim.isPending} aria-busy={claim.isPending}>
            {claim.isPending ? t('claim.saving') : t('claim.cta')}
          </Btn>
        </div>
      </section>
    );
  }

  // The visitor asks to keep this result in the account they are about to
  // create or sign in to: remember it for this tab (ToolResultClaimHost).
  const arm = () => armPendingResult({ id: report.resultId, kind: report.kind, expiresAt: report.expiresAt });

  return (
    <section className={styles.next} aria-labelledby="tool-signup" data-next="signup">
      <h3 id="tool-signup" className={styles.sectionTitle}>
        {isCheck ? t('signup.titleCheck') : t('signup.titleMatch')}
      </h3>
      <p className={styles.body}>{isCheck ? t('signup.bodyCheck') : t('signup.bodyMatch')}</p>
      <div className={styles.actions}>
        <Link className={`${styles.linkBtn} ${styles.linkPrimary}`} href={signupHref(entry)} data-cta-from={entry.from} onClick={arm}>
          {t('signup.cta')}
        </Link>
        <Link className={`${styles.linkBtn} ${styles.linkSecondary}`} href={signupHref(entry, 'login')} onClick={arm}>
          {t('signup.login')}
        </Link>
      </div>
    </section>
  );
}
