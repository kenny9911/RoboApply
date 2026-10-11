'use client';

// JobHeader — company, title, practical facts, source and the job's actions
// (PRODUCT F-JOB-01, F-JOB-06/07). One primary action: "Apply on company
// site" (opens the employer's page; the job moves to Applied at once with an
// inline Undo — rulings R1/C11). D1: we never send anything; the user applies
// on the employer's page.
//
// GoApply: the job's market block (JobMetaCn, which the panel shows under the
// header on every tab) prints the pay as the post states it, the post's own
// date, "Last checked" and the source ("Added by you" for the user's own job).
// When it does, the header leaves its own pay, date and source lines out, so
// each fact is on the page once. "Only you can see this job" stays here.
//
// Dates are three separate facts (MARKET_STRATEGY 1.5): "Posted" is the
// employer's own date and nothing else; "First seen" is when we first read the
// posting (shown when the posting states no date, and beside a posted date
// that is more than a day from it); "Last checked" is when a source last
// confirmed the posting listed. "New" is the server's `isNew` (first seen by
// us in the last 48 hours), never the posted date. A provider's sponsorship
// reading is a badge that names the provider and is never worded as the
// posting's own statement.

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { cn } from '../../../lib/utils';
import { useBrand } from '../../../lib/brand';
import { marketMetaCoversBasics, marketPayWords } from '../market';
import type { JobDetailResponse } from '../../../lib/api/contracts/jobs/detail';
import { initialOf, jobDetailHref, payLine, validDate } from './format';
import styles from './job.module.css';

export interface JobHeaderProps {
  detail: JobDetailResponse;
  mode: 'split' | 'page';
  onClose?: () => void;
  /** The actions row (built by the panel, which owns the action state). */
  actions: ReactNode;
}

const DAY_MS = 86_400_000;

/**
 * The job's dates as the header prints them. A date we assigned
 * (`postedAtEstimated`) is never "posted": a server from before the three-date
 * wire sent our first-seen date as `postedAt`, so it is read as first seen.
 * First seen is left out beside a posted date of the same day (it would say
 * the same thing twice).
 */
export function headerDates(job: Pick<JobDetailResponse['job'], 'postedAt' | 'postedAtEstimated' | 'firstSeenAt' | 'lastSeenAt'>): { posted: Date | null; firstSeen: Date | null; checked: Date | null } {
  const posted = job.postedAtEstimated ? null : validDate(job.postedAt);
  const seen = validDate(job.firstSeenAt) ?? (job.postedAtEstimated ? validDate(job.postedAt) : null);
  const firstSeen = seen && posted && Math.abs(seen.getTime() - posted.getTime()) <= DAY_MS ? null : seen;
  return { posted, firstSeen, checked: validDate(job.lastSeenAt) };
}

const KNOWN_EMPLOYMENT = new Set(['full_time', 'part_time', 'contract', 'internship']);
const KNOWN_SENIORITY = new Set(['intern_newgrad', 'entry', 'mid', 'senior', 'lead_staff', 'director_exec']);

export function JobHeader({ detail, mode, onClose, actions }: JobHeaderProps) {
  const t = useTranslations('jobDetail');
  const format = useFormatter();
  const locale = useLocale();
  const brand = useBrand();
  const { job, company } = detail;
  const slotHasBasics = marketMetaCoversBasics(brand.market, detail.marketMeta);
  const ownImport = job.source.kind === 'user_import';
  const pay = payLine(job.pay, locale);
  // Pay in words by the market's rule: GoApply never prints 面议 (it reads "Pay not listed").
  const payWords = marketPayWords(brand.market, job);
  const { posted, firstSeen, checked } = headerDates(job);
  const fmt = (d: Date) => format.dateTime(d, { dateStyle: 'medium' });
  // Facts from the post (at most 3). "New" is ours and comes from `isNew`; an older server sent it in the list.
  const facts = job.badges.filter((b) => b.kind !== 'new').slice(0, 3);
  const isNew = job.isNew === true || (job.isNew === undefined && job.badges.some((b) => b.kind === 'new'));
  const badgeLabel = (b: (typeof facts)[number]): string | null => {
    switch (b.kind) {
      case 'direct_from_employer':
      case 'sponsorship':
        return t(`header.badge.${b.kind}`);
      case 'sponsorship_provider':
        // The provider's reading, in the provider's name; without a name nothing is shown.
        return b.provider?.trim() ? t('header.badge.sponsorship_provider', { provider: b.provider.trim() }) : null;
      case 'market_tag':
      case 'closing_soon':
        return b.label;
      default:
        return null;
    }
  };
  const shown = facts.map((b) => ({ badge: b, label: badgeLabel(b) })).filter((x): x is { badge: (typeof facts)[number]; label: string } => !!x.label);

  const chips: string[] = [];
  if (job.location) chips.push(job.location);
  if (job.workModel) chips.push(t(`header.workModel.${job.workModel}`));
  if (job.employmentType && KNOWN_EMPLOYMENT.has(job.employmentType)) chips.push(t(`header.employmentType.${job.employmentType}`));
  if (job.seniority && KNOWN_SENIORITY.has(job.seniority)) chips.push(t(`header.seniority.${job.seniority}`));

  const sourceLine = ownImport
    ? t('header.source.user_import')
    : job.source.name
      ? t(`header.source.${job.source.kind}`, { sourceName: job.source.name })
      : t('header.source.unknown');

  const TitleTag = mode === 'page' ? 'h1' : 'h2';
  const logo = company.logoUrl ?? null;

  return (
    <header className={styles.header} data-testid="job-header">
      <div className={styles.identity}>
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.logo} src={logo} alt="" width={48} height={48} />
        ) : (
          <span className={styles.logo} aria-hidden="true">
            {initialOf(company.name || job.companyName)}
          </span>
        )}
        <div className={styles.titles}>
          <p className={styles.company}>{company.name || job.companyName}</p>
          <TitleTag className={styles.title}>{job.title}</TitleTag>
        </div>
        {mode === 'split' ? (
          <Link className={styles.fullPageLink} href={jobDetailHref(job.id)} data-testid="job-full-page">
            {t('openFullPage')}
          </Link>
        ) : null}
        {mode === 'split' && onClose ? (
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label={t('close')}>
            {t('close')}
          </button>
        ) : null}
      </div>

      {chips.length ? (
        <ul className={styles.chips}>
          {chips.map((c) => (
            <li key={c} className={styles.chip}>
              {c}
            </li>
          ))}
        </ul>
      ) : null}

      {slotHasBasics ? null : pay ? (
        <p className={styles.pay} data-testid="job-pay">
          {pay.kind === 'exact'
            ? t('header.payExact', { amount: pay.amount, period: t(`header.period.${pay.period}`) })
            : pay.kind === 'range'
              ? t('header.payRange', { min: pay.min, max: pay.max, period: t(`header.period.${pay.period}`) })
              : pay.kind === 'from'
                ? t('header.payFrom', { min: pay.min, period: t(`header.period.${pay.period}`) })
                : t('header.payUpTo', { max: pay.max, period: t(`header.period.${pay.period}`) })}
        </p>
      ) : payWords ? (
        <p className={styles.pay} data-testid="job-pay">
          {t('header.payAsStated', { text: payWords })}
        </p>
      ) : (
        <p className={styles.payMissing} data-testid="job-pay">
          {t('header.payNotListed')}
        </p>
      )}

      {slotHasBasics && job.visibility !== 'private' ? null : (
        <p className={styles.meta}>
          {!slotHasBasics && posted ? <span data-testid="job-posted">{t('header.posted', { date: fmt(posted) })}</span> : null}
          {!slotHasBasics && firstSeen ? <span data-testid="job-first-seen">{t('header.firstSeen', { date: fmt(firstSeen) })}</span> : null}
          {!slotHasBasics && checked ? <span data-testid="job-last-checked">{t('header.lastChecked', { date: fmt(checked) })}</span> : null}
          {!slotHasBasics ? <span data-testid="job-source">{sourceLine}</span> : null}
          {!slotHasBasics && job.source.originalName && job.source.originalName !== job.source.name ? (
            <span>{t('header.originalSource', { sourceName: job.source.originalName })}</span>
          ) : null}
          {job.visibility === 'private' ? <span>{t('header.private')}</span> : null}
        </p>
      )}

      {isNew || shown.length ? (
        <ul className={styles.badges}>
          {isNew ? (
            <li className={styles.badge} data-badge="new">
              {t('header.badge.new')}
            </li>
          ) : null}
          {shown.map(({ badge: b, label }) => (
            <li
              key={b.kind}
              className={cn(styles.badge, b.kind === 'direct_from_employer' && styles.badgeOk)}
              title={b.quote ? t('header.quote', { quote: b.quote }) : undefined}
              data-badge={b.kind}
            >
              {label}
            </li>
          ))}
        </ul>
      ) : null}

      {actions}
    </header>
  );
}

/** The actions row, rendered by the panel into the header. */
export function JobHeaderActions({ children }: { children: ReactNode }) {
  const t = useTranslations('jobDetail.actions');
  return (
    <div className={styles.actions} role="group" aria-label={t('label')}>
      {children}
    </div>
  );
}

