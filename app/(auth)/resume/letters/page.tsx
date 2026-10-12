// /resume/letters — cover letters (WP-37; PRODUCT_PLAN.md F-CL-01, F-RES-02 tab).
// Renders inside the (auth) app shell. `?jobId=` opens the "Write a cover
// letter" form for that job; `&entry=` attaches the new letter to that
// application.

import { CoverLetterHub } from '../../../../components/features/coverletter';

type Search = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null);

export default async function ResumeLettersPage({ searchParams }: { searchParams?: Promise<Search> }) {
  const sp: Search = (await searchParams) ?? {};
  // `?job=` is accepted too: the job page's checklist links with it (WP-34; Wave 3 gate).
  return <CoverLetterHub jobId={one(sp.jobId) ?? one(sp.job)} trackerEntryId={one(sp.entry)} />;
}
