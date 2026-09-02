// components/v3/account/format.ts
//
// Shared money / credit formatting used by the billing surfaces (billing.tsx
// CurrentPlanCard, planCatalog.tsx PlanCard, billingHistory.tsx). Lifted out
// of the former per-file copies so the pricing format is defined exactly
// once — and money() is now the same formatter the public landing page uses
// (lib/pricing.ts), so a price reads identically before and after sign-in.
//
// VALUE framing: the only $/¥ shown is the user's OWN price — never cost/margin.

import { formatMoney } from '../../../lib/pricing';

/** Format minor units (cents / fen) into `currency` for `locale`. */
export const money = formatMoney;

/** Trim float dust from a credit count (e.g. 10 → "10", 1.5 → "1.5"). */
export function fmtCredits(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}
