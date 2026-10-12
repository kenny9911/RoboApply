// /job/[idSlug] not found: an unknown job, one we may not show publicly, or a
// closed one (the API answers 410 for those; a Next page answers 404).

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';
import { JobNotFound } from '../../../components/features/seo';

export default function JobNotFoundPage() {
  return (
    <HybridShell from="job" footer={<LegalFooter />}>
      <JobNotFound />
    </HybridShell>
  );
}
