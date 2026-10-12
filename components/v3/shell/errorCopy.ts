'use client';

// errorCopy — the words and the one fact (signed in or not) that the 404 page
// and the route error boundary need, read in a way that cannot throw.
//
// Both render in the worst moments of the app: the page that crashed may have
// crashed BECAUSE of the translation layer (development makes every intl error
// throw — app/providers.tsx `onIntlError`), and Next can render either file
// outside the providers. A boundary that throws while rendering hands the user
// the bare global error page instead. So every read here has an English
// fallback, and the fallbacks are the en.json strings word for word
// (app/errorPages.test.tsx keeps them equal).
//
// Every string here is already translated in all nine bundles. Six are the
// `errors` namespace. The visitor's "Go to the home page" is
// `seo.job.notFound.home` — the same link on the public "this job is gone"
// page — read from there rather than staged as a new English-only key, which
// would show English under a translated title until it was translated.

import { useTranslations } from 'next-intl';

import { useAuth } from '../../../lib/auth/useAuth';

export const ERROR_COPY_EN = {
  not_found_title: 'That page does not exist',
  not_found_body: 'The address may be wrong, or the page may have moved.',
  error_title: 'Something on this page failed to load',
  error_body: 'Nothing you saved was lost. Try again, and if it keeps failing, reload the page.',
  try_again: 'Try again',
  go_home: 'Go to Jobs',
  go_site_home: 'Go to the home page',
} as const;

export type ErrorCopyKey = keyof typeof ERROR_COPY_EN;

/** Where each string lives in the message bundles. */
export const ERROR_COPY_PATH: Record<ErrorCopyKey, string> = {
  not_found_title: 'errors.not_found_title',
  not_found_body: 'errors.not_found_body',
  error_title: 'errors.error_title',
  error_body: 'errors.error_body',
  try_again: 'errors.try_again',
  go_home: 'errors.go_home',
  go_site_home: 'seo.job.notFound.home',
};

/** `copy('try_again')` in the reader's language, or the English when it cannot be read. */
export function useErrorCopy(): (key: ErrorCopyKey) => string {
  let t: ReturnType<typeof useTranslations> | null = null;
  try {
    // Throws when there is no NextIntlClientProvider above (same on every
    // render of a given mount, so the hook order is stable).
    // eslint-disable-next-line react-hooks/rules-of-hooks
    t = useTranslations();
  } catch {
    t = null;
  }
  return (key) => {
    if (!t) return ERROR_COPY_EN[key];
    const path = ERROR_COPY_PATH[key];
    try {
      // `has` first: outside development a missing key does not throw, it
      // renders the dotted path ("errors.try_again") — never show that here.
      return t.has(path) ? t(path) : ERROR_COPY_EN[key];
    } catch {
      return ERROR_COPY_EN[key];
    }
  };
}

/**
 * True only for a confirmed session. Loading, signed out and "no AuthProvider
 * above" all read as a visitor: a visitor's link (the home page) works for
 * everyone, while "Go to Jobs" sends a visitor to the sign-in page.
 */
export function useIsSignedIn(): boolean {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useAuth().status === 'authenticated';
  } catch {
    return false;
  }
}
