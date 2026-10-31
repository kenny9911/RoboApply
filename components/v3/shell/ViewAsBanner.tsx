'use client';

// components/v3/shell/ViewAsBanner.tsx — the admin "view as" banner (the
// god's-eye view; server platform/viewAs).
//
// While the signed-in admin views the app as another user (`/auth/me.viewAs`),
// this bar sits above every screen: whose app it is, that it is read-only, how
// long the view lasts, and Exit. It is mounted once at the root
// (app/providers.tsx), so it shows on the app shell, onboarding and public
// pages alike, and it publishes its height as `--view-as-h` so the 100vh app
// grid and the sticky top bars make room for it (styles/v3.css).
//
// While it is up, product analytics are paused (lib/analytics.ts): the
// admin's clicks are not the person's activity. It also owns the client
// reactions of lib/api/client.ts:
//   - a write the server refused (403 view_as_read_only): "Not saved" for a
//     moment in place of the read-only line;
//   - the server ended the view (`X-RA-View-As: ended`), or its time is up:
//     back to the admin console, reloaded as the admin.
// Exit ends the view and returns to the person's admin page. Leaving is always
// a full page load, so no screen keeps the person's data cached.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useStopViewAs } from '../../../hooks/useViewAs';
import { pauseAnalytics } from '../../../lib/analytics';
import { registerViewAsHandlers } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/useAuth';
import { IconPerson } from '../primitives/Iconset';
import styles from './ViewAsBanner.module.css';

/** How long "Not saved" replaces the read-only line after a refused write. */
export const VIEW_AS_BLOCKED_NOTICE_MS = 5000;
/** Where the admin goes when the view ends without Exit. */
export const VIEW_AS_ENDED_ROUTE = '/admin?tab=users';

/** Whole minutes left (at least 1 while any time is left; 0 once it is up). */
export function minutesLeft(expiresAt: string, now: number): number {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / 60_000));
}

// useLayoutEffect warns during the server render; the banner only matters in the browser.
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type Navigate = (url: string) => void;
const hardNavigate: Navigate = (url) => window.location.assign(url);

export function ViewAsBanner({ navigate = hardNavigate }: { navigate?: Navigate } = {}) {
  const { me } = useAuth();
  const viewAs = me?.viewAs;
  if (!viewAs || !me?.user) return null;
  return <Banner key={`${me.user.id}:${viewAs.startedAt}`} user={me.user} expiresAt={viewAs.expiresAt} navigate={navigate} />;
}

function Banner({ user, expiresAt, navigate }: { user: { id: string; name?: string | null; email: string }; expiresAt: string; navigate: Navigate }) {
  const t = useTranslations('viewAs');
  const stop = useStopViewAs();
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [blockedAt, setBlockedAt] = useState<number | null>(null);
  const leaving = useRef(false);

  const leave = (to: string, end: boolean) => {
    if (leaving.current) return;
    leaving.current = true;
    const go = () => navigate(to);
    if (end) stop.mutate(undefined, { onSettled: go });
    else go();
  };

  // Make room in the shell for the banner (styles/v3.css reads --view-as-h).
  useBrowserLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--view-as-h', `${el.offsetHeight}px`);
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--view-as-h');
    };
  }, []);

  // The admin's clicks are not the person's product activity.
  useEffect(() => {
    pauseAnalytics(true);
    return () => pauseAnalytics(false);
  }, []);

  // The API client's reactions while viewing.
  useEffect(
    () =>
      registerViewAsHandlers({
        onReadOnly: () => setBlockedAt(Date.now()),
        onEnded: () => leave(VIEW_AS_ENDED_ROUTE, false),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registered once per view
    [],
  );

  // The clock for "Ends in …"; the view ends by itself when the time is up.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const minutes = minutesLeft(expiresAt, now);
  useEffect(() => {
    if (minutes === 0) leave(VIEW_AS_ENDED_ROUTE, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `leave` is stable for this view
  }, [minutes]);

  useEffect(() => {
    if (blockedAt === null) return;
    const timer = window.setTimeout(() => setBlockedAt(null), VIEW_AS_BLOCKED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [blockedAt]);

  const name = user.name?.trim() || user.email;
  const exiting = leaving.current || stop.isPending;
  return (
    <div ref={ref} className={styles.banner} role="region" aria-label={t('label')} data-testid="view-as-banner">
      <div className={styles.who}>
        <IconPerson size={16} aria-hidden="true" />
        <p className={styles.title}>
          {t('title', { name })}
          {user.name?.trim() ? <span className={styles.email}>{user.email}</span> : null}
        </p>
        <p className={styles.note} aria-live="polite">
          {blockedAt !== null ? t('blocked') : t('readOnly')}
        </p>
      </div>
      <div className={styles.actions}>
        <span className={styles.time}>{t('endsIn', { minutes })}</span>
        <button type="button" className={styles.exit} disabled={exiting} onClick={() => leave(`/admin/users/${encodeURIComponent(user.id)}`, true)}>
          {exiting ? t('exiting') : t('exit')}
        </button>
      </div>
    </div>
  );
}
