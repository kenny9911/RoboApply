'use client';

// hooks/notifications/useNotificationPreferences.ts — /settings#notifications (WP-39b).
//
//   useNotificationPreferences()        GET  /notifications/preferences
//   usePatchNotificationPreferences()   PATCH; the server answers with the full view, which
//                                       replaces the cache (no optimistic guess at defaults)
//   useUnsubscribePreview(token)        GET  /api/v1/public/email/unsubscribe (no session)
//   useUnsubscribe(token)               POST the same (RFC 8058 one-click, from the page's button)
//   useUnsubscribeSurvey()              POST …/unsubscribe/survey

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getNotificationPreferences,
  getUnsubscribePreview,
  patchNotificationPreferences,
  submitUnsubscribeSurvey,
  unsubscribeEmail,
} from '../../lib/api/notifications';
import type * as N from '../../lib/api/contracts/notifications';
import { notificationKeys } from './keys';

export type NotificationPreferencesView = N.NotificationPreferencesView;
export type NotificationPreferencesPatch = N.NotificationPreferencesPatch;

export function useNotificationPreferences(options: { enabled?: boolean } = {}) {
  return useQuery<NotificationPreferencesView>({
    queryKey: notificationKeys.preferences(),
    queryFn: ({ signal }) => getNotificationPreferences({ signal }),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

export function usePatchNotificationPreferences() {
  const client = useQueryClient();
  return useMutation<NotificationPreferencesView, Error, NotificationPreferencesPatch>({
    mutationFn: (patch) => patchNotificationPreferences(patch),
    onSuccess: (view) => client.setQueryData(notificationKeys.preferences(), view),
  });
}

export function useUnsubscribePreview(token: string) {
  return useQuery<N.UnsubscribePreview>({
    queryKey: notificationKeys.unsubscribe(token),
    queryFn: ({ signal }) => getUnsubscribePreview({ token }, { signal }),
    enabled: token.length >= 16,
    retry: false,
    staleTime: Infinity,
  });
}

export function useUnsubscribe(token: string) {
  return useMutation<N.UnsubscribeResponse, Error, void>({
    mutationFn: () => unsubscribeEmail({}, { token }),
  });
}

export function useUnsubscribeSurvey() {
  return useMutation<void, Error, { token: string; reason: N.UnsubscribeReason; note?: string }>({
    mutationFn: (body) => submitUnsubscribeSurvey(body),
  });
}
