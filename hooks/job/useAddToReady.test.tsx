// M5 gate (MKT-5C O-10, review finding 3): adding a job to Ready to apply.
// The server refuses a posting that is gone with 410 `gone` and
// `details.reason: 'job_closed'`, and a full list with 409 `conflict` and
// `details.reason: 'queue_full'`. The hook keeps the two apart, so no surface
// words a closed job as "your list is full" or as "try again".

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ addToQueue: vi.fn() }));
vi.mock('../../lib/api/agent', () => ({ addToQueue: api.addToQueue }));

import { RoboApiError } from '../../lib/api/client';
import { useAddToReady } from './useAddToReady';

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidated: unknown[] = [];
  const real = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((filters: { predicate?: (q: { queryKey: readonly unknown[] }) => boolean }) => {
    invalidated.push(['job', 'agent'].filter((k) => filters.predicate?.({ queryKey: [k] })));
    return real(filters as never);
  }) as never;
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { wrapper, invalidated };
}

const refusal = (status: number, code: string, reason: string) =>
  new RoboApiError('x', { status, code, payload: { success: false, code, error: 'x', details: { reason } } });

beforeEach(() => api.addToQueue.mockReset());

describe('useAddToReady', () => {
  it('added: the job and the list are read again', async () => {
    api.addToQueue.mockResolvedValue({ added: 1 });
    const h = harness();
    const { result } = renderHook(() => useAddToReady('j1'), { wrapper: h.wrapper });
    await act(() => result.current.add());
    expect(result.current.status).toBe('added');
    expect(api.addToQueue).toHaveBeenCalledWith({ jobIds: ['j1'], addedVia: 'manual' });
    expect(h.invalidated).toEqual([['job', 'agent']]);
  });

  it('a posting that is gone is "closed", never "full" or a retry; the job page reads itself again', async () => {
    api.addToQueue.mockRejectedValueOnce(refusal(410, 'gone', 'job_closed'));
    const h = harness();
    const { result } = renderHook(() => useAddToReady('j1'), { wrapper: h.wrapper });
    await act(() => result.current.add());
    await waitFor(() => expect(result.current.status).toBe('closed'));
    expect(h.invalidated).toEqual([['job']]);
  });

  it('a full list is "full"; anything else is "error"', async () => {
    api.addToQueue.mockRejectedValueOnce(refusal(409, 'conflict', 'queue_full'));
    const h = harness();
    const { result } = renderHook(() => useAddToReady('j1'), { wrapper: h.wrapper });
    await act(() => result.current.add());
    expect(result.current.status).toBe('full');
    api.addToQueue.mockRejectedValueOnce(new RoboApiError('x', { status: 500, code: 'internal_error' }));
    await act(() => result.current.add());
    expect(result.current.status).toBe('error');
    expect(h.invalidated).toEqual([]);
  });
});
