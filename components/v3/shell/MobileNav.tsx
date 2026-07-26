'use client';

// MobileNav — the fixed bottom bar below 760px, where styles/v3.css hides the
// 248px rail.
//
// It renders DESTINATIONS, the same array the Sidebar renders: same four
// items, same labels, same order, same routes. That is the point of the bar —
// it IS the information architecture (ruling D3). If something does not fit
// here, it is not a destination; Settings, Billing and Sign out live in the
// AvatarMenu in the Topbar, which is present at every width.
//
// Labels are sentence case at --fs-label. (The 9px uppercase mono they used to
// be — below the 12px floor, in the case that destroys word-shape cues, at the
// size where the reader most needs them — died with the type system in
// deb1edc; this file only has to not bring it back.)
//
// New here: an explicit 44×44 floor per tab. The bar used to size itself from
// its contents, so the tap target was whatever the icon plus the label
// happened to add up to in the user's locale — and the bottom row of a phone
// screen is the one place a 4px miss costs a wrong destination.
//
// The QUEUE_REVIEW_ENABLED / job-applying filtering is gone: a bar whose item
// count depended on a server flag could not be the IA.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DESTINATIONS } from './Sidebar';

export function MobileNav() {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav');

  return (
    <nav
      aria-label={t('aria_primary')}
      className="v3-mobile-nav robo-bottom-nav fixed inset-x-0 bottom-0 z-30 items-stretch"
      style={{
        background: 'var(--surface)',
        borderTop: '1px solid var(--rule)',
      }}
    >
      {DESTINATIONS.map(({ href, labelKey, Icon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className="flex flex-1 flex-col items-center justify-center gap-1 px-1 py-2"
            // 44px is the floor for a tap target; the bar sits above the home
            // indicator on iOS, so the padding-bottom is the safe area.
            style={{
              minHeight: 44,
              minWidth: 44,
              paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))',
              color: active ? 'var(--action)' : 'var(--text-muted)',
            }}
          >
            <Icon size={18} />
            <span
              style={{
                fontSize: 'var(--fs-label)',
                fontWeight: 600,
                textAlign: 'center',
                lineHeight: 1.2,
              }}
            >
              {t(labelKey)}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
