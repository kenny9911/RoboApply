// roboapply/lib/locale.ts
//
// Client-side helpers for the active UI locale. The locale lives in the
// `robo_locale` cookie so the server layout (app/layout.tsx) can resolve it
// at request time and hand the right message bundle to NextIntlClientProvider.
//
// The same cookie value is echoed to the backend on every API call via the
// `X-Robo-Locale` header (see lib/api/client.ts) so LLM agents respond in the
// language the user is reading the UI in.

'use client';

import {
  LOCALE_COOKIE,
  isLocale,
  type RoboLocale,
} from './localeConfig';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Read the active locale from the cookie (client-side only). */
export function getCookieLocale(): RoboLocale | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${LOCALE_COOKIE}=`));
  if (!match) return null;
  const value = decodeURIComponent(match.slice(LOCALE_COOKIE.length + 1));
  return isLocale(value) ? value : null;
}

/**
 * Persist the chosen locale to the cookie. `path=/` so every route sees it;
 * `SameSite=Lax` so it rides same-site navigations (and the dev `/api` proxy);
 * year-long max-age so the choice sticks across sessions.
 */
export function setLocaleCookie(locale: RoboLocale): void {
  if (typeof document === 'undefined') return;
  document.cookie =
    `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; ` +
    `path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}
