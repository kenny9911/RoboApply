// /practice/questions/[company] — route shell (FND-6b). Interview questions for one company (flag `interviewBank`).
//
// STUB. Owner: WP-59, who replaces this page. Renders inside the (auth) app shell.
// Nothing links here until the owner ships and INT flips the entry.

export default async function PracticeQuestionsCompanyPage({ params }: { params: Promise<{ company: string }> }) {
  const { company } = await params;
  return <div hidden data-route-stub="/practice/questions/[company]" data-owner="WP-59" data-param={company} />;
}
