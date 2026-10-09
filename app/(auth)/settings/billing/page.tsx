// /settings/billing — plan, payment, cancel, the plan sheet and today's
// credits on one page (WP-21b). The same views render under /settings#billing
// and #credits; this page is the deep-link target for "See Pro", "Get Pro"
// and the cancel-time "7-day pass instead?" link (`?plan=<key>#plans`).
//
// Server component: it reads the visitor's country from the edge header so
// the plan sheet knows whether the EU/UK/TW withdrawal acknowledgement
// applies (lib/serverMarket.ts), then hands off to the client page.

import { BillingPage } from '../../../../components/features/credits';
import { resolveVisitorCountry } from '../../../../lib/serverMarket';

export default async function SettingsBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, visitorCountry] = await Promise.all([searchParams, resolveVisitorCountry()]);
  const plan = typeof params.plan === 'string' && /^[a-z0-9_]{1,40}$/.test(params.plan) ? params.plan : null;
  return <BillingPage visitorCountry={visitorCountry} requestedPlan={plan} />;
}
