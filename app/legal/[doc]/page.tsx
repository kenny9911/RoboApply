// /legal/[doc] — legal documents per brand (WP-13; PRODUCT_PLAN.md F-MKT-04).
//
// RoboApply: terms, privacy, cookies, refunds, subscription-terms,
// ai-disclosure, tw-pdpa-notice. GoApply: terms (用户协议), privacy (隐私政策),
// pi-collection-list (个人信息收集清单), third-party-sharing (第三方共享清单),
// ai-content-labels (AI 生成内容标识说明), complaints (投诉举报). Aliases
// (`/legal/agreement`, `/legal/personal-info-list`, GoApply `/legal/ai-disclosure`)
// redirect to the canonical slug.
//
// Public page in HybridShell (R-23). Documents are DRAFT until counsel approves
// them and ops sets the docs version (GoApply: CN_LEGAL_DOCS_VERSION). A draft
// is served with the DRAFT banner on both brands and is never indexed.

import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';

import { LegalDocument, legalDocsFor } from '../../../components/features/compliance';
import { LegalFooter } from '../../../components/features/market';
import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { getServerBrand } from '../../../lib/server/brand';
import { resolveLocale } from '../../../lib/serverLocale';
import { loadLegalDocForPage, type LegalBrandInfo } from '../legalSource';

type Params = { params: Promise<{ doc: string }> };

async function load(doc: string) {
  const brand = await getServerBrand();
  const info: LegalBrandInfo = { id: brand.id, market: brand.market, name: brand.name, replyTo: brand.email.replyTo };
  return { brand, info, result: loadLegalDocForPage(info, doc) };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { doc } = await params;
  const { brand, result } = await load(doc);
  if (result.kind !== 'doc') return { robots: { index: false, follow: false } };
  return {
    title: `${result.doc.title} · ${brand.seo.titleSuffix}`,
    robots: result.doc.draft ? { index: false, follow: false } : { index: true, follow: true },
  };
}

export default async function LegalDocPage({ params }: Params) {
  const { doc } = await params;
  const { brand, result } = await load(doc);
  if (result.kind === 'redirect') permanentRedirect(`/legal/${result.to}`);
  if (result.kind !== 'doc') notFound();
  const locale = await resolveLocale(brand);
  return (
    <HybridShell from="legal" footer={<LegalFooter />}>
      <LegalDocument
        doc={result.doc.doc}
        title={result.doc.title}
        body={result.doc.body}
        draft={result.doc.draft}
        version={result.doc.version}
        updated={result.doc.updated}
        market={brand.market}
        lang={result.doc.lang}
        uiLocale={locale}
        otherDocs={legalDocsFor(brand.market, locale)}
      />
    </HybridShell>
  );
}
