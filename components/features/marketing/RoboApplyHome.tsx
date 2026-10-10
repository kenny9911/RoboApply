'use client';

// RoboApply home (`/`, `/{locale}`) — TASK_PLAN.md WP-40, PRODUCT §3.2, F-MKT-01/02.
//
//   hero (gap first, ruling R2; the "{count}+ open roles" clause only when the
//   public index holds ≥ 1,000 jobs) → labelled interactive Example → the four
//   verbs → feature links → real counters → the job ticker slot → quick
//   search → pricing summary → FAQ (FAQPage JSON-LD is rendered by the page) →
//   final CTA.
//
// `ticker` is a server-rendered slot: the route passes <JobTicker /> (the
// newest jobs we may show publicly, each a real posting with the time we found
// it). It renders nothing when there are none — never a placeholder row.
//
// No testimonials, no user counts, no static stats, no competitor names or
// prices. Every CTA → /signup?from=home… preserving job/ref/utm_*.

import type { ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand';
import { HOME_FAQ_KEYS } from './catalog';
import { useIndexStats } from './hooks';
import { heroCount } from './links';
import { Faq, FeatureGrid, HomeExample, IndexCounters, PricingSummary, QuickSearch } from './Sections';
import { SignupLink } from './SignupLink';
import { SitePage } from './SiteChrome';
import styles from './marketing.module.css';

const VERBS = ['find', 'understand', 'fix', 'practice'] as const;

export function HomeHeroSub() {
  const t = useTranslations('landing.home.hero');
  const format = useFormatter();
  const { data } = useIndexStats();
  const count = heroCount(data?.openRoles);
  return (
    <p className={styles.heroSub} data-hero-count={count ?? ''}>
      {count !== null ? t('subCount', { count: format.number(count) }) : t('subPlain')}
    </p>
  );
}

export interface RoboApplyHomeProps {
  /** The live job ticker, rendered on the server by the route (components/features/seo/server). */
  ticker?: ReactNode;
}

export function RoboApplyHome({ ticker = null }: RoboApplyHomeProps = {}) {
  const t = useTranslations('landing.home');
  const tc = useTranslations('landing.cta');
  const brand = useBrand();
  return (
    <SitePage from="home" localeLinks>
      <section className={styles.hero} aria-labelledby="home-title">
        <div className={`${styles.wrap} ${styles.heroGrid}`}>
          <div>
            <p className={styles.eyebrow}>{t('hero.eyebrow')}</p>
            <h1 className={styles.heroTitle} id="home-title">
              {t('hero.headline')}
            </h1>
            <HomeHeroSub />
            <div className={styles.actions}>
              <SignupLink from="home:hero">{tc('start')}</SignupLink>
              <a className={styles.ctaSecondary} href="#how">
                {t('hero.ctaSecondary')}
              </a>
            </div>
            <p className={styles.reassure}>{t('hero.reassure')}</p>
          </div>
          <HomeExample />
        </div>
      </section>

      <section className={styles.section} id="how" aria-labelledby="home-verbs-title">
        <div className={styles.wrap}>
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>{t('verbs.eyebrow')}</p>
            <h2 className={styles.h2} id="home-verbs-title">
              {t('verbs.title')}
            </h2>
          </div>
          <ol className={`${styles.grid4} ${styles.plainList}`}>
            {VERBS.map((key, i) => (
              <li key={key} className={styles.card}>
                <span className={styles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
                <h3 className={styles.h3}>{t(`verbs.${key}.title`)}</h3>
                <p className={styles.body}>{t(`verbs.${key}.body`)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <FeatureGrid />

      <IndexCounters />
      {ticker}
      <QuickSearch countries={brand.countries} />
      <PricingSummary from="home:pricing" />
      <Faq id="faq" title={t('faq.title')} items={HOME_FAQ_KEYS.map((k) => ({ q: t(`faq.${k}.q`), a: t(`faq.${k}.a`) }))} />

      <section className={styles.sectionAlt} aria-labelledby="home-final-title">
        <div className={`${styles.wrap} ${styles.narrow}`}>
          <h2 className={styles.h2} id="home-final-title">
            {t('final.title')}
          </h2>
          <p className={styles.body}>{t('final.sub')}</p>
          <div className={`${styles.actions} ${styles.spaced}`}>
            <SignupLink from="home:final">{tc('createAccount')}</SignupLink>
          </div>
        </div>
      </section>
    </SitePage>
  );
}
