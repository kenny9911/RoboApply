'use client';

// MoreSheet — the bottom bar's fifth slot opens this (FND-6a; PRODUCT_PLAN.md
// §3.3). RoboApply "More": Ready to apply, Profile, Coaching (if any), Invite
// friends, Settings, Plan. GoApply 我的: 简历, 我的资料, 待投递, 内推, 邀请好友,
// 设置, 会员. The entries are the registry's `mobile: 'more'` entries for the
// brand (destinations.ts), so the sheet cannot list something the rail hides.
//
// A link closes the sheet; the Sheet primitive handles focus and Escape.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useNavBadges, NAV_BADGE_LABEL_KEYS } from '../../../hooks/shared/navBadges';
import { PlanBadge } from '../../features/credits/PlanBadge';
import { Sheet } from '../primitives/Sheet';
import type { NavEntry } from './destinations';
import styles from './shell.module.css';

export interface MoreSheetProps {
  open: boolean;
  onClose: () => void;
  entries: readonly NavEntry[];
  title: string;
}

export function MoreSheet({ open, onClose, entries, title }: MoreSheetProps) {
  const t = useTranslations('nav');
  const pathname = usePathname() ?? '';
  const badges = useNavBadges();

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <nav aria-label={title}>
        <ul className={styles.moreList}>
          {entries.map((e) => {
            const active = e.match(pathname);
            const badge = e.badge ? badges[e.badge] : null;
            const Icon = e.icon;
            return (
              <li key={e.id}>
                <Link
                  href={e.href}
                  className={styles.moreItem}
                  aria-current={active ? 'page' : undefined}
                  onClick={onClose}
                >
                  <Icon size={18} />
                  <span className={styles.moreItemLabel}>{t(e.labelKey)}</span>
                  {badge && e.badge ? (
                    badge.kind === 'count' ? (
                      <>
                        <span className={styles.moreCount} aria-hidden="true">
                          {badge.count}
                        </span>
                        <span className="sr-only">{t(NAV_BADGE_LABEL_KEYS[e.badge], { count: badge.count })}</span>
                      </>
                    ) : (
                      <>
                        <span className={styles.dot} aria-hidden="true" />
                        <span className="sr-only">{t(NAV_BADGE_LABEL_KEYS[e.badge])}</span>
                      </>
                    )
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className={styles.morePlan}>
          <PlanBadge variant="sheet" />
        </div>
      </nav>
    </Sheet>
  );
}
