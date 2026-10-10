'use client';

// hooks/pwa/useAnnouncements.ts — "What's new" announcements (F-NOTIF-09; WP-61).
//
//   useNextAnnouncement({ enabled, locale })  GET /announcements/next (once per session)
//   useMarkAnnouncementSeen()                 POST /announcements/:id/seen (when shown)
//   useAdminAnnouncements(filter)             admin list
//   useCreateAnnouncement() / useUpdateAnnouncement() / useDeleteAnnouncement()

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  adminCreateAnnouncement,
  adminDeleteAnnouncement,
  adminListAnnouncements,
  adminUpdateAnnouncement,
  getNextAnnouncement,
  markAnnouncementSeen,
} from '../../lib/api/announcements';
import type * as AN from '../../lib/api/contracts/announcements';
import type { In } from '../../lib/api/contracts/wire';

export type AnnouncementView = AN.AnnouncementView;
export type AdminAnnouncementView = AN.AdminAnnouncementView;
export type UpsertAnnouncementInput = In<typeof AN.UpsertAnnouncementBodySchema>;
export type PatchAnnouncementInput = In<typeof AN.PatchAnnouncementBodySchema>;
export type AdminAnnouncementsFilter = In<typeof AN.AdminAnnouncementsQuerySchema>;

export const announcementKeys = {
  all: ['announcements'] as const,
  next: (locale: string) => ['announcements', 'next', locale] as const,
  admin: (filter: AdminAnnouncementsFilter = {}) => ['announcements', 'admin', filter] as const,
};

export function useNextAnnouncement({ enabled = true, locale }: { enabled?: boolean; locale: string }) {
  return useQuery<AN.NextAnnouncementResponse>({
    queryKey: announcementKeys.next(locale),
    queryFn: ({ signal }) => getNextAnnouncement({ locale }, { signal }),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useMarkAnnouncementSeen() {
  return useMutation<void, Error, { id: string; locale: string }>({
    mutationFn: ({ id, locale }) => markAnnouncementSeen(id, { locale }),
  });
}

export function useAdminAnnouncements(filter: AdminAnnouncementsFilter = {}, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<{ items: AdminAnnouncementView[] }>({
    queryKey: announcementKeys.admin(filter),
    queryFn: ({ signal }) => adminListAnnouncements(filter, { signal }),
    enabled,
    staleTime: 15_000,
  });
}

function useInvalidateAdmin() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['announcements', 'admin'] });
}

export function useCreateAnnouncement() {
  const invalidate = useInvalidateAdmin();
  return useMutation<AdminAnnouncementView, Error, UpsertAnnouncementInput>({
    mutationFn: (body) => adminCreateAnnouncement(body),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateAnnouncement() {
  const invalidate = useInvalidateAdmin();
  return useMutation<AdminAnnouncementView, Error, { id: string; body: PatchAnnouncementInput }>({
    mutationFn: ({ id, body }) => adminUpdateAnnouncement(id, body),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteAnnouncement() {
  const invalidate = useInvalidateAdmin();
  return useMutation<void, Error, string>({
    mutationFn: (id) => adminDeleteAnnouncement(id),
    onSuccess: () => invalidate(),
  });
}
