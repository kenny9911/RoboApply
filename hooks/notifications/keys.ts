// hooks/notifications/keys.ts — TanStack Query keys of the message center (WP-39b).

export const notificationKeys = {
  all: ['notifications'] as const,
  list: () => ['notifications', 'list'] as const,
  unread: () => ['notifications', 'unread'] as const,
  preferences: () => ['notifications', 'preferences'] as const,
  unsubscribe: (token: string) => ['notifications', 'unsubscribe', token] as const,
};

/** The bell polls the unread count this often while the page is visible (ARCHITECTURE.md §8.3). */
export const UNREAD_POLL_MS = 60_000;
