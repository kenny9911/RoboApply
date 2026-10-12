// /practice/questions — practice questions (WP-59; PRODUCT_PLAN.md F-INT-01, F-INT-03).
// Renders inside the (auth) app shell (capability `interviewBank`). `?job=<id>`
// shows that job's practice set first: AI questions written from the job post
// (labelled, never attributed to the company) and moderated user reports.

import { PracticeQuestionsPage } from '../../../../components/features/prep';

type Search = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null);

export default async function PracticeQuestionsRoute({ searchParams }: { searchParams?: Promise<Search> }) {
  const sp: Search = (await searchParams) ?? {};
  return <PracticeQuestionsPage jobId={one(sp.job) ?? one(sp.jobId)} />;
}
