'use client';

// InboxPage — /inbox (PRODUCT_PLAN.md §3.4 "Messages"; F-NOTIF-01, F-NET-09).
// The source of truth for every alert, reminder and notice (§7.1): the full
// message list with "Mark all as read", older pages and a link to the
// notification settings. Renders inside the (auth) app shell.

import { useTranslations } from 'next-intl';

import { PageHeader } from '../../v3/primitives/PageHeader';
import { MessageList } from './MessageList';
import styles from './notifications.module.css';

export function InboxPage() {
  const t = useTranslations('inbox');
  return (
    <div className={styles.page}>
      <PageHeader title={t('title')} sub={t('sub')} />
      <MessageList />
    </div>
  );
}

export default InboxPage;
