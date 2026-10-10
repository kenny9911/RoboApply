// Test render helper (WP-78): brand + resolved flags, the English bundle with
// staging merged and %BRAND% substituted for that brand, as lib/i18n does.

import type { ReactElement } from 'react';
import type { AbstractIntlMessages } from 'next-intl';

import enMessages from '../../../../i18n/messages/en.json';
import { STAGING_EN } from '../../../../i18n/staging/index';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import type { BrandId } from '../../../../lib/brand/registry.generated';
import { substituteBrandTokens } from '../../../../lib/brand/tokens';
import type { ResolvedFlags } from '../../../../server/src/platform/flags';
import { capsFor } from '../../../../__tests__/shell/helpers';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';

type Tree = Record<string, unknown>;
const isTree = (v: unknown): v is Tree => !!v && typeof v === 'object' && !Array.isArray(v);
function mergeOver(base: Tree, over: Tree): Tree {
  const out: Tree = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isTree(v) && isTree(out[k]) ? mergeOver(out[k] as Tree, v) : v;
  return out;
}

const EN = mergeOver(JSON.parse(JSON.stringify(enMessages)), JSON.parse(JSON.stringify(STAGING_EN)));

export function messagesFor(brand: BrandId): AbstractIntlMessages {
  return substituteBrandTokens(EN, brand) as AbstractIntlMessages;
}

/** next-intl errors (a missing key renders its path silently); tests assert this stays empty. */
export const intlErrors: unknown[] = [];

export function renderVisitor(ui: ReactElement, { brand = 'roboapply', flags = {} }: { brand?: BrandId; flags?: Partial<ResolvedFlags> | null } = {}) {
  return renderWithProviders(
    <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={flags === null ? null : capsFor(brand, flags)}>
      {ui}
    </BrandProvider>,
    {
      intlMessages: messagesFor(brand),
      intlLocale: 'en',
      onIntlError: (e) => {
        if ((e as { code?: string }).code !== 'ENVIRONMENT_FALLBACK') intlErrors.push(e);
      },
    },
  );
}
