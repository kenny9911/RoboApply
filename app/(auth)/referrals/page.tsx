// /referrals — the GoApply 内推码 hub (WP-54; PRODUCT F-NET-08 cn; flag `cn.referralCodes`).
// Renders inside the (auth) app shell. `?company=` pre-fills the company
// filter (the job page's "See all referral codes"). With the capability off
// the page says it is not available (there is no nav entry then).

import { ReferralHub } from '../../../components/features/network';

type Search = Record<string, string | string[] | undefined>;

export default async function ReferralsPage({ searchParams }: { searchParams?: Promise<Search> }) {
  const sp: Search = (await searchParams) ?? {};
  const company = typeof sp.company === 'string' && sp.company.trim() ? sp.company.trim().slice(0, 120) : null;
  return <ReferralHub initialCompany={company} />;
}
