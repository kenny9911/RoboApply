// /ready/[jobId] — route shell (FND-6b). One prepared application kit for review.
//
// STUB. Owner: WP-53, who replaces this page. Renders inside the (auth) app shell.
// Nothing links here until the owner ships and INT flips the entry.

export default async function ReadyJobIdPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <div hidden data-route-stub="/ready/[jobId]" data-owner="WP-53" data-param={jobId} />;
}
