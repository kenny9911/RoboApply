'use client';

// MarketJobMeta — the market slot on job cards and the job page (TASK_PLAN.md
// R-21; CN_TW_LAUNCH_PLAN.md §4.1(3)). Shared cards render this ONE component
// and never branch on market themselves; each market fills its own folder:
//
//   brand.market 'cn'   → market/cn  JobMetaCn  (WP-41)
//   brand.market 'intl' → market/tw  JobMetaTw  (WP-42; nothing for non-TW jobs)
//
// The dispatch is final (FND-6b).
//
// `marketMetaCoversBasics` tells the shared card and job page when the slot
// already prints the pay, the posting's date, "Last checked" and the source
// (GoApply's JobMetaCn does, in its own words), so they do not print those
// lines a second time.

import { useBrand } from '../../../lib/brand/BrandProvider';
import { JobMetaCn, cnPayWords, isNegotiablePay, readCnMeta } from './cn';
import { JobMetaTw } from './tw';
import type { MarketCardMeta, MarketJobMetaProps } from './types';

export type { MarketJobMetaProps } from './types';

export function MarketJobMeta(props: MarketJobMetaProps) {
  const brand = useBrand();
  return brand.market === 'cn' ? <JobMetaCn {...props} /> : <JobMetaTw {...props} />;
}

/**
 * True when the market slot for this job prints pay, dates and source itself:
 * GoApply (market 'cn') with a readable `meta.cn`. False everywhere else,
 * including GoApply jobs the server sent no `cn` meta for, so nothing is ever
 * dropped without its replacement on screen. Pure.
 */
export function marketMetaCoversBasics(market: 'intl' | 'cn', meta: MarketCardMeta | null | undefined): boolean {
  return market === 'cn' && readCnMeta(meta) !== null;
}

/**
 * Pay stated in words, as shared UI may print it for this market (the
 * similar-jobs list, the job header when no market block covers it, the share
 * card). Shared UI asks here and never branches on the market itself.
 *   'intl': the posting's words as they are (Taiwan's 面議 has its own note,
 *           NegotiablePayNote).
 *   'cn':   null when the posting states no pay or only says 面议, which is
 *           then shown as 薪资未披露 ("Pay not listed"), never as 面议 (cn/meta.ts
 *           `cnPayWords`).
 * Pure.
 */
export function marketPayWords(market: 'intl' | 'cn', row: { salary?: unknown; pay?: unknown; payText?: unknown } | null | undefined): string | null {
  if (market === 'cn') return cnPayWords(row);
  const words = row?.payText;
  return typeof words === 'string' && words ? words : null;
}

/**
 * The posting's own pay line that accompanies its figures (`pay.text`), as
 * shared UI may print it for this market: on 'cn' a line that only says 面议
 * is dropped. Pure.
 */
export function marketPayLineText(market: 'intl' | 'cn', text: unknown): string {
  const words = typeof text === 'string' ? text.trim() : '';
  return market === 'cn' && isNegotiablePay(words) ? '' : words;
}

export default MarketJobMeta;
