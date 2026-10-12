// /resume/letters/[id] — cover letter editor (WP-37; PRODUCT_PLAN.md F-CL-02).
// Renders inside the (auth) app shell. `?entry=` offers "Attach to this
// application" (the tracker drawer links here with it).

import { CoverLetterEditor } from '../../../../../components/features/coverletter';

type Search = Record<string, string | string[] | undefined>;

export default async function ResumeLettersIdPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<Search> }) {
  const { id } = await params;
  const sp: Search = (await searchParams) ?? {};
  const entry = typeof sp.entry === 'string' && sp.entry.trim() ? sp.entry.trim().slice(0, 64) : null;
  return <CoverLetterEditor letterId={id} trackerEntryId={entry} />;
}
