'use client';

// components/features/brand/WrongBrandNudge.tsx — the wrong-market nudge
// (ARCHITECTURE.md §1.3, CN_TW_LAUNCH_PLAN.md §2.4, PRODUCT_PLAN.md §2,
// TASK_PLAN.md WP-12, catalog TW-01). It replaces geo-routing:
//   - RoboApply + visitor country CN (unless a zh-TW signal says the visitor
//     reads Traditional Chinese) → offer GoApply.
//   - GoApply + country TW/HK/MO, any other non-CN country, or a zh-TW
//     locale signal → offer RoboApply (in 繁體中文 for the Traditional cases).
//     A zh-TW signal includes the locale GoApply's /zh-TW → /zh clamp dropped
//     (`ra_clamped_from` cookie or `from_locale` query, set by the proxy).
// The rules are the pure `decideWrongBrandNudge()` in ./nudge.ts.
//
// Rules this component keeps:
//   - Never redirects. It is an inline banner with a link the visitor may
//     follow; it never changes the currency, the payment rail or the locale.
//   - It is not a modal, so it does not take the popup gate's slot.
//   - One dismissal sticks: in localStorage for every visitor and, for a
//     signed-in user, in RAUserUiState (`dismiss` key per brand) so it stays
//     dismissed on their other devices.
//   - Nothing renders until the dismissal state is known (no flash of a
//     banner the visitor already closed) and nothing renders on the server
//     (the browser's language signals only exist on the client).
//
// Mounted once by app/layout.tsx inside <Providers>.

import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { dismiss as dismissUi, getUiState } from '../../../lib/api/uiState';
import { useBrand } from '../../../lib/brand';
import { getCookieLocale } from '../../../lib/locale';
import { matchLocale } from '../../../lib/localeConfig';
import { BrandSymbol } from '../../chrome/BrandSymbol';
import styles from './brand.module.css';
import {
  CLAMPED_FROM_COOKIE,
  CLAMPED_FROM_QUERY,
  decideWrongBrandNudge,
  nudgeDismissKey,
  nudgeStorageKey,
  type NudgeDecision,
  type NudgeReason,
} from './nudge';

export interface WrongBrandNudgeProps {
  /** Visitor country from the edge headers (uppercase ISO-3166 alpha-2), or null. */
  country: string | null;
  /** The resolved UI locale of this request. */
  locale: string;
}

type Phase = 'pending' | 'show' | 'hidden';


/** Title and body per reason (literal keys, so the copy gate can resolve them). */
function copyFor(reason: NudgeReason, t: (key: string) => string): { title: string; body: string } {
  switch (reason) {
    case 'country_cn':
      return { title: t('to_cn.title'), body: t('to_cn.body') };
    case 'country_outside_cn':
      return { title: t('to_intl.title'), body: t('to_intl.body') };
    case 'region_traditional':
    case 'locale_zh_tw':
      return { title: t('to_traditional.title'), body: t('to_traditional.body') };
  }
}

function readLocalDismissal(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function writeLocalDismissal(key: string): void {
  try {
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Storage blocked (private mode): the dismissal lasts this page view.
  }
}

/** The browser's first language we serve, if any. */
function browserLocale(): string | null {
  if (typeof navigator === 'undefined') return null;
  const tags = navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
  return matchLocale(tags);
}

/**
 * The locale a redirect dropped (GoApply clamps `/zh-TW/*` to `/zh/*`): the
 * `ra_clamped_from` cookie or the `from_locale` query parameter, whichever the
 * proxy sets. Null when neither is present or readable.
 */
function clampedFromLocale(): string | null {
  try {
    const row = document.cookie.split('; ').find((r) => r.startsWith(`${CLAMPED_FROM_COOKIE}=`));
    if (row) return decodeURIComponent(row.slice(CLAMPED_FROM_COOKIE.length + 1));
  } catch {
    // Cookies blocked: fall through to the query.
  }
  try {
    return new URLSearchParams(window.location.search).get(CLAMPED_FROM_QUERY);
  } catch {
    return null;
  }
}

export function WrongBrandNudge({ country, locale }: WrongBrandNudgeProps) {
  const brand = useBrand();
  const [decision, setDecision] = useState<NudgeDecision | null>(null);
  const [phase, setPhase] = useState<Phase>('pending');
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const next = decideWrongBrandNudge({
      brand,
      country,
      locale,
      preferredLocales: [getCookieLocale(), clampedFromLocale(), browserLocale()],
    });
    setDecision(next);
    if (!next || readLocalDismissal(nudgeStorageKey(brand.id))) {
      setPhase('hidden');
      return;
    }
    // Signed-in users carry the dismissal across devices; a visitor without a
    // session gets a 401 here and sees the banner.
    getUiState()
      .then((res) => {
        if (cancelled) return;
        setSignedIn(true);
        const dismissed = Boolean(res?.state?.dismissals?.[nudgeDismissKey(brand.id)]);
        if (dismissed) writeLocalDismissal(nudgeStorageKey(brand.id));
        setPhase(dismissed ? 'hidden' : 'show');
      })
      .catch(() => {
        if (!cancelled) setPhase('show');
      });
    return () => {
      cancelled = true;
    };
  }, [brand, country, locale]);

  const onDismiss = useCallback(() => {
    setPhase('hidden');
    writeLocalDismissal(nudgeStorageKey(brand.id));
    if (signedIn) dismissUi([nudgeDismissKey(brand.id)]).catch(() => {});
  }, [brand.id, signedIn]);

  if (phase !== 'show' || !decision) return null;
  return (
    <NudgeBoundary>
      <NudgeBanner decision={decision} onDismiss={onDismiss} />
    </NudgeBoundary>
  );
}

/** The banner itself; mounted only once there is something to show. */
function NudgeBanner({ decision, onDismiss }: { decision: NudgeDecision; onDismiss: () => void }) {
  const t = useTranslations('brand.nudge');
  const copy = copyFor(decision.reason, t);
  return (
    <aside className={styles.nudge} aria-label={t('region_label')} data-testid="wrong-brand-nudge" data-reason={decision.reason}>
      <div className={styles.nudgeInner}>
        <span className={styles.nudgeMark} aria-hidden="true">
          <BrandSymbol size={16} brand={decision.target.id} />
        </span>
        <p className={styles.nudgeText}>
          <span className={styles.nudgeTitle}>{copy.title}</span>
          <span className={styles.nudgeBody}>{copy.body}</span>
        </p>
        <div className={styles.nudgeActions}>
          <a className={styles.nudgeCta} href={decision.href} hrefLang={decision.targetLocale}>
            {t('cta')}
          </a>
          <button type="button" className={styles.nudgeDismiss} onClick={onDismiss}>
            {t('dismiss')}
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * The nudge sits above every page in the root layout: if it ever fails to
 * render (a missing provider, a bad bundle), it disappears instead of taking
 * the page down with it.
 */
class NudgeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default WrongBrandNudge;
