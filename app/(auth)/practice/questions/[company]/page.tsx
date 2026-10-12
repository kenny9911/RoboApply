// /practice/questions/[company] — questions %BRAND% users shared about one
// company (WP-59; F-INT-01). Only moderated user reports, with month and count.
// `[company]` is the company slug, or the URL-encoded company name when there
// is no company record (WP-34's job page link). `?job=<id>` adds that job's
// practice set first.

import { CompanyQuestionsPage } from '../../../../../components/features/prep';

type Search = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null);

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export default async function PracticeQuestionsCompanyRoute({ params, searchParams }: { params: Promise<{ company: string }>; searchParams?: Promise<Search> }) {
  const { company } = await params;
  const sp: Search = (await searchParams) ?? {};
  return <CompanyQuestionsPage company={decode(company).slice(0, 120)} jobId={one(sp.job) ?? one(sp.jobId)} />;
}
