'use client';

// MobileNav — the fixed bottom bar below 760px, where styles/v3.css hides the
// 248px rail (FND-6a; PRODUCT_PLAN.md §3.3).
//
//   RoboApply  Jobs · Applications · Resume · Interview prep · More
//   GoApply    职位 · 校招 · 投递 · 面试 · 我的
//
// Four destination slots from the registry (`mobile: 1–4`, destinations.ts)
// plus a fifth that opens the More sheet with every `mobile: 'more'` entry.
// A slot whose entry is hidden (flag off, page not ready) collapses; the More
// slot shows only when the sheet has something in it. Every slot is at least
// 44 × 44 (the bottom row of a phone is where a 4px miss costs a wrong
// destination), and labels are sentence case at --fs-label.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { NAV_BADGE_LABEL_KEYS, useNavBadges } from '../../../hooks/shared/navBadges';
import { IconMore } from '../primitives/Iconset';
import { MORE_LABEL_KEY, useVisibleNav } from './destinations';
import { MoreSheet } from './MoreSheet';
import styles from './shell.module.css';

const TAP_FLOOR = { minHeight: 44, minWidth: 44 } as const;

export function MobileNav() {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav');
  const nav = useVisibleNav();
  const badges = useNavBadges();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreLabel = t(MORE_LABEL_KEY[nav.brandId]);
  const moreActive = nav.more.some((e) => e.match(pathname));

  return (
    <>
      <nav
        aria-label={t('aria_primary')}
        className="v3-mobile-nav robo-bottom-nav fixed inset-x-0 bottom-0 z-30 items-stretch"
        style={{ background: 'var(--surface)', borderTop: '1px solid var(--rule)' }}
        data-slots={nav.mobile.length + (nav.more.length > 0 ? 1 : 0)}
      >
        {nav.mobile.map((e) => {
          const active = e.match(pathname);
          const Icon = e.icon;
          const badge = e.badge ? badges[e.badge] : null;
          return (
            <Link
              key={e.id}
              href={e.href}
              aria-current={active ? 'page' : undefined}
              className={styles.tab}
              // The 44px floor, inline as well so it holds even before the module CSS loads.
              style={TAP_FLOOR}
            >
              <Icon size={18} />
              <span className={styles.tabLabel}>{t(e.mobileLabelKey ?? e.labelKey)}</span>
              {badge && e.badge ? (
                <>
                  {badge.kind === 'count' ? (
                    <span className={styles.tabBadge} aria-hidden="true">
                      {badge.count}
                    </span>
                  ) : (
                    <span className={styles.tabDot} aria-hidden="true" />
                  )}
                  <span className="sr-only">
                    {badge.kind === 'count'
                      ? t(NAV_BADGE_LABEL_KEYS[e.badge], { count: badge.count })
                      : t(NAV_BADGE_LABEL_KEYS[e.badge])}
                  </span>
                </>
              ) : null}
            </Link>
          );
        })}
        {nav.more.length > 0 ? (
          <button
            type="button"
            className={styles.tab}
            style={TAP_FLOOR}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            data-active={moreActive ? 'true' : undefined}
            onClick={() => setMoreOpen(true)}
          >
            <IconMore size={18} />
            <span className={styles.tabLabel}>{moreLabel}</span>
          </button>
        ) : null}
      </nav>
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} entries={nav.more} title={moreLabel} />
    </>
  );
}
