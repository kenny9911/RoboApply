'use client';

// JobPage — the public job page (`/job/<id>-<slug>`, F-SEO-05 / F-JOB-09).
// Only what the posting states: pay when it lists pay ("Not listed"
// otherwise), the posted date unless it was estimated (then the date we
// first found it, labelled), a closing date only when the posting has one,
// the source by name. The posting text renders as plain text.
//
// D1: signed out, "Apply on company site" opens the employer's page and the
// page says the user applies there; signed in, the job opens in the app
// (`/jobs/<id>`), where applying is tracked with Undo (R-19).
//
// GoApply: <WechatShareCard> sets the card WeChat shows when the page is
// shared from inside WeChat — "{title} · {company}", the place and the pay as
// the post lists it (left out when it lists none; never 0), linking this
// public page (anyone can open it; the app's /jobs/<id> needs an account).
// It renders nothing and is inert outside WeChat.
//
// GoApply display rules (MARKET_STRATEGY 1.4): under the source, the date we
// last found the posting at its source ("Last checked {date}") and, on a
// GoHire bank posting, GoHire's HR-service licence when the API sends one
// (it does only when both licence values are configured). Both come from the
// API and are read with a null default, so an older response shows neither.
//
// Signed out, flag `visitorAssistant` (either brand): the visitor assistant's
// launcher (page-scoped public questions; nothing typed is stored). On
// GoApply the widget asks for the AI consent tick before the first question.

import Link from 'next/link';

import { useAuth } from '../../../lib/auth/useAuth';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { useFlag } from '../../../lib/flags';
import type { PublicJobDetail } from '../../../lib/api/contracts/seo';
import { WechatShareCard } from '../notify-cn';
import { VisitorAssistant } from '../visitor';
import { useSeoFormat } from './labels';
import styles from './seo.module.css';

export interface JobPageProps {
  job: PublicJobDetail;
  /** `/signup?from=job&job=<id>`. */
  signupHref: string;
}

function paragraphs(text: string | null): string[] {
  return (text ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function JobPage({ job, signupHref }: JobPageProps) {
  const { t, date, pay, workModel, employment } = useSeoFormat();
  const { status } = useAuth();
  const signedIn = status === 'authenticated';
  const brand = useBrand();
  const assistantOn = useFlag('visitorAssistant');
  const posted = date(job.postedAt);
  const closes = date(job.expiresAt);
  // Pay only as the posting lists it: its figures, else its own words. Null = it lists none.
  const payAsListed = pay(job.pay) ?? (job.salaryText?.trim() || null);
  const payLine = payAsListed ?? t('job.notListed');
  const cn = brand.market === 'cn';
  const lastChecked = cn ? date(job.lastVerifiedAt ?? null) : null;
  const licence = cn ? (job.licence ?? null) : null;
  const shareDescription = [job.location, payAsListed].map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean).join(' · ') || null;
  const sections: Array<[string, string | null]> = [
    ['job.about', job.descriptionPlain],
    ['job.responsibilities', job.responsibilities],
    ['job.qualifications', job.qualifications],
    ['job.benefits', job.benefits],
  ];

  return (
    <div className={styles.page} data-job-id={job.id}>
      {cn ? <WechatShareCard title={`${job.title} · ${job.company.name}`} description={shareDescription} path={job.canonicalPath} /> : null}
      <nav aria-label={t('breadcrumb.browse')}>
        <ol className={styles.crumbs}>
          <li>
            <Link href="/">{t('breadcrumb.home')}</Link>
          </li>
          <li aria-current="page">{job.title}</li>
        </ol>
      </nav>

      <header className={styles.intro}>
        <p className={styles.eyebrow}>{job.company.name}</p>
        <h1 className={styles.h1}>{job.title}</h1>
        {job.location ? <p className={styles.lede}>{job.location}</p> : null}
      </header>

      <div className={styles.jobLayout}>
        <div className={styles.prose}>
          {sections.map(([key, text]) => {
            const parts = paragraphs(text);
            if (!parts.length) return null;
            return (
              <section key={key} className={styles.section}>
                <h2 className={styles.h2}>{t(key as 'job.about')}</h2>
                {parts.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </section>
            );
          })}
        </div>

        <aside className={styles.section} aria-label={t('job.facts')}>
          <div className={styles.actions}>
            {signedIn ? (
              <Link className={styles.btnPrimary} href={`/jobs/${encodeURIComponent(job.id)}`}>
                {t('job.openInApp')}
              </Link>
            ) : (
              <>
                <a className={styles.btnPrimary} href={job.applyUrl} target="_blank" rel="noopener noreferrer nofollow">
                  {t('job.applyOnSite')}
                </a>
                <Link className={styles.btnSecondary} href={signupHref}>
                  {t('job.seeFit')}
                </Link>
              </>
            )}
            <p className={styles.note}>{t('job.applyNote')}</p>
          </div>

          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{t('job.pay')}</dt>
              <dd className={styles.factValue}>{payLine}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{t('job.location')}</dt>
              <dd className={styles.factValue}>{job.location ?? t('job.notListed')}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{t('job.workModel')}</dt>
              <dd className={styles.factValue}>{workModel(job.workModel) ?? t('job.notListed')}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{t('job.employment')}</dt>
              <dd className={styles.factValue}>{employment(job.employmentType) ?? t('job.notListed')}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{t('job.posted')}</dt>
              <dd className={styles.factValue}>{posted ?? t('job.postedUnknown', { date: date(job.firstSeenAt) ?? '—' })}</dd>
            </div>
            {closes ? (
              <div className={styles.fact}>
                <dt className={styles.factLabel}>{t('job.closes')}</dt>
                <dd className={styles.factValue}>{closes}</dd>
              </div>
            ) : null}
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{t('job.source')}</dt>
              <dd className={styles.factValue}>
                {job.sourceName ?? t('job.notListed')}
                {job.originalSourceName ? (
                  <>
                    <br />
                    {t('job.originalPublisher', { name: job.originalSourceName })}
                  </>
                ) : null}
                {job.sourceUrl ? (
                  <>
                    <br />
                    <a className={styles.inlineLink} href={job.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                      {t('job.viewOriginal')}
                    </a>
                  </>
                ) : null}
                {lastChecked ? (
                  <>
                    <br />
                    <span data-last-checked="">{t('job.lastChecked', { date: lastChecked })}</span>
                  </>
                ) : null}
                {licence ? (
                  <>
                    <br />
                    <span data-licence="">{t('job.licence', { holder: licence.holder, number: licence.number })}</span>
                  </>
                ) : null}
              </dd>
            </div>
          </dl>
        </aside>
      </div>

      {assistantOn && status === 'unauthenticated' ? (
        <VisitorAssistant
          from="job"
          pageContext={{
            path: job.canonicalPath.slice(0, 512),
            role: job.title.slice(0, 80),
            ...(job.city ? { city: job.city.slice(0, 80) } : {}),
            ...(job.country && /^[A-Za-z]{2}$/.test(job.country) ? { country: job.country.toUpperCase() } : {}),
          }}
        />
      ) : null}
    </div>
  );
}

/** Body of app/job/[idSlug]/not-found.tsx: closed, removed or unknown. */
export function JobNotFound() {
  const { t } = useSeoFormat();
  return (
    <div className={styles.page} data-seo-page="job-not-found">
      <div className={styles.empty}>
        <h1 className={styles.emptyTitle}>{t('job.notFound.title')}</h1>
        <p className={styles.note}>{t('job.notFound.body')}</p>
        <p>
          <Link className={styles.inlineLink} href="/">
            {t('job.notFound.home')}
          </Link>
        </p>
      </div>
    </div>
  );
}
