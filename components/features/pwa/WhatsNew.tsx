'use client';

// WhatsNew — server-driven "What's new" (F-NOTIF-09; ARCHITECTURE.md §8.5;
// WP-61), rendered once by the shell's AnnouncementModal slot.
//
//   1. Asks GET /announcements/next once per session for the UI language
//      (the server applies brand, language, cohort, window, seen-once and the
//      24 h popup budget; at most one comes back).
//   2. Asks the popup gate for a slot: `requestPopup('announcement:<id>',
//      'announcement')` — one popup per page view, 24 h between popups.
//   3. When granted, shows it and marks it seen at once (shown = seen; the
//      server also copies it to the inbox so it can be found later).
// Admin-written text, not AI output, so no AI label on GoApply.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { Modal } from '../../v3/primitives/Modal';
import { useAuth } from '../../../lib/auth/useAuth';
import { usePopupGate } from '../../../lib/ui/popupGate';
import { useMarkAnnouncementSeen, useNextAnnouncement, type AnnouncementView } from '../../../hooks/pwa';
import styles from './pwa.module.css';

/** The popup-gate key of one announcement. */
export function announcementPopupKey(id: string): string {
  return `announcement:${id}`;
}

/**
 * A same-site path: one leading '/', no second '/' or '\\' after it (browsers
 * read '/\\host' as '//host', another site). Mirrors the server's
 * `isInternalHref` (announcements/contract.ts), which the type-only contract
 * mirror cannot carry.
 */
export function isInternalHref(href: string | null | undefined): href is string {
  return typeof href === 'string' && /^\/(?![\/\\])[^\\]*$/.test(href);
}

/** Only https links leave the site; anything else is not rendered. */
function isExternalHref(href: string): boolean {
  return /^https:\/\/[^\\]+$/.test(href);
}

function Cta({ a, onDone }: { a: AnnouncementView; onDone: () => void }) {
  if (!a.ctaHref || !a.ctaLabel) return null;
  if (!isInternalHref(a.ctaHref) && !isExternalHref(a.ctaHref)) return null;
  if (isInternalHref(a.ctaHref)) {
    return (
      <Link href={a.ctaHref} className="btn primary" onClick={onDone}>
        {a.ctaLabel}
      </Link>
    );
  }
  return (
    <Btn as="a" variant="primary" href={a.ctaHref} target="_blank" rel="noopener noreferrer" onClick={onDone}>
      {a.ctaLabel}
    </Btn>
  );
}

export function WhatsNew() {
  const t = useTranslations('pwa.announcement');
  const locale = useLocale();
  const { status } = useAuth();
  const next = useNextAnnouncement({ enabled: status === 'authenticated', locale });
  const announcement = next.data?.announcement ?? null;
  const { granted } = usePopupGate(announcementPopupKey(announcement?.id ?? 'none'), 'announcement', { enabled: Boolean(announcement) });
  const seen = useMarkAnnouncementSeen();
  const marked = useRef<string | null>(null);
  const [closed, setClosed] = useState(false);

  const open = Boolean(announcement && granted && !closed);

  useEffect(() => {
    if (!open || !announcement || marked.current === announcement.id) return;
    marked.current = announcement.id;
    seen.mutate({ id: announcement.id, locale });
  }, [open, announcement, locale, seen]);

  if (!announcement) return null;
  const close = () => setClosed(true);

  return (
    <Modal
      open={open}
      onClose={close}
      title={announcement.title}
      maxWidth="md"
      footer={
        <div className={styles.actions}>
          <Btn variant={announcement.ctaHref && announcement.ctaLabel ? 'ghost' : 'primary'} onClick={close}>
            {t('close')}
          </Btn>
          <Cta a={announcement} onDone={close} />
        </div>
      }
    >
      <div className={styles.stack} data-testid="announcement-modal">
        <p className={styles.label}>{t('label')}</p>
        <p className={styles.body}>{announcement.body}</p>
      </div>
    </Modal>
  );
}

