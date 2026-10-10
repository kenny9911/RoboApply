'use client';

// InviteLanding — /r/[code], where an invite link lands (F-GROW-01; WP-60).
//
// Says who it is for (new accounts), what both people get and what the
// friend has to do, then sends them to signup with `?ref=<code>&from=invite`.
// Only where the programme runs (`useInvitesLive`: the `invites` capability
// and a brand whose every sign-up attaches the invite); elsewhere it is a
// plain "create an account" page with no reward promise. The code is not
// looked up before signup, so the copy says the credit applies if the link is
// still active rather than claiming a friend is behind it.
// The signup pages carry `ref` through /login ⇄ /signup and send it with the
// new account (lib/auth/entry.ts → growth.recordAttribution → the invite is
// attached on the server). The page shows no inviter name: the code is
// checked on the server at signup, and a crafted link cannot put words on a
// brand page. A signed-in visitor is pointed to their own /invite instead.

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useInvitesLive } from '../../../hooks/growth/useInvites';
import { track } from '../../../lib/analytics';
import { useAuth } from '../../../lib/auth/useAuth';
import { REFERRAL_TERMS_HREF } from './InviteFriends';
import styles from './invite.module.css';

/** 8 characters of Crockford base32 after the forgiving reads (server twin: referralCodes.ts). */
export function normalizeInviteCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim().toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(s) ? s : null;
}

export function signupHrefFor(code: string): string {
  return `/signup?${new URLSearchParams({ ref: code, from: 'invite' }).toString()}`;
}

export function loginHrefFor(code: string): string {
  return `/login?${new URLSearchParams({ ref: code, from: 'invite' }).toString()}`;
}

export interface InviteLandingProps {
  code: string;
}

export function InviteLanding({ code: raw }: InviteLandingProps) {
  const t = useTranslations('invite.landing');
  const tInvite = useTranslations('invite');
  const { status } = useAuth();
  const live = useInvitesLive();
  const code = normalizeInviteCode(raw);
  const signedIn = status === 'authenticated';
  const viewed = useRef(false);

  useEffect(() => {
    if (viewed.current || status === 'loading') return;
    viewed.current = true;
    track('invite_landing_viewed', { signedIn });
  }, [status, signedIn]);

  if (!live) {
    return (
      <div className={styles.landing} data-testid="invite-landing-plain">
        <h1 className={styles.landingTitle}>{t('plainTitle')}</h1>
        <p className={styles.body}>{t('sub')}</p>
        <div className={styles.actions}>
          <Link className={`btn primary ${styles.btn}`} href={signedIn ? '/jobs' : '/signup'}>
            {signedIn ? t('plainJobs') : t('invalidAction')}
          </Link>
        </div>
      </div>
    );
  }

  if (!code) {
    return (
      <div className={styles.landing} data-testid="invite-landing-invalid">
        <h1 className={styles.landingTitle}>{t('invalidTitle')}</h1>
        <p className={styles.body}>{t('invalidBody')}</p>
        <div className={styles.actions}>
          <Link className={`btn primary ${styles.btn}`} href="/signup">
            {t('invalidAction')}
          </Link>
        </div>
      </div>
    );
  }

  if (signedIn) {
    return (
      <div className={styles.landing} data-testid="invite-landing-signed-in">
        <h1 className={styles.landingTitle}>{t('signedInTitle')}</h1>
        <p className={styles.body}>{t('signedInBody')}</p>
        <div className={styles.actions}>
          <Link className={`btn primary ${styles.btn}`} href="/invite">
            {t('signedInAction')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.landing} data-testid="invite-landing">
      <h1 className={styles.landingTitle}>{t('title')}</h1>
      <p className={styles.body}>{t('sub')}</p>
      <section className={styles.hero} aria-labelledby="invite-landing-reward">
        <h2 className={styles.title} id="invite-landing-reward">
          {t('rewardTitle')}
        </h2>
        <p className={styles.body}>{t('reward')}</p>
        <p className={styles.muted}>{t('existingNote')}</p>
      </section>
      <div className={styles.actions}>
        <Link className={`btn primary ${styles.btn}`} href={signupHrefFor(code)} data-testid="invite-signup">
          {t('start')}
        </Link>
        <Link className={`btn ${styles.btn}`} href={loginHrefFor(code)}>
          {t('login')}
        </Link>
      </div>
      <p className={styles.muted}>
        {t('codeLabel', { code })} ·{' '}
        <Link className={styles.link} href={REFERRAL_TERMS_HREF}>
          {tInvite('terms')}
        </Link>
      </p>
    </div>
  );
}

export default InviteLanding;
