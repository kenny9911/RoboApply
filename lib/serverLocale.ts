// roboapply/lib/serverLocale.ts
//
// Server-side locale resolution, shared by app/layout.tsx and the landing
// pages' generateMetadata. Priority:
//
//   1. URL path locale — `/es`, `/zh-TW`, … The proxy forwards the pathname
//      as `x-pathname` (headers() can't see the URL otherwise), so localized
//      landing routes render with the matching <html lang> + message bundle
//      regardless of the visitor's cookie. This is what makes /{locale}
//      pages stable, indexable documents for hreflang.
//   2. `robo_locale` cookie — the user's explicit choice.
//   3. Accept-Language — first supported tag wins (script-aware zh mapping).
//   4. DEFAULT_LOCALE (`en`).

import { cookies, headers } from 'next/headers';

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  matchLocale,
  type RoboLocale,
} from './localeConfig';

/** Extract a locale from a pathname like `/es` or `/zh-TW/anything`. */
export function pathnameLocale(pathname: string | null): RoboLocale | null {
  if (!pathname) return null;
  const seg = pathname.split('/').filter(Boolean)[0];
  return isLocale(seg) ? seg : null;
}

export async function resolveLocale(): Promise<RoboLocale> {
  try {
    const headersList = await headers();
    const fromPath = pathnameLocale(headersList.get('x-pathname'));
    if (fromPath) return fromPath;

    const cookieStore = await cookies();
    const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
    if (isLocale(cookieLocale)) return cookieLocale;

    const acceptLang = headersList.get('accept-language') ?? '';
    const tags = acceptLang.split(',').map((t) => t.split(';')[0].trim());
    const matched = matchLocale(tags);
    if (matched) return matched;
  } catch {
    /* prerender context — fall through */
  }
  return DEFAULT_LOCALE;
}
