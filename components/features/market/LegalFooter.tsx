'use client';

// LegalFooter — the per-brand legal footer: document links, entity name, and
// on GoApply the ICP 备案号 (→ beian.miit.gov.cn), 公安备案号 (→ beian.mps.gov.cn
// with the record code), EDI and HR licence numbers when held, AI model names
// with filing numbers, and the 投诉举报 contact (PRODUCT_PLAN.md §3.2;
// TASK_PLAN.md WP-13). Every value comes from env via
// GET /api/v1/public/legal/footer; a value that is not set is left out, never
// shown empty or as "pending".
//
// The document links render at once from the brand registry; the configured
// lines (entity, filing numbers, models) appear when the model has loaded.

import { useQuery } from '@tanstack/react-query';
import { useLocale } from 'next-intl';

import { useBrand } from '../../../lib/brand';
import { getLegalFooter } from '../../../lib/api/compliance';
import type { LegalFooterModel } from '../../../lib/api/contracts/compliance';
import { LEGAL_FOOTER_DOCS, LegalFooterView } from '../compliance';

export interface LegalFooterProps {
  /** 'marketing' under public pages; 'app' as a compact line inside the app. */
  variant?: 'marketing' | 'app';
}

export const LEGAL_FOOTER_QUERY_KEY = ['compliance', 'legal-footer'] as const;

export function LegalFooter({ variant = 'marketing' }: LegalFooterProps = {}) {
  const brand = useBrand();
  const locale = useLocale();
  const query = useQuery({
    queryKey: [...LEGAL_FOOTER_QUERY_KEY, brand.id],
    queryFn: () => getLegalFooter(),
    staleTime: 5 * 60 * 1000,
  });
  const resolved: LegalFooterModel = query.data ?? {
      brand: brand.id,
      market: brand.market,
      entity: null,
      links: LEGAL_FOOTER_DOCS[brand.market].map((doc) => ({ doc, href: `/legal/${doc}` })),
      icp: null,
      psb: null,
      edi: null,
      hrLicence: null,
      aiModels: [],
      genaiRegistration: null,
      algorithmFiling: null,
      statusNote: null,
      complaints: null,
    };
  const extraDocs = brand.market === 'intl' && locale === 'zh-TW' ? ['tw-pdpa-notice'] : [];
  return <LegalFooterView model={resolved} variant={variant} extraDocs={extraDocs} />;
}

export default LegalFooter;
