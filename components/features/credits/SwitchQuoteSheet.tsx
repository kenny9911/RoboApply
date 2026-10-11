'use client';

// SwitchQuoteSheet — every change of subscription happens here, with a quote
// first: a legacy practice-plan subscriber moving to Pro, and a Pro
// subscriber moving between weekly, monthly and quarterly (PRODUCT_PLAN.md
// §6.3; F-BILL-03; MARKET_STRATEGY §4.4 "Plan change", §5.1 "Switch", M-16).
//
//   - The quote shows the amount charged today (the payment provider's
//     proration), the new renewal price and the next renewal date. Every
//     number on the sheet comes from the server quote.
//   - The new terms need a new acknowledgement: an UNTICKED box with the same
//     sentence as checkout, naming the new period and the renewal price OF
//     THE QUOTE (what the server records and charges; it can differ from the
//     catalog price shown on the plan sheet, e.g. for a subscription charged
//     in another currency). Confirm stays disabled until it is ticked.
//     Nothing is charged until Confirm.
//   - When the bank wants the buyer to confirm the payment (the server
//     answers `requires_action`), the plan has NOT changed: the sheet says so
//     and links to the payment provider's page for that invoice, in the same
//     tab. Without such a page it offers Manage payment. The "you're on
//     {plan}" state is never shown for that answer.

import { useEffect, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { Sheet } from '../../v3/primitives/Sheet';
import { useBrand } from '../../../lib/brand/BrandProvider';
import type { CatalogPlan } from '../../../lib/api/credits';
import { useConfirmSwitch, usePaymentPortal, useSwitchQuote } from '../../../hooks/credits/useBillingActions';
import { money, parseDate, planNameKey, pricePeriod } from './labels';
import styles from './credits.module.css';

export interface SwitchQuoteSheetProps {
  plan: CatalogPlan;
  withdrawalWaiver?: boolean;
  onClose: () => void;
  /** Browser navigation for the Manage payment fallback (tests inject it). */
  navigate?: (url: string) => void;
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

export function SwitchQuoteSheet({ plan, withdrawalWaiver, onClose, navigate = defaultNavigate }: SwitchQuoteSheetProps) {
  const t = useTranslations('credits.quote');
  const tc = useTranslations('credits');
  const locale = useLocale();
  const format = useFormatter();
  const brand = useBrand();
  const quote = useSwitchQuote();
  const confirm = useConfirmSwitch();
  const portal = usePaymentPortal();
  const { mutate: requestQuote } = quote;
  // The acknowledgement of the NEW terms: unticked for every quote.
  const [autoRenewAck, setAutoRenewAck] = useState(false);

  useEffect(() => {
    setAutoRenewAck(false);
    requestQuote({ planKey: plan.key });
  }, [plan.key, requestQuote]);

  const nameKey = planNameKey(brand.id, plan.key);
  const name = nameKey ? tc(nameKey) : plan.defaultLabel;
  const q = quote.data;
  const renewal = parseDate(q?.nextRenewalAt);
  const renewalDate = renewal ? format.dateTime(renewal, { dateStyle: 'medium' }) : '—';
  const answer = confirm.data;
  const done = answer?.status === 'switched' ? answer : null;
  const needsBank = answer?.status === 'requires_action' ? answer : null;
  const doneDate = parseDate(done?.nextRenewalAt);
  const period = pricePeriod(plan);

  return (
    <Sheet open onClose={onClose} title={t('title', { plan: name })}>
      <div className={styles.stack}>
        {quote.isPending ? <p className={styles.muted} aria-busy="true">{t('loading')}</p> : null}
        {quote.isError ? (
          <p className={styles.error} role="alert">
            {t('error')}
          </p>
        ) : null}
        {q && !answer ? (
          <>
            <ul className={styles.list} data-testid="switch-quote">
              <li className={styles.row}>
                <span className={styles.rowLabel}>{t('today')}</span>
                <span className={styles.rowValue}>{money(locale, q.amountDueTodayMinor, q.currency)}</span>
              </li>
              <li className={styles.row}>
                <span className={styles.rowLabel}>{t('renewalPrice')}</span>
                <span className={styles.rowValue}>
                  {tc(`price.${period}`, { price: money(locale, q.renewalAmountMinor, q.currency) })}
                </span>
              </li>
              <li className={styles.row}>
                <span className={styles.rowLabel}>{t('nextRenewal')}</span>
                <span className={styles.rowValue}>{renewalDate}</span>
              </li>
            </ul>
            <label className={styles.check}>
              <input type="checkbox" checked={autoRenewAck} onChange={(e) => setAutoRenewAck(e.target.checked)} />
              <span>{tc('planSheet.autoRenewAck', { period, price: money(locale, q.renewalAmountMinor, q.currency) })}</span>
            </label>
            <p className={styles.muted}>{t('note')}</p>
            {confirm.isError ? (
              <p className={styles.error} role="alert">
                {t('confirmError')}
              </p>
            ) : null}
            <div className={styles.actions}>
              <Btn
                variant="primary"
                disabled={confirm.isPending || !autoRenewAck}
                onClick={() => confirm.mutate({ quoteId: q.quoteId, autoRenewAck, withdrawalWaiver })}
              >
                {t('confirm', { price: money(locale, q.amountDueTodayMinor, q.currency) })}
              </Btn>
              <Btn onClick={onClose}>{t('notNow')}</Btn>
            </div>
          </>
        ) : null}
        {needsBank ? (
          <div className={styles.notice} role="status" data-testid="switch-requires-action">
            <p className={styles.body}>{t('requiresAction')}</p>
            {portal.isError ? <p className={styles.error}>{tc('paymentFailed.portalError')}</p> : null}
            <div className={styles.actions}>
              {needsBank.hostedInvoiceUrl ? (
                // The payment provider's own page for this invoice, in this tab.
                <Btn as="a" variant="primary" href={needsBank.hostedInvoiceUrl} rel="noopener">
                  {t('requiresActionCta')}
                </Btn>
              ) : (
                <Btn variant="primary" disabled={portal.isPending} onClick={() => portal.mutate(undefined, { onSuccess: (r) => navigate(r.url) })}>
                  {tc('current.manage')}
                </Btn>
              )}
              <Btn onClick={onClose}>{t('close')}</Btn>
            </div>
          </div>
        ) : null}
        {done ? (
          <div className={`${styles.notice} ${styles.ok}`} role="status">
            <p className={styles.body}>
              {doneDate ? t('done', { plan: name, date: format.dateTime(doneDate, { dateStyle: 'medium' }) }) : t('doneNoDate', { plan: name })}
            </p>
            <div className={styles.actions}>
              <Btn onClick={onClose}>{t('close')}</Btn>
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

export default SwitchQuoteSheet;
