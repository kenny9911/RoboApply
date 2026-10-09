// Shared next-intl provider wrapper for unit tests.
//
// Uses the real en.json bundle so missing-key regressions surface as
// "MISSING_MESSAGE" warnings exactly as in production. Tests that
// deliberately probe missing-key fallbacks pass a `messages` override.

import type { ReactNode } from 'react';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';
import enMessages from '../../i18n/messages/en.json';
import { substituteBrandTokens } from '../../lib/brand/tokens';
import { STAGING_EN } from '../../i18n/staging/index';

export interface IntlWrapperProps {
  children: ReactNode;
  locale?: string;
  messages?: AbstractIntlMessages;
  onError?: (error: unknown) => void;
}

type Tree = Record<string, unknown>;
const isTree = (v: unknown): v is Tree => !!v && typeof v === 'object' && !Array.isArray(v);

/** Staged English wins over en.json, exactly as lib/i18n.ts does at runtime. */
function mergeOver(base: Tree, over: Tree): Tree {
  const out: Tree = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isTree(v) && isTree(out[k]) ? mergeOver(out[k] as Tree, v) : v;
  }
  return out;
}

// English = en.json + the staged English of the feature waves (i18n/staging),
// as at runtime, so a staged key renders its text in tests too.
// Bundles carry `%BRAND%` instead of the product name (lib/brand/tokens.ts);
// substitute it the way loadMessages does for the default brand (RoboApply).
const DEFAULT_MESSAGES = substituteBrandTokens(
  mergeOver(JSON.parse(JSON.stringify(enMessages)), JSON.parse(JSON.stringify(STAGING_EN))),
  'roboapply',
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
