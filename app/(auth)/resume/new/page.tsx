// /resume/new — the guided resume builder (WP-65; PRODUCT_PLAN.md F-RES-17).
// Renders inside the (auth) app shell. The builder is a client component that
// loads its steps for this brand and locale from GET /v2/resumes/builder/config.

import { ResumeBuilder } from '../../../../components/features/resume/builder/ResumeBuilder';

export default function ResumeNewPage() {
  return <ResumeBuilder />;
}
