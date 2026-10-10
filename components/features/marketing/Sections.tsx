'use client';

// Shared marketing sections (WP-40): FAQ list, the labelled Example sample,
// the index counters, quick search and the pricing summary.
//
// Honesty (D3, PRODUCT §9.3): samples always carry the "Example" label and a
// note that the data is made up; counters render only real counts from the
// API (rounded down, source + "updated hourly"), and nothing when unknown;
// prices come only from GET /billing/plans.

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { usePlans } from '../../../hooks/credits/usePlans';
import { useBrand } from '../../../lib/brand';
import { formatMoney } from '../../../lib/pricing';
import { SourceNote } from '../common';
import { useBrowseEnabled, useIndexStats, useSignupHref } from './hooks';
import { HERO_COUNT_MIN, browseHref } from './links';
import { SignupLink } from './SignupLink';
import styles from './marketing.module.css';

// ── FAQ ─────────────────────────────────────────────────────────────────

export interface FaqItem {
  q: string;
  a: string;
}

export function Faq({ title, items, id }: { title: string; items: FaqItem[]; id?: string }) {
  return (
    <section className={styles.section} id={id} aria-labelledby={id ? `${id}-title` : undefined}>
      <div className={`${styles.wrap} ${styles.narrow}`}>
        <h2 className={styles.h2} id={id ? `${id}-title` : undefined}>
          {title}
        </h2>
        <div className={styles.faq}>
          {items.map((item) => (
            <article key={item.q} className={styles.faqItem}>
              <h3>{item.q}</h3>
              <p className={styles.body}>{item.a}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Example frame ─────────────────────────────────────────────────────────

/** A sample box that always says "Example" and that its data is made up. */
export function ExampleFrame({ title, children, tabs }: { title: string; children: ReactNode; tabs?: ReactNode }) {
  const t = useTranslations('landing.example');
  return (
    <figure className={styles.sample} data-example="" aria-label={`${t('label')}: ${title}`}>
      <div className={styles.sampleHead}>
        <span className={styles.h3}>{title}</span>
        <span className={styles.exampleChip}>{t('label')}</span>
      </div>
      {tabs}
      <div className={styles.sampleBody}>{children}</div>
      <figcaption className={styles.sampleNote}>{t('note')}</figcaption>
    </figure>
  );
}

const SAMPLE_TABS = ['find', 'understand', 'fix', 'practice'] as const;
type SampleTab = (typeof SAMPLE_TABS)[number];

/** The home page's interactive Example: one made-up job through the four verbs. */
export function HomeExample() {
  const t = useTranslations('landing.home.sample');
  const [tab, setTab] = useState<SampleTab>('understand');
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const tabs = (
    <div className={styles.tabs} role="tablist" aria-label={t('tabsLabel')}>
      {SAMPLE_TABS.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          id={`${baseId}-${key}`}
          aria-selected={tab === key}
          aria-controls={panelId}
          className={styles.tab}
          onClick={() => setTab(key)}
        >
          {t(`tabs.${key}`)}
        </button>
      ))}
    </div>
  );
  return (
    <ExampleFrame title={t('title')} tabs={tabs}>
      <div role="tabpanel" id={panelId} aria-labelledby={`${baseId}-${tab}`} className={styles.form}>
        <p className={styles.sampleRole}>
          {t('role')} · {t('company')}
        </p>
        {tab === 'find' ? (
          <>
            <p className={styles.sampleLine}>{t('find.line1')}</p>
            <p className={styles.sampleLine}>{t('find.line2')}</p>
            <p className={styles.sampleOverlap}>{t('find.line3')}</p>
          </>
        ) : null}
        {tab === 'understand' ? (
          <>
            <p className={styles.sampleGap}>{t('understand.gap')}</p>
            <p className={styles.sampleOverlap}>{t('understand.overlap')}</p>
            <p className={styles.muted}>{t('understand.fitLine')}</p>
          </>
        ) : null}
        {tab === 'fix' ? (
          <>
            <p className={styles.sampleLine}>{t('fix.line1')}</p>
            <p className={styles.sampleGap}>{t('fix.line2')}</p>
          </>
        ) : null}
        {tab === 'practice' ? (
          <>
            <p className={styles.sampleLine}>{t('practice.line1')}</p>
            <p className={styles.sampleLine}>{t('practice.line2')}</p>
            <p className={styles.sampleOverlap}>{t('practice.line3')}</p>
          </>
        ) : null}
      </div>
    </ExampleFrame>
  );
}

// ── Index counters ──────────────────────────────────────────────────────

/**
 * Real counts from the public index, rounded down to 2 significant figures by
 * the API, cached hourly. Hidden while unknown and below HERO_COUNT_MIN.
 */
export function IndexCounters() {
  const t = useTranslations('landing.home.counters');
  const format = useFormatter();
  const { data } = useIndexStats();
  const open = data?.openRoles ?? null;
  if (!open || open.value < HERO_COUNT_MIN) return null;
  const week = data?.addedThisWeek ?? null;
  return (
    <section className={styles.section} aria-labelledby="index-counters-title" data-index-counters="">
      <div className={styles.wrap}>
        <h2 className={styles.h2} id="index-counters-title">
          {t('title')}
        </h2>
        <div className={styles.counters}>
          <p className={styles.counterValue}>{t('openRoles', { count: format.number(open.value) })}</p>
          {week && week.value > 0 ? <p className={styles.counterValue}>{t('addedThisWeek', { count: format.number(week.value) })}</p> : null}
        </div>
        <p className={styles.sourceNote}>{t('method')}</p>
        <SourceNote sourced={open} className={styles.sourceNote} />
      </div>
    </section>
  );
}

// ── Quick search ─────────────────────────────────────────────────────────

/**
 * Title, country, city, remote. Routes to the public browse page when browse
 * pages are live (`seo.browse`), to signup otherwise (PRODUCT F-MKT-02).
 * Nothing typed here goes into the signup URL.
 */
export function QuickSearch({ countries }: { countries: readonly string[] }) {
  const t = useTranslations('landing.search');
  const router = useRouter();
  const locale = useLocale();
  const browse = useBrowseEnabled();
  const signup = useSignupHref('home:search');
  const [role, setRole] = useState('');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [remote, setRemote] = useState(false);
  const [error, setError] = useState(false);
  const ids = useId();
  const names = (() => {
    try {
      return new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      return null;
    }
  })();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!browse) {
      router.push(signup);
      return;
    }
    const href = browseHref({ role, city, country, remote });
    if (!href) {
      setError(true);
      return;
    }
    setError(false);
    router.push(href);
  }

  return (
    <section className={styles.section} aria-labelledby={`${ids}-title`}>
      <div className={styles.wrap}>
        <h2 className={styles.h2} id={`${ids}-title`}>
          {t('title')}
        </h2>
        <form className={styles.searchForm} onSubmit={submit} role="search" aria-labelledby={`${ids}-title`} noValidate>
          <label className={styles.field}>
            <span className={styles.label}>{t('role')}</span>
            <input
              className={styles.input}
              name="role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder={t('rolePlaceholder')}
              autoComplete="off"
              maxLength={80}
              aria-invalid={error || undefined}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{t('country')}</span>
            <select className={styles.select} name="country" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">{t('anyCountry')}</option>
              {countries.map((c) => (
                // Region names come from the runtime's own locale data, which differs between
                // Node and browsers ("Hong Kong SAR China" vs "Hong Kong"): keep the server text.
                <option key={c} value={c} suppressHydrationWarning>
                  {names?.of(c) ?? c}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{t('city')}</span>
            <input
              className={styles.input}
              name="city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder={t('cityPlaceholder')}
              autoComplete="off"
              maxLength={60}
              disabled={remote}
            />
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
            {t('remote')}
          </label>
          <button type="submit" className={styles.ctaPrimary}>
            {t('submit')}
          </button>
        </form>
        {error ? (
          <p className={styles.error} role="alert">
            {t('roleRequired')}
          </p>
        ) : null}
        {!browse ? <p className={styles.muted}>{t('signupNote')}</p> : null}
      </div>
    </section>
  );
}

// ── Pricing summary (home) ───────────────────────────────────────────────

/** Free + the preselected Pro plan, priced from GET /billing/plans. */
export function PricingSummary({ from }: { from: string }) {
  const t = useTranslations('landing.home.pricing');
  const tc = useTranslations('credits');
  const tnav = useTranslations('landing.cta');
  const locale = useLocale();
  const brand = useBrand();
  const { data } = usePlans();
  const pro = data?.plans.find((p) => p.key === (data.defaultSelection ?? 'pro_monthly')) ?? null;
  const proPrice =
    pro && pro.amountMinor !== null
      ? tc(`price.${pro.kind === 'subscription' ? (pro.interval === 'week' ? 'week' : pro.interval === 'quarter' ? 'quarter' : 'month') : 'once'}`, {
          price: formatMoney(locale, pro.amountMinor, pro.currency),
        })
      : null;
  return (
    <section className={styles.sectionAlt} id="pricing" aria-labelledby="home-pricing-title">
      <div className={styles.wrap}>
        <div className={styles.sectionHead}>
          <p className={styles.eyebrow}>{t('eyebrow')}</p>
          <h2 className={styles.h2} id="home-pricing-title">
            {t('title')}
          </h2>
          <p className={styles.body}>{t('sub')}</p>
        </div>
        <div className={styles.grid2}>
          <article className={styles.card}>
            <h3 className={styles.h3}>{tc(`plans.${brand.id}.free`)}</h3>
            <p className={styles.price}>{formatMoney(locale, 0, brand.currency)}</p>
            <p className={styles.body}>{t('freeNote')}</p>
            <SignupLink from={from} variant="secondary">
              {tnav('start')}
            </SignupLink>
          </article>
          <article className={`${styles.card} ${styles.cardFeatured}`}>
            <h3 className={styles.h3}>{pro ? tc(`plans.${brand.id}.${pro.key}`) : '—'}</h3>
            <p className={styles.price}>{proPrice ?? t('notSet')}</p>
            <p className={styles.body}>{t('proNote')}</p>
            <a className={styles.inlineLink} href="/pricing">
              {t('seeAll')}
            </a>
          </article>
        </div>
      </div>
    </section>
  );
}
