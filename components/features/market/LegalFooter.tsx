'use client';

// LegalFooter — the per-brand legal footer: entity name, terms and privacy
// links; on GoApply the ICP 备案号, 公安备案号, licence numbers (when held),
// AI model names and filing numbers (PRODUCT_PLAN.md §3.2; TASK_PLAN.md
// WP-13). Every value comes from brand config/env; a value that is not set is
// left out, never shown empty.
//
// STUB (FND-6b). Owner: WP-13. Renders nothing. Passed as `footer` to
// HybridShell by every public page.

export interface LegalFooterProps {
  /** 'marketing' under public pages; 'app' as a compact line inside the app. */
  variant?: 'marketing' | 'app';
}

export function LegalFooter(_props: LegalFooterProps = {}): null {
  return null;
}

export default LegalFooter;
