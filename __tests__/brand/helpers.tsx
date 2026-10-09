// Shared render helper for the brand presentation tests (WP-12): the real
// message bundles with %BRAND% substituted per brand (lib/i18n loadMessages)
// and the brand context, as app/layout.tsx + app/providers.tsx provide them.

import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import { BrandProvider } from '../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../lib/brand/client';
import type { BrandId } from '../../lib/brand/registry.generated';
import { loadMessages } from '../../lib/i18n';
import type { RoboLocale } from '../../lib/localeConfig';

export function renderBranded(ui: ReactElement, opts: { brand?: BrandId; locale?: RoboLocale } = {}) {
  const brand = opts.brand ?? 'roboapply';
  const locale = opts.locale ?? (brand === 'goapply' ? 'zh' : 'en');
  const messages = loadMessages(locale, brand);
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <BrandProvider brand={clientBrandFor(brand)}>
        <NextIntlClientProvider locale={locale} messages={messages as never} timeZone="UTC">
          {children}
        </NextIntlClientProvider>
      </BrandProvider>
    );
  }
  return render(ui, { wrapper: Wrapper });
}
