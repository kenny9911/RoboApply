'use server';

// Server function for the billing UI (WP-21b): the visitor's country from the
// edge header, for client surfaces that are not rendered by a server page of
// their own — /settings#billing (SettingsSection) has no server parent that
// can pass it. /settings/billing reads it on the server and never calls this.
// It returns only the caller's own country (or null), so it is safe to expose.

import { resolveVisitorCountry } from '../../../../lib/serverMarket';

export async function visitorCountryAction(): Promise<string | null> {
  return resolveVisitorCountry();
}
