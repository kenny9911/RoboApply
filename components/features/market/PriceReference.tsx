'use client';

// PriceReference — the Taiwan reference line under a USD price:
// "約 NT$X（依 {source} {asOf} 匯率估算，實際金額以發卡銀行為準）"
// (TASK_PLAN.md R-25, WP-21b; CN_TW_LAUNCH_PLAN.md §4 billing).
//
// STUB (FND-6b). Owner: WP-21b. Renders nothing. When filled it renders only
// for zh-TW or a Taiwan visitor, only when the stored `fx.reference` rate is
// 45 days old or less, and nothing otherwise (never a guessed rate).

export interface PriceReferenceProps {
  /** The price in minor units of `currency` (cents). */
  amountMinor: number;
  currency: 'USD';
}

export function PriceReference(_props: PriceReferenceProps): null {
  return null;
}

export default PriceReference;
