'use client';

// BrowsePage — a programmatic job list (`/browse/*`, WP-56; F-SEO-01/02/04/06/07,
// F-TOOL-05). Server data only (lib/server/publicApi.ts → GET /public/seo/page):
//   breadcrumb → title + intro built from the page's stats (every number from
//   `stats`, D3) → the stats with their source line → the sponsorship method
//   (sponsorship lists) → narrower lists → the latest jobs → signup → the
//   VisitorFeed below (rendered by the route, WP-78).
// Below the indexability floor the route marks the page noindex and this view
// says the list is short and links upward.

import Link from 'next/link';

import type { SeoLink, SeoPageResponse } from '../../../lib/api/contracts/seo';
import { SourceNote, SourcedValue } from '../common';
import { newestCount } from './BrowseHub';
import { JobCard } from './JobCard';
import { cityLabel, countryLabel, roleLabel, useSeoFormat } from './labels';
import { browseTitle } from './names';
import styles from './seo.module.css';

export interface BrowsePageProps {
  data: SeoPageResponse;
  /** `/signup?from=…` for the signup panel. */
  signupHref: string;
}

function useLinkLabel() {
  const { t, locale } = useSeoFormat();
  return (link: SeoLink): string => {
    switch (link.kind) {
      case 'hub':
        return t('browse.up.hub');
      case 'city':
        return t('browse.children.city', { city: cityLabel(link.city, locale) });
      case 'remote':
        return t('browse.children.remote');
      case 'graduate':
        return t('browse.children.graduate');
      default:
        return t('browse.up.role', { role: roleLabel(link.role, locale) });
    }
  };
}

export function BrowsePage({ data, signupHref }: BrowsePageProps) {
  const { t, locale, money } = useSeoFormat();
  const linkLabel = useLinkLabel();
  const title = browseTitle(data, locale);
  const h1 = t(`browse.title.${title.key as 'role'}`, title.params);
  const { stats, intro } = data;
  const count = stats.jobCount.value;
  const median = stats.medianPay;

  return (
    <div className={styles.page} data-seo-page={data.type} data-indexable={data.indexable ? 'true' : 'false'}>
      <nav aria-label={t('breadcrumb.browse')}>
        <ol className={styles.crumbs}>
          <li>
            <Link href="/">{t('breadcrumb.home')}</Link>
          </li>
          <li>
            <Link href="/browse">{t('breadcrumb.browse')}</Link>
          </li>
          {data.up.kind !== 'hub' ? (
            <li>
              <Link href={data.up.path}>{linkLabel(data.up)}</Link>
            </li>
          ) : null}
          <li aria-current="page">{h1}</li>
        </ol>
      </nav>

      <header className={styles.intro}>
        <p className={styles.eyebrow}>{t('browse.eyebrow')}</p>
        <h1 className={styles.h1}>{h1}</h1>
        {intro.template === 'empty' ? (
          <p className={styles.lede}>{t('browse.intro.empty')}</p>
        ) : (
          <p className={styles.lede}>
            {t('browse.intro.count', { count })} {t('browse.intro.new', { newLast7d: stats.newLast7d.value })}{' '}
            {t('browse.intro.pay', { payListed: stats.payListed.value })}
            {median ? ` ${t('browse.intro.median', { median: money(median.value.value, median.value.currency), sampleSize: median.sampleSize ?? 0 })}` : null}
          </p>
        )}
        {data.country ? (
          <p className={styles.note}>
            {t('browse.filtered', { country: countryLabel(data.country, locale) })}{' '}
            <Link className={styles.inlineLink} href={data.path}>
              {t('browse.showAll')}
            </Link>
          </p>
        ) : null}
        {!data.indexable && !data.country && count > 0 ? (
          <p className={styles.note}>
            {t('browse.short')}{' '}
            <Link className={styles.inlineLink} href={data.up.path}>
              {linkLabel(data.up)}
            </Link>
          </p>
        ) : null}
        {data.method ? <p className={styles.method}>{t('browse.method')}</p> : null}

        <dl className={styles.stats} aria-label={t('browse.stats.label')}>
          <div className={styles.stat}>
            <dt className={styles.statLabel}>{t('browse.stats.jobCount')}</dt>
            <dd className={styles.statValue}>
              <SourcedValue value={stats.jobCount} />
            </dd>
          </div>
          <div className={styles.stat}>
            <dt className={styles.statLabel}>{t('browse.stats.newLast7d')}</dt>
            <dd className={styles.statValue}>
              <SourcedValue value={stats.newLast7d} />
            </dd>
          </div>
          <div className={styles.stat}>
            <dt className={styles.statLabel}>{t('browse.stats.payListed')}</dt>
            <dd className={styles.statValue}>{t('browse.stats.payListedValue', { payListed: stats.payListed.value, count })}</dd>
          </div>
          <div className={styles.stat}>
            <dt className={styles.statLabel}>{t('browse.stats.medianPay')}</dt>
            <dd className={styles.statValue}>
              <SourcedValue value={median} format={(v) => money(v.value, v.currency)} />
            </dd>
            {median ? <SourceNote sourced={median} className={styles.sourceNote} /> : null}
          </div>
        </dl>
        <SourceNote sourced={stats.jobCount} className={styles.sourceNote} />
        {stats.topCompanies.length ? (
          <p className={styles.note}>
            {t('browse.stats.topCompanies')}: {stats.topCompanies.map((c) => t('browse.stats.companyCount', { name: c.name, count: c.count.value })).join(', ')}
          </p>
        ) : null}
      </header>

      {data.children.length ? (
        <section className={styles.section} aria-labelledby="seo-children">
          <h2 className={styles.h2} id="seo-children">
            {t('browse.children.title')}
          </h2>
          <ul className={styles.chips}>
            {data.children.map((c) => (
              <li key={c.path}>
                <Link className={styles.chip} href={c.path}>
                  {linkLabel(c)}
                  {c.jobCount ? <span className={styles.chipCount}>{t('browse.children.count', { count: c.jobCount.value })}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
          <SourceNote sourced={newestCount(data.children)} className={styles.sourceNote} />
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="seo-jobs">
        <h2 className={styles.h2} id="seo-jobs">
          {t('browse.jobsTitle')}
        </h2>
        {data.jobs.length ? (
          <ul className={styles.list}>
            {data.jobs.map((job) => (
              <li key={job.id}>
                <JobCard job={job} showQuote={data.type === 'sponsorship_role'} />
              </li>
            ))}
          </ul>
        ) : (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{t('browse.empty.title')}</p>
            <p className={styles.note}>{t('browse.empty.body')}</p>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.cta}>
          <div className={styles.ctaText}>
            <p className={styles.ctaTitle}>{t('browse.signup.title')}</p>
            <p className={styles.note}>{t('browse.signup.body')}</p>
          </div>
          <Link className={styles.btnPrimary} href={signupHref}>
            {t('browse.signup.cta')}
          </Link>
        </div>
      </section>
    </div>
  );
}
