'use client';

// components/features/growth/AnalyticsConsent.tsx — the analytics consent
// banner and the analytics bootstrap (TASK_PLAN.md WP-23, H28).
//
// Mounted once by app/layout.tsx with the visitor's country from the edge
// headers. On every page it:
//   1. configures lib/analytics.ts with the consent rule for this visitor
//      (RoboApply asks in the EEA, the UK and Switzerland, and when the
//      country is unknown; GoApply never shows the banner — its personal
//      information list covers event collection, WP-13);
//   2. records `page_viewed` on route changes and notes entry attribution;
//   3. where consent is required and no choice is stored, shows a docked,
//      non-modal banner. "Allow" and "Don't allow" carry identical weight.
//      Before a choice nothing is stored on the device and nothing is linked.
//
// The banner must never sit on top of the last thing on a page (the "Already
// have an account? Sign in" link of the sign-up card was covered at 1280×900).
// While it is open it publishes the room it takes at the bottom of the window
// as `--analytics-consent-h` on <html>; a page that ends near the bottom edge
// reserves that room (the sign-in layout, app/(public)/layout.tsx). On the
// two-column sign-in layout it docks under the brand panel instead of the
// form (growth.module.css).
//
// The banner appears once the page is idle, so it never competes with the
// first paint or becomes the page's largest element. It is a docked notice,
// not a modal, so it does not take the popup gate's one-per-view slot
// (lib/ui/popupGate.ts) and stays until the visitor chooses.
// `requestAnalyticsConsentReview()` (lib/analytics.ts) shows it again, for a
// "Privacy choices" link.

import { useEffect, useId, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand/BrandProvider';
import {
  captureAttribution,
  configureAnalytics,
  isAnalyticsConsentRequired,
  onAnalyticsConsentReview,
  readAnalyticsConsent,
  setAnalyticsConsent,
  track,
  type AnalyticsConsentChoice,
} from '../../../lib/analytics';
import { Btn } from '../../v3/primitives/Btn';
import styles from './growth.module.css';

export interface AnalyticsConsentProps {
  /** Visitor country from the edge headers (uppercase ISO-3166 alpha-2), or null. */
  country: string | null;
}

type IdleHandle = { cancel: () => void };

/** Run `fn` when the browser is idle (or soon after, where idle callbacks are missing). */
function whenIdle(fn: () => void): IdleHandle {
  const w = globalThis as typeof globalThis & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(fn, { timeout: 2000 });
    return { cancel: () => w.cancelIdleCallback?.(id) };
  }
  const id = setTimeout(fn, 200);
  return { cancel: () => clearTimeout(id) };
}

function referrerHost(): string | null {
  try {
    if (typeof document === 'undefined' || !document.referrer) return null;
    const host = new URL(document.referrer).host;
    return host && host !== location.host ? host : null;
  } catch {
    return null;
  }
}

export function AnalyticsConsent({ country }: AnalyticsConsentProps) {
  const brand = useBrand();
  const pathname = usePathname();
  const required = isAnalyticsConsentRequired(brand.market, country);
  const [open, setOpen] = useState(false);
  const firstView = useRef(true);

  useEffect(() => {
    configureAnalytics({ consentRequired: required });
    if (!required) return undefined;
    const idle = whenIdle(() => setOpen(readAnalyticsConsent() === null));
    const unsubscribe = onAnalyticsConsentReview(() => setOpen(true));
    return () => {
      idle.cancel();
      unsubscribe();
    };
  }, [required]);

  useEffect(() => {
    if (pathname === null) return;
    captureAttribution();
    const props: { locale?: string; referrerHost?: string } = {};
    if (typeof document !== 'undefined' && document.documentElement.lang) props.locale = document.documentElement.lang;
    if (firstView.current) {
      const host = referrerHost();
      if (host) props.referrerHost = host;
      firstView.current = false;
    }
    track('page_viewed', props);
  }, [pathname]);

  if (!open) return null;
  return (
    <ConsentBanner
      onChoose={(choice) => {
        setAnalyticsConsent(choice);
        setOpen(false);
      }}
    />
  );
}

/** The CSS variable that carries the room the open banner takes at the bottom of the window. */
export const CONSENT_RESERVE_VAR = '--analytics-consent-h';
/** Space kept between the banner and the content above it. */
const CONSENT_RESERVE_GAP = 12;

/**
 * Publishes how much of the window's bottom the banner covers (its height plus
 * its distance from the bottom edge) while it is mounted, and clears it after.
 */
function useConsentReserve(ref: { current: HTMLElement | null }): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    const publish = () => {
      const rect = el.getBoundingClientRect();
      // Not laid out (hidden, or no layout engine): nothing is covered.
      if (rect.height <= 0) return;
      const covered = Math.max(0, Math.ceil(window.innerHeight - rect.top));
      root.style.setProperty(CONSENT_RESERVE_VAR, `${covered + CONSENT_RESERVE_GAP}px`);
    };
    publish();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    window.addEventListener('resize', publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty(CONSENT_RESERVE_VAR);
    };
  }, [ref]);
}

function ConsentBanner({ onChoose }: { onChoose: (choice: AnalyticsConsentChoice) => void }) {
  const t = useTranslations('growth.consent');
  const titleId = useId();
  const bannerRef = useRef<HTMLElement | null>(null);
  useConsentReserve(bannerRef);
  return (
    <section ref={bannerRef} className={styles.consent} role="region" aria-label={t('regionLabel')} aria-describedby={titleId} data-analytics-consent="">
      <div className={styles.consentText}>
        <p id={titleId} className={styles.consentTitle}>
          {t('title')}
        </p>
        <p className={styles.consentBody}>
          {t('body')}{' '}
          <a className={styles.consentLink} href="/legal/privacy">
            {t('privacy')}
          </a>
        </p>
      </div>
      <div className={styles.consentActions}>
        <Btn className={styles.choice} onClick={() => onChoose('denied')}>
          {t('reject')}
        </Btn>
        <Btn className={styles.choice} onClick={() => onChoose('granted')}>
          {t('allow')}
        </Btn>
      </div>
    </section>
  );
}

export default AnalyticsConsent;
