import { describe, expect, it, vi } from 'vitest';

import {
  waitForApi,
  type ApiHealthFetch,
} from '../../scripts/dev-web-after-api';

function fakeClock() {
  let currentMs = 0;
  return {
    now: () => currentMs,
    sleep: async (ms: number) => {
      currentMs += ms;
    },
  };
}

describe('waitForApi', () => {
  it('waits through connection failures and unhealthy responses', async () => {
    const clock = fakeClock();
    const fetchImpl = vi
      .fn<ApiHealthFetch>()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await waitForApi('http://localhost:4611/api/v1/health', {
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 200,
      timeoutMs: 1_000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(clock.now()).toBe(400);
  });

  it('starts immediately when the API is already healthy', async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn<ApiHealthFetch>().mockResolvedValue({ ok: true, status: 200 });

    await waitForApi('http://localhost:4611/api/v1/health', {
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(clock.now()).toBe(0);
  });

  it('fails with the last health error after the readiness timeout', async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn<ApiHealthFetch>().mockResolvedValue({ ok: false, status: 503 });

    await expect(
      waitForApi('http://localhost:4611/api/v1/health', {
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        intervalMs: 200,
        timeoutMs: 400,
      }),
    ).rejects.toThrow(
      'API did not become ready at http://localhost:4611/api/v1/health within 400ms (health check returned HTTP 503)',
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
