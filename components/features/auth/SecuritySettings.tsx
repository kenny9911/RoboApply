'use client';

// Settings pieces for #account and #security (WP-10; F-ACCT-01/02,
// F-TRUST-01):
//   - EmailVerificationLine: confirmed or not, with "Send confirmation email"
//     (verification never blocks; it unlocks the free practice interview).
//   - SignInMethods: email+password, Google, LINE, WeChat, phone — masked,
//     with Remove (refused for the last way to sign in).
//   - SignedInSessions: one row per live session, the current one marked,
//     each can be signed out. No device names or locations are recorded, so
//     none are shown.
// Unknown/loading states render as a line, never as a fabricated zero.

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { RoboApiError } from '../../../lib/api/client';
import {
  useEmailStatus,
  useIdentities,
  useRevokeSession,
  useSendVerificationEmail,
  useSessions,
  useUnlinkIdentity,
} from '../../../hooks/auth/useAuthAccount';
import { Btn } from '../../v3/primitives/Btn';
import styles from './auth.module.css';

function formatDate(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function EmailVerificationLine() {
  const t = useTranslations('auth');
  const status = useEmailStatus();
  const send = useSendVerificationEmail();
  // `?verified=1` is set by the API redirect after a confirmation link.
  const [justVerified, setJustVerified] = useState(false);
  useEffect(() => {
    setJustVerified(new URLSearchParams(window.location.search).get('verified') === '1');
  }, []);

  if (status.isLoading || status.isError || !status.data) return null;
  if (status.data.verified) {
    return (
      <p className={`${styles.verifyLine} ${styles.verifyOk}`} role="status" data-testid="email-verified">
        {justVerified ? t('verifyBanner.justVerified') : t('verifyBanner.verified')}
      </p>
    );
  }
  if (!status.data.canResend) return null;
  return (
    <div className={styles.verifyLine} data-testid="email-unverified">
      <span>{t('verifyBanner.unverified')}</span>
      {send.isSuccess ? (
        <span role="status">{t('verifyBanner.sent')}</span>
      ) : (
        <Btn onClick={() => send.mutate()} disabled={send.isPending} aria-busy={send.isPending}>
          {t('verifyBanner.resend')}
        </Btn>
      )}
      {send.isError ? (
        <span className={styles.error} role="alert">
          {send.error instanceof RoboApiError && send.error.code === 'rate_limited' ? t('errors.rateLimited') : t('verifyBanner.failed')}
        </span>
      ) : null}
    </div>
  );
}

const PROVIDER_KEYS = {
  email: 'security.provider.email',
  google: 'security.provider.google',
  line: 'security.provider.line',
  wechat: 'security.provider.wechat',
  phone: 'security.provider.phone',
} as const;

export function SignInMethods() {
  const t = useTranslations('auth');
  const locale = useLocale();
  const identities = useIdentities();
  const unlink = useUnlinkIdentity();

  return (
    <section className={styles.settingsBlock} aria-labelledby="auth-methods-title" data-testid="sign-in-methods">
      <h3 id="auth-methods-title" className={styles.settingsTitle}>
        {t('security.methodsTitle')}
      </h3>
      {identities.isLoading ? (
        <p className={styles.inline}>{t('security.loading')}</p>
      ) : identities.isError || !identities.data ? (
        <p className={styles.inline}>
          {t('security.loadError')}{' '}
          <Btn variant="ghost" onClick={() => void identities.refetch()}>
            {t('security.retry')}
          </Btn>
        </p>
      ) : (
        <>
          <ul className={styles.list}>
            {identities.data.identities.map((i) => (
              <li key={i.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.rowLabel}>
                    {t(PROVIDER_KEYS[i.provider])} · {i.display}
                  </span>
                  <span className={styles.rowMeta}>
                    {i.lastUsedAt
                      ? t('security.lastUsed', { date: formatDate(i.lastUsedAt, locale) })
                      : t('security.added', { date: formatDate(i.createdAt, locale) })}
                  </span>
                </div>
                {i.removable ? (
                  <Btn
                    variant="ghost"
                    onClick={() => unlink.mutate(i.id)}
                    disabled={unlink.isPending}
                    aria-label={`${t('security.remove')} ${t(PROVIDER_KEYS[i.provider])}`}
                  >
                    {unlink.isPending && unlink.variables === i.id ? t('security.removing') : t('security.remove')}
                  </Btn>
                ) : null}
              </li>
            ))}
          </ul>
          {identities.data.identities.length === 1 ? <p className={styles.inline}>{t('security.lastMethod')}</p> : null}
          {unlink.isError ? (
            <p className={styles.error} role="alert">
              {t('security.lastMethod')}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

export function SignedInSessions() {
  const t = useTranslations('auth');
  const locale = useLocale();
  const sessions = useSessions();
  const revoke = useRevokeSession();

  return (
    <section className={styles.settingsBlock} aria-labelledby="auth-sessions-title" data-testid="signed-in-sessions">
      <h3 id="auth-sessions-title" className={styles.settingsTitle}>
        {t('security.sessionsTitle')}
      </h3>
      <p className={styles.inline}>{t('security.sessionsNote')}</p>
      {sessions.isLoading ? (
        <p className={styles.inline}>{t('security.loading')}</p>
      ) : sessions.isError || !sessions.data ? (
        <p className={styles.inline}>{t('security.loadError')}</p>
      ) : (
        <ul className={styles.list}>
          {sessions.data.sessions.map((s) => (
            <li key={s.id} className={styles.row}>
              <div className={styles.rowMain}>
                <span className={styles.rowLabel}>{t('security.sessionStarted', { date: formatDate(s.createdAt, locale) })}</span>
                {s.current ? <span className={styles.badge}>{t('security.thisDevice')}</span> : null}
              </div>
              {!s.current ? (
                <Btn variant="ghost" onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending}>
                  {t('security.signOutSession')}
                </Btn>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
