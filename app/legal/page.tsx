// /legal — the legal index per brand (WP-93): the brand's documents, plus the
// facts this deployment can state about itself, each rendered from the code
// that enforces it:
//   - where and how data is processed        residencySummary(brand)
//   - companies that process data, AI models  configuration (disclosures)
//   - AI endpoints allowed and refused        the AI routing policy lists
//   - how long data is kept                   the retention schedule
//   - datasets used under an attribution licence   jobDataAttributions()
//
// Public page in HybridShell (R-23), like /legal/[doc]. It lists the brand's
// documents on both brands; a draft is listed and marked as one (GoApply no
// longer hides drafts in production). Not indexed while any listed document
// is a draft.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { LegalIndex } from '../../components/features/compliance';
import { LegalFooter } from '../../components/features/market';
import { HybridShell } from '../../components/v3/shell/HybridShell';
import { loadMessages } from '../../lib/i18n';
import { getServerBrand } from '../../lib/server/brand';
import { resolveLocale } from '../../lib/serverLocale';
import { listLegalDocsForPage, type LegalBrandInfo } from './legalSource';

async function load() {
  const brand = await getServerBrand();
  const locale = await resolveLocale(brand);
  const info: LegalBrandInfo = { id: brand.id, market: brand.market, name: brand.name, replyTo: brand.email.replyTo };
  return { brand, locale, docs: listLegalDocsForPage(info, locale) };
}

/** `legal.index.title` in the visitor's language (the page body reads the same key). */
function indexTitle(messages: Record<string, unknown>): string | null {
  const legal = messages.legal as { index?: { title?: unknown } } | undefined;
  return typeof legal?.index?.title === 'string' ? legal.index.title : null;
}

export async function generateMetadata(): Promise<Metadata> {
  const { brand, locale, docs } = await load();
  const indexable = docs.length > 0 && docs.every((d) => !d.draft);
  const title = indexTitle(loadMessages(locale, brand.id));
  return {
    title: title ? `${title} · ${brand.seo.titleSuffix}` : brand.seo.titleSuffix,
    robots: indexable ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default async function LegalIndexPage() {
  const { brand, docs } = await load();
  if (docs.length === 0) notFound();
  return (
    <HybridShell from="legal" footer={<LegalFooter />}>
      <LegalIndex market={brand.market} docs={docs.map((d) => ({ doc: d.doc, draft: d.draft, updated: d.updated }))} />
    </HybridShell>
  );
}
