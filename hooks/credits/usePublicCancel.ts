'use client';

// hooks/credits/usePublicCancel.ts — the /cancel page without signing in
// (PRODUCT F-BILL-03; §312k BGB): email → one-time link (30 min) → confirm.
//
// The request step always "succeeds" from the visitor's point of view: the
// server answers 204 whether or not the email has a subscription, so the page
// never reveals who is a customer.
//
// With a link (ST-9, MARKET_STRATEGY §4.4 "Statutory withdrawal"): the page
// first asks what the link can do (`usePreviewPublicCancel`; the link stays
// usable), then the visitor either cancels at the end of the period or, while
// a withdrawal is open, withdraws from the contract (`withdraw: true`).

import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

import { accountApi, type PublicCancelConfirmBody, type PublicCancelPreview, type PublicCancelResult } from '../../lib/api/account';
import { requestPublicCancel } from '../../lib/api/credits';

export function useRequestCancelLink(): UseMutationResult<void, Error, { email: string }> {
  return useMutation({ mutationFn: (body: { email: string }) => requestPublicCancel({ email: body.email.trim().toLowerCase() }) });
}

export const PUBLIC_CANCEL_PREVIEW_QUERY_KEY = ['credits', 'publicCancel', 'preview'] as const;

/**
 * The longest the cancel page waits for the question before it shows its
 * button. The answer needs the payment provider on the server, and the page
 * shows no button while it waits: a question that hangs must not keep a
 * visitor from cancelling (§312k BGB). Long enough for a cold start plus one
 * read at the payment provider.
 */
export const PUBLIC_CANCEL_PREVIEW_TIMEOUT_MS = 8000;

/** `work`, or a rejection after `ms` (the request is aborted then). An answer that arrives later is dropped. */
function withinTime<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (outer?.aborted) abort();
  outer?.addEventListener('abort', abort, { once: true });
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abort();
      reject(new Error('The cancel link question took too long'));
    }, ms);
    const settle = () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', abort);
    };
    work(controller.signal).then(
      (value) => {
        settle();
        resolve(value);
      },
      (err: unknown) => {
        settle();
        reject(err);
      },
    );
  });
}

/**
 * What the emailed link can do: the plan it cancels, until when access stays,
 * and the withdrawal it can make while one is open. Asked once per page view
 * and never again by itself: the answer is a quote the visitor acts on, and
 * the link does not get better by asking twice. The question fails after
 * `PUBLIC_CANCEL_PREVIEW_TIMEOUT_MS`; the page then offers the ordinary
 * cancel, as for any other failed question, and a late answer changes nothing.
 */
export function usePreviewPublicCancel(token: string | null): UseQueryResult<PublicCancelPreview> {
  return useQuery<PublicCancelPreview>({
    queryKey: [...PUBLIC_CANCEL_PREVIEW_QUERY_KEY, token],
    queryFn: ({ signal }) => withinTime((s) => accountApi.previewPublicCancel(token!, { signal: s }), PUBLIC_CANCEL_PREVIEW_TIMEOUT_MS, signal),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useConfirmPublicCancel(): UseMutationResult<PublicCancelResult, Error, PublicCancelConfirmBody> {
  return useMutation({ mutationFn: (body: PublicCancelConfirmBody) => accountApi.confirmPublicCancel(body) });
}
