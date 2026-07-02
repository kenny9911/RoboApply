// components/v3/account/format.ts
//
// Shared money / credit formatting used by the billing surfaces (billing.tsx
// CurrentPlanCard + planCatalog.tsx PlanCard). Lifted out of the two former
// copies (billing.tsx + the old choose-plan/page.tsx inline helpers) so the
// pricing format is defined exactly once.
//
// VALUE framing: the only $/¥ shown is the user's OWN price — never cost/margin.

/** Format minor units (cents / fen) into the region currency for `locale`. */
export function money(locale: string, amountMinor: number, currency: string): string {
  const amount = amountMinor / 100;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: (currency || 'USD').toUpperCase(),
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency === 'CNY' ? '¥' : '$'}${amount}`;
  }
}

/** Trim float dust from a credit count (e.g. 10 → "10", 1.5 → "1.5"). */
export function fmtCredits(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}
