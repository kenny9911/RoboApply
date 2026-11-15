'use client';

// WaitingList — "Waiting for you" on /today (docs/agent-driven/REDESIGN.md §5.2).
//
// At most four cards, most urgent first (todayModel.waitingOf). Each card is
// one fact and one action (ruling C11). The first card's action is the
// screen's only primary button; every other action is a default button.
//
// D1: no card applies or submits. "Check and open" and "Open application" go
// to the application's own page, where the user opens the employer's site and
// submits there.
// D3: nothing is listed until every read behind the list has answered; a read
// that failed is said plainly and never turns into "Nothing needs you".

import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { IconArrow, IconCheck, IconClock, IconFile, IconInfo, IconPerson, IconSettings } from '../../v3/primitives';
import { NO_REPLY_DAYS } from '../../../hooks/tracker/useApplicationsBadge';
import { kitHref } from '../agent';
import { verifyDetailsHref } from '../resume';
import { FailedNote } from './parts';
import type { WaitingItem, WaitingKind, WaitingState } from './todayModel';
import styles from './today.module.css';

/** The anchor of the Job search lane (the empty line points at the picks). */
export const PICKS_ANCHOR = 'today-job-search';

/** Where a card's one action goes. Pure. */
export function waitingHref(item: WaitingItem): string {
  switch (item.kind) {
    case 'review':
    case 'open':
      return kitHref(item.jobId);
    case 'verify':
      // The session that made the version re-opens the tailor flow on Verify details; without one, the resume itself.
      return item.sessionId ? verifyDetailsHref(item.sessionId) : `/resume/${encodeURIComponent(item.resumeId)}`;
    case 'no_reply':
      return '/applications';
    case 'profile':
      return '/profile';
    case 'no_resume':
      return '/resume';
    case 'setup':
      // The same place "Finish setting up" has always gone (onboarding FinishSetupBanner).
      return '/onboarding';
  }
}

const ACTION_KEY: Record<WaitingKind, string> = {
  review: 'review',
  open: 'open',
  verify: 'verify',
  no_reply: 'noReply',
  profile: 'profile',
  no_resume: 'noResume',
  setup: 'setup',
};

const TILE: Record<WaitingKind, { tone: string; icon: ReactNode }> = {
  review: { tone: 'sage', icon: <IconCheck size={18} /> },
  open: { tone: 'mint', icon: <IconArrow size={18} /> },
  verify: { tone: 'camel', icon: <IconInfo size={18} /> },
  no_reply: { tone: 'sky', icon: <IconClock size={18} /> },
  profile: { tone: 'lilac', icon: <IconPerson size={18} /> },
  no_resume: { tone: 'blush', icon: <IconFile size={18} /> },
  setup: { tone: 'clay', icon: <IconSettings size={18} /> },
};

function WaitingCard({ item, first }: { item: WaitingItem; first: boolean }) {
  const t = useTranslations('today');
  const factId = useId();

  const fact = (): string => {
    switch (item.kind) {
      case 'review':
      case 'open':
        if (item.title && item.company) return t(`waiting.fact.${item.kind}`, { title: item.title, company: item.company });
        if (item.title) return t(`waiting.fact.${item.kind}Title`, { title: item.title });
        return t(`waiting.fact.${item.kind}Unnamed`);
      case 'verify':
        return t('waiting.fact.verify', { count: item.count, name: item.name });
      case 'no_reply':
        return t('waiting.fact.noReply', { count: item.count, days: NO_REPLY_DAYS });
      case 'profile':
        return t('waiting.fact.profile', { count: item.count });
      case 'no_resume':
        return t('waiting.fact.noResume');
      case 'setup':
        return t('waiting.fact.setup', { count: item.count });
    }
  };

  const tile = TILE[item.kind];
  return (
    <li className={styles.card} data-first={first || undefined} data-kind={item.kind} data-testid="waiting-card">
      <span className={styles.tile} data-tone={tile.tone} aria-hidden="true">
        {tile.icon}
      </span>
      <p id={factId} className={styles.fact}>
        {fact()}
      </p>
      {/* The fact names the job; several cards may share one action word, so the link is described by its fact. */}
      <Link href={waitingHref(item)} className={`btn${first ? ' primary' : ''} ${styles.action}`} aria-describedby={factId} data-testid="waiting-action">
        {t(`waiting.action.${ACTION_KEY[item.kind]}`)}
      </Link>
    </li>
  );
}

export interface WaitingListProps {
  waiting: WaitingState;
  /** The Job search lane has picks to point at when nothing waits. */
  picksBelow: boolean;
}

export function WaitingList({ waiting, picksBelow }: WaitingListProps) {
  const t = useTranslations('today');
  const titleId = useId();
  const loading = waiting.status === 'loading';

  return (
    <section className={styles.waiting} aria-labelledby={titleId} aria-busy={loading || undefined} data-testid="today-waiting">
      <h2 id={titleId} className={styles.sectionTitle}>
        {t('waiting.title')}
      </h2>

      {loading ? (
        <div role="status">
          <span className={styles.srOnly}>{t('waiting.loading')}</span>
          <div className={styles.skeletons} aria-hidden="true">
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
          </div>
        </div>
      ) : waiting.shown.length > 0 ? (
        <ul className={styles.cards}>
          {waiting.shown.map((item, i) => (
            <WaitingCard key={item.key} item={item} first={i === 0} />
          ))}
        </ul>
      ) : waiting.partial ? null : (
        // One calm line. Nothing is invented to fill the space.
        <p className={styles.calm} data-testid="waiting-empty">
          {picksBelow ? (
            <>
              <span>{t('waiting.empty')}</span>
              <a className={styles.link} href={`#${PICKS_ANCHOR}`}>
                {t('waiting.emptyLink')}
              </a>
            </>
          ) : (
            <span>{t('waiting.emptyPlain')}</span>
          )}
        </p>
      )}

      {!loading && waiting.more > 0 ? (
        <p className={styles.note} data-testid="waiting-more">
          {t('waiting.more', { count: waiting.more })}
        </p>
      ) : null}
      {!loading && waiting.partial ? <FailedNote message={t('waiting.partial')} onRetry={waiting.retry} /> : null}
    </section>
  );
}
