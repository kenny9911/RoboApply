// /resume/[id]/check — Resume check report (WP-22; PRODUCT_PLAN.md F-RES-03…06).
// Renders inside the (auth) app shell. The report itself is a client
// component (components/features/resume) that loads the latest check.
// `?issue=<issueId>` opens the report on that issue (the Assistant links here).

import { ResumeCheckReport } from '../../../../../components/features/resume';

type Query = Record<string, string | string[] | undefined>;

export default async function ResumeIdCheckPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<Query> }) {
  const { id } = await params;
  const query = (await searchParams) ?? {};
  const raw = Array.isArray(query.issue) ? query.issue[0] : query.issue;
  const issue = typeof raw === 'string' && raw.trim() && raw.length <= 120 ? raw.trim() : null;
  return <ResumeCheckReport resumeId={id} focusIssueId={issue} />;
}
