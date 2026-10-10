// server/src/features/jobs/sources/atsPublic/http.ts — the only outbound HTTP
// of the public ATS connectors (WP-42).
//
// Review rule (TASK_PLAN.md WP-16b / WP-42, CN_TW_LAUNCH_PLAN.md L-5): JSON
// posting APIs only. A request to any host outside API_HOSTS is refused before
// it is sent, so no code path can fetch an HTML job board (104, 1111, Cake,
// Yourator, LinkedIn …) or Workday's career sites. Requests carry no personal
// information: only the ops-curated board token is in the URL. Redirects are
// never followed (`redirect: 'error'`, and a 3xx is refused), so an allowed
// API host cannot hand the request on to another host.

import { MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS } from './shared.js';

/** The documented public posting APIs, one per supported ATS. */
export const API_HOSTS = ['boards-api.greenhouse.io', 'api.lever.co', 'api.ashbyhq.com', 'api.smartrecruiters.com'] as const;

export type FetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' | 'manual' | 'follow' },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class BoardFetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'BoardFetchError';
    this.status = status;
  }
}

export interface HttpDeps {
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function assertApiHost(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BoardFetchError('invalid_url');
  }
  if (parsed.protocol !== 'https:' || !(API_HOSTS as readonly string[]).includes(parsed.hostname)) {
    throw new BoardFetchError(`host_not_allowed:${parsed.hostname}`);
  }
  return parsed;
}

/** GET a JSON document from an allowed API host. Throws BoardFetchError. */
export async function getJson(url: string, deps: HttpDeps = {}): Promise<unknown> {
  assertApiHost(url);
  if (deps.signal?.aborted) throw new BoardFetchError('timeout');
  const doFetch: FetchLike = deps.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await doFetch(url, { signal: controller.signal, headers: { Accept: 'application/json' }, redirect: 'error' });
    // A fetch that ignores `redirect` (or answers 'manual') must still not be followed.
    if (res.status >= 300 && res.status < 400) throw new BoardFetchError('redirect', res.status);
    if (!res.ok) throw new BoardFetchError(res.status === 404 ? 'board_not_found' : `http_${res.status}`, res.status);
    const body = await res.text();
    if (body.length > MAX_RESPONSE_BYTES) throw new BoardFetchError('response_too_large');
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new BoardFetchError('not_json');
    }
  } catch (err) {
    if (err instanceof BoardFetchError) throw err;
    if (controller.signal.aborted) throw new BoardFetchError('timeout');
    // undici rejects a redirect under `redirect: 'error'` with a TypeError.
    if (err instanceof TypeError && /redirect/i.test(`${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`)) {
      throw new BoardFetchError('redirect');
    }
    throw new BoardFetchError(err instanceof Error ? `network:${err.message.slice(0, 120)}` : 'network');
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}
