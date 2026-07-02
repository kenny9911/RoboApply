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
import { DcThemeProvider } from '../lib/dcTheme';

interface ProvidersProps {
  children: ReactNode;
  locale: string;
  messages: Record<string, unknown>;
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
      >
        <AuthProvider>
          <DcThemeProvider>{children}</DcThemeProvider>
        </AuthProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

// Exposed for advanced consumers who need to imperatively invalidate.
export function useRoboQueryClient() {
  return useQueryClient();
}
