'use client';

// A localized landing URL (`/en`, `/zh`, …) is a language choice: the visitor
// followed a link that names the language (RoboHire's job-seeker link, a
// search result in that language, the footer's language list). Remember it
// the way LanguageMenu does, so /signup, /login and the app that follow keep
// that language instead of falling back to an older cookie or the browser's.

import { useEffect } from 'react';

import { getCookieLocale, setLocaleCookie } from '../../lib/locale';
import type { RoboLocale } from '../../lib/localeConfig';

export function RememberLocale({ locale }: { locale: RoboLocale }) {
  useEffect(() => {
    if (getCookieLocale() !== locale) setLocaleCookie(locale);
  }, [locale]);
  return null;
}
