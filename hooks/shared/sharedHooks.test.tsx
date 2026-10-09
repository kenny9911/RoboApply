// hooks/shared — the cross-area hooks FND-7 ships (credits, entitlements,
// credit gate, Assistant rail, job actions, tailor/practice launchers).

import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const flags: Record<string, boolean> = { copilot: true };
vi.mock('../../lib/flags', () => ({ useFlag: (key: string) => flags[key] === true }));

import { creditsResponse, freeSummary } from '../../__tests__/fixtures/credits';
import { CREDITS_QUERY_KEY, bucketSummary, creditsLeft, primeCredits, useCredits } from './useCredits';
import { useEntitlement, useEntitlements } from './useEntitlements';
import { __outOfCreditsStore, creditsExhaustedFrom, useCreditGate, useOutOfCredits } from './useCreditGate';
import { __assistantRailStore, useAssistantRail, useOpenAssistant } from './useOpenAssistant';
import { tailorHref, useLaunchTailor } from './useLaunchTailor';
import { practiceHref, useLaunchPractice } from './useLaunchPractice';
import { useJobActions } from './useJobActions';
import { RoboApiError } from '../../lib/api/client';

// ── fetch double ─────────────────────────────────────────────────────────────

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const calls: Array<{ method: string; path: string; init: RequestInit }> = [];
let handler: Handler;

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fail = (status: number, code: string, details?: unknown) =>
  new Response(JSON.stringify({ success: false, code, error: code, details }), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  handler = () => ok({});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: (init.method ?? 'GET').toUpperCase(), path: new URL(url, 'http://x').pathname, init });
      return handler(url, init);
    }),
  );
  push.mockReset();
  flags.copilot = true;
  __outOfCreditsStore.reset();
  __assistantRailStore.reset();
});
afterEach(() => vi.unstubAllGlobals());

function wrapper(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return {
    client,
    Wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  };
}

// ── useCredits / useEntitlements ─────────────────────────────────────────────

describe('useCredits / useEntitlements', () => {
  it('fetches GET /credits once and exposes the summary', async () => {
    handler = () => ok(creditsResponse);
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useCredits(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/roboapply/credits']);
    expect(result.current.data?.summary.planProfile).toBe('free');
  });

  it('computes what is left from window + bonus, null when unknown', () => {
    expect(creditsLeft(bucketSummary(freeSummary, 'fit_analysis'))).toBe(2);
    expect(creditsLeft(bucketSummary(freeSummary, 'tailor'))).toBe(0);
    expect(creditsLeft(bucketSummary(null, 'tailor'))).toBeNull();
    expect(bucketSummary(freeSummary, 'nope')).toBeNull();
  });

  it('fails closed until the summary arrives, then reads entitlements', async () => {
    let release!: () => void;
    handler = () => new Promise<Response>((r) => (release = () => r(ok(creditsResponse))));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => ({ e: useEntitlements(), saved: useEntitlement('saved_searches') }), { wrapper: Wrapper });
    expect(result.current.e).toMatchObject({ status: 'loading', isPro: false, upgradable: false, entitlements: null });
    expect(result.current.saved).toBeNull();
    await act(async () => release());
    await waitFor(() => expect(result.current.e.status).toBe('ready'));
    expect(result.current.saved).toBe(1);
    expect(result.current.e.upgradable).toBe(true);
  });

  it('primeCredits seeds the cache from /auth/me without a request, and clears on sign-out', async () => {
    const { client, Wrapper } = wrapper();
    primeCredits(client, freeSummary);
    const { result } = renderHook(() => useEntitlements(), { wrapper: Wrapper });
    expect(result.current.status).toBe('ready');
    expect(calls).toHaveLength(0);
    primeCredits(client, null);
    expect(client.getQueryData(CREDITS_QUERY_KEY)).toBeUndefined();
  });
});

// ── useCreditGate ────────────────────────────────────────────────────────────

describe('useCreditGate', () => {
  function gate(bucket: string) {
    const { client, Wrapper } = wrapper();
    primeCredits(client, freeSummary);
    return renderHook(() => ({ gate: useCreditGate(bucket), sheet: useOutOfCredits() }), { wrapper: Wrapper });
  }

  it('runs the action with a fresh idempotency key and returns its value', async () => {
    const { result } = gate('fit_analysis');
    expect(result.current.gate).toMatchObject({ left: 2, cap: 3, canSpend: true });
    const keys: string[] = [];
    let out: Awaited<ReturnType<typeof result.current.gate.run<string>>> | undefined;
    await act(async () => {
      out = await result.current.gate.run(async (key) => {
        keys.push(key);
        return 'done';
      });
    });
    expect(out).toEqual({ ok: true, value: 'done' });
    expect(keys[0]).toMatch(/.{8,}/);
    expect(result.current.sheet.info).toBeNull();
  });

  it('does not send the action when the summary shows nothing left; opens the sheet', async () => {
    const { result } = gate('tailor');
    expect(result.current.gate.canSpend).toBe(false);
    const action = vi.fn();
    let out: unknown;
    await act(async () => {
      out = await result.current.gate.run(action);
    });
    expect(action).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, reason: 'credits_exhausted', info: { bucket: 'tailor', upgradable: true } });
    expect(result.current.sheet.info).toEqual({ bucket: 'tailor', resetsAt: '2026-10-11T00:00:00.000Z', upgradable: true });
    act(() => result.current.sheet.dismiss());
    expect(result.current.sheet.info).toBeNull();
  });

  it('turns a 402 credits_exhausted into the sheet with the server details', async () => {
    const { result } = gate('fit_analysis');
    const err = new RoboApiError('No credits', {
      code: 'credits_exhausted',
      status: 402,
      payload: { code: 'credits_exhausted', details: { bucket: 'fit_analysis', resetsAt: '2026-10-11T07:00:00.000Z', upgradable: false } },
    });
    let out: unknown;
    await act(async () => {
      out = await result.current.gate.run(async () => {
        throw err;
      });
    });
    expect(out).toMatchObject({ ok: false, reason: 'credits_exhausted' });
    expect(result.current.sheet.info).toEqual({ bucket: 'fit_analysis', resetsAt: '2026-10-11T07:00:00.000Z', upgradable: false });
  });

  it('rethrows any other error', async () => {
    const { result } = gate('fit_analysis');
    await expect(
      act(async () => {
        await result.current.gate.run(async () => {
          throw new Error('boom');
        });
      }),
    ).rejects.toThrow('boom');
    expect(creditsExhaustedFrom(new Error('x'))).toBeNull();
  });
});

// ── Assistant rail ───────────────────────────────────────────────────────────

describe('useOpenAssistant / useAssistantRail', () => {
  it('opens the rail with the request; each request bumps the sequence', () => {
    const { result } = renderHook(() => ({ open: useOpenAssistant(), rail: useAssistantRail() }));
    expect(result.current.rail.open).toBe(false);
    act(() => {
      expect(result.current.open({ jobId: 'job_1', source: 'job_card' })).toBe(true);
    });
    expect(result.current.rail).toMatchObject({ open: true, request: { jobId: 'job_1', source: 'job_card' }, seq: 1 });
    act(() => void result.current.open({ jobId: 'job_1' }));
    expect(result.current.rail.seq).toBe(2);
    act(() => result.current.rail.close());
    expect(result.current.rail.open).toBe(false);
  });

  it('never opens when the copilot capability is off', () => {
    flags.copilot = false;
    const { result } = renderHook(() => ({ open: useOpenAssistant(), rail: useAssistantRail() }));
    act(() => {
      expect(result.current.open({ jobId: 'job_1' })).toBe(false);
    });
    expect(result.current.rail.open).toBe(false);
  });

  it('does not open on its own (re-render / navigation)', () => {
    const { result, rerender } = renderHook(() => useAssistantRail());
    rerender();
    rerender();
    expect(result.current.open).toBe(false);
    expect(result.current.seq).toBe(0);
  });
});

// ── Launchers ────────────────────────────────────────────────────────────────

describe('useLaunchTailor / useLaunchPractice', () => {
  it('builds the route contracts WP-36a and WP-43 implement', () => {
    expect(tailorHref({ jobId: 'j 1' })).toBe('/resume?tailor=j+1');
    expect(tailorHref({ jobId: 'j1', resumeId: 'rv/1', from: 'job_card' })).toBe('/resume/rv%2F1?tailor=j1&from=job_card');
    expect(practiceHref({ jobId: 'j1' })).toBe('/practice?job=j1');
    expect(practiceHref({ jobId: 'j1', resumeId: 'rv1', from: 'ready' })).toBe('/practice?job=j1&resume=rv1&from=ready');
  });

  it('navigate with the router', () => {
    const { result } = renderHook(() => ({ tailor: useLaunchTailor(), practice: useLaunchPractice() }));
    result.current.tailor({ jobId: 'j1' });
    result.current.practice({ jobId: 'j1' });
    expect(push.mock.calls.map((c) => c[0])).toEqual(['/resume?tailor=j1', '/practice?job=j1']);
  });
});

// ── useJobActions ────────────────────────────────────────────────────────────

describe('useJobActions', () => {
  function setup(applyUrl?: string | null) {
    const opened: string[] = [];
    const placeholder = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const opener = { open: (url: string) => void opened.push(url), blank: vi.fn(() => placeholder as unknown as Window) };
    const { client, Wrapper } = wrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const hook = renderHook(() => useJobActions('job_1', { applyUrl, opener, source: 'job_card' }), { wrapper: Wrapper });
    return { ...hook, opened, placeholder, opener, invalidate };
  }

  it('Apply on company site (URL known): opens it inside the click, records the click, offers Undo', async () => {
    handler = () => ok({ applyUrl: 'https://jobs.example.com/1', atsType: null, extensionSupported: false, trackerEntryId: 'trk_1' });
    const { result, opened, opener, invalidate } = setup('https://jobs.example.com/1');
    await act(async () => void (await result.current.applyOnCompanySite()));
    expect(opened).toEqual(['https://jobs.example.com/1']);
    expect(opener.blank).not.toHaveBeenCalled();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/v1/roboapply/jobs/job_1/apply-click']);
    expect(result.current.lastApplied).toMatchObject({ trackerEntryId: 'trk_1' });
    expect(invalidate).toHaveBeenCalled();

    await act(async () => result.current.undoApplied());
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/v1/roboapply/jobs/job_1/applied' });
    expect(result.current.lastApplied).toBeNull();
  });

  it('Apply on company site (URL unknown): points a placeholder tab at the URL the server returns', async () => {
    handler = () => ok({ applyUrl: 'https://jobs.example.com/2', atsType: null, extensionSupported: false, trackerEntryId: 'trk_2' });
    const { result, placeholder, opened } = setup(null);
    await act(async () => void (await result.current.applyOnCompanySite()));
    expect(placeholder.location.href).toBe('https://jobs.example.com/2');
    expect(placeholder.opener).toBeNull();
    expect(opened).toEqual([]);
  });

  it('closes the placeholder tab when the click fails, and keeps the error', async () => {
    handler = () => fail(404, 'not_found');
    const { result, placeholder } = setup(null);
    await act(async () => void (await result.current.applyOnCompanySite()));
    expect(placeholder.close).toHaveBeenCalled();
    expect(result.current.lastApplied).toBeNull();
    expect(result.current.error).toBeInstanceOf(RoboApiError);
  });

  it('save / unsave / hide / report / I applied hit the documented endpoints', async () => {
    handler = (url) => (url.includes('/hide') ? ok({ proposedFilterDiff: null }) : ok({}));
    const { result } = setup();
    await act(async () => {
      await result.current.save();
      await result.current.unsave();
      await result.current.hide('wrong_title');
      await result.current.report('scam', 'Asks for a fee');
      await result.current.markApplied('2026-10-09T12:00:00.000Z');
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/roboapply/jobs/job_1/save',
      'DELETE /api/v1/roboapply/jobs/job_1/save',
      'POST /api/v1/roboapply/feed/jobs/job_1/hide',
      'POST /api/v1/roboapply/feed/jobs/job_1/report',
      'POST /api/v1/roboapply/jobs/job_1/applied',
    ]);
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ reasonCode: 'wrong_title' });
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ reason: 'scam', note: 'Asks for a fee' });
    expect(result.current.lastApplied).toMatchObject({ at: '2026-10-09T12:00:00.000Z' });
  });

  it('Ask about this job / tailor / practice go through the shared launchers', () => {
    const { result } = setup();
    let opened = false;
    act(() => {
      opened = result.current.askAboutJob();
    });
    expect(opened).toBe(true);
    expect(__assistantRailStore.get()).toMatchObject({ open: true, request: { jobId: 'job_1', source: 'job_card' } });
    result.current.tailor('rv_1');
    result.current.practice();
    expect(push.mock.calls.map((c) => c[0])).toEqual(['/resume/rv_1?tailor=job_1&from=job_card', '/practice?job=job_1&from=job_card']);
  });
});
