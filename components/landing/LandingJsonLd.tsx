// Server component: renders the landing structured-data graph. Kept out of
// LandingContent (client) so the message bundles' server-only path (lib/seo →
// lib/i18n) never enters the browser bundle. `market` picks the currency of
// the offers so they match the prices the visitor sees.

import { landingJsonLd } from '../../lib/seo';
import type { RoboLocale } from '../../lib/localeConfig';
import type { BillingMarket } from '../../lib/pricing';

export function LandingJsonLd({
  locale,
  market = 'other',
}: {
  locale: RoboLocale;
  market?: BillingMarket;
}) {
  return (
    <script
      type="application/ld+json"
      // Output of landingJsonLd is JSON.stringify'd with `<` escaped.
      dangerouslySetInnerHTML={{ __html: landingJsonLd(locale, market) }}
    />
  );
}
