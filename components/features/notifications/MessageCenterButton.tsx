'use client';

// MessageCenterButton — the Topbar's Inbox bell (FND-6a slot; PRODUCT_PLAN.md
// §3.3 "Inbox bell (only real items: alerts, reminders, announcements, billing
// notices)"; ARCHITECTURE.md §8.3). Filled by WP-39b.
//
// The count is the real unread count from GET /notifications/unread-count,
// polled every 60 s while the page is visible and refreshed when the tab comes
// back. Unknown (loading, error) and zero both draw no number (D3: never a
// placeholder count). The bell opens the shared Drawer with the newest
// messages; "Open inbox" goes to /inbox. 40px on wide screens, 44px on phones.

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Drawer } from '../../v3/primitives/Drawer';
import { IconBell } from '../../v3/primitives/Iconset';
import { cn } from '../../../lib/utils';
import { useUnreadCount } from '../../../hooks/notifications';
import { MarkAllReadButton, MessageList } from './MessageList';
import styles from './notifications.module.css';

export type MessageCenterButtonProps = Record<string, never>;

/** "99+" above 99, so the badge keeps its size. */
export function formatUnread(count: number): string {
  return count > 99 ? '99+' : String(count);
}

export function MessageCenterButton(_props: MessageCenterButtonProps = {}) {
  const t = useTranslations('inbox');
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  const shown = unread !== null && unread > 0 ? unread : null;
  const close = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        className={cn('icon-btn', styles.bell)}
        aria-label={shown !== null ? t('bellAriaUnread', { count: shown }) : t('bellAria')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        data-testid="inbox-bell"
      >
        <IconBell size={15} />
        {shown !== null ? (
          <span className={styles.count} aria-hidden="true">
            {formatUnread(shown)}
          </span>
        ) : null}
      </button>
      <Drawer
        open={open}
        onClose={close}
        title={t('drawerTitle')}
        footer={
          <div className={styles.drawerFooter}>
            <MarkAllReadButton disabled={shown === null} />
            <Link href="/inbox" className={styles.linkBtn} onClick={close}>
              {t('openInbox')}
            </Link>
          </div>
        }
      >
        {open ? <MessageList onNavigate={close} hideToolbar /> : null}
      </Drawer>
    </>
  );
}

export default MessageCenterButton;
