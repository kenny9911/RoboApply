'use client';

// Top-level client providers. Wraps the entire tree.
//
// Order matters:
//   1. React Query — needed by AuthProvider's hooks down the road.
//   2. AuthProvider — exposes session state to all (auth) descendants.
//   3. NextIntlClientProvider — locale + translation messages.
//
// We deliberately resolve the locale + load messages at the server layer
// (app/layout.tsx) and pass them down so we don't ship the entire
// dictionary on every public page request.

import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { useMemo, type ReactNode } from 'react';

import { AuthProvider } from '../lib/auth/AuthProvider';
import { ThemeProvider } from '../lib/theme';

interface ProvidersProps {
  children: ReactNode;
  locale: string;
  messages: Record<string, unknown>;
}

/**
 * Make a missing translation loud in development and harmless in production.
 *
 * next-intl does NOT throw on a missing key — `lib/i18n.ts` deep-merges each
 * locale over English, and with no `onError` the library falls back to
 * rendering the literal dotted path. So a renamed namespace with one stale
 * call site ships the string `jobs.headline` to production, in nine languages,
 * and neither `next build` nor `vitest` sees anything wrong (ruling C30).
 *
 * Two defences, and this is the second:
 *   • `scripts/check-copy.mjs` reads every `t('…')` literal and fails the build
 *     if it does not resolve in en.json. That catches the static cases.
 *   • This throws in development for everything static analysis cannot see —
 *     a key built from a template literal, or a namespace chosen at runtime.
 *
 * Production only logs. A user reading a rejection-adjacent screen should see
 * an imperfect string, never a crashed page, and the same event is already
 * failing the build for whoever is about to deploy.
 */
function onIntlError(error: unknown): void {
  if (process.env.NODE_ENV === 'development') throw error;
  console.error('[i18n]', error);
}

export function Providers({ children, locale, messages }: ProvidersProps) {
  // Memoize so React Query state survives across navigation. One client per
  // tab is the recommended pattern from the next.js docs.
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
    [],
  );

  // Defensive: deep-clone messages so any namespace-wrapped JSON import
  // upstream can't leak a Module Namespace Object into the React tree.
  // Required to avoid React error #31 in the static prerender pass for
  // /404 and /500.
  const safeMessages = useMemo<Record<string, unknown>>(() => {
    try {
      return JSON.parse(JSON.stringify(messages ?? {}));
    } catch {
      return {};
    }
  }, [messages]);

  return (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale={locale}
        messages={safeMessages as any}
        timeZone="UTC"
        onError={onIntlError}
      >
        <AuthProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </AuthProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

// Exposed for advanced consumers who need to imperatively invalidate.
export function useRoboQueryClient() {
  return useQueryClient();
}
