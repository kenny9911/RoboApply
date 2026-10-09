// /settings/billing/return — where the payment page sends the buyer back
// (WP-21b). `?billing=success|cancel` (legacy Stripe return) or
// `?status=success|cancel`; anything else reads as "checking". The plan sheet
// also puts `?plan=<key>` (and, for a practice pack, `?practiceBefore=<n>`)
// in the return URL so this page knows what to wait for.

import { CheckoutReturn } from '../../../../../components/features/credits';

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
  return <CheckoutReturn outcome={outcome} planKey={plan} practiceBefore={before} />;
}
