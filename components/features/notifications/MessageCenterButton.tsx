'use client';

// MessageCenterButton — the Topbar's Inbox bell (FND-6a slot; PRODUCT_PLAN.md
// §3.3 "Inbox bell (only real items: alerts, reminders, announcements, billing
// notices)").
//
// STUB (FND-6a). Owner: WP-39b. Renders nothing. A bell with no feed behind it
// is the same species of claim as a fabricated number, so the slot stays empty
// until the message center exists. When filled: an unread count from the
// notifications API (null → no count), a 44 px target, and a Drawer.

export type MessageCenterButtonProps = Record<string, never>;

export function MessageCenterButton(_props: MessageCenterButtonProps = {}): null {
  return null;
}

export default MessageCenterButton;
