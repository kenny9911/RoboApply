'use client';

// lib/auth/optionalTranslations.ts — `useTranslations` that tolerates a
// missing NextIntlClientProvider (unit tests that render a gate on its own).
// The hook is always called, so React's hook order is unchanged; only its
// failure is caught and the English fallback is used.

import { useTranslations } from 'next-intl';

type Values = Record<string, string | number>;

export function useOptionalTranslations(namespace: string): (key: string, fallback: string, values?: Values) => string {
  let t: ((key: string, values?: Values) => string) | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    t = useTranslations(namespace) as unknown as (key: string, values?: Values) => string;
  } catch {
    t = null;
  }
  return (key, fallback, values) => {
    if (!t) return fallback;
    try {
      return t(key, values);
    } catch {
      return fallback;
    }
  };
}
