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
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useEffect, useRef, type ReactNode } from 'react';

import { useAuth } from '../../../lib/auth/useAuth';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { CopilotRail } from '../../features/copilot/CopilotRail';
import { OutOfCreditsSheet } from '../../features/credits';
// The marketing area's pure link builder, from its own file rather than the
// area index: the index also exports the home pages, which the app shell must
// not pull into every signed-in route's bundle (same reason as CopilotRail above).
import { buildSignupHref } from '../../features/marketing/links';
import { BrandSymbol } from '../../chrome/BrandSymbol';
import { Toaster } from '../primitives/Toast';
import { CommandPaletteProvider } from './CommandPalette';
import { LanguageSwitcher } from './LanguageSwitcher';
import { MobileNav } from './MobileNav';
import { Sidebar } from './Sidebar';
import { useSessionCleanupRegistration } from './signOutCleanup';
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

  // While the app shell is up, a session that dies (`auth_expired` in
  // lib/api/client.ts) forgets this device before it is cleared.
  useSessionCleanupRegistration();

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

/**
 * The job id of a public job page, `/job/<id>-<slug>` → `<id>` (twin of
 * lib/seo.ts `parseJobIdSlug`; that module loads every message bundle, which
 * the shell must not pull into the client). Null on every other path.
 */
export function publicJobIdFromPath(pathname: string): string | null {
  const m = /^\/job\/([^/?#]+)\/?$/.exec(pathname);
  if (!m) return null;
  let raw = m[1]!;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep the raw segment
  }
  const id = raw.split('-')[0] ?? '';
  return /^[A-Za-z0-9_]{1,64}$/.test(id) ? id : null;
}

/**
 * The header CTA's signup link (PRODUCT §3.2): `/signup?from=<slug>` plus the
 * `job`, `ref` and `utm_*` values of the page the visitor is on, built by the
 * marketing site's own `buildSignupHref` so every CTA on a public page agrees.
 * On a public job page the job is that page's id, whatever a stray `?job=`
 * says. Nothing else travels: no job title, no free text, no email address.
 */
export function signupHref(from?: string, location: { pathname?: string; search?: string | URLSearchParams | null } = {}): string {
  const params = new URLSearchParams(location.search ? location.search.toString().replace(/^\?/, '') : '');
  const jobId = publicJobIdFromPath(location.pathname ?? '');
  if (jobId) params.set('job', jobId);
  const href = buildSignupHref(from ?? 'site', params);
  if (from) return href;
  // No page slug given: carry the preserved values without inventing one.
  const query = new URLSearchParams(href.slice(href.indexOf('?') + 1));
  query.delete('from');
  const rest = query.toString();
  return rest ? `/signup?${rest}` : '/signup';
}

/**
 * "Get started" in the signed-out header. Reading the query string makes a
 * statically rendered page bail out to client rendering unless the reader
 * sits under Suspense, so the link that needs it is its own component and the
 * fallback is the same link without the carried values.
 */
function SignupCta({ from, label }: { from?: string; label: string }) {
  const pathname = usePathname() ?? '';
  const search = useSearchParams();
  return (
    <Link href={signupHref(from, { pathname, search: search ? search.toString() : null })} className={styles.mktCta} data-cta-from={from}>
      {label}
    </Link>
  );
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
          <Suspense
            fallback={
              <Link href={signupHref(from)} className={styles.mktCta} data-cta-from={from}>
                {t('marketing.get_started')}
              </Link>
            }
          >
            <SignupCta from={from} label={t('marketing.get_started')} />
          </Suspense>
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
