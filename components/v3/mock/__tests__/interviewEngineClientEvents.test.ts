// postClientEvents — client telemetry from the live interview room.
//
// The contract is fire-and-forget: telemetry must NEVER affect the interview
// (failures swallowed), a single call is capped at 50 events (backend limit +
// keepalive body size), and the final flush can ride `keepalive: true` so it
// survives page unload. These tests pin that contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  postClientEvents,
  type IEClientEvent,
} from '../../../../lib/api/interviewEngine';

function makeEvents(n: number): IEClientEvent[] {
  return Array.from({ length: n }, (_, i) => ({ type: `evt_${i}`, ts: i }));
}

describe('postClientEvents', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('POSTs the batch to the session client-events endpoint with cookie credentials', () => {
    postClientEvents('sess-1', [
      { type: 'reconnecting', ts: 1 },
      { type: 'reconnected', ts: 2, data: { offlineMs: 1200 } },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/interview-engine/sessions/sess-1/client-events');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.keepalive).toBe(false);
    const body = JSON.parse(init.body as string) as { events: IEClientEvent[] };
    expect(body.events).toHaveLength(2);
    expect(body.events[1]).toEqual({ type: 'reconnected', ts: 2, data: { offlineMs: 1200 } });
  });

  it('URL-encodes the session id', () => {
    postClientEvents('sess 1/x', makeEvents(1));
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/sessions/sess%201%2Fx/client-events');
  });

  it('caps a single call at 50 events', () => {
    postClientEvents('sess-1', makeEvents(80));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { events: IEClientEvent[] };
    expect(body.events).toHaveLength(50);
    expect(body.events[0].type).toBe('evt_0');
    expect(body.events[49].type).toBe('evt_49');
  });

  it('sets keepalive for the final unload flush', () => {
    postClientEvents('sess-1', makeEvents(1), { keepalive: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.keepalive).toBe(true);
  });

  it('does nothing for an empty batch', () => {
    postClientEvents('sess-1', []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the localStorage bearer token as a fallback to the cookie', () => {
    window.localStorage.setItem('auth_token', 'tok-123');
    postClientEvents('sess-1', makeEvents(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-123');
  });

  it('swallows network failures (fire-and-forget)', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(() => postClientEvents('sess-1', makeEvents(1))).not.toThrow();
    // Drain the microtask queue — an unhandled rejection here would fail the run.
    await Promise.resolve();
    await Promise.resolve();
  });
});
