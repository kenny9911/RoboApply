// hooks/today/loadable.ts — one read on Today, in the four states the screen
// tells apart (docs/agent-driven/REDESIGN.md §5; ruling D3):
//
//   off      the capability is off for this brand or user: there is no entry
//            for it (R-04), and nothing was asked
//   loading  asked, no answer yet: the screen shows "—" or a skeleton, never 0
//   error    asked, failed: the lane says so and offers Retry
//   ready    a real answer from the server
//
// A read that already has data stays `ready` while it refreshes or when a
// refresh fails: the last real answer is still a real answer.

import { apiErrorCode } from '../../lib/api/contracts/wire';

export type Loadable<T> = { status: 'off' } | { status: 'loading' } | { status: 'error'; retry: () => void } | { status: 'ready'; data: T };

export const OFF: Loadable<never> = { status: 'off' };
export const LOADING: Loadable<never> = { status: 'loading' };

/** The part of a query result `loadableOf` reads. */
export interface QueryLike<T> {
  data: T | undefined;
  isError: boolean;
  error?: unknown;
  refetch: () => unknown;
}

/** The server says the area is not there for this account: no entry, not an error. */
export function isUnavailableError(error: unknown): boolean {
  const code = apiErrorCode(error);
  return code === 'feature_disabled' || code === 'not_implemented';
}

/**
 * A query as a Loadable. `enabled` false is `off`. `pick` may return
 * `undefined` for an answer it cannot read (a wrong shape): that is an error,
 * never a made-up value.
 */
export function loadableOf<T, R>(query: QueryLike<T>, enabled: boolean, pick: (data: T) => R | undefined): Loadable<R> {
  if (!enabled) return OFF;
  const retry = () => {
    void query.refetch();
  };
  if (query.data !== undefined) {
    const picked = pick(query.data);
    return picked === undefined ? { status: 'error', retry } : { status: 'ready', data: picked };
  }
  if (query.isError) return isUnavailableError(query.error) ? OFF : { status: 'error', retry };
  return LOADING;
}

/** The value when it is known, else null ("—" on screen). */
export function valueOf<T>(loadable: Loadable<T>): T | null {
  return loadable.status === 'ready' ? loadable.data : null;
}
