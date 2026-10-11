// /settings/billing/return — where the payment page sends the buyer back
// (WP-21b). `?billing=success|cancel` (legacy Stripe return) or
// `?status=success|cancel`; anything else reads as "checking". The plan sheet
// also puts `?plan=<key>` (and, for a practice pack, `?practiceBefore=<n>`)
// in the return URL so this page knows what to wait for. The card payment
// page adds `?session_id=cs_…` (its Checkout Session): the page hands it to
// the server once more, so a paid purchase is added even when the payment
// provider's own notification was lost (MARKET_STRATEGY §5.1 "Lost-event
// recovery"). Anything that is not a session id is dropped here.

import { CheckoutReturn } from '../../../../../components/features/credits';
import { checkoutSessionId } from '../../../../../lib/api/account';

export default async function SettingsBillingReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = [params.billing, params.status].find((v) => typeof v === 'string');
  const outcome = raw === 'success' || raw === 'cancel' ? raw : null;
  const plan = typeof params.plan === 'string' && /^[a-z0-9_]{1,40}$/.test(params.plan) ? params.plan : null;
  const before = typeof params.practiceBefore === 'string' && /^\d{1,6}$/.test(params.practiceBefore) ? Number(params.practiceBefore) : null;
  const sessionId = checkoutSessionId(params.session_id);
  return <CheckoutReturn outcome={outcome} planKey={plan} practiceBefore={before} sessionId={sessionId} />;
}
