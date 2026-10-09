// WP-23 web: lib/api/growth.ts sendEventsBeacon, the keepalive request that
// carries events while the page is hidden or closed. growth.test.tsx mocks
// the whole module, so this file exercises the real function against a
// stubbed fetch (no network).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE } from '../../../lib/config';
import { EVENTS_PATH, sendEventsBeacon } from '../../../lib/api/growth';
import { apiUrl } from '../../../lib/api/contracts/wire';

const BODY = {
  anonId: 'anon_12345678',
  sessionId: 'sess_abcdefgh',
  events: [{ name: 'page_viewed' as const, path: '/jobs', at: '2026-10-10T12:00:00.000Z' }],
};

function clearBrandCookie() {
  document.cookie = 'ra_brand_override=; Path=/; Max-Age=0';
}

describe('sendEventsBeacon', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    clearBrandCookie();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearBrandCookie();
  });

  it('POSTs the JSON batch to the events endpoint with keepalive and the right credentials mode', () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(sendEventsBeacon(BODY)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(apiUrl('/api/v1/public/events'));
    expect(EVENTS_PATH).toBe('/api/v1/public/events');
    expect(init).toMatchObject({
      method: 'POST',
      keepalive: true,
      credentials: API_BASE ? 'include' : 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(init.body as string)).toEqual(BODY);
    expect((init.headers as Record<string, string>)['X-RA-Brand']).toBeUndefined();
  });

  it('adds the dev brand header when the brand override cookie is set (outside production)', () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    document.cookie = 'ra_brand_override=goapply; Path=/';

    sendEventsBeacon(BODY);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-RA-Brand']).toBe('goapply');
  });

  it('returns false when fetch throws synchronously, and swallows an async rejection', async () => {
    globalThis.fetch = vi.fn(() => {
      throw new TypeError('keepalive body too large');
    }) as unknown as typeof fetch;
    expect(sendEventsBeacon(BODY)).toBe(false);

    const rejecting = vi.fn(async () => Promise.reject(new TypeError('offline')));
    globalThis.fetch = rejecting as unknown as typeof fetch;
    expect(sendEventsBeacon(BODY)).toBe(true);
    await Promise.resolve();
    expect(rejecting).toHaveBeenCalledTimes(1);
  });

  it('returns false where fetch does not exist', () => {
    // @ts-expect-error simulating a runtime without fetch
    globalThis.fetch = undefined;
    expect(sendEventsBeacon(BODY)).toBe(false);
  });
});
