// /job/[idSlug] — public job page, `<id>-<slug>` (R-05; F-SEO-05, F-JOB-09).
// Data: lib/server/publicApi.ts (unstable_cache per brand × id, tag
// `seo:<brand>:job:<id>`) → GET /api/v1/public/seo/jobs/:id, which answers
// only for jobs we may show publicly (PUBLIC_DISPLAY_PROVIDERS / bank
// syndication consent) and 410 for a closed one. A wrong slug 301s to the
// canonical path. Unknown, not public or closed → the not-found page. An App
// Router page cannot answer 410; the HTML 410 for a closed job is the proxy's
// (REQ-56-2: proxy.ts calls `publicJobHtmlStatus` from lib/server/publicApi).
// GoApply: public job pages are deferred → 404. JobPosting JSON-LD per ARCH
// §9.3 (lib/seo.ts). Reads forward the visitor's IP on cache misses (F-TRUST-02).

import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';
import { JsonLd } from '../../../components/features/marketing';
import { JobPage } from '../../../components/features/seo';
import { jobJsonLd, jobMetadata, seoRequest } from '../../../components/features/seo/server';
import { parseJobIdSlug } from '../../../lib/seo';
import { loadPublicJob } from '../../../lib/server/publicApi';
import type { PublicJobDetail } from '../../../lib/api/contracts/seo';

interface JobProps {
  params: Promise<{ idSlug: string }>;
}

async function load({ params }: JobProps): Promise<{ job: PublicJobDetail; requested: string } | null> {
  const { idSlug } = await params;
  const req = await seoRequest();
  if (req.brand.market === 'cn') return null;
  const id = parseJobIdSlug(idSlug);
  if (!id) return null;
  const res = await loadPublicJob(req.brand.id, id, { clientIp: req.clientIp });
  return res.status === 'ok' ? { job: res.data.job, requested: `/job/${idSlug}` } : null;
}

export async function generateMetadata(props: JobProps): Promise<Metadata> {
  const loaded = await load(props);
  if (!loaded) return { robots: { index: false, follow: true } };
  return jobMetadata(await seoRequest(), loaded.job);
}

export default async function JobIdSlugPage(props: JobProps) {
  const loaded = await load(props);
  if (!loaded) notFound();
  const { job, requested } = loaded;
  let decoded = requested;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    /* keep */
  }
  if (decoded !== job.canonicalPath) permanentRedirect(job.canonicalPath);
  const req = await seoRequest();
  return (
    <HybridShell from="job" footer={<LegalFooter />}>
      <JsonLd json={jobJsonLd(req, job)} />
      <JobPage job={job} signupHref={`/signup?from=job&job=${encodeURIComponent(job.id)}`} />
    </HybridShell>
  );
}
