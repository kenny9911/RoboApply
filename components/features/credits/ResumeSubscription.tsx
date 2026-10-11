'use client';

// ResumeSubscription — "Keep my plan" (ST-6; MARKET_STRATEGY §4.4 "Cancel":
// "Keep my plan" resumes while the period is live). Shown on the current-plan
// card under "Cancelled. Pro stays on until {date}." Rules:
//
//   - Only for a Pro subscription that renews by itself, that was cancelled,
//     and whose paid period is still running. Never for a one-time pass, never
//     after the period ended, never on the mainland brand (its plans are
//     passes; nothing renews there), and never for a grandfathered practice
//     plan: the server keeps no renewal terms for one and refuses the call,
//     so the offer would be a dead end (that subscriber has the payment
//     portal and the switch to Pro).
//   - Turning renewal back on is agreeing to be charged again, so it needs
//     the same sentence as checkout behind an UNTICKED box: "renews
//     automatically every {period} at {price} until I cancel". The period is
//     the plan's. The price is what the subscription is charged, as the
//     billing plan states it: the same figure the server stores with the
//     acknowledgement. It is never the catalog price (a subscription can be
//     charged another currency or an earlier price). With no charged price
//     (the billing plan has not answered, failed, or states none) the control
//     is not offered: the sentence is never printed with a guess.
//   - The button is enabled only while the box is ticked. Nothing is charged
//     by this call; the next charge is the renewal on the date the card shows.
//   - After the server says "resumed" the card reads the plan again and
//     prints "Renews on {date}" from it; this component only says that
//     renewal is back on.
//   - 409 `nothing_to_resume` means the page was behind the server, and the
//     server uses it for more than one state. So the wording comes from the
//     plan as read again after the refusal, never from the code alone: "This
//     plan has already ended" only when the plan read again is over; nothing
//     when it renews again (the card says "Renews on {date}"); the plain
//     retry line while it still reads as cancelled and running.

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import { RESUME_NOTHING_CODE, useResumeSubscription } from '../../../hooks/credits/useBillingActions';
import type { SubscriptionState } from '../../../hooks/credits/useSubscriptionState';
import { money, parseDate, type PricePeriod } from './labels';
import styles from './credits.module.css';

export type RenewalPeriod = Exclude<PricePeriod, 'once'>;

/** The plan's renewal period, or null when the summary names none that renews. */
export function renewalPeriod(interval: string | null | undefined): RenewalPeriod | null {
  return interval === 'week' || interval === 'month' || interval === 'quarter' ? interval : null;
}

/**
 * Can this subscription be kept? A renewing plan, cancelled, with its paid
 * period still running, on a brand whose plans renew. Not a grandfathered
 * practice plan (the server refuses those).
 */
export function canResumeSubscription(
  sub: Pick<SubscriptionState, 'status' | 'autoRenews' | 'cancelAtPeriodEnd' | 'periodEnd' | 'isPass' | 'legacy'>,
  market: string,
  now: Date = new Date(),
): boolean {
  if (market === 'cn' || sub.status !== 'ready') return false;
  if (sub.legacy || !sub.autoRenews || !sub.cancelAtPeriodEnd || sub.isPass) return false;
  const end = parseDate(sub.periodEnd);
  return !!end && end.getTime() > now.getTime();
}

/**
 * Is the subscription over, as far as the page knows now? True for a free
 * account, a one-time pass (the subscription is gone) and a cancelled plan
 * whose period end has passed. False for a plan that renews, for a cancelled
 * plan that still runs, and whenever the state is not known.
 */
export function subscriptionIsOver(
  sub: Pick<SubscriptionState, 'status' | 'profile' | 'autoRenews' | 'cancelAtPeriodEnd' | 'periodEnd' | 'isPass'>,
  now: Date = new Date(),
): boolean {
  if (sub.status !== 'ready') return false;
  if (sub.isPass) return true;
  if (!sub.autoRenews) return sub.profile === 'free';
  if (!sub.cancelAtPeriodEnd) return false;
  const end = parseDate(sub.periodEnd);
  return !!end && end.getTime() <= now.getTime();
}

export interface ResumeTerms {
  period: RenewalPeriod;
  amountMinor: number;
  currency: string;
}

/**
 * What the acknowledgement names: the plan's period and the price charged at
 * each renewal, as the billing plan states it. Null when either is unknown.
 */
export function resumeTerms(sub: Pick<SubscriptionState, 'interval' | 'chargedAmountMinor' | 'chargedCurrency'>): ResumeTerms | null {
  const period = renewalPeriod(sub.interval);
  if (!period || sub.chargedAmountMinor === null || !sub.chargedCurrency) return null;
  return {
    period,
    amountMinor: sub.chargedAmountMinor,
    currency: sub.chargedCurrency,
  };
}

export interface ResumeSubscriptionProps {
  sub: SubscriptionState;
  /** Called once the server confirmed that renewal is back on. */
  onResumed?: () => void;
  /** Clock (tests). */
  now?: () => Date;
}

export function ResumeSubscription({ sub, onResumed, now = () => new Date() }: ResumeSubscriptionProps) {
  const brand = useBrand();
  const at = now();
  const eligible = canResumeSubscription(sub, brand.market, at);
  // This component stays mounted on the card, so what the control remembers
  // (the box, the answer of the call) must not outlive the cancellation it
  // belongs to. Each time the plan becomes "cancelled and still running", and
  // each time it renews again, the control starts over: a later cancellation
  // meets an unticked box and no old answer, and a refusal cannot speak up
  // when a plan that renewed in between ends later. While the plan is in
  // neither state (free, a pass, period over, not known) the control is kept,
  // so a refusal can be worded from the plan read after it.
  const phase = eligible ? 'cancelled' : sub.status === 'ready' && sub.willRenew ? 'renews' : 'other';
  const [seen, setSeen] = useState({ phase, round: 0 });
  if (seen.phase !== phase) setSeen({ phase, round: phase === 'other' ? seen.round : seen.round + 1 });
  return <ResumeControl key={seen.round} sub={sub} eligible={eligible} at={at} onResumed={onResumed} />;
}

function ResumeControl({ sub, eligible, at, onResumed }: { sub: SubscriptionState; eligible: boolean; at: Date; onResumed?: () => void }) {
  const t = useTranslations('credits');
  const locale = useLocale();
  const resume = useResumeSubscription();
  const [ack, setAck] = useState(false);
  const { isSuccess: resumed, isError: failed } = resume;
  // The server answered 409 "nothing to resume". Read from the call's own
  // state (not from a callback), so it reaches the screen in the same render
  // as the plan that was read again; what it means is decided from that plan.
  const refused = failed && apiErrorCode(resume.error) === RESUME_NOTHING_CODE;

  if (!eligible) {
    if (!refused || !subscriptionIsOver(sub, at)) return null;
    return (
      <p className={styles.error} role="alert" data-testid="resume-ended">
        {t('resume.ended')}
      </p>
    );
  }
  if (resumed) {
    // The server's own answer; the card prints the renewal date once it has read the plan again.
    return (
      <p className={`${styles.notice} ${styles.ok}`} role="status" data-testid="resume-done">
        {t('resume.done')}
      </p>
    );
  }
  const terms = resumeTerms(sub);
  if (!terms) return null;

  return (
    <div className={styles.stack} data-testid="resume-subscription">
      <label className={styles.check}>
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>
          {t('planSheet.autoRenewAck', {
            period: terms.period,
            price: money(locale, terms.amountMinor, terms.currency),
          })}
        </span>
      </label>
      {failed ? (
        <p className={styles.error} role="alert">
          {t('resume.error')}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Btn
          variant="primary"
          disabled={!ack || resume.isPending}
          aria-busy={resume.isPending || undefined}
          onClick={() => resume.mutate(undefined, { onSuccess: () => onResumed?.() })}
        >
          {resume.isPending ? t('resume.pending') : t('resume.button')}
        </Btn>
      </div>
    </div>
  );
}

export default ResumeSubscription;
