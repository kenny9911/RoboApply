// components/features/common/honesty.ts — the required honesty strings
// (PRODUCT_PLAN.md F-TRUST-05; TASK_PLAN.md §2.2). One place, so no screen
// paraphrases them. Rendered by <HonestyLine kind=… />.
//
// `fit` reuses the existing, already-translated `jobs.score.disclaimer`
// ("This is not your chance of getting hired.", ruling C5). The rest are
// staged under `nav.honesty.*` (FND-6a's namespace) until INT translates them.
// GoApply's AI 生成内容标识 is a badge, not a line: AiGeneratedBadge (WP-13).

export type HonestyKind = 'fit' | 'ai_written' | 'search_results' | 'sponsorship' | 'you_submit';

export const HONESTY_KINDS: readonly HonestyKind[] = ['fit', 'ai_written', 'search_results', 'sponsorship', 'you_submit'];

/** Full message key (namespace included) for each kind. */
export const HONESTY_KEYS: Record<HonestyKind, string> = {
  fit: 'jobs.score.disclaimer',
  ai_written: 'nav.honesty.ai_written',
  search_results: 'nav.honesty.search_results',
  sponsorship: 'nav.honesty.sponsorship',
  you_submit: 'nav.honesty.you_submit',
};
