// Shared next-intl provider wrapper for unit tests.
//
// Uses the real en.json bundle so missing-key regressions surface as
// "MISSING_MESSAGE" warnings exactly as in production. Tests that
// deliberately probe missing-key fallbacks pass a `messages` override.

import type { ReactNode } from 'react';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';
import enMessages from '../../i18n/messages/en.json';

export interface IntlWrapperProps {
  children: ReactNode;
  locale?: string;
  messages?: AbstractIntlMessages;
  onError?: (error: unknown) => void;
}

const DEFAULT_MESSAGES = JSON.parse(
  JSON.stringify(enMessages),
) as AbstractIntlMessages;

export function IntlWrapper({
  children,
  locale = 'en',
  messages = DEFAULT_MESSAGES,
  onError,
}: IntlWrapperProps) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      onError={(err) => {
        if (onError) onError(err);
      }}
      getMessageFallback={({ key }) => key}
    >
      {children}
    </NextIntlClientProvider>
  );
}

export const defaultMessages = DEFAULT_MESSAGES;
