// /campus/[company] — one employer's campus programmes (WP-58).
//
// Public page in HybridShell (R-23). Server-rendered from the public API;
// capability off or a company with nothing published ⇒ 404.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../../components/features/market';
import { CampusCompany } from '../../../components/features/campus';
import { campusMetadata, readCampusCompany } from '../../../components/features/campus/serverData';

type Params = Promise<{ company: string }>;

function slugOf(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const slug = slugOf((await params).company);
  const read = await readCampusCompany(slug);
  const company = read.status === 'ok' ? read.data.companyName : slug;
  return campusMetadata({
    path: `/campus/${encodeURIComponent(slug)}`,
    titleKey: 'campus.meta.companyTitle',
    descriptionKey: 'campus.meta.companyDescription',
    vars: { company },
    indexable: read.status === 'ok',
  });
}

export default async function CampusCompanyPage({ params }: { params: Params }) {
  const slug = slugOf((await params).company);
  const read = await readCampusCompany(slug);
  if (read.status === 'disabled' || read.status === 'not_found') notFound();
  return (
    <HybridShell from="campus" footer={<LegalFooter />}>
      <CampusCompany slug={slug} initial={read.status === 'ok' ? read.data : null} />
    </HybridShell>
  );
}
