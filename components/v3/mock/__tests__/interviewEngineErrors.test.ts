// The interview-engine error envelope (contract C5) and the keepalive end
// (contract C8). The UI picks its message from ieErrorInfo, so a code that
// stops parsing silently turns every specific message into the generic one.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoboApiError } from '../../../../lib/api/client';
import { endSessionKeepalive, ieErrorInfo, RETRYABLE_PREPARE_ERRORS } from '../../../../lib/api/interviewEngine';

describe('ieErrorInfo', () => {
  it('reads the contract code, reason and session from the payload', () => {
    const info = ieErrorInfo(new RoboApiError('x', {
      status: 409,
      payload: { error: 'session_failed', reason: 'llm_unavailable', session: { id: 's1' } },
    }));
    expect(info).toMatchObject({ code: 'session_failed', status: 409, network: false, reason: 'llm_unavailable' });
    expect(info.session).toEqual({ id: 's1' });
  });

  it('ignores unknown codes and flags network failures', () => {
    expect(ieErrorInfo(new RoboApiError('x', { status: 500, payload: { error: 'boom' } })).code).toBeNull();
    expect(ieErrorInfo(new RoboApiError('x', { code: 'network_error' })).network).toBe(true);
    expect(ieErrorInfo(new TypeError('Failed to fetch')).network).toBe(true);
  });

  it('only the plan-writing failures are retryable from the live page', () => {
    expect(RETRYABLE_PREPARE_ERRORS.has('llm_unavailable')).toBe(true);
    expect(RETRYABLE_PREPARE_ERRORS.has('prepare_failed')).toBe(true);
    expect(RETRYABLE_PREPARE_ERRORS.has('no_answer')).toBe(false);
  });
});

describe('endSessionKeepalive', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('POSTs /end with keepalive and does not wait for it', () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    expect(endSessionKeepalive('s 1')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/interview-engine\/sessions\/s%201\/end$/);
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'include' });
  });
});
