// /pay — "Pay check": what live job posts of the last 90 days state about pay
// for a job title (resume.io's Salary Analyzer, from our own index only; D3).
// Renders inside the (auth) app shell. `?title=` and `?location=` fill the
// form (the job page's "See what postings pay for this title" link sends
// both; `location=remote` asks for remote jobs). Without a title the active
// saved search's first title is used. With the `jobs.feed` capability off the
// page says it is not available (there is no nav entry then).

import { PayCheckPage } from '../../../components/features/pay';

type Search = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);

export default async function PayRoute({ searchParams }: { searchParams?: Promise<Search> }) {
  const sp: Search = (await searchParams) ?? {};
  return <PayCheckPage initialTitle={one(sp.title)} initialLocation={one(sp.location)} />;
}
