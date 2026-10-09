'use client';

// SwitchQuoteSheet — a legacy practice-plan subscriber switching to Pro sees
// the quote first: amount charged today (Stripe proration), the new renewal
// price and the next renewal date. Nothing is charged until Confirm
// (PRODUCT_PLAN.md §6.3 "Folding in the existing mock-interview plans";
// F-BILL-03; TASK_PLAN.md WP-21a "legacy switch never charges without
// confirm"). Every number on the sheet comes from the server quote.

import { useEffect } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { Sheet } from '../../v3/primitives/Sheet';
import { useBrand } from '../../../lib/brand/BrandProvider';
import type { CatalogPlan } from '../../../lib/api/credits';
import { useConfirmSwitch, useSwitchQuote } from '../../../hooks/credits/useBillingActions';
import { money, parseDate, planNameKey, pricePeriod } from './labels';
import styles from './credits.module.css';

export interface SwitchQuoteSheetProps {
  plan: CatalogPlan;
  /** The renewal acknowledgement the user ticked on the plan sheet. */
  autoRenewAck: boolean;
  withdrawalWaiver?: boolean;
  onClose: () => void;
}

export function SwitchQuoteSheet({ plan, autoRenewAck, withdrawalWaiver, onClose }: SwitchQuoteSheetProps) {
  const t = useTranslations('credits.quote');
  const tc = useTranslations('credits');
  const locale = useLocale();
  const format = useFormatter();
  const brand = useBrand();
  const quote = useSwitchQuote();
  const confirm = useConfirmSwitch();
  const { mutate: requestQuote } = quote;

  useEffect(() => {
    requestQuote({ planKey: plan.key });
  }, [plan.key, requestQuote]);

  const nameKey = planNameKey(brand.id, plan.key);
  const name = nameKey ? tc(nameKey) : plan.defaultLabel;
  const q = quote.data;
  const renewal = parseDate(q?.nextRenewalAt);
  const renewalDate = renewal ? format.dateTime(renewal, { dateStyle: 'medium' }) : '—';
  const done = confirm.data;
  const doneDate = parseDate(done?.nextRenewalAt);

  return (
    <Sheet open onClose={onClose} title={t('title', { plan: name })}>
      <div className={styles.stack}>
        {quote.isPending ? <p className={styles.muted} aria-busy="true">{t('loading')}</p> : null}
        {quote.isError ? (
          <p className={styles.error} role="alert">
            {t('error')}
          </p>
        ) : null}
        {q && !done ? (
          <>
            <ul className={styles.list} data-testid="switch-quote">
              <li className={styles.row}>
                <span className={styles.rowLabel}>{t('today')}</span>
                <span className={styles.rowValue}>{money(locale, q.amountDueTodayMinor, q.currency)}</span>
              </li>
              <li className={styles.row}>
                <span className={styles.rowLabel}>{t('renewalPrice')}</span>
                <span className={styles.rowValue}>
                  {tc(`price.${pricePeriod(plan)}`, { price: money(locale, q.renewalAmountMinor, q.currency) })}
                </span>
              </li>
              <li className={styles.row}>
                <span className={styles.rowLabel}>{t('nextRenewal')}</span>
                <span className={styles.rowValue}>{renewalDate}</span>
              </li>
            </ul>
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
