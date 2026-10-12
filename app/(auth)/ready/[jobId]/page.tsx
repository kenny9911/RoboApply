// /ready/[jobId] — one prepared application kit for review (WP-53; PRODUCT
// F-AGENT-05). The id in the URL is the job id; the kit is found in the
// user's list.

import { KitReview } from '../../../../components/features/agent';

export default async function ReadyJobIdPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <KitReview jobId={jobId} />;
}
