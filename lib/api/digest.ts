// Digest endpoints. The cached digest payload is fetched via GET /digest/today;
// the live SSE stream is opened via GET /digest/stream with a `?token=` query
// for cross-origin auth (cookies don't flow on EventSource without same-site).
//
// The SSE format mirrors the seeker coach SSE: frames are `data: {...json}\n\n`.
// We parse with fetch + ReadableStream (not EventSource) because that gives us
// AbortController control. Mirrors _archive/seeker-app-v1/lib/api/coach.ts.

import { API_BASE } from '../config';
import { RoboApiError, roboApi } from './client';
import type { DigestStreamEvent } from './types';

export interface DigestSnapshot {
  appNarration: string;
  citedRunIds: string[];
  sentAt: string | null;
  /** Whether this digest is freshly streaming or already cached. */
  streaming: boolean;
}

/**
 * Fetch the cached digest for today. Backend returns `data: null` (with
 * 200, not 404) when no digest has been composed yet — that's the normal
 * first-run state. Consumers must guard for null.
 */
export function getTodayDigest() {
  return roboApi.get<DigestSnapshot | null>('/api/v1/roboapply/digest/today');
}

function getBearerToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem('auth_token');
  } catch {
    return null;
  }
}

/**
 * Stream today's digest narration token-by-token. The async iterable yields
 * parsed events. Callers can abort via the `signal`.
 *
 * Backend may not have shipped this — the iterator throws RoboApiError with
 * code='not_found' and pages must fall back to the cached payload (or the
 * agent quote empty-state).
 */
export async function* streamDigest(
  signal?: AbortSignal,
): AsyncIterable<DigestStreamEvent> {
  const url = `${API_BASE}/api/v1/roboapply/digest/stream`;
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
  };
  const bearer = getBearerToken();
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    throw new RoboApiError(
      err instanceof Error ? err.message : 'Digest stream connect failed',
      { code: 'network_error' },
    );
  }

  if (!res.ok || !res.body) {
    let detail: unknown = undefined;
    try {
      detail = await res.json();
    } catch {
      /* noop */
    }
    throw new RoboApiError(`HTTP ${res.status}`, {
      status: res.status,
      payload: detail,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          try {
            yield JSON.parse(json) as DigestStreamEvent;
          } catch {
            yield {
              type: 'error',
              code: 'parse_error',
              message: 'Malformed SSE frame',
            };
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}
