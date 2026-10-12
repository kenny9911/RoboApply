'use client';

// CancelFooterLink — the "/cancel" link every footer carries (PRODUCT_PLAN.md
// §3.4; F-BILL-03; §312k BGB). English "Cancel a subscription"; the `de`
// translation must read exactly "Verträge hier kündigen" (INT, WP-92).
// For WP-13 (LegalFooter) and WP-40 (marketing footer) to place.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

export interface CancelFooterLinkProps {
  className?: string;
}

export function CancelFooterLink({ className }: CancelFooterLinkProps) {
  const t = useTranslations('credits.cancelPage');
  return (
    <Link href="/cancel" className={className} data-testid="cancel-footer-link">
      {t('footerLink')}
    </Link>
  );
}

export default CancelFooterLink;
