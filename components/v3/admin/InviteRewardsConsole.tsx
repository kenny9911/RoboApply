'use client';

// components/v3/admin/InviteRewardsConsole.tsx — /admin/reports/invites, the
// invite rewards held for a person to review (WP-60's risk check; INT-08).
//
// An invite is held when its risk signs add up (same device, same network,
// throwaway email, many sign-ups at once) or when the signs could not be read
// at all. Each card shows what the API returns and nothing more: the two
// account ids (linked to their admin pages), the sign-up and qualifying
// dates, the risk points and the signs behind them. No names or emails.
//
//   Approve  the practice credits that are due are given. The answer's status
//            says what happened, and the page says exactly that:
//              rewarded   both people got their credit
//              qualified  only the friend did (the inviter is at the yearly
//                         limit, or has no profile)
//              rejected   nobody did (the friend's profile is gone, or someone
//                         rejected the invite first)
//            A 409 on approve means "approved; the credits could not be added
//            yet and are retried automatically" — shown as such, not a failure.
//   Reject   the invite does not count; no credits are given.
// A decision cannot be undone here. The list is read again after each one.

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { PageHeader } from '../primitives/PageHeader';
import { Btn } from '../primitives/Btn';
import { Tag } from '../primitives/Tag';
import { useHeldReferrals, useReviewReferral } from '../../../hooks/useAdmin';
import { apiErrorCode, apiErrorDetails } from '../../../lib/api/contracts/wire';
import type { HeldReferralView, ReferralStatus } from '../../../lib/api/contracts/growth';
import { AdminGate } from './AdminGate';
import { AdminNav } from './AdminNav';
import { ErrorPanel } from './SystemConsole';
import { fmtCount, fmtLongDate } from './format';
import styles from './console.module.css';

/** Hold reasons the console has words for (features/growth referralRisk.ts and referrals.ts). */
export const HOLD_REASONS = ['same_device', 'same_ip', 'same_browser', 'disposable_email', 'burst', 'signals_missing', 'signals_unavailable', 'invitee_no_profile'] as const;

export type ReviewOutcome = 'approved' | 'approved_friend_only' | 'approved_pending' | 'not_counted' | 'rejected' | 'already_reviewed' | 'failed';

/**
 * What a review answer means.
 *
 * A successful approve is read from the status the server stored, never
 * assumed: `rewarded` = both credited; `qualified` = only the friend (the
 * inviter is at the yearly limit or has no profile); `rejected` = nobody (the
 * friend's profile is gone, or a reject landed first); `pending` = approved,
 * credits still being added. Anything else (still `held`, or no status) means
 * the approval did not take.
 *
 * 409 on approve = approved, credits retried automatically — unless the server
 * says the invite was no longer held (`details.status`), which means someone
 * else already reviewed it.
 */
export function reviewOutcome(decision: 'approve' | 'reject', error: unknown, status?: ReferralStatus | null): ReviewOutcome {
  if (error) {
    if (apiErrorCode(error) !== 'conflict') return 'failed';
    const was = apiErrorDetails<{ status?: unknown }>(error)?.status;
    if (decision === 'reject' || typeof was === 'string') return 'already_reviewed';
    return 'approved_pending';
  }
  if (decision === 'reject') return 'rejected';
  if (status === 'rewarded') return 'approved';
  if (status === 'qualified') return 'approved_friend_only';
  if (status === 'rejected') return 'not_counted';
  if (status === 'pending') return 'approved_pending';
  return 'failed';
}

export function InviteRewardsConsole() {
  return (
    <AdminGate>
      <InviteRewardsInner />
    </AdminGate>
  );
}

function InviteRewardsInner() {
  const t = useTranslations('admin.console.inviteRewards');
  const q = useHeldReferrals();
  const review = useReviewReferral();
  // Outcomes by invite id, kept after the list is read again (a decided invite leaves the list).
  const [outcomes, setOutcomes] = useState<Array<{ id: string; outcome: ReviewOutcome }>>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const decide = (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    const done = (error: unknown, status?: ReferralStatus | null) => {
      setBusyId(null);
      setOutcomes((prev) => [...prev.filter((o) => o.id !== id), { id, outcome: reviewOutcome(decision, error, status) }]);
    };
    review.mutate({ id, decision }, { onSuccess: (answer) => done(null, answer?.status ?? null), onError: (err) => done(err) });
  };

  const items = q.data?.items ?? [];
  const shownIds = new Set(items.map((i) => i.id));
  // Results for invites that have left the list (approved, rejected, reviewed elsewhere).
  const settled = outcomes.filter((o) => !shownIds.has(o.id));

  return (
    <div className={styles.page}>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('sub')} />
      <AdminNav />
      <section className={styles.panel} aria-labelledby="invite-rewards-title">
        <div className={styles.panelHead}>
          <div>
            <h2 id="invite-rewards-title">{t('listTitle')}</h2>
            <p>{t('listSub')}</p>
          </div>
        </div>
        {settled.map((o) => (
          <p key={o.id} className={o.outcome === 'failed' ? styles.error : styles.okBox} role={o.outcome === 'failed' ? 'alert' : 'status'}>
            {t(`outcome.${o.outcome}`)}
          </p>
        ))}
        {q.isError ? (
          <ErrorPanel retry={() => void q.refetch()} />
        ) : !q.data ? (
          <p className={styles.muted} aria-busy="true">{t('loading')}</p>
        ) : items.length === 0 ? (
          <p className={styles.muted}>{t('empty')}</p>
        ) : (
          <ul className={styles.list}>
            {items.map((item) => (
              <HeldInviteCard
                key={item.id}
                item={item}
                busy={review.isPending}
                working={busyId === item.id}
                outcome={outcomes.find((o) => o.id === item.id)?.outcome ?? null}
                onDecide={(decision) => decide(item.id, decision)}
              />
            ))}
          </ul>
        )}
        <p className={styles.muted}>{t('help')}</p>
      </section>
    </div>
  );
}

function HeldInviteCard({
  item,
  busy,
  working,
  outcome,
  onDecide,
}: {
  item: HeldReferralView;
  busy: boolean;
  working: boolean;
  outcome: ReviewOutcome | null;
  onDecide: (decision: 'approve' | 'reject') => void;
}) {
  const t = useTranslations('admin.console.inviteRewards');
  const locale = useLocale();
  const reasonLabel = (reason: string) => (t.has(`reason.${reason}`) ? t(`reason.${reason}`) : reason);
  const titleId = `held-invite-${item.id}`;
  return (
    <li className={styles.card} aria-labelledby={titleId}>
      <div className={styles.cardHead}>
        <div>
          <h3 id={titleId}>{t('cardTitle', { date: fmtLongDate(item.signedUpAt, locale) })}</h3>
          <p>{item.qualifiedAt ? t('qualified', { date: fmtLongDate(item.qualifiedAt, locale) }) : t('notQualified')}</p>
        </div>
        <div className={styles.tags}>
          <Tag tone="warn">{t('riskPoints', { points: fmtCount(item.riskScore, locale) })}</Tag>
        </div>
      </div>
      {item.riskReasons.length > 0 ? (
        <div>
          <p className={styles.muted}>{t('reasonsTitle')}</p>
          <ul className={styles.tagList} aria-label={t('reasonsTitle')}>
            {item.riskReasons.map((r) => (
              <li key={r}>
                <Tag>{reasonLabel(r)}</Tag>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={styles.muted}>{t('noReasons')}</p>
      )}
      <div className={styles.actions}>
        <Link className={styles.link} href={`/admin/users/${encodeURIComponent(item.inviterUserId)}`}>{t('inviterPage')}</Link>
        <Link className={styles.link} href={`/admin/users/${encodeURIComponent(item.inviteeUserId)}`}>{t('friendPage')}</Link>
      </div>
      <div className={styles.actions}>
        <Btn variant="primary" disabled={busy} onClick={() => onDecide('approve')}>{t(working ? 'working' : 'approve')}</Btn>
        <Btn disabled={busy} onClick={() => onDecide('reject')}>{t('reject')}</Btn>
        {outcome ? (
          <p className={outcome === 'failed' ? styles.error : styles.success} role={outcome === 'failed' ? 'alert' : 'status'}>
            {t(`outcome.${outcome}`)}
          </p>
        ) : null}
      </div>
    </li>
  );
}
