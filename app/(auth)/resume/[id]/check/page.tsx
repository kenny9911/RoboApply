// /resume/[id]/check — Resume check report (WP-22; PRODUCT_PLAN.md F-RES-03…06).
// Renders inside the (auth) app shell. The report itself is a client
// component (components/features/resume) that loads the latest check.

import { ResumeCheckReport } from '../../../../../components/features/resume';

export default async function ResumeIdCheckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ResumeCheckReport resumeId={id} />;
}
