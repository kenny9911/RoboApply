'use client';

// CnRenewButton — "续费" for a GoApply pass (PRODUCT F-BILL-03 cn: passes do
// not renew; the user buys the same pass again and the new days start when
// the current ones end — fulfilPass extends from the live end date). WP-21a's
// sweep sends the reminder 3 days before a 30/90-day pass ends; this is the
// button the reminder and the billing page point to.
//
// Renders nothing unless WeChat Pay can take the payment now and the pass is
// on sale (no UI entry when off, R-04). Never renews by itself.

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import type { CnOrderStatus } from '../../../lib/api/contracts/billing-cn';
import { WechatPaySheet } from './WechatPaySheet';
import { planNameKey } from './WechatPayCheckout';
import { sellableCnPlan, useWechatPayAvailable } from './useWechatPay';
import styles from './billingCn.module.css';

export interface CnRenewButtonProps {
  /** The pass the user holds (`pro_week_pass` | `pro_monthly` | `pro_quarterly`). */
  planKey: string;
  /** When the current access ends (ISO), if known. */
  accessUntil?: string | null;
  onPaid?: (order: CnOrderStatus) => void;
  navigate?: (url: string) => void;
  userAgent?: string;
}

export function CnRenewButton({ planKey, accessUntil, onPaid, navigate, userAgent }: CnRenewButtonProps) {
  const t = useTranslations('billingCn');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const { available, plans } = useWechatPayAvailable();
  const plan = sellableCnPlan(plans, planKey);
  if (!available || !plan || plan.kind !== 'pass') return null;

  const until = accessUntil ? new Date(accessUntil) : null;
  const live = until && !Number.isNaN(until.getTime()) && until.getTime() > Date.now() ? until : null;
  const description = live
    ? t('renew.description', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(live) })
    : t('renew.descriptionNoDate');

  return (
    <>
      <Btn variant="primary" className={styles.touch} onClick={() => setOpen(true)}>
        {t('renew.button')}
      </Btn>
      <WechatPaySheet
        open={open}
        onClose={() => setOpen(false)}
        planKey={planKey}
        title={t('renew.title', { plan: t(planNameKey(planKey)) })}
        description={description}
        onPaid={onPaid}
        navigate={navigate}
        userAgent={userAgent}
      />
    </>
  );
}
