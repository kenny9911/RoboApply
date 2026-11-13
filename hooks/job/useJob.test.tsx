// The two reads of one job page (hooks/job/useJob.ts): the person opened the
// job (`GET /jobs/:id`, the server records the view) or the page is shown
// before they picked it (`GET /jobs/:id?preview=1`, the desktop Jobs list's
// first job; nothing recorded). Each has its own cache entry, so opening a
// previewed job still reads the page (and the view is recorded); the page on
// screen stays meanwhile, and another job's page never stands in for it.

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { installFetch, ok } from '../../components/features/feed/feed.testkit';
import { jobKeys, useJob } from './useJob';

const page = (id: string, title = 'Backend Engineer') => ({ job: { id, title } });

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useJob: an open and a preview are two reads', () => {
  it('a preview asks with ?preview=1, an open without it; each keeps its own entry', async () => {
    const net = installFetch({ 'GET /api/v1/roboapply/jobs/j1': (c) => ok(page('j1', c.search ? 'Previewed' : 'Opened')) });
    const h = harness();
    const preview = renderHook(() => useJob('j1', { preview: true }), { wrapper: h.wrapper });
    await waitFor(() => expect(preview.result.current.data?.job.title).toBe('Previewed'));
    expect(net.calls.map((c) => c.search)).toEqual(['?preview=1']);
    const open = renderHook(() => useJob('j1'), { wrapper: h.wrapper });
    await waitFor(() => expect(open.result.current.data?.job.title).toBe('Opened'));
    expect(net.calls.map((c) => c.search)).toEqual(['?preview=1', '']);
    expect(h.client.getQueryData(jobKeys.preview('j1'))).toMatchObject({ job: { title: 'Previewed' } });
    expect(h.client.getQueryData(jobKeys.detail('j1'))).toMatchObject({ job: { title: 'Opened' } });
  });

  it('opening the previewed job keeps its page on screen while the open read runs, and never shows another job', async () => {
    let answer: (r: Response) => void = () => undefined;
    let opens = 0;
    installFetch({
      'GET /api/v1/roboapply/jobs/j1': (c) => {
        if (c.search) return ok(page('j1', 'Previewed'));
        opens += 1;
        return new Promise<Response>((resolve) => (answer = resolve));
      },
      'GET /api/v1/roboapply/jobs/j2': () => new Promise<Response>(() => undefined),
    });
    const h = harness();
    const view = renderHook(({ id, preview }: { id: string; preview: boolean }) => useJob(id, { preview }), { wrapper: h.wrapper, initialProps: { id: 'j1', preview: true } });
    await waitFor(() => expect(view.result.current.data?.job.title).toBe('Previewed'));
    view.rerender({ id: 'j1', preview: false });
    await waitFor(() => expect(opens).toBe(1));
    // The preview stands in (no loading state) until the open read answers.
    expect(view.result.current.isPending).toBe(false);
    expect(view.result.current.isPlaceholderData).toBe(true);
    expect(view.result.current.data?.job.title).toBe('Previewed');
    answer(ok(page('j1', 'Opened')));
    await waitFor(() => expect(view.result.current.data?.job.title).toBe('Opened'));
    expect(view.result.current.isPlaceholderData).toBe(false);
    // Another job never borrows this one's page.
    view.rerender({ id: 'j2', preview: false });
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.isPending).toBe(true);
  });
});
