// components/v3/account/format.ts
//
// Money / credit formatting for the invoice list (billingHistory.tsx).
// money() is the same formatter the public pricing page uses (lib/pricing.ts),
// so a price reads identically before and after sign-in.
//
// VALUE framing: the only $/¥ shown is the user's OWN price — never cost/margin.

import { formatMoney } from '../../../lib/pricing';

/** Format minor units (cents / fen) into `currency` for `locale`. */
export const money = formatMoney;

/** Trim float dust from a credit count (e.g. 10 → "10", 1.5 → "1.5"). */
export function fmtCredits(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * True for the generated address of an account that has no email: GoApply
 * phone and WeChat sign-ups get `u-<random>@users.goapply.invalid` (server:
 * features/auth-cn/accounts.ts, same rule). `.invalid` is a reserved top-level
 * domain, so no real address ends with it. Such an address is never shown and
 * the user is never asked to type it.
 *
 * Interim: the web reads it off the address until /auth/me carries
 * `emailIsPlaceholder` (request to INT-01).
 */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.trim().toLowerCase().endsWith('.invalid');
}
