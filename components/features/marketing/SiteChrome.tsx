'use client';

// The marketing chrome of the home pages (WP-40): header with the brand
// wordmark (never a literal product name; carry-over WP-12 R4), primary nav,
// language + theme, Sign in and the signup CTA; and the site footer every
// marketing page carries (feature links, company, help, the /cancel link
// (WP-21b), popular job lists when browse pages are live, the per-brand legal
// footer with the ICP line on GoApply (WP-13), and the locale links).

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { useBrand } from '../../../lib/brand';
import { SEO_READY_LOCALES, LOCALE_LABELS, isLocaleIn, localePath } from '../../../lib/localeConfig';
import { LanguageMenu } from '../../landing/LanguageMenu';
import { ThemeToggle } from '../../v3/shell/ThemeToggle';
import { BrandWordmark } from '../brand';
import { CancelFooterLink } from '../credits';
import { LegalFooter } from '../market';
import { featuresFor, extensionStoreId, type FeatureDef } from './catalog';
import { useBrowseEnabled, useIndexStats, useMarketingFlag } from './hooks';
import { popularListHref } from './links';
import { SignupLink } from './SignupLink';
import styles from './marketing.module.css';

export function SiteHeader({ from }: { from: string }) {
  const t = useTranslations('landing.site.nav');
  return (
    <header className={styles.header}>
      <div className={`${styles.wrap} ${styles.headerRow}`}>
        <BrandWordmark size="md" />
        <nav className={styles.nav} aria-label={t('label')}>
          <a className={styles.navLink} href="/#features">
            {t('features')}
          </a>
          <Link className={styles.navLink} href="/pricing">
            {t('pricing')}
          </Link>
          <Link className={styles.navLink} href="/help">
            {t('help')}
          </Link>
        </nav>
        <div className={styles.headerActions}>
          <LanguageMenu label={t('label')} />
          <ThemeToggle className={`icon-btn ${styles.hideSmall}`} />
          <Link className={styles.navLink} href="/login">
            {t('signIn')}
          </Link>
          {/* Below 760 px the hero's CTA sits right under the header. */}
          <SignupLink from={from} size="sm" className={styles.hideSmall}>
            {t('getStarted')}
          </SignupLink>
        </div>
      </div>
    </header>
  );
}

/** Whether a gated feature may be linked/shown right now (fail closed). */
export function useFeatureVisible(def: Pick<FeatureDef, 'gate' | 'brand'>): boolean {
  const flagKey = def.gate === 'extensionPublished' ? 'extension' : def.gate;
  const flagOn = useMarketingFlag((flagKey ?? 'extension') as never);
  if (def.gate === null) return true;
  if (def.gate === 'extensionPublished') return flagOn && extensionStoreId(def.brand) !== null;
  return flagOn;
}

function FeatureFooterLink({ def }: { def: FeatureDef }) {
  const t = useTranslations(`landing.features.${def.brand}.${def.key}`);
  const visible = useFeatureVisible(def);
  if (!visible) return null;
  return (
    <li>
      <Link className={styles.footerLink} href={`/features/${def.slug}`}>
        {t('eyebrow')}
      </Link>
    </li>
  );
}

function PopularLists() {
  const t = useTranslations('landing.site.footer');
  const browse = useBrowseEnabled();
  const brand = useBrand();
  const { data } = useIndexStats();
  const lists = data?.popularLists ?? [];
  if (!browse || lists.length === 0) return null;
  return (
    <div>
      <p className={styles.footerTitle}>{t('popularTitle')}</p>
      <ul className={styles.footerLinks}>
        {lists.map((l) => (
          <li key={l.taxonomyId}>
            <Link className={styles.footerLink} href={popularListHref(l.taxonomyId)}>
              {brand.market === 'cn' ? l.labelZh : l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface MarketingFooterProps {
  /** Show the crawlable locale links (the home pages' hreflang cluster). */
  localeLinks?: boolean;
}

/** The site footer. Its <footer> landmark is LegalFooter's (a footer may not nest another). */
export function MarketingFooter({ localeLinks = false }: MarketingFooterProps) {
  const t = useTranslations('landing.site.footer');
  const brand = useBrand();
  const features = featuresFor(brand.id);
  const locales = brand.seoLocales.filter((l) => isLocaleIn(l, SEO_READY_LOCALES));
  return (
    <div className={styles.footer} data-marketing-footer="">
      <div className={styles.wrap}>
        <nav className={styles.footerGrid} aria-label={t('label')}>
          <div>
            <BrandWordmark href={null} size="md" />
            <p className={`${styles.muted} ${styles.footerTagline}`}>
              {brand.market === 'cn' ? t('taglineCn') : t('tagline')}
            </p>
          </div>
          <div>
            <p className={styles.footerTitle}>{t('productTitle')}</p>
            <ul className={styles.footerLinks}>
              {features.map((def) => (
                <FeatureFooterLink key={def.slug} def={def} />
              ))}
              <li>
                <Link className={styles.footerLink} href="/pricing">
                  {t('pricing')}
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <p className={styles.footerTitle}>{t('companyTitle')}</p>
            <ul className={styles.footerLinks}>
              <li>
                <Link className={styles.footerLink} href="/about">
                  {t('about')}
                </Link>
              </li>
              <li>
                <Link className={styles.footerLink} href="/security">
                  {t('security')}
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <p className={styles.footerTitle}>{t('helpTitle')}</p>
            <ul className={styles.footerLinks}>
              <li>
                <Link className={styles.footerLink} href="/help">
                  {t('help')}
                </Link>
              </li>
              <li>
                <Link className={styles.footerLink} href="/help/ranking">
                  {t('ranking')}
                </Link>
              </li>
              <li>
                <CancelFooterLink className={styles.footerLink} />
              </li>
            </ul>
          </div>
          <PopularLists />
        </nav>
        <div className={styles.footerBottom}>
          {localeLinks && locales.length > 1 ? (
            <nav aria-label={t('langTitle')} className={styles.localeLinks}>
              {locales.map((code) => (
                <a key={code} className={styles.footerLink} href={localePath(code, brand.defaultLocale)} hrefLang={code} lang={code}>
                  {LOCALE_LABELS[code]}
                </a>
              ))}
            </nav>
          ) : null}
          <LegalFooter variant="marketing" />
          <p className={styles.muted}>{t('copyright', { year: new Date().getUTCFullYear() })}</p>
        </div>
      </div>
    </div>
  );
}

/** Header + main + footer for the brand home pages. */
export function SitePage({ from, children, localeLinks }: { from: string; children: ReactNode; localeLinks?: boolean }) {
  const t = useTranslations('nav');
  return (
    <div className={`v3-root ${styles.page}`} data-shell="marketing-home">
      <a className={styles.skip} href="#main-content">
        {t('skip_content')}
      </a>
      <SiteHeader from={from} />
      <main id="main-content" tabIndex={-1} className={styles.main}>
        {children}
      </main>
      <MarketingFooter localeLinks={localeLinks} />
    </div>
  );
}
