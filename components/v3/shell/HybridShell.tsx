'use client';

// HybridShell — public pages that signed-in users also use (R-23): /campus,
// /job/*, /browse/*, /extension, /pricing, /tools/*. With a session they
// render inside the app shell (rail, topbar, bottom bar); without one, inside
// light marketing chrome (brand, Sign in, Get started). While the session is
// still loading — including the server render — the marketing chrome shows,
// so crawlers and first paint never depend on a cookie.
//
//   <HybridShell from="campus">{page}</HybridShell>
//
// Also exports AppShell, the one implementation of the authenticated frame,
// used by app/(auth)/layout.tsx too:
//
//   .app grid → 248px Sidebar (md+) + scrollable .main with a sticky Topbar.
//   < 760px → the Sidebar is hidden and MobileNav takes over.
//   `fullscreen` → no grid, no shell (a live practice interview).
//
// `.dark-canvas` stays on the wrapper so pre-V3 pages still pick up the
// legacy retint rules in globals.css; `.v3-root` scopes the V3 scrollbars.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, type ReactNode } from 'react';

import { useAuth } from '../../../lib/auth/useAuth';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { CopilotRail } from '../../features/copilot/CopilotRail';
import { OutOfCreditsSheet } from '../../features/credits';
import { BrandSymbol } from '../../chrome/BrandSymbol';
import { Toaster } from '../primitives/Toast';
import { CommandPaletteProvider } from './CommandPalette';
import { LanguageSwitcher } from './LanguageSwitcher';
import { MobileNav } from './MobileNav';
import { Sidebar } from './Sidebar';
import { ThemeToggle } from './ThemeToggle';
import { Topbar } from './Topbar';
import styles from './shell.module.css';

/**
 * Static routes that sit beside /practice/[id] (Next.js matches them before
 * the dynamic segment), so they are pages with the shell, not live rooms.
 */
const PRACTICE_STATIC_SEGMENTS = new Set(['questions']);

/** /practice/[id] is the live room (full screen); its setup and report keep the shell. */
export function isPracticeLivePath(pathname: string): boolean {
  const m = /^\/practice\/([^/]+)\/?$/.exec(pathname);
  return !!m && !PRACTICE_STATIC_SEGMENTS.has(m[1]) && !pathname.endsWith('/report') && !pathname.includes('/custom/');
}

export interface AppShellProps {
  children: ReactNode;
  /** No rail, topbar or bottom bar (focused full-screen mode). */
  fullscreen?: boolean;
  /** Layout slots rendered once beside the frame (rail, modals, tour). */
  slots?: ReactNode;
}

export function AppShell({ children, fullscreen = false, slots }: AppShellProps) {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav');
  const mainRef = useRef<HTMLElement>(null);

  // The workspace scrolls inside main on desktop. Reset that region when the
  // destination changes; same-page setting anchors keep their own position.
  useEffect(() => {
    if (!window.location.hash) mainRef.current?.scrollTo?.(0, 0);
  }, [pathname]);

  if (fullscreen) {
    return (
      <div className="dark-canvas v3-root min-h-screen">
        <main id="main-content" tabIndex={-1} className="min-h-screen">
          {children}
        </main>
        {slots}
      </div>
    );
  }

  return (
    <CommandPaletteProvider>
      <div className="dark-canvas v3-root">
        <a className="workspace-skip" href="#main-content">
          {t('skip_content')}
        </a>
        <div className="app">
          {/* A direct grid child (248px). Hidden below 760px by v3.css. */}
          <Sidebar />
          <main className="main" id="main-content" tabIndex={-1} ref={mainRef}>
            <Topbar />
            <div className="main-inner">{children}</div>
          </main>
        </div>
        {/* Shown below 760px (same breakpoint as the grid collapse). */}
        <MobileNav />
        {slots}
        <Toaster />
      </div>
    </CommandPaletteProvider>
  );
}

export interface HybridShellProps {
  children: ReactNode;
  /** Page slug for signup attribution: CTAs go to /signup?from=<slug> (PRODUCT §3.2). */
  from?: string;
  /** Footer for the signed-out chrome (e.g. the legal footer). */
  footer?: ReactNode;
}

export function HybridShell({ children, from, footer }: HybridShellProps) {
  const { status } = useAuth();
  if (status === 'authenticated') {
    return (
      <AppShell
        slots={
          <>
            <CopilotRail />
            <OutOfCreditsSheet />
          </>
        }
      >
        {children}
      </AppShell>
    );
  }
  return (
    <MarketingChrome from={from} footer={footer}>
      {children}
    </MarketingChrome>
  );
}

/** Signup link carrying the page slug (and nothing personal). */
export function signupHref(from?: string): string {
  return from ? `/signup?from=${encodeURIComponent(from)}` : '/signup';
}

function MarketingChrome({ children, from, footer }: HybridShellProps) {
  const t = useTranslations('nav');
  const brand = useBrand();
  return (
    <div className={`v3-root ${styles.mkt}`} data-shell="marketing">
      <a className="workspace-skip" href="#main-content">
        {t('skip_content')}
      </a>
      <header className={styles.mktHeader}>
        <Link href="/" className={styles.mktBrand} aria-label={t('marketing.home_aria', { brand: brand.name })}>
          <BrandSymbol size={22} />
          <span>{brand.name}</span>
        </Link>
        <div className={styles.mktActions}>
          <ThemeToggle />
          <LanguageSwitcher />
          <Link href="/login" className={styles.mktLink}>
            {t('marketing.sign_in')}
          </Link>
          <Link href={signupHref(from)} className={styles.mktCta}>
            {t('marketing.get_started')}
          </Link>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className={styles.mktMain}>
        {children}
      </main>
      {footer}
      <Toaster />
    </div>
  );
}
