'use client';

// hooks/growth/useInvites.ts — invite friends (F-GROW-01; WP-60).
//
// `useInvites` reads the person's invite link, their friends' progress and
// this year's rewards. `useShareInvite` notes that the link was copied or
// shared (the server keeps a hashed note of the browser for the reward check;
// the analytics event carries only the channel). Nothing here sends a message.
// `useInvitesLive` says whether this site runs the programme at all: the
// `invites` capability AND a brand whose every sign-up path attaches the
// invite (INVITE_REWARD_BRANDS). Without it no page promises a reward.

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { track } from '../../lib/analytics';
import { useBrandId } from '../../lib/brand/BrandProvider';
import { useFlag } from '../../lib/flags';
import { getInvites, markInviteShared } from '../../lib/api/growth';
import { apiErrorCode } from '../../lib/api/contracts/wire';
import type { InviteShareChannel, InvitesResponse } from '../../lib/api/contracts/growth';

export const INVITES_QUERY_KEY = ['growth', 'invites'] as const;

/**
 * Web twin of the server's INVITE_SIGNUP_WIRED_BRANDS (features/growth/contract.ts;
 * a test keeps them equal). GoApply joins once its phone and WeChat sign-ups
 * pass the invite code (request R-60-3).
 */
export const INVITE_REWARD_BRANDS: readonly string[] = ['roboapply'];

/** The invite programme runs here: capability on and every sign-up path attaches invites. */
export function useInvitesLive(): boolean {
  const on = useFlag('invites');
  const brand = useBrandId();
  return on && INVITE_REWARD_BRANDS.includes(brand);
}
export const INVITES_STALE_MS = 60 * 1000;

const FINAL_CODES = new Set(['unauthorized', 'auth_expired', 'AUTH_REQUIRED', 'INVALID_TOKEN', 'NO_AUTH', 'auth_other_brand', 'not_implemented', 'feature_disabled', 'not_found']);

export function shouldRetryInvites(failureCount: number, error: unknown): boolean {
  const code = apiErrorCode(error);
  if (code && FINAL_CODES.has(code)) return false;
  return failureCount < 1;
}

export function useInvites(options: { enabled?: boolean } = {}): UseQueryResult<InvitesResponse> {
  return useQuery<InvitesResponse>({
    queryKey: INVITES_QUERY_KEY,
    queryFn: ({ signal }) => getInvites({ signal }),
    staleTime: INVITES_STALE_MS,
    retry: shouldRetryInvites,
    enabled: options.enabled ?? true,
  });
}

/** The full invite link on this site's own origin (dev hosts stay local). */
export function inviteLinkFor(view: Pick<InvitesResponse, 'path' | 'link'> | null | undefined, origin?: string): string | null {
  if (!view?.path) return view?.link ?? null;
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return base ? `${base.replace(/\/+$/, '')}${view.path}` : view.link;
}

export function useShareInvite(from: 'invite_page' | 'settings') {
  const client = useQueryClient();
  return useMutation<unknown, unknown, InviteShareChannel>({
    mutationFn: async (channel) => {
      track('invite_link_shared', { channel, from });
      try {
        return await markInviteShared({ channel });
      } catch {
        // Sharing already happened on the device; the note is best effort.
        return null;
      }
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: INVITES_QUERY_KEY });
    },
  });
}
