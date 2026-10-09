// roboapply/lib/serverLocale.ts
//
// Server-side locale resolution, shared by app/layout.tsx and the landing
// pages' generateMetadata. Every candidate is clamped to the current brand's
// locales (RoboApply: all nine; GoApply: zh + en) — ARCHITECTURE.md §1.5.
// Priority:
//
//   1. URL path locale — `/es`, `/zh-TW`, … The proxy forwards the pathname
//      as `x-pathname` (headers() can't see the URL otherwise), so localized
//      landing routes render with the matching <html lang> + message bundle
//      regardless of the visitor's cookie. This is what makes /{locale}
//      pages stable, indexable documents for hreflang. (A locale the brand
//      does not serve never gets here: the proxy redirects it first.)
//   2. `robo_locale` cookie — the user's explicit choice: set by the language
//      switchers, and by opening a localized landing URL (RememberLocale).
//   3. Accept-Language — first tag the brand serves wins (script-aware zh).
//   4. The brand's default locale (`en` on RoboApply, `zh` on GoApply).

import { cookies, headers } from 'next/headers';

import type { ProductBrand } from './brand/registry.generated';
import { getServerBrand } from './server/brand';
import {
  LOCALE_COOKIE,
  isLocale,
  isLocaleIn,
  matchLocale,
  type RoboLocale,
} from './localeConfig';

/** Extract a locale from a pathname like `/es` or `/zh-TW/anything`. */
export function pathnameLocale(pathname: string | null): RoboLocale | null {
  if (!pathname) return null;
  const seg = pathname.split('/').filter(Boolean)[0];
  return isLocale(seg) ? seg : null;
}

/** The locales and default a resolution is clamped to. */
export type LocaleScope = Pick<ProductBrand, 'locales' | 'defaultLocale'>;

/** Pure core of resolveLocale (exported for tests). */
export function pickLocale(
  input: { pathname: string | null; cookieLocale: string | null | undefined; acceptLanguage: string | null },
  scope: LocaleScope,
): RoboLocale {
  const fromPath = pathnameLocale(input.pathname);
  if (fromPath && isLocaleIn(fromPath, scope.locales)) return fromPath;

  if (isLocaleIn(input.cookieLocale, scope.locales)) return input.cookieLocale;

  const tags = (input.acceptLanguage ?? '').split(',').map((t) => t.split(';')[0]!.trim());
  const matched = matchLocale(tags, scope.locales);
  if (matched) return matched;

  return scope.defaultLocale;
}

/**
 * The locale for this request. Pass `brand` when the caller already has it
 * (saves a second header read); otherwise the current request's brand is used.
 */
export async function resolveLocale(brand?: LocaleScope): Promise<RoboLocale> {
  const scope = brand ?? (await getServerBrand());
  try {
    const headersList = await headers();
    let cookieLocale: string | undefined;
    try {
      cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
    } catch {
      cookieLocale = undefined;
    }
    return pickLocale(
      {
        pathname: headersList.get('x-pathname'),
        cookieLocale,
        acceptLanguage: headersList.get('accept-language'),
      },
      scope,
    );
  } catch {
    /* prerender context — fall through */
  }
  return scope.defaultLocale;
}
