'use client';

// GoApply home (`/`, `/en`) — TASK_PLAN.md WP-40, PRODUCT §1.2/§3.2,
// F-MKT-01/02 (cn), F-TOOL-05 (cn campus link-out).
//
//   少填表、不错过截止、面试不慌 → three pillars → 校招日历 preview (only when
//   the `jobs.campusCalendar` capability is on; R-14) → AI面试 practice →
//   free-core statement → FAQ → final CTA. The ICP / 公安备案 / licence lines
//   come from the legal footer (WP-13) and show only when configured.
//
// AI practice (the interview pillar, the hero clause and the practice
// section) shows only while `ai.text` is on: GoApply's AI stays off until a
// domestic model and content safety are configured (R-13), and a disabled
// feature has no UI entry (R-04). "Paid plans are not open yet" shows only
// while /billing/plans says so (R-15).
//
// Never names an AI-interview vendor; never claims voice practice (GoApply's
// `ai.interviewVoice` is off); never claims auto-submission.

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';

import { usePlans } from '../../../hooks/credits/usePlans';
import { listPublicCampusEvents } from '../../../lib/api/campus';
import { CN_HOME_FAQ_KEYS } from './catalog';
import { useMarketingFlag } from './hooks';
import { Faq } from './Sections';
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
  const date = (iso: string | null) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? format.dateTime(d, { dateStyle: 'medium' }) : null;
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

export function GoApplyHome() {
  const t = useTranslations('landing.cnHome');
  const tc = useTranslations('landing.cta');
  const ai = useMarketingFlag('ai.text');
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

      <section className={styles.section} id="features" aria-labelledby="cn-pillars-title">
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

      <CampusPreview />

      {ai ? (
        <section className={styles.section} aria-labelledby="cn-practice-title" data-cn-practice="">
          <div className={`${styles.wrap} ${styles.narrow}`}>
            <h2 className={styles.h2} id="cn-practice-title">
              {t('practice.title')}
            </h2>
            <p className={styles.body}>{t('practice.sub')}</p>
            <div className={`${styles.actions} ${styles.spaced}`}>
              <SignupLink from="home:practice" variant="secondary">
                {t('practice.cta')}
              </SignupLink>
            </div>
          </div>
        </section>
      ) : null}

      <section className={styles.sectionAlt} id="free" aria-labelledby="cn-free-title">
        <div className={`${styles.wrap} ${styles.narrow}`}>
          <h2 className={styles.h2} id="cn-free-title">
            {t('free.title')}
          </h2>
          <p className={styles.body}>{t('free.body')}</p>
          {plans.data?.paymentsOpen === false ? <p className={styles.body}>{t('free.notOpen')}</p> : null}
          <div className={`${styles.actions} ${styles.spaced}`}>
            <Link className={styles.inlineLink} href="/pricing">
              {t('free.pricing')}
            </Link>
          </div>
        </div>
      </section>

      <Faq id="faq" title={t('faq.title')} items={CN_HOME_FAQ_KEYS.map((k) => ({ q: t(`faq.${k}.q`), a: t(`faq.${k}.a`) }))} />

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
