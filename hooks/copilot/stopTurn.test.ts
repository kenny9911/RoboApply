// The Stop button names the thread to stop (verification finding: "Stopped."
// on screen, the full answer stored). The call is the `stopTurn` wrapper in
// lib/api/copilot.ts; the last test checks the real wrapper's request.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ stopTurn: vi.fn(async (_threadId: string) => ({ stopped: true })) }));
vi.mock('../../lib/api/copilot', () => api);

import { requestStopTurn } from './stopTurn';

describe('requestStopTurn', () => {
  beforeEach(() => api.stopTurn.mockClear());

  it('asks the server to stop the reply of that thread', async () => {
    expect(await requestStopTurn('th_1')).toBe(true);
    expect(api.stopTurn).toHaveBeenCalledWith('th_1');
  });

  it('does nothing before the thread exists', async () => {
    expect(await requestStopTurn(null)).toBe(false);
    expect(api.stopTurn).not.toHaveBeenCalled();
  });

  it('never throws when the server cannot be reached', async () => {
    api.stopTurn.mockRejectedValueOnce(new Error('network'));
    expect(await requestStopTurn('th_1')).toBe(false);
  });
});

describe('the wrapper in lib/api/copilot.ts', () => {
  it('POSTs to the thread\'s stop endpoint and returns whether a reply was stopped', async () => {
    const real = await vi.importActual<typeof import('../../lib/api/copilot')>('../../lib/api/copilot');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { stopped: true } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await real.stopTurn('th 1')).toEqual({ stopped: true });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toMatch(/\/api\/v1\/roboapply\/copilot\/threads\/th%201\/stop$/);
      expect(init.method).toBe('POST');
      expect(real.copilotApi.stopTurn).toBe(real.stopTurn);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
