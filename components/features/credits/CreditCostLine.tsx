'use client';

// CreditCostLine — the pre-spend line under every credit-using button:
// "Uses 1 of your 2 left today" (PRODUCT_PLAN.md §6.1, F-BILL-01;
// ARCHITECTURE.md §7.3 "Pre-spend notice"). Reads `/credits` through the
// shared summary cache (hooks/shared/useCredits); the client never computes
// caps. Unknown renders "Credits left: —". "See Pro" shows only when the
// server says a sellable plan raises the cap.
//
//   <CreditCostLine bucket="tailor" />

import { useRouter } from 'next/navigation';

import { CreditNotice } from '../../v3/primitives/CreditNotice';
import { bucketSummary, useCredits } from '../../../hooks/shared/useCredits';

export const BILLING_PLANS_HREF = '/settings/billing#plans';

export interface CreditCostLineProps {
  /** Credit bucket (`tailor`, `fit_analysis`, `cover_letter`, …). */
  bucket: string;
  /** Credits the action uses (default 1). */
  cost?: number;
  className?: string;
}

export function CreditCostLine({ bucket, cost = 1, className }: CreditCostLineProps) {
  const router = useRouter();
  const { data } = useCredits();
  const summary = bucketSummary(data?.summary, bucket);
  return (
    <CreditNotice
      bucket={summary}
      cost={cost}
      upgradable={data?.summary.upgradable === true}
      onUpgrade={() => router.push(BILLING_PLANS_HREF)}
      className={className}
    />
  );
}

export default CreditCostLine;
