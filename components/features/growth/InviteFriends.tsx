'use client';

// InviteFriends — /invite (PRODUCT_PLAN.md F-GROW-01; TASK_PLAN.md WP-60).
//
// The person's invite link, how the reward works, this year's rewards and the
// friends who joined (no names: "Friend joined {date}" and a status). The
// reward size, the yearly cap and every count come from the server
// (`InvitesResponse`), never from copy. Rewards are practice credits with no
// cash value; nothing is asked in return (F-GROW-02 is SKIP). Links to the
// invite terms (/legal/referral-terms). Hidden behind the `invites`
// capability and a brand whose every sign-up attaches the invite
// (`useInvitesLive`; the server answers `not_available` otherwise): then the
// page only says invites are not available (there is no nav entry then).

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { useInvites, useInvitesLive } from '../../../hooks/growth/useInvites';
import { track } from '../../../lib/analytics';
import type { InviteViewStatus, InvitesResponse } from '../../../lib/api/contracts/growth';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { Btn, EmptyState, PageHeader } from '../../v3/primitives';
import { InviteLinkBox } from './InviteLinkBox';
import styles from './invite.module.css';

export const REFERRAL_TERMS_HREF = '/legal/referral-terms';

const BADGE: Record<InviteViewStatus, string> = {
  signed_up: styles.badgeWait ?? '',
  checking: styles.badgeWait ?? '',
  rewarded: styles.badgeGood ?? '',
  over_limit: styles.badge ?? '',
  not_counted: styles.badge ?? '',
};

export function InviteProgress({ view }: { view: InvitesResponse }) {
  const t = useTranslations('invite.progress');
  const { granted, capPerYear, year } = view.rewards;
  const pct = capPerYear > 0 ? Math.min(100, Math.round((granted / capPerYear) * 100)) : 0;
  return (
    <section className={styles.section} aria-labelledby="invite-progress">
      <h2 className={styles.title} id="invite-progress">
        {t('title', { year })}
      </h2>
      <p className={styles.body}>{t('count', { granted, cap: capPerYear })}</p>
      <div className={styles.meter} role="meter" aria-label={t('meterLabel')} aria-valuemin={0} aria-valuemax={capPerYear} aria-valuenow={granted}>
        <div className={styles.meterFill} style={{ width: `${pct}%` }} />
      </div>
      <p className={styles.muted}>{granted >= capPerYear ? t('reached') : t('limitNote', { cap: capPerYear })}</p>
    </section>
  );
}

export function InviteFriendsList({ view }: { view: InvitesResponse }) {
  const t = useTranslations('invite.friends');
  const format = useFormatter();
  return (
    <section className={styles.section} aria-labelledby="invite-friends">
      <h2 className={styles.title} id="invite-friends">
        {t('title')}
      </h2>
      {view.invites.length === 0 ? (
        <p className={styles.body}>{t('empty')}</p>
      ) : (
        <ul className={styles.list} data-testid="invite-friends">
          {view.invites.map((inv, i) => (
            <li key={`${inv.at}-${i}`} className={styles.item}>
              <div className={styles.itemText}>
                <p className={styles.itemTitle}>{t('joined', { date: format.dateTime(new Date(inv.at), { dateStyle: 'medium' }) })}</p>
                <p className={styles.muted}>{t(`statusHelp.${inv.status}`)}</p>
              </div>
              <span className={BADGE[inv.status]}>{t(`status.${inv.status}`)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={styles.muted}>{t('privacy')}</p>
    </section>
  );
}

export function InviteFriends() {
  const t = useTranslations('invite');
  const market = useBrand().market;
  const enabled = useInvitesLive();
  const q = useInvites({ enabled });
  const viewed = useRef(false);

  useEffect(() => {
    if (!q.data || viewed.current) return;
    viewed.current = true;
    track('invite_viewed', { from: 'invite_page', eligible: q.data.eligibility === 'ok' });
  }, [q.data]);

  if (!enabled || q.data?.eligibility === 'not_available') {
    return (
      <div className={styles.page}>
        <EmptyState title={t('page.unavailable')} />
      </div>
    );
  }

  const credits = q.data?.reward.credits ?? null;

  return (
    <div className={styles.page} data-testid="invite-page">
      <PageHeader title={t('page.title')} sub={credits !== null ? t('page.sub', { credits }) : undefined} />

      {q.isError ? (
        <div className={styles.section}>
          <p className={styles.error} role="alert">
            {t('page.loadError')}
          </p>
          <div className={styles.actions}>
            <Btn className={styles.btn} onClick={() => void q.refetch()}>
              {t('page.retry')}
            </Btn>
          </div>
        </div>
      ) : null}

      {q.data ? (
        <>
          <InviteLinkBox view={q.data} from="invite_page" />

          <section className={styles.hero} aria-labelledby="invite-how">
            <h2 className={styles.title} id="invite-how">
              {t('how.title')}
            </h2>
            <ol className={styles.steps}>
              <li>{t('how.step1')}</li>
              <li>{t('how.step2', { market })}</li>
              <li>{t('how.step3', { credits: q.data.reward.credits })}</li>
            </ol>
          </section>

          <InviteProgress view={q.data} />
          <InviteFriendsList view={q.data} />
        </>
      ) : null}

      <p className={styles.muted}>
        {t('honesty')}{' '}
        <Link className={styles.link} href={REFERRAL_TERMS_HREF} data-testid="invite-terms">
          {t('terms')}
        </Link>
      </p>
    </div>
  );
}

export default InviteFriends;
