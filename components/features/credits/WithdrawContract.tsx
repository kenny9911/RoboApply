'use client';

// WithdrawContract — "Withdraw from contract" on /settings/billing (ST-9;
// MARKET_STRATEGY §4.4 "Statutory withdrawal", Directive (EU) 2023/2673):
// a clearly labelled entry, shown for 14 days after each purchase of a buyer
// in the EU, the EEA, the UK or Taiwan. Rules:
//
//   - It is its own section with its own heading under the current plan card,
//     never a line inside the cancel control: cancelling stops the renewal,
//     withdrawing undoes the purchase.
//   - Who sees it is the server's answer (`GET /credits/withdrawal`), never a
//     guess from the visitor's country: `available: false` (a buyer elsewhere,
//     day 15, already withdrawn or refunded) renders nothing. The mainland
//     brand never asks: its plans are paid once and its rails have no refund
//     call. A quote whose last day has passed on this device's clock is not
//     offered either.
//   - One row per purchase that is still open, the latest first, each with
//     its own amount and last day (a practice pack bought on day 3 of a
//     monthly plan and the plan are two rows).
//   - Two steps in total: the entry opens the confirmation; "Withdraw and
//     refund {amount}" sends it. Nothing is sent to the server before the
//     second step. Every number on the sheet comes from the quote: the paid
//     amount, the refund, the last day and, when the buyer asked us to start
//     at once, the used and unused days.
//   - The amount depends on the day (a pro-rata refund is one day smaller
//     every day), so the step never opens with an old figure: a quote that
//     has been on screen for longer than `WITHDRAWAL_STALE_MS` is read again
//     when the entry is pressed, and the step opens with that answer (or the
//     page says the purchase can no longer be withdrawn, or that the amount
//     could not be checked). While a step is open the quote is read again
//     every few minutes, and whenever the tab comes back into view.
//   - After the server says "withdrawn": the refunded amount, that a
//     confirmation email is on its way, and the plan is read again (the plan
//     card then shows what the server holds).
//   - 409 `withdrawal_not_available`: "This purchase can no longer be
//     withdrawn", and the quote is read again. Other refusals keep the
//     confirmation open with their own message.
//   - The label and the wording of the confirming button are counsel items
//     per locale (owner list 13): each lives in its own key
//     (`credits.withdraw.label`, `credits.withdraw.confirmButton`).

import { useEffect, useId, useRef, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import type { WithdrawalOption, WithdrawalOverview } from '../../../lib/api/account';
import type { CatalogPlan } from '../../../lib/api/credits';
import { requiresWithdrawalWaiver } from '../../../lib/pricing';
import {
  useRereadBilling,
  useWithdraw,
  useWithdrawalQuote,
  WITHDRAWAL_OPEN_STEP_REFRESH_MS,
  WITHDRAWAL_STALE_MS,
  WITHDRAWAL_UNAVAILABLE_CODE,
} from '../../../hooks/credits/useBillingActions';
import { plansExtras, usePlans } from '../../../hooks/credits/usePlans';
import { useVisitorCountry } from '../../../hooks/credits/useVisitorCountry';
import { chargedMoney, parseDate, planNameKey } from './labels';
import styles from './credits.module.css';

/** What a purchase gave the buyer, which is what a withdrawal ends. */
export type WithdrawalKind = 'subscription' | 'pass' | 'pack' | 'other';

/**
 * The kind of the purchased plan: the catalog's own word when the plan is
 * listed, a practice pack by its key, else `other` (the sheet then says only
 * that what the purchase gave ends, never that "Pro" does).
 */
export function withdrawalKind(planKey: string | null, plans: ReadonlyArray<Pick<CatalogPlan, 'key' | 'kind'>> | null | undefined): WithdrawalKind {
  if (!planKey) return 'other';
  const kind = plans?.find((p) => p.key === planKey)?.kind;
  if (kind === 'subscription' || kind === 'pass' || kind === 'pack') return kind;
  return planKey.startsWith('practice_pack_') ? 'pack' : 'other';
}

/** The purchases that can still be withdrawn at `now`: what the server offers, minus any whose last day has passed. */
export function openWithdrawals(overview: WithdrawalOverview | null | undefined, now: Date): WithdrawalOption[] {
  if (!overview?.available) return [];
  return overview.options.filter((o) => {
    const deadline = parseDate(o.quote.deadline);
    return !!deadline && deadline.getTime() > now.getTime();
  });
}

/** Which message a refused withdrawal gets: the server's own reason, never one generic line for all. */
export type WithdrawRefusal = 'unavailable' | 'rateLimited' | 'notConfigured' | 'provider' | 'generic';

export function withdrawRefusal(err: unknown): WithdrawRefusal {
  switch (apiErrorCode(err)) {
    case WITHDRAWAL_UNAVAILABLE_CODE:
      return 'unavailable';
    case 'rate_limited':
      return 'rateLimited';
    case 'rail_not_configured':
      return 'notConfigured';
    case 'payment_provider_error':
      return 'provider';
    default:
      return 'generic';
  }
}

/**
 * After a withdrawal the plan ends at the payment provider first and on our
 * side when its notice arrives, a moment later. The page reads the plan again
 * at once and then after these delays, so the plan card catches up by itself.
 */
export const WITHDRAW_REREAD_DELAYS_MS: readonly number[] = [3000, 10_000];

export interface WithdrawContractProps {
  /**
   * The visitor's country when a server page already read it (`null` there:
   * the edge sent none). Used only to decide whether a FAILED check is worth
   * telling the visitor about; who may withdraw is the server's answer.
   */
  visitorCountry?: string | null;
  /** Clock (tests). */
  now?: () => Date;
}

export function WithdrawContract(props: WithdrawContractProps) {
  const brand = useBrand();
  // The mainland brand: one-time passes on rails without a refund call. Nothing is asked.
  if (brand.market !== 'intl') return null;
  return <WithdrawContractPanel {...props} />;
}

interface Withdrawn {
  id: string;
  planKey: string | null;
  kind: WithdrawalKind;
  refundMinor: number | null;
  currency: string | null;
}

function WithdrawContractPanel({ visitorCountry, now = () => new Date() }: WithdrawContractProps) {
  const t = useTranslations('credits');
  const format = useFormatter();
  const locale = useLocale();
  const brand = useBrand();
  const headingId = useId();
  /** The purchase whose confirmation step is open. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** The purchase whose quote is being read again before its step opens. */
  const [opening, setOpening] = useState<string | null>(null);
  /** That read failed for this purchase: said at its row; the entry asks again. */
  const [refreshFailed, setRefreshFailed] = useState<string | null>(null);
  const quote = useWithdrawalQuote({ refreshEveryMs: confirming ? WITHDRAWAL_OPEN_STEP_REFRESH_MS : null });
  const withdraw = useWithdraw();
  const plansQ = usePlans();
  const reread = useRereadBilling();
  const rereadRef = useRef(reread);
  rereadRef.current = reread;
  /** Withdrawals completed on this page: their confirmation stays after the quote is read again. */
  const [withdrawn, setWithdrawn] = useState<Withdrawn[]>([]);
  /** The server refused with "no longer available": said once, under the heading. */
  const [gone, setGone] = useState(false);
  /** The purchases it refused: not offered again on this page, whatever a later quote says. */
  const [refused, setRefused] = useState<string[]>([]);

  // The plan card catches up with the payment provider's notice (see the constant).
  const withdrawnCount = withdrawn.length;
  useEffect(() => {
    if (withdrawnCount === 0) return undefined;
    const timers = WITHDRAW_REREAD_DELAYS_MS.map((ms) => setTimeout(() => void rereadRef.current(), ms));
    return () => timers.forEach(clearTimeout);
  }, [withdrawnCount]);

  // Keyboard and screen-reader users follow the step: opening it moves focus to its title; closing it moves focus
  // back to the entry it was opened from, or to the section heading when that row is gone (the purchase was withdrawn).
  const sectionRef = useRef<HTMLElement | null>(null);
  const lastConfirming = useRef<string | null>(null);
  useEffect(() => {
    const root = sectionRef.current;
    const previous = lastConfirming.current;
    lastConfirming.current = confirming;
    if (!root || previous === confirming) return;
    if (confirming) {
      root.querySelector<HTMLElement>('[data-testid="withdraw-confirm"] h3')?.focus();
      return;
    }
    const row = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="withdraw-option"]')).find((el) => el.getAttribute('data-purchase') === previous);
    (row?.querySelector<HTMLElement>('button') ?? root.querySelector<HTMLElement>('h2'))?.focus();
  }, [confirming]);

  // A failed check is mentioned only where a right of withdrawal is plausible.
  const checkFailed = quote.isError && !quote.data;
  const { country } = useVisitorCountry(visitorCountry, plansExtras(plansQ.data).visitorCountry, { enabled: checkFailed && !!plansQ.data });
  const showCheckError = checkFailed && requiresWithdrawalWaiver(country);

  const closed = new Set([...withdrawn.map((w) => w.id), ...refused]);
  const options = openWithdrawals(quote.data, now()).filter((o) => !closed.has(o.purchase.id));

  // A quote read again while a step is open (the timer, the tab coming back, a billing action elsewhere) can say the
  // purchase is no longer open: the step then closes with the reason, instead of vanishing. Not while the withdrawal
  // itself is on its way (its own answer decides) or a read is still out.
  const stepLost = confirming !== null && !withdraw.isPending && !quote.isFetching && !options.some((o) => o.purchase.id === confirming);
  useEffect(() => {
    if (!stepLost) return;
    setConfirming(null);
    setGone(true);
  }, [stepLost]);

  if (options.length === 0 && withdrawn.length === 0 && !gone && !showCheckError) return null;

  const plans = plansQ.data?.plans;
  const planName = (planKey: string | null) => {
    const key = planNameKey(brand.id, planKey);
    return key ? t(key) : t('withdraw.unknownPlan');
  };
  const amount = (minor: number, currency: string) => chargedMoney(locale, minor, currency, brand.currency);
  const day = (iso: string | null) => {
    const d = parseDate(iso);
    return d ? format.dateTime(d, { dateStyle: 'medium' }) : null;
  };
  const moment = (iso: string) => {
    const d = parseDate(iso);
    return d ? format.dateTime(d, { dateStyle: 'medium', timeStyle: 'short' }) : iso;
  };
  const refusal = withdraw.isError ? withdrawRefusal(withdraw.error) : null;

  /**
   * Step one. A quote that is current opens the step at once. An older one is
   * read again first (the entry waits, disabled): the step then opens with
   * that answer, so the amount on "Withdraw and refund {amount}" is today's.
   */
  const onEntry = (purchaseId: string) => {
    withdraw.reset();
    setGone(false);
    setRefreshFailed(null);
    if (Date.now() - quote.dataUpdatedAt < WITHDRAWAL_STALE_MS) {
      setConfirming(purchaseId);
      return;
    }
    setOpening(purchaseId);
    void quote.refetch().then((res) => {
      setOpening(null);
      if (res.isError || !res.data) {
        setRefreshFailed(purchaseId);
        return;
      }
      // Open it with that answer. If the purchase is no longer in it, the rule above (`stepLost`) closes the step
      // at once with "can no longer be withdrawn" and moves focus to the heading.
      setConfirming(purchaseId);
    });
  };

  const onConfirm = (option: WithdrawalOption) => {
    const kind = withdrawalKind(option.purchase.planKey, plans);
    withdraw.mutate(
      { purchaseId: option.purchase.id },
      {
        onSuccess: (res) => {
          setConfirming(null);
          setGone(false);
          setWithdrawn((list) => [...list, { id: option.purchase.id, planKey: option.purchase.planKey, kind, refundMinor: res.refundMinor, currency: res.currency }]);
        },
        onError: (err) => {
          if (withdrawRefusal(err) !== 'unavailable') return;
          // The page was behind the server: the hook reads the quote again; the step closes.
          setConfirming(null);
          setGone(true);
          setRefused((ids) => [...ids, option.purchase.id]);
        },
      },
    );
  };

  return (
    <section className={styles.card} aria-labelledby={headingId} data-testid="withdraw-contract" ref={sectionRef}>
      <h2 className={styles.h2} id={headingId} tabIndex={-1}>
        {t('withdraw.label')}
      </h2>

      {withdrawn.map((w) => (
        <div key={w.id} className={`${styles.notice} ${styles.ok}`} role="status" data-testid="withdraw-done">
          <p className={styles.body}>
            {w.refundMinor !== null && w.currency
              ? t('withdraw.done', { plan: planName(w.planKey), amount: amount(w.refundMinor, w.currency) })
              : t('withdraw.doneNoAmount', { plan: planName(w.planKey) })}
          </p>
          <p className={styles.body}>{t(`withdraw.ended.${w.kind}`)}</p>
        </div>
      ))}

      {gone ? (
        <p className={styles.error} role="alert" data-testid="withdraw-gone">
          {t('withdraw.errors.unavailable')}
        </p>
      ) : null}

      {showCheckError ? (
        <div className={styles.stack} data-testid="withdraw-check-error">
          <p className={styles.body}>{t('withdraw.checkError')}</p>
          <div className={styles.actions}>
            <Btn disabled={quote.isFetching} onClick={() => void quote.refetch()}>
              {t('retry')}
            </Btn>
          </div>
        </div>
      ) : null}

      {options.length > 0 ? <p className={styles.muted}>{t('withdraw.intro', { count: options.length })}</p> : null}

      {options.map((option) => {
        const { purchase, quote: q } = option;
        const name = planName(purchase.planKey);
        const refund = amount(q.refundMinor, q.currency);
        const paidOn = day(purchase.chargedAt);
        const paid = amount(purchase.amountMinor, purchase.currency);
        const kind = withdrawalKind(purchase.planKey, plans);
        const open = confirming === purchase.id;
        const titleId = `${headingId}-${purchase.id}`;

        if (open) {
          return (
            <div key={purchase.id} className={styles.notice} role="group" aria-labelledby={titleId} data-testid="withdraw-confirm" data-purchase={purchase.id}>
              <h3 className={styles.h3} id={titleId} tabIndex={-1}>
                {t('withdraw.confirmTitle', { plan: name })}
              </h3>
              <p className={styles.body}>{t('withdraw.confirmRefund', { amount: refund })}</p>
              {q.prorata ? (
                <p className={styles.body} data-testid="withdraw-prorata">
                  {t('withdraw.prorata', { unused: q.prorata.periodDays - q.prorata.usedDays, periodDays: q.prorata.periodDays })}
                </p>
              ) : null}
              <p className={styles.body}>{t('withdraw.lastDay', { date: moment(q.deadline) })}</p>
              <p className={styles.body}>{t(`withdraw.ends.${kind}`)}</p>
              {refusal && refusal !== 'unavailable' ? (
                <p className={styles.error} role="alert">
                  {t(`withdraw.errors.${refusal}`)}
                </p>
              ) : null}
              <div className={styles.actions}>
                <Btn variant="primary" disabled={withdraw.isPending} aria-busy={withdraw.isPending || undefined} onClick={() => onConfirm(option)}>
                  {withdraw.isPending ? t('withdraw.pending') : t('withdraw.confirmButton', { amount: refund })}
                </Btn>
                <Btn
                  disabled={withdraw.isPending}
                  onClick={() => {
                    withdraw.reset();
                    setConfirming(null);
                  }}
                >
                  {t('withdraw.back')}
                </Btn>
              </div>
            </div>
          );
        }

        return (
          <div key={purchase.id} className={styles.stack} style={{ gap: 'var(--sp-1)' }} data-testid="withdraw-option" data-purchase={purchase.id}>
            <h3 className={styles.h3}>{name}</h3>
            <p className={styles.body}>{paidOn ? t('withdraw.paid', { amount: paid, date: paidOn }) : t('withdraw.paidNoDate', { amount: paid })}</p>
            <p className={styles.body}>{t('withdraw.refund', { amount: refund })}</p>
            <p className={styles.body}>{t('withdraw.lastDay', { date: moment(q.deadline) })}</p>
            {refreshFailed === purchase.id ? (
              <p className={styles.error} role="alert" data-testid="withdraw-refresh-error">
                {t('withdraw.refreshError')}
              </p>
            ) : null}
            <div className={styles.actions}>
              <Btn
                disabled={withdraw.isPending || opening !== null}
                aria-busy={opening === purchase.id || undefined}
                // The visible label stays the counsel-approved wording; the accessible name adds which purchase.
                aria-label={options.length > 1 ? t('withdraw.entryLabel', { label: t('withdraw.label'), plan: name }) : undefined}
                onClick={() => onEntry(purchase.id)}
              >
                {t('withdraw.label')}
              </Btn>
              {opening === purchase.id ? (
                <span className={styles.muted} role="status" data-testid="withdraw-refreshing">
                  {t('withdraw.refreshing')}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}

export default WithdrawContract;
