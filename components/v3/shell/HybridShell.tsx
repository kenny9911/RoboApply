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
// The signed-in frame is AppShell (./AppShell.tsx). It is loaded only once a
// session is known: a signed-out visitor downloads the marketing chrome, not
// the sidebar, topbar, command palette, assistant rail and credits sheet.
// While that chunk loads, the marketing chrome stays up, exactly as it does
// while the session itself is loading.

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, lazy, type ReactNode } from 'react';

import { useAuth } from '../../../lib/auth/useAuth';
import { useBrand } from '../../../lib/brand/BrandProvider';
// The marketing area's pure link builder, from its own file rather than the
// area index: the index also exports the home pages, which every page using
// this shell would otherwise download.
import { buildSignupHref } from '../../features/marketing/links';
import { BrandSymbol } from '../../chrome/BrandSymbol';
import { Toaster } from '../primitives/Toast';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ThemeToggle } from './ThemeToggle';
import styles from './shell.module.css';

const HybridAppFrame = lazy(() => import('./AppShell').then((m) => ({ default: m.HybridAppFrame })));

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
      <Suspense
        fallback={
          <MarketingChrome from={from} footer={footer}>
            {children}
          </MarketingChrome>
        }
      >
        <HybridAppFrame>{children}</HybridAppFrame>
      </Suspense>
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
