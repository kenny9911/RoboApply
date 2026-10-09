'use client';

// components/features/brand/WrongBrandNudge.tsx — STUB (FND-2b; WP-12 fills it).
//
// The wrong-market nudge (ARCHITECTURE.md §1.3, PRODUCT_PLAN.md §2, TW-01):
// a dismissible banner that offers the other brand. It replaces geo-routing.
//   - RoboApply + country CN (+ locale zh) → offer GoApply.
//   - GoApply + country TW/HK/MO/non-CN, or locale zh-TW → offer RoboApply.
// Rules WP-12 must keep: never redirect, never change currency or payment
// rail, one dismissal sticks, and it goes through lib/ui/popupGate.ts only if
// it ever becomes a modal (it should stay an inline banner).
//
// Mounted once by app/layout.tsx inside <Providers>. Brand comes from
// useBrand() (lib/brand); the server passes what only it can read.

export interface WrongBrandNudgeProps {
  /** Visitor country from the edge headers (uppercase ISO-3166 alpha-2), or null. */
  country: string | null;
  /** The resolved UI locale of this request. */
  locale: string;
}

export function WrongBrandNudge(_props: WrongBrandNudgeProps): null {
  return null;
}

export default WrongBrandNudge;
