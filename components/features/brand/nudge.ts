// components/features/brand/nudge.ts — when to offer the other brand
// (ARCHITECTURE.md §1.3, CN_TW_LAUNCH_PLAN.md §2.4, TASK_PLAN.md WP-12, TW-01).
//
// Pure: no React, no storage, no network. The banner (WrongBrandNudge.tsx)
// feeds it what the request and the browser say and renders its answer.
//
//   RoboApply  + visitor country CN, no zh-TW signal     → offer GoApply
//   GoApply    + locale zh-TW (shown, cookie or browser)  → offer RoboApply in 繁體中文
//   GoApply    + visitor country TW / HK / MO            → offer RoboApply in 繁體中文
//   GoApply    + any other known country outside CN      → offer RoboApply
//
// Never a redirect: the answer is a link the visitor may follow. It never
// changes the currency, the payment rail or the locale of this site.

import { clampLocale, localePath, type RoboLocale } from '../../../lib/localeConfig';
import { getBrand, type BrandId } from '../../../lib/brand';

/** Regions whose readers use Traditional Chinese and are served by RoboApply (TW-01). */
export const TRADITIONAL_REGIONS: readonly string[] = ['TW', 'HK', 'MO'];

/**
 * The locale a redirect dropped. GoApply's proxy clamps `/zh-TW/*` to `/zh/*`
 * (ARCHITECTURE.md §1.5 step 3) and the page must still show the RoboApply
 * nudge, so the redirect carries the dropped locale in this short-lived cookie
 * (or, equivalently, this query parameter). The banner reads either one as a
 * locale signal. Setting it is the proxy owner's job (WP-12 handoff request).
 */
export const CLAMPED_FROM_COOKIE = 'ra_clamped_from';
export const CLAMPED_FROM_QUERY = 'from_locale';

/** True when any locale signal asks for Traditional Chinese. */
export function hasTraditionalSignal(signals: readonly (string | null | undefined)[]): boolean {
  return signals.some((l) => typeof l === 'string' && l.trim().toLowerCase() === 'zh-tw');
}

/** UI-state dismissal key (RAUserUiState.dismissals) for one brand's nudge. */
export function nudgeDismissKey(brandId: BrandId): string {
  return `brand.wrong_brand_nudge.${brandId}`;
}

/** localStorage key that remembers the dismissal for visitors without an account. */
export function nudgeStorageKey(brandId: BrandId): string {
  return `ra_wrong_brand_nudge_dismissed:${brandId}`;
}

export type NudgeReason = 'country_cn' | 'region_traditional' | 'locale_zh_tw' | 'country_outside_cn';

export interface NudgeInput {
  brand: {
    id: BrandId;
    otherBrand: { id: BrandId; name: string; canonicalOrigin: string };
  };
  /** Visitor country from the edge (ISO-3166 alpha-2), or null. */
  country: string | null | undefined;
  /** The locale this page renders in. */
  locale: string | null | undefined;
  /**
   * Other locale signals from the browser: the `robo_locale` cookie (an
   * explicit earlier choice, which GoApply clamps away from zh-TW) and the
   * visitor's first matching Accept-Language preference.
   */
  preferredLocales?: readonly (string | null | undefined)[];
}

export interface NudgeDecision {
  reason: NudgeReason;
  /** The brand offered. */
  target: { id: BrandId; name: string };
  /** Locale the link opens the other brand in. */
  targetLocale: RoboLocale;
  /** Absolute URL on the other brand's canonical origin. */
  href: string;
}

/** Uppercase ISO alpha-2, or null for anything else (unknown, 'XX', Tor 'T1'). */
export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX' || c === 'ZZ') return null;
  return c;
}

/** The other brand's URL for a locale (its own default locale when it does not serve that one). */
function linkTo(otherId: BrandId, origin: string, wanted: string | null | undefined): { targetLocale: RoboLocale; href: string } {
  const other = getBrand(otherId);
  const targetLocale = clampLocale(wanted, other.locales, other.defaultLocale);
  return { targetLocale, href: `${origin.replace(/\/+$/, '')}${localePath(targetLocale, other.defaultLocale)}` };
}

/** Decide whether to offer the other brand; null = show nothing. */
export function decideWrongBrandNudge(input: NudgeInput): NudgeDecision | null {
  const { brand } = input;
  const country = normalizeCountry(input.country);
  const other = brand.otherBrand;
  const target = { id: other.id, name: other.name };
  const signals = [input.locale, ...(input.preferredLocales ?? [])];
  const wantsTraditional = hasTraditionalSignal(signals);

  if (brand.id === 'roboapply') {
    if (country !== 'CN') return null;
    // A 繁體中文 reader in the mainland (a Taiwanese visitor travelling, say)
    // belongs here: GoApply has no Traditional Chinese (L-9, CN §2.4).
    if (wantsTraditional) return null;
    return { reason: 'country_cn', target, ...linkTo(other.id, other.canonicalOrigin, 'zh') };
  }

  // GoApply serves mainland China; everyone else belongs on RoboApply.
  const toTraditional = (reason: NudgeReason): NudgeDecision => ({
    reason,
    target,
    ...linkTo(other.id, other.canonicalOrigin, 'zh-TW'),
  });

  if (country && TRADITIONAL_REGIONS.includes(country)) return toTraditional('region_traditional');
  if (wantsTraditional) return toTraditional('locale_zh_tw');
  if (country && country !== 'CN') {
    return { reason: 'country_outside_cn', target, ...linkTo(other.id, other.canonicalOrigin, input.locale) };
  }
  return null;
}
