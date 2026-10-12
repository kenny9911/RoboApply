'use client';

// WechatPaySheet — the WeChat Pay checkout in a bottom sheet (WP-62). The
// plan sheet (WP-21b) opens it for GoApply when `checkout.rails` includes
// 'wechatpay'; the 续费 button opens it for the pass the user holds.

import { useTranslations } from 'next-intl';

import { Sheet } from '../../v3/primitives/Sheet';
import type { CnOrderStatus } from '../../../lib/api/contracts/billing-cn';
import { WechatPayCheckout, planNameKey } from './WechatPayCheckout';

export interface WechatPaySheetProps {
  open: boolean;
  onClose: () => void;
  planKey: string;
  /** Sheet title (default: the plan name). */
  title?: string;
  description?: string;
  onPaid?: (order: CnOrderStatus) => void;
  navigate?: (url: string) => void;
  userAgent?: string;
}

export function WechatPaySheet({ open, onClose, planKey, title, description, onPaid, navigate, userAgent }: WechatPaySheetProps) {
  const t = useTranslations('billingCn');
  return (
    <Sheet open={open} onClose={onClose} title={title ?? t(planNameKey(planKey))} description={description}>
      {open ? <WechatPayCheckout planKey={planKey} onPaid={onPaid} onCancel={onClose} navigate={navigate} userAgent={userAgent} /> : null}
    </Sheet>
  );
}
