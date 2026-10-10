'use client';

// MessageList — the inbox messages (ARCHITECTURE.md §8.3; PRODUCT_PLAN.md
// F-NET-09 "real system items only"). Used by the bell's drawer and /inbox.
//
// Each row: an unread dot, the category ("Job alert", "Reminder", …), the
// relative time, a localized title/body (template + params, else the stored
// text) and, when the message has a link, the whole row opens it and marks the
// message read. Invitations (flag `invitations`) carry their two answers.
// Nothing here is a nudge: rows exist only because a producer wrote a real
// message.

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { toast } from '../../v3/primitives/Toast';
import { useFlag } from '../../../lib/flags';
import { formatRelativeTime } from '../../../lib/relativeTime';
import { cn } from '../../../lib/utils';
import {
  flattenNotifications,
  useMarkAllRead,
  useMarkRead,
  useNotificationList,
  useRespondToInvitation,
  type NotificationView,
} from '../../../hooks/notifications';
import { useMessageText } from './messageText';
import styles from './notifications.module.css';

export interface MessageListProps {
  /** Called after a message link is followed (the drawer closes). */
  onNavigate?: () => void;
  /** Hide the "Mark all as read" toolbar (the drawer renders it in its footer). */
  hideToolbar?: boolean;
}

function InvitationActions({ n }: { n: NotificationView }) {
  const t = useTranslations('inbox.invitation');
  const respond = useRespondToInvitation();
  if (n.response) {
    return <p className={styles.status}>{n.response.interested ? t('answeredYes') : t('answeredNo')}</p>;
  }
  const answer = (interested: boolean) =>
    respond.mutate({ id: n.id, interested }, { onError: () => toast({ message: t('answerFailed'), tone: 'danger' }) });
  return (
    <>
      <Btn variant="primary" onClick={() => answer(true)} disabled={respond.isPending}>
        {t('interested')}
      </Btn>
      <Btn onClick={() => answer(false)} disabled={respond.isPending}>
        {t('notInterested')}
      </Btn>
    </>
  );
}

function MessageRow({ n, onNavigate, invitations }: { n: NotificationView; onNavigate?: () => void; invitations: boolean }) {
  const t = useTranslations('inbox');
  const locale = useLocale();
  const text = useMessageText()(n);
  const markRead = useMarkRead();
  const unread = !n.readAt;

  const read = () => {
    if (unread) markRead.mutate(n.id, { onError: () => toast({ message: t('markReadFailed'), tone: 'danger' }) });
  };

  const content = (
    <>
      <span className={cn(styles.dot, !unread && styles.dotRead)} aria-hidden="true" />
      <span className={styles.itemText}>
        <span className={styles.meta}>
          <span>{t(`categories.${n.category}`)}</span>
          <time dateTime={n.createdAt}>{formatRelativeTime(n.createdAt, locale)}</time>
          {unread ? <span className="sr-only">{t('unreadLabel')}</span> : null}
        </span>
        <span className={cn(styles.itemTitle, !unread && styles.itemTitleRead)}>{text.title}</span>
        {text.body ? <span className={styles.itemBody}>{text.body}</span> : null}
      </span>
    </>
  );

  const showInvitation = n.category === 'invitation' && invitations;
  return (
    <li className={styles.item}>
      {n.href ? (
        <Link
          href={n.href}
          className={styles.itemInner}
          onClick={() => {
            read();
            onNavigate?.();
          }}
        >
          {content}
        </Link>
      ) : unread ? (
        <button type="button" className={styles.itemInner} onClick={read}>
          {content}
        </button>
      ) : (
        <div className={cn(styles.itemInner, styles.itemStatic)}>{content}</div>
      )}
      {showInvitation ? (
        <div className={styles.actions}>
          <InvitationActions n={n} />
        </div>
      ) : null}
    </li>
  );
}

export function MarkAllReadButton({ disabled }: { disabled?: boolean }) {
  const t = useTranslations('inbox');
  const markAll = useMarkAllRead();
  return (
    <button
      type="button"
      className={styles.linkBtn}
      disabled={disabled || markAll.isPending}
      onClick={() => markAll.mutate(undefined, { onError: () => toast({ message: t('markReadFailed'), tone: 'danger' }) })}
    >
      {t('markAllRead')}
    </button>
  );
}

export function MessageList({ onNavigate, hideToolbar = false }: MessageListProps) {
  const t = useTranslations('inbox');
  const invitations = useFlag('invitations');
  const query = useNotificationList();
  const items = flattenNotifications(query.data);

  if (query.isLoading) return <p className={styles.status}>{t('loading')}</p>;
  if (query.isError && items.length === 0) {
    return (
      <div className={styles.listWrap} role="alert">
        <p className={styles.error}>{t('loadFailed')}</p>
        <div>
          <Btn onClick={() => void query.refetch()}>{t('retry')}</Btn>
        </div>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className={styles.listWrap}>
        <p className={styles.itemTitle}>{t('emptyTitle')}</p>
        <p className={styles.itemBody}>{t('emptySub')}</p>
      </div>
    );
  }

  const anyUnread = items.some((n) => !n.readAt);
  return (
    <div className={styles.listWrap}>
      {hideToolbar ? null : (
        <div className={styles.toolbar}>
          <MarkAllReadButton disabled={!anyUnread} />
          <Link href="/settings#notifications" className={styles.linkBtn} onClick={onNavigate}>
            {t('settingsLink')}
          </Link>
        </div>
      )}
      <ul className={styles.list}>
        {items.map((n) => (
          <MessageRow key={n.id} n={n} onNavigate={onNavigate} invitations={invitations} />
        ))}
      </ul>
      {query.hasNextPage ? (
        <div>
          <Btn onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {t('loadMore')}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

export default MessageList;
