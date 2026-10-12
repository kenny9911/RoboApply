'use client';

// VisitorJobCard — one public job for a signed-out visitor (WP-78; F-FEED-16).
// Facts only, from the posting: title (opens the public job page), company,
// place, work model, pay as listed or "Pay not listed", posted / last checked,
// where we found it, and at most 3 badges that rest on real fields or quotes.
// No fit score, no tier, no "locked" score placeholder: there is no profile
// to compare with (D3). No apply button here: the public job page has the
// employer link, and the visitor applies there (D1).

import Link from 'next/link';
import { useId } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import type { FeedItem } from '../../../lib/api/contracts/feed';
import type { VisitorFeedItem } from '../../../lib/api/contracts/visitor';
import { cardBadges, companyInitial, payText, shortDate, sourceLine, type CardBadge } from '../feed';
import { visitorJobHref } from './model';
import styles from './visitor.module.css';

export interface VisitorJobCardProps {
  item: VisitorFeedItem;
  market: 'intl' | 'cn';
}

function asFeedItem(item: VisitorFeedItem): FeedItem {
  return { ...item, fit: null, tracker: null };
}

function Badge({ badge, locale }: { badge: CardBadge; locale: string }) {
  const t = useTranslations('visitor.card.badge');
  const tipId = useId();
  let label: string | null = null;
  let tip: string | null = null;
  switch (badge.kind) {
    case 'direct':
      label = t('direct');
      break;
    case 'agency':
      label = t('agency');
      break;
    case 'sponsorship':
      label = badge.status === 'offered' ? t('sponsorshipOffered') : t('sponsorshipNotOffered');
      tip = badge.quote;
      break;
    case 'clearance':
      label = t('clearance');
      tip = badge.quote;
      break;
    case 'citizens':
      label = t('citizens');
      tip = badge.quote;
      break;
    case 'closes': {
      const date = shortDate(badge.at, locale);
      label = date ? t('closes', { date }) : null;
      tip = badge.quote;
      break;
    }
    default:
      // Market tags and "new" need their own wording on the job page; the visitor card leaves them out.
      label = null;
  }
  if (!label) return null;
  return (
    <li className={styles.badge} title={tip ?? undefined} aria-describedby={tip ? tipId : undefined}>
      {label}
      {tip ? (
        <span id={tipId} className="sr-only">
          {tip}
        </span>
      ) : null}
    </li>
  );
}

export function VisitorJobCard({ item, market }: VisitorJobCardProps) {
  const t = useTranslations('visitor.card');
  const locale = useLocale();
  const feedItem = asFeedItem(item);
  const pay = payText(item.pay, {
    locale,
    market,
    range: (min, max) => t('range', { min, max }),
    from: (amount) => t('from', { amount }),
    upTo: (amount) => t('upTo', { amount }),
  });
  const payLine = pay ? (pay.period ? t(`payPeriod.${pay.period}`, { amount: pay.amount }) : pay.amount) : t('payNotListed');
  const posted = shortDate(item.postedAt, locale);
  const checked = shortDate(item.lastSeenAt, locale);
  const src = sourceLine(feedItem);
  const badges = cardBadges(feedItem);
  const href = visitorJobHref(item);

  return (
    <article className={styles.card} data-job-id={item.jobId}>
      <div className={styles.cardHead}>
        <span className={styles.logo} aria-hidden="true">
          {companyInitial(item.company.name)}
        </span>
        <div className={styles.cardTitles}>
          <h3 className={styles.cardTitle}>
            <Link href={href} className={styles.cardLink}>
              {item.title}
            </Link>
          </h3>
          <p className={styles.company}>{item.company.name}</p>
        </div>
      </div>
      <ul className={styles.facts}>
        <li>{item.location ?? t('placeNotListed')}</li>
        {item.workModel ? <li>{t(`workModel.${item.workModel}`)}</li> : null}
        <li className={pay ? undefined : styles.unknown}>{payLine}</li>
      </ul>
      <p className={styles.meta}>
        {posted ? t('posted', { date: posted }) : null}
        {posted && checked ? ' · ' : null}
        {checked ? t('lastChecked', { date: checked }) : null}
        {src && src.key !== 'user_import' ? (
          <>
            {posted || checked ? ' · ' : null}
            {src.key === 'bank' ? t('source.bank', { sourceName: src.sourceName }) : t(`source.${src.key}`, { name: src.name })}
          </>
        ) : null}
      </p>
      {badges.length ? (
        <ul className={styles.badges}>
          {badges.map((b, i) => (
            <Badge key={`${b.kind}-${i}`} badge={b} locale={locale} />
          ))}
        </ul>
      ) : null}
    </article>
  );
}
