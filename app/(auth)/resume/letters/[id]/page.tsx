// /resume/letters/[id] — route shell (FND-6b). Cover letter editor.
//
// STUB. Owner: WP-37, who replaces this page. Renders inside the (auth) app shell.
// Nothing links here until the owner ships and INT flips the entry.

export default async function ResumeLettersIdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div hidden data-route-stub="/resume/letters/[id]" data-owner="WP-37" data-param={id} />;
}
