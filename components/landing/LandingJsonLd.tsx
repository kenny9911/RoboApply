// Server component: renders the landing structured-data graph. Kept out of
// LandingContent (client) so the message bundles' server-only path (lib/seo →
// lib/i18n) never enters the browser bundle.

import { landingJsonLd } from '../../lib/seo';
import type { RoboLocale } from '../../lib/localeConfig';

export function LandingJsonLd({ locale }: { locale: RoboLocale }) {
  return (
    <script
      type="application/ld+json"
      // Output of landingJsonLd is JSON.stringify'd with `<` escaped.
      dangerouslySetInnerHTML={{ __html: landingJsonLd(locale) }}
    />
  );
}
