// renderWithProviders — single canonical wrapper for roboapply-app unit tests.
//
// Wraps any subject in:
//   - NextIntlClientProvider (real en.json bundle)
//   - QueryClientProvider (fresh per-test client)
//   - AuthWrapper (stubbed authenticated user)
//
// Tests that need different auth/intl/messages override via opts.

import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AbstractIntlMessages } from 'next-intl';
import { IntlWrapper } from './mockTranslations';
import { AuthWrapper } from './mockAuth';

interface ProviderOpts {
  authValue?: Parameters<typeof AuthWrapper>[0]['value'];
  intlLocale?: string;
  intlMessages?: AbstractIntlMessages;
  onIntlError?: (e: unknown) => void;
}

function buildClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(
  ui: ReactElement,
  opts: ProviderOpts & Omit<RenderOptions, 'wrapper'> = {},
) {
  const client = buildClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <IntlWrapper
          locale={opts.intlLocale}
          messages={opts.intlMessages}
          onError={opts.onIntlError}
        >
          <AuthWrapper value={opts.authValue}>{children}</AuthWrapper>
        </IntlWrapper>
      </QueryClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...opts });
}

export { IntlWrapper } from './mockTranslations';
export { AuthWrapper, buildFakeUser, buildAuthValue } from './mockAuth';
