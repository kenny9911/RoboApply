'use client';

// Topbar — the sticky header (.topbar) (FND-6a; PRODUCT_PLAN.md §3.3).
// Left: the page name (crumb). Right (.top-actions): ⌘K search, **Ask** (opens
// the Assistant rail), the message-center slot, theme, language, avatar menu.
//
// The crumb is one level. It comes from the nav registry (destinations.ts
// `crumbKeyFor`), so every destination names itself the same way in the rail,
// the bottom bar and here; an unmatched path renders NO crumb rather than a
// wrong one.
//
// Ask renders only when the `copilot` capability is on (and
// `SURFACES_READY.assistant`, true since INT-12; set it to false to take the
// button out). It opens the rail through useOpenAssistant() — an explicit
// click, never a route change.
//
// The Inbox bell is the MessageCenterButton slot (WP-39b). It renders nothing
// until a real feed exists: a bell that cannot do anything is a claim.
//
// Mobile: the topbar renders at every width, which is what makes the
// AvatarMenu (Settings / Billing / Sign out) reachable on a phone. The search
// pill gives way to an icon button at 760px and below; Ask keeps a 44px icon;
// the page name wraps to two lines before it pushes a button off screen.
//
// Which of the two search buttons shows is decided in styles/v3.css
// (`.top-actions .search` / `.top-actions .search-compact`), NOT with Tailwind
// utilities here: `.search` and `.icon-btn` set `display` in stylesheets that
// app/globals.css imports unlayered, and an unlayered rule beats every
// `@layer utilities` rule — `max-[760px]:hidden` on them does nothing
// (components/v3/shell/topbarResponsive.test.ts).

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useBrandId } from '../../../lib/brand/BrandProvider';
import { useFlag } from '../../../lib/flags';
import { useOpenAssistant } from '../../../hooks/shared/useOpenAssistant';
import { MessageCenterButton } from '../../features/notifications/MessageCenterButton';
import { useCommandPalette, usePaletteJobSearch } from './CommandPalette';
import { AvatarMenu } from './AvatarMenu';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { SURFACES_READY, crumbKeyFor, showAllNav } from './destinations';
import { IconChat, IconSearch } from '../primitives/Iconset';
import styles from './shell.module.css';

/** Ask is shown when the Assistant exists for this brand/user and has shipped. */
export function useAskVisible(): boolean {
  const copilot = useFlag('copilot');
  return copilot && (SURFACES_READY.assistant || showAllNav());
}

export function Topbar() {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav');
  const palette = useCommandPalette();
  const brandId = useBrandId();
  const openAssistant = useOpenAssistant();
  const askVisible = useAskVisible();
  // Where there is no job feed (GoApply while its feed is off) ⌘K only jumps
  // between pages, and the button says that rather than "Search jobs".
  const jobSearch = usePaletteJobSearch();
  const searchAria = jobSearch ? t('search_aria') : t('jump_aria');

  const crumbKey = crumbKeyFor(pathname, brandId);
  const isAdmin = crumbKey === 'admin';

  return (
    <div className="topbar">
      <div className="crumbs">{crumbKey ? <span className="now">{t(crumbKey)}</span> : null}</div>

      <div className="top-actions">
        {!isAdmin ? (
          <>
            <button
              type="button"
              className="search"
              onClick={palette.open}
              aria-label={searchAria}
            >
              <IconSearch size={13} />
              <span className="grow">{jobSearch ? t('search_placeholder') : t('jump_placeholder')}</span>
              <kbd>⌘K</kbd>
            </button>

            {/* Same action, phone width. Two elements rather than one that
             *  reflows, because .search is a 240px input-shaped button and an
             *  icon button is a different control, not a narrower one. Only
             *  one is ever displayed, so only one is in the tab order. */}
            <button
              type="button"
              className="icon-btn search-compact"
              onClick={palette.open}
              aria-label={searchAria}
            >
              <IconSearch size={15} />
            </button>

            {askVisible ? (
              <button
                type="button"
                className={styles.ask}
                onClick={() => openAssistant({ source: 'topbar' })}
                aria-label={t('ask_aria')}
              >
                <IconChat size={15} />
                <span className={styles.askLabel}>{t('ask')}</span>
              </button>
            ) : null}
          </>
        ) : null}

        <MessageCenterButton />

        <ThemeToggle />

        <LanguageSwitcher />

        <AvatarMenu />
      </div>
    </div>
  );
}
