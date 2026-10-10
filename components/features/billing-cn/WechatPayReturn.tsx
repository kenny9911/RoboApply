'use client';

// WechatPayReturn — where WeChat Pay H5 sends the buyer back (WP-62; the
// rail's `redirect_url` is /settings/billing/return?plan=…&order=<our order
// number>). WeChat returns the buyer whether or not they paid, so this asks
// the server about that one order and keeps asking while it is pending
// (`getWechatPayOrder`, every 3 s, until the payment window is over). It says
// "paid" only when the server does. `onStatus` tells the page what the order
// is now, so its heading never keeps saying "checking" over a final answer.
//
// Renders nothing off GoApply or when WeChat Pay is not available (no UI
// entry, R-04); the caller then shows its ordinary return page.

import { useEffect, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import type { CnOrderStatus } from '../../../lib/api/contracts/billing-cn';
import { BILLING_PATH, HELP_PATH } from './WechatPayCheckout';
import { useWechatPayAvailable, useWechatPayOrder } from './useWechatPay';
import styles from './billingCn.module.css';

/** Our WeChat Pay order numbers (`GAWX…`, ≤32 chars of [0-9A-Za-z_-|*]). */
export function isOrderNumber(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9A-Za-z_\-|*]{6,64}$/.test(value);
}

/** What the order is now: the server's status, `checking` before the first answer, `error` when the status call failed. */
export type WechatPayReturnState = CnOrderStatus['status'] | 'checking' | 'error';

export interface WechatPayReturnProps {
  /** `?order=` from the return URL. */
  orderId: string | null;
  /** Called once when the server reports the order paid. */
  onPaid?: (order: CnOrderStatus) => void;
  /** Called whenever the shown state changes (the page picks its heading from it). */
  onStatus?: (state: WechatPayReturnState) => void;
}

export function WechatPayReturn({ orderId, onPaid, onStatus }: WechatPayReturnProps) {
  const t = useTranslations('billingCn');
  const locale = useLocale();
  const { available, loading } = useWechatPayAvailable();
  const id = isOrderNumber(orderId) ? orderId : null;
  const status = useWechatPayOrder(available ? id : null);
  const order = status.data ?? null;

  const paidOrder = order?.status === 'paid' ? order : null;
  useEffect(() => {
    if (paidOrder) onPaid?.(paidOrder);
    // Fire once per paid order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paidOrder?.orderId]);

  const shown = !loading && available && id !== null;
  const state = order?.status ?? null;
  const reported: WechatPayReturnState = status.isError ? 'error' : (state ?? 'checking');
  useEffect(() => {
    if (shown) onStatus?.(reported);
    // Fire once per change of state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, reported]);

  if (!shown) return null;

  let message: ReactNode;
  if (status.isError) {
    message = t('qr.checkFailed');
  } else if (!order || state === 'pending') {
    message = t('return.checking');
  } else if (state === 'paid') {
    const until = order.accessUntil ? new Date(order.accessUntil) : null;
    message =
      order.purpose === 'interview_pack'
        ? t('status.paidPack')
        : until && !Number.isNaN(until.getTime())
          ? t('status.paidPass', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(until) })
          : t('status.paidPassNoDate');
  } else if (state === 'needs_support') {
    message = t.rich('status.needsSupport', {
      help: (chunks) => (
        <a href={HELP_PATH} className={styles.link}>
          {chunks}
        </a>
      ),
    });
  } else if (state === 'closed') {
    // The buyer came back from WeChat without paying: there was no code to expire.
    message = t('return.notPaid');
  } else {
    message = t(`status.${state}`);
  }

  const waiting = !status.isError && (!order || state === 'pending');
  return (
    <div className={styles.stack} data-testid="wechatpay-return" data-state={reported}>
      <p className={state === 'paid' ? styles.success : styles.notice} role={status.isError ? 'alert' : 'status'} aria-busy={waiting || undefined}>
        {message}
      </p>
      <div className={styles.actions}>
        {status.isError ? (
          <Btn variant="primary" disabled={status.isFetching} onClick={() => void status.refetch()}>
            {t('qr.checkAgain')}
          </Btn>
        ) : null}
        <Btn as="a" href={BILLING_PATH} variant={status.isError ? 'default' : 'primary'}>
          {t('status.viewBilling')}
        </Btn>
      </div>
    </div>
  );
}

export default WechatPayReturn;
