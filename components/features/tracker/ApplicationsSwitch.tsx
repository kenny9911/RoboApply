'use client';

// ApplicationsSwitch — one Applications destination, two views
// (docs/agent-driven/REDESIGN.md §7): "Getting ready" (/ready, the
// applications being prepared and waiting for the user) and "Sent"
// (/applications, the tracker). It sits at the top of both pages.
//
// These are links, not tabs: each view is its own page with its own address,
// query parameters and content, so the switch is a <nav> of two <a>s and the
// page the user is on carries `aria-current="page"`. It only looks like the
// shared segmented Tabs control.
//
// The number beside "Getting ready" is the server's count of applications that
// are ready and not opened yet (hooks/agent `useReadyBadge`, the same number
// the nav badge used). Unknown, loading or zero draws nothing (D3).
//
// Flag `agent` off → renders nothing: there is no Getting ready view to switch
// to (R-04), and /applications looks as it did.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useReadyBadge } from '../../../hooks/agent';
import { useFlag } from '../../../lib/flags';
import styles from './tracker.module.css';

export type ApplicationsView = 'ready' | 'sent';

export const APPLICATIONS_VIEW_HREF: Record<ApplicationsView, string> = {
  ready: '/ready',
  sent: '/applications',
};

export interface ApplicationsSwitchProps {
  /** The view this page is. */
  current: ApplicationsView;
}

export function ApplicationsSwitch({ current }: ApplicationsSwitchProps) {
  const t = useTranslations('applications.switch');
  const on = useFlag('agent');
  const badge = useReadyBadge();
  if (!on) return null;
  const waiting = badge?.kind === 'count' && badge.count > 0 ? badge.count : null;

  return (
    <nav className={styles.switch} aria-label={t('label')} data-testid="applications-switch">
      <Link href={APPLICATIONS_VIEW_HREF.ready} className={styles.switchLink} aria-current={current === 'ready' ? 'page' : undefined}>
        {t('ready')}
        {waiting !== null ? (
          <>
            {/* A space of the link's own text keeps the sentence apart from the label in the link's name
                ("Getting ready 2 applications…"); alone in a flex row it takes no room. */}
            {' '}
            <span className={styles.switchCount} aria-hidden="true" data-testid="applications-switch-count">
              {waiting}
            </span>
            <span className="sr-only">{t('waiting', { count: waiting })}</span>
          </>
        ) : null}
      </Link>
      <Link href={APPLICATIONS_VIEW_HREF.sent} className={styles.switchLink} aria-current={current === 'sent' ? 'page' : undefined}>
        {t('sent')}
      </Link>
    </nav>
  );
}
