// The Stop button names the thread to stop (verification finding: "Stopped."
// on screen, the full answer stored). The API wrapper is looked up by name in
// lib/api/copilot.ts; without it the call is a no-op (with a development
// warning), and the tripwire at the end of this file says when that changes.

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

describe('the wrapper in lib/api/copilot.ts (FIX-5 handoff, Request 1)', () => {
  // Until `stopTurn` is exported there, Stop does not reach the server. This test is EXPECTED to
  // fail today (`it.fails`). When it goes red the wrapper has landed: in hooks/copilot/stopTurn.ts
  // replace the by-name lookup with `import { stopTurn } from '../../lib/api/copilot'`, and delete
  // this test.
  it.fails('TRIPWIRE: lib/api/copilot.ts exports stopTurn — import it directly in stopTurn.ts, then delete this test', async () => {
    const real = await vi.importActual<Record<string, unknown>>('../../lib/api/copilot');
    expect(typeof real.stopTurn).toBe('function');
  });
});
