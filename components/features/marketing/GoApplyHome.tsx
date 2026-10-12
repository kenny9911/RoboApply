'use client';

// GoApply home (`/`, `/en`) — TASK_PLAN.md WP-40, PRODUCT §1.2/§3.2,
// F-MKT-01/02 (cn), F-TOOL-05 (cn campus link-out); owner ruling D5.
//
//   少填表、不错过截止、面试不慌 → three pillars → the feature cards → real
//   counters → the job ticker slot → quick search → 校招日历 preview → AI面试
//   practice → the pricing summary (free core + the preselected pass) → FAQ →
//   final CTA.
//
// The same visitor functions as the RoboApply home, over GoApply's own data
// (D5): the counters, the ticker and the quick search read the `market = 'cn'`
// index, the prices come from GET /billing/plans (CNY passes), the cards come
// from GoApply's feature catalog. What differs is the market's own: the copy,
// the campus calendar, one country.
//
// Honesty (D3): the counters and the ticker render only real rows and nothing
// when the index is empty or small; the campus preview lists only published
// programmes; no number is ever a placeholder. `ticker` is a server-rendered
// slot: the route passes <JobTicker />, which renders nothing without public
// jobs. The ICP / 公安备案 / licence lines come from the legal footer (WP-13)
// and show only when configured.
//
// Capabilities (R-04: a disabled feature has no UI entry): the campus preview
// needs `jobs.campusCalendar`; AI practice (the interview pillar, the hero
// clause and the practice section) needs `ai.text`, which is on by default on
// GoApply and off only when the operator turned AI off; the line about
// speaking with an AI interviewer needs `ai.interviewVoice`. "Paid plans are
// not open yet" shows only while /billing/plans says `paymentsOpen: false`.
//
// Listed jobs (`jobs.feed`, on by default; the operator's
// CN_RECRUITMENT_INFO_MODE=off turns it off): the counters are a number, so
// they show only once the capability is known to be on. The ticker, the quick
// search, the "Where do the jobs come from?" question and the job-matches
// card are part of the page as the server sends it and are removed once the
// capability is known to be off. The ticker's API also answers empty in that
// mode, and the route leaves that question out of the FAQ JSON-LD
// (`cnHomeFaqKeys(false)`), so structured data never says more than the page.
//
// Never names an AI-interview vendor; never claims that an application is
// submitted for the user (D1).

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';

import { usePlans } from '../../../hooks/credits/usePlans';
import { listPublicCampusEvents } from '../../../lib/api/campus';
import { useBrand } from '../../../lib/brand';
import { CAMPUS_TIME_ZONE } from '../campus/format';
import { cnHomeFaqKeys } from './catalog';
import { useMarketingFlag, useMarketingFlagOff } from './hooks';
import { Faq, FeatureGrid, IndexCounters, PricingSummary, QuickSearch } from './Sections';
import { SignupLink } from './SignupLink';
import { SitePage } from './SiteChrome';
import styles from './marketing.module.css';

const PILLARS = ['forms', 'deadlines', 'interview'] as const;
/** At most this many programmes in the preview. */
export const CAMPUS_PREVIEW_MAX = 5;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '—';
  }
}

/** 校招日历 preview: open programmes with their closing date, source and last check. */
export function CampusPreview() {
  const t = useTranslations('landing.cnHome.campus');
  const format = useFormatter();
  const on = useMarketingFlag('jobs.campusCalendar');
  const query = useQuery({
    queryKey: ['marketing', 'campus-preview'],
    queryFn: ({ signal }) => listPublicCampusEvents({ openNow: 'true' }, { signal }),
    enabled: on,
    staleTime: 15 * 60 * 1000,
    retry: false,
  });
  if (!on) return null;
  const items = (query.data?.items ?? []).slice(0, CAMPUS_PREVIEW_MAX);
  // Campus dates are Beijing-time dates: formatting in the viewer's zone would
  // show the day before west of it, and change the text after hydration.
  const date = (iso: string | null) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? format.dateTime(d, { dateStyle: 'medium', timeZone: CAMPUS_TIME_ZONE }) : null;
  };
  return (
    <section className={styles.sectionAlt} aria-labelledby="campus-preview-title" data-campus-preview="">
      <div className={styles.wrap}>
        <div className={styles.sectionHead}>
          <h2 className={styles.h2} id="campus-preview-title">
            {t('title')}
          </h2>
          <p className={styles.body}>{t('sub')}</p>
        </div>
        {query.isSuccess && items.length === 0 ? <p className={styles.muted}>{t('empty')}</p> : null}
        {items.length > 0 ? (
          <ul className={styles.campusList}>
            {items.map((ev) => {
              const closes = date(ev.applyClosesAt);
              return (
                <li key={ev.id} className={styles.campusItem}>
                  <span className={styles.h3}>
                    {ev.companyName} · {ev.title}
                  </span>
                  <span className={styles.body}>{closes ? t('closes', { date: closes }) : t('noDate')}</span>
                  <span className={styles.muted}>
                    {t('source', { source: ev.sourceName ?? hostOf(ev.officialUrl), date: date(ev.verifiedAt) ?? '—' })}
                    {ev.needsReverify ? ` · ${t('needsCheck')}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className={`${styles.actions} ${styles.spaced}`}>
          <Link href="/campus" className={styles.ctaSecondary}>
            {t('open')}
          </Link>
        </div>
      </div>
    </section>
  );
}

export interface GoApplyHomeProps {
  /** The live job ticker, rendered on the server by the route (components/features/seo/server). */
  ticker?: ReactNode;
}

export function GoApplyHome({ ticker = null }: GoApplyHomeProps = {}) {
  const t = useTranslations('landing.cnHome');
  const tc = useTranslations('landing.cta');
  const brand = useBrand();
  const ai = useMarketingFlag('ai.text');
  const voice = useMarketingFlag('ai.interviewVoice');
  const feedOn = useMarketingFlag('jobs.feed');
  const feedOff = useMarketingFlagOff('jobs.feed');
  const plans = usePlans();
  const pillars = PILLARS.filter((key) => key !== 'interview' || ai);
  return (
    <SitePage from="home">
      <section className={styles.hero} aria-labelledby="cn-home-title">
        <div className={`${styles.wrap} ${styles.narrow}`}>
          <p className={styles.eyebrow}>{t('hero.eyebrow')}</p>
          <h1 className={styles.heroTitle} id="cn-home-title">
            {t('hero.headline')}
          </h1>
          <p className={styles.heroSub}>{ai ? t('hero.sub') : t('hero.subNoAi')}</p>
          <div className={styles.actions}>
            <SignupLink from="home:hero">{tc('start')}</SignupLink>
            <a className={styles.ctaSecondary} href="#free">
              {t('hero.ctaSecondary')}
            </a>
          </div>
          <p className={styles.reassure}>{t('hero.reassure')}</p>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="cn-pillars-title">
        <div className={styles.wrap}>
          <h2 className={styles.h2} id="cn-pillars-title">
            {t('pillars.title')}
          </h2>
          <ul className={`${styles.grid3} ${styles.plainList}`}>
            {pillars.map((key) => (
              <li key={key} className={styles.card}>
                <h3 className={styles.h3}>{t(`pillars.${key}.title`)}</h3>
                <p className={styles.body}>{t(`pillars.${key}.body`)}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <FeatureGrid />

      {feedOn ? <IndexCounters /> : null}
      {feedOff ? null : ticker}
      {feedOff ? null : (
        <QuickSearch countries={brand.countries} examples={{ role: t('search.rolePlaceholder'), city: t('search.cityPlaceholder') }} />
      )}

      <CampusPreview />

      {ai ? (
        <section className={styles.section} aria-labelledby="cn-practice-title" data-cn-practice="">
          <div className={`${styles.wrap} ${styles.narrow}`}>
            <h2 className={styles.h2} id="cn-practice-title">
              {t('practice.title')}
            </h2>
            <p className={styles.body}>{t('practice.sub')}</p>
            {voice ? (
              <p className={styles.body} data-cn-practice-voice="">
                {t('practice.voice')}
              </p>
            ) : null}
            <div className={`${styles.actions} ${styles.spaced}`}>
              <SignupLink from="home:practice" variant="secondary">
                {t('practice.cta')}
              </SignupLink>
            </div>
          </div>
        </section>
      ) : null}

      <PricingSummary from="home:pricing" ns="landing.cnHome.pricing" id="free" note={plans.data?.paymentsOpen === false ? t('pricing.notOpen') : null} />

      <Faq id="faq" title={t('faq.title')} items={cnHomeFaqKeys(!feedOff).map((k) => ({ q: t(`faq.${k}.q`), a: t(`faq.${k}.a`) }))} />

      <section className={styles.sectionAlt} aria-labelledby="cn-final-title">
        <div className={`${styles.wrap} ${styles.narrow}`}>
          <h2 className={styles.h2} id="cn-final-title">
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
