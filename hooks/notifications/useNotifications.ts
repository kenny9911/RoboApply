'use client';

// hooks/notifications/useNotifications.ts — the message center (WP-39b; ARCHITECTURE.md §8.3).
//
//   usePageVisible()            document.visibilityState, live
//   useUnreadCount()            GET /notifications/unread-count, polled every 60 s while the page
//                               is visible and refreshed on focus; null until known (never a fake 0)
//   useNotificationList()       GET /notifications, cursor pages
//   useMarkRead() / useMarkAllRead()   optimistic: the row and the count update at once
//   useRespondToInvitation()    POST /notifications/:id/respond (flag `invitations`)

import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';

import { getUnreadCount, listNotifications, markAllRead, markRead, respondToInvitation } from '../../lib/api/notifications';
import type { NotificationView, NotificationsResponse, UnreadCountResponse } from '../../lib/api/contracts/notifications';
import { UNREAD_POLL_MS, notificationKeys } from './keys';

export type { NotificationView };

function visibleNow(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/** True while the tab is visible. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(visibleNow);
  useEffect(() => {
    const on = () => setVisible(visibleNow());
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/** The unread count, or null while unknown. Polls only while visible. */
export function useUnreadCount(options: { enabled?: boolean } = {}): number | null {
  const visible = usePageVisible();
  const enabled = options.enabled ?? true;
  const query = useQuery<UnreadCountResponse>({
    queryKey: notificationKeys.unread(),
    queryFn: ({ signal }) => getUnreadCount({ signal }),
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled && visible ? UNREAD_POLL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  // A refetch when the tab comes back is part of "refreshed on focus".
  const { refetch } = query;
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (enabled && visible && !wasVisible.current) void refetch();
    wasVisible.current = visible;
  }, [enabled, visible, refetch]);
  const count = query.data?.count;
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

export const NOTIFICATION_PAGE_SIZE = 20;

export function useNotificationList(options: { enabled?: boolean } = {}) {
  return useInfiniteQuery<NotificationsResponse, Error, InfiniteData<NotificationsResponse>, readonly unknown[], string | undefined>({
    queryKey: notificationKeys.list(),
    queryFn: ({ pageParam, signal }) => listNotifications({ cursor: pageParam, limit: NOTIFICATION_PAGE_SIZE }, { signal }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.cursor ?? undefined,
    enabled: options.enabled ?? true,
    staleTime: 15_000,
  });
}

/** Every loaded message, in order. */
export function flattenNotifications(data: InfiniteData<NotificationsResponse> | undefined): NotificationView[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}

function patchRows(client: QueryClient, fn: (n: NotificationView) => NotificationView): void {
  client.setQueryData<InfiniteData<NotificationsResponse>>(notificationKeys.list(), (prev) =>
    prev ? { ...prev, pages: prev.pages.map((p) => ({ ...p, items: p.items.map(fn) })) } : prev,
  );
}

function bumpUnread(client: QueryClient, next: (n: number) => number): void {
  client.setQueryData<UnreadCountResponse>(notificationKeys.unread(), (prev) => (prev ? { count: Math.max(0, next(prev.count)) } : prev));
}

interface Snapshot {
  list: InfiniteData<NotificationsResponse> | undefined;
  unread: UnreadCountResponse | undefined;
}

async function snapshot(client: QueryClient): Promise<Snapshot> {
  await client.cancelQueries({ queryKey: notificationKeys.all });
  return {
    list: client.getQueryData<InfiniteData<NotificationsResponse>>(notificationKeys.list()),
    unread: client.getQueryData<UnreadCountResponse>(notificationKeys.unread()),
  };
}

function restore(client: QueryClient, snap: Snapshot | undefined): void {
  if (!snap) return;
  client.setQueryData(notificationKeys.list(), snap.list);
  client.setQueryData(notificationKeys.unread(), snap.unread);
}

export function useMarkRead() {
  const client = useQueryClient();
  return useMutation<void, Error, string, Snapshot>({
    mutationFn: (id) => markRead(id),
    onMutate: async (id) => {
      const snap = await snapshot(client);
      const wasUnread = flattenNotifications(snap.list).some((n) => n.id === id && !n.readAt);
      const at = new Date().toISOString();
      patchRows(client, (n) => (n.id === id && !n.readAt ? { ...n, readAt: at } : n));
      if (wasUnread) bumpUnread(client, (c) => c - 1);
      return snap;
    },
    onError: (_e, _id, snap) => restore(client, snap),
    onSettled: () => void client.invalidateQueries({ queryKey: notificationKeys.unread() }),
  });
}

export function useMarkAllRead() {
  const client = useQueryClient();
  return useMutation<{ updated: number }, Error, void, Snapshot>({
    mutationFn: () => markAllRead(),
    onMutate: async () => {
      const snap = await snapshot(client);
      const at = new Date().toISOString();
      patchRows(client, (n) => (n.readAt ? n : { ...n, readAt: at }));
      bumpUnread(client, () => 0);
      return snap;
    },
    onError: (_e, _v, snap) => restore(client, snap),
    onSettled: () => void client.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

export function useRespondToInvitation() {
  const client = useQueryClient();
  return useMutation<NotificationView, Error, { id: string; interested: boolean }>({
    mutationFn: ({ id, interested }) => respondToInvitation(id, { interested }),
    onSuccess: (view) => {
      patchRows(client, (n) => (n.id === view.id ? view : n));
      void client.invalidateQueries({ queryKey: notificationKeys.unread() });
    },
  });
}
