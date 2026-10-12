// components/features/notifications — public surface of the notifications area (WP-39b / WP-61).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).

export { MessageCenterButton, formatUnread, type MessageCenterButtonProps } from './MessageCenterButton';
export { AnnouncementModal, type AnnouncementModalProps } from './AnnouncementModal';
export { SettingsSection as NotificationsSettingsSection } from './SettingsSection';
export { NotificationsSettings } from './NotificationsSettings';
export { MessageList, MarkAllReadButton, type MessageListProps } from './MessageList';
export { InboxPage } from './InboxPage';
export { UnsubscribeFlow, UNSUBSCRIBE_REASON_ORDER } from './UnsubscribeFlow';
export { icuArguments, useMessageText, type MessageText } from './messageText';
