'use client';

// VisitorFeed — the signed-out job list on public pages (TASK_PLAN.md WP-78;
// F-FEED-16; ruling C26). WP-56's browse pages render it under their
// server-rendered list:
//
//   <VisitorFeed from="browse" query={{ role, city, country }} />
//
//   - Data: GET /api/v1/public/feed (lib/api/visitor `getPublicFeed`):
//     at most 20 public jobs (`publicDisplay`, re-checked against the public
//     page rules), no fit, cached 15 min by the server.
//   - After the list (at most 20 cards) comes the signup gate. A visitor
//     never sees a score: fit needs a resume.
//   - "Get new jobs like these by email" links to /tools/job-alerts with the
//     same search when logged-out alerts are on (`jobs.alerts` + `notify.email`).
//   - The visitor assistant launcher (flag `visitorAssistant`, off by default
//     on both brands) answers about this page only; it is not shown to
//     signed-in people (they have the Assistant). On GoApply the widget asks
//     for the AI consent tick before the first question.
//   - Capability `jobs.feed` off (GoApply with CN_RECRUITMENT_INFO_MODE=off) →
//     nothing renders (R-04: a disabled feature has no UI entry).

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';

import { getPublicFeed } from '../../../lib/api/visitor';
import type { PublicFeedItem } from '../../../lib/api/contracts/feed';
import type { VisitorFeedItem, VisitorFeedResponse } from '../../../lib/api/contracts/visitor';
import { useAuth } from '../../../lib/auth/useAuth';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { useFlag } from '../../../lib/flags';
import { Btn } from '../../v3/primitives';
import { VisitorAssistant } from './VisitorAssistant';
import { VisitorJobCard } from './VisitorJobCard';
import { VISITOR_FEED_LIMIT, alertsHref, signupHref } from './model';
import styles from './visitor.module.css';

export interface VisitorFeedQuery {
  role?: string;
  city?: string;
  /** ISO-3166 alpha-2, uppercase. */
  country?: string;
}

export interface VisitorFeedProps {
  /** The page's own filter (role, city, country). */
  query?: VisitorFeedQuery;
  /** Signup attribution slug for the gate's CTA (`/signup?from=<from>`). */
  from: string;
  /** Items the server already rendered for this query, to skip the first fetch. */
  initialItems?: readonly PublicFeedItem[];
}

function cleanQuery(q: VisitorFeedQuery = {}): VisitorFeedQuery {
  const out: VisitorFeedQuery = {};
  if (q.role?.trim()) out.role = q.role.trim().slice(0, 80);
  if (q.city?.trim()) out.city = q.city.trim().slice(0, 80);
  if (q.country && /^[A-Z]{2}$/.test(q.country)) out.country = q.country;
  return out;
}

export function visitorFeedQueryKey(brandId: string, q: VisitorFeedQuery): readonly unknown[] {
  return ['visitor', 'feed', brandId, q.role ?? '', q.city ?? '', q.country ?? ''] as const;
}

export function VisitorFeed({ query, from, initialItems }: VisitorFeedProps) {
  const t = useTranslations('visitor');
  const locale = useLocale();
  const brand = useBrand();
  const pathname = usePathname() ?? '/';
  const { status } = useAuth();
  const feedOn = useFlag('jobs.feed');
  const alertsFlag = useFlag('jobs.alerts');
  const emailFlag = useFlag('notify.email');
  const alertsOn = alertsFlag && emailFlag;
  const assistantOn = useFlag('visitorAssistant');
  const headingId = useId();
  const q = cleanQuery(query);

  const initialData: VisitorFeedResponse | undefined = initialItems
    ? { items: initialItems.slice(0, VISITOR_FEED_LIMIT).map((i) => ({ ...i, path: null })), asOf: '' }
    : undefined;
  const feed = useQuery<VisitorFeedResponse>({
    queryKey: visitorFeedQueryKey(brand.id, q),
    queryFn: () => getPublicFeed(q),
    enabled: feedOn,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    ...(initialData ? { initialData } : {}),
  });

  if (!feedOn) return null;

  const items: VisitorFeedItem[] = (feed.data?.items ?? []).slice(0, VISITOR_FEED_LIMIT);
  const signedIn = status === 'authenticated';
  const asOf = feed.data?.asOf ? new Date(feed.data.asOf) : null;
  const asOfText =
    asOf && Number.isFinite(asOf.getTime()) ? new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' }).format(asOf) : null;

  return (
    <section className={styles.feed} aria-labelledby={headingId} data-visitor-feed={from}>
      <header className={styles.feedHead}>
        <h2 id={headingId} className={styles.h2}>
          {t('feed.title')}
        </h2>
        <p className={styles.body}>{t('feed.sub')}</p>
        {!signedIn ? <p className={styles.muted}>{t('feed.fitNote')}</p> : null}
      </header>

      {feed.isPending ? (
        <p className={styles.muted} role="status">
          {t('feed.loading')}
        </p>
      ) : feed.isError ? (
        <div className={styles.notice} role="alert">
          <p className={styles.body}>{t('feed.error')}</p>
          <Btn onClick={() => void feed.refetch()}>{t('feed.retry')}</Btn>
        </div>
      ) : items.length === 0 ? (
        <p className={styles.body} data-empty="true">
          {t('feed.empty')}
        </p>
      ) : (
        <>
          <ul className={styles.list} aria-label={t('feed.listLabel')}>
            {items.map((item) => (
              <li key={item.jobId}>
                <VisitorJobCard item={item} market={brand.market} />
              </li>
            ))}
          </ul>
          {asOfText ? <p className={styles.muted}>{t('feed.asOf', { time: asOfText })}</p> : null}
        </>
      )}

      {signedIn ? (
        <div className={styles.gate} data-gate="signed-in">
          <Link href="/jobs" className={styles.gateCta}>
            {t('gate.openJobs')}
          </Link>
        </div>
      ) : (
        <div className={styles.gate} data-gate="signup">
          <h3 className={styles.gateTitle}>{t('gate.title')}</h3>
          <p className={styles.body}>{t('gate.body')}</p>
          <div className={styles.gateActions}>
            <Link href={signupHref(from)} className={styles.gateCta}>
              {t('gate.cta')}
            </Link>
            <Link href={`/login?next=${encodeURIComponent(pathname)}`} className={styles.gateSecondary}>
              {t('gate.login')}
            </Link>
          </div>
        </div>
      )}

      {alertsOn && !signedIn ? (
        <Link href={alertsHref(q)} className={styles.alertsLink} data-alerts-link="true">
          {t('feed.alertsLink')}
        </Link>
      ) : null}

      {assistantOn && status === 'unauthenticated' ? <VisitorAssistant pageContext={{ path: pathname.slice(0, 512), ...q }} from={from} /> : null}
    </section>
  );
}

export default VisitorFeed;
