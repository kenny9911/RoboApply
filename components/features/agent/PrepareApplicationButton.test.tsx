// PrepareApplicationButton — one tap from a job to an application being
// prepared (docs/agent-driven/REDESIGN.md §5).
//
// What must hold:
//   • the three server calls happen in the old path's order: add to the list,
//     a quote with no `confirm` (the cost is on screen before anything is
//     spent), then `confirm: true` through the credit gate;
//   • a job that is already past "picked" is never prepared twice: the button
//     is a link to where that application is;
//   • a closed posting and a full list say so and spend nothing;
//   • flag `agent` off → nothing renders (R-04);
//   • no wording implies the product applies or submits (D1).
// Agent calls are mocked at lib/api/agent; credits answer from a fetch double.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/today',
}));

const api = vi.hoisted(() => ({
  getAgentSettings: vi.fn(),
  addToQueue: vi.fn(),
  prepareKit: vi.fn(),
}));
vi.mock('../../../lib/api/agent', async (orig) => ({ ...(await orig<typeof import('../../../lib/api/agent')>()), ...api }));

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { installFetch, ok } from '../filters/filters.testkit';
import { RoboApiError } from '../../../lib/api/client';
import { __outOfCreditsStore } from '../../../hooks/shared/useCreditGate';
import { __toastStore } from '../../v3/primitives/Toast';
import type { QueueItemView, QueueState } from '../../../lib/api/contracts/agent';
import { PrepareApplicationButton, placeOf } from './PrepareApplicationButton';

const RESETS = '2026-11-16T00:00:00.000Z';
const bucket = (cap: number, remaining: number, window: 'day' | 'week') => ({ cap, window, used: cap - remaining, remaining, grantRemaining: 0, resetsAt: RESETS });
const CREDITS = {
  summary: {
    planKey: 'free',
    planProfile: 'free',
    legacyPlan: false,
    interval: null,
    periodEnd: null,
    timezone: 'UTC',
    upgradable: true,
    buckets: { ready_kits: bucket(3, 2, 'week'), tailor: bucket(2, 2, 'day'), cover_letter: bucket(2, 1, 'day') },
    entitlements: {},
  },
  practice: null,
};

function item(over: Partial<QueueItemView> = {}): QueueItemView {
  return {
    id: 'q1',
    jobId: 'job1',
    state: 'picked',
    weekKey: '2026-W46',
    trackerEntryId: null,
    resumeVariantId: null,
    coverLetterId: null,
    missingFields: [],
    addedVia: 'feed',
    openedAt: null,
    userMarkedSubmitted: false,
    updatedAt: '2026-11-11T00:00:00.000Z',
    ...over,
  };
}

const apiError = (status: number, code: string, details?: unknown) => new RoboApiError(code, { code, status, payload: { code, details } });

const ON = { agent: true };
const toasts = () => __toastStore.get().map((t) => t.message);

beforeEach(() => {
  vi.clearAllMocks();
  __outOfCreditsStore.set(null);
  __toastStore.set([]);
  api.getAgentSettings.mockResolvedValue({ weeklyTarget: 10, minTier: 'good', tailorEach: true, coverLetterMode: 'when_required', baseVariantId: null, fileNameStyle: 'name_company_role' });
  api.addToQueue.mockResolvedValue({ items: [item()] });
  api.prepareKit.mockImplementation(async (_id: string, body: { confirm?: boolean }) =>
    body.confirm ? { credits: [], confirmed: true, started: ['q1'] } : { credits: [{ bucket: 'tailor', cost: 1 }], confirmed: false },
  );
  installFetch({ 'GET /api/v1/roboapply/credits': () => ok(CREDITS) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('placeOf (pure)', () => {
  it('maps every queue state to where the application is, and leaves the preparable ones to the button', () => {
    const expected: Record<QueueState, ReturnType<typeof placeOf>> = {
      picked: null,
      failed: null,
      preparing: 'preparing',
      ready_for_review: 'review',
      approved: 'review',
      opened: 'sent',
      applied: 'sent',
      skipped: 'listed',
      expired: 'listed',
    };
    for (const [state, place] of Object.entries(expected)) expect(placeOf(state as QueueState), state).toBe(place);
    expect(placeOf(null)).toBeNull();
    expect(placeOf(undefined)).toBeNull();
  });
});

describe('PrepareApplicationButton', () => {
  it('renders nothing when the agent flag is off', () => {
    const { container } = renderWithBrand(<PrepareApplicationButton jobId="job1" />, { flags: {} });
    expect(container.querySelector('[data-testid="prepare-application"]')).toBeNull();
    expect(api.addToQueue).not.toHaveBeenCalled();
  });

  it('adds the job, shows the cost before anything is spent, then starts the preparation', async () => {
    const onStarted = vi.fn();
    renderWithBrand(<PrepareApplicationButton jobId="job1" addedVia="suggestions" onStarted={onStarted} />, { flags: ON });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));

    await waitFor(() => expect(api.addToQueue).toHaveBeenCalledWith({ jobIds: ['job1'], addedVia: 'suggestions' }));
    const sheet = await screen.findByTestId('prepare-sheet');
    expect(await within(sheet).findByTestId('cost-ready_kits')).toHaveTextContent('Uses 1 kit; you have 2 left this week.');
    expect(within(sheet).getByTestId('cost-tailor')).toHaveTextContent('Uses 1 tailoring credit; you have 2 left today.');
    // The quote spends nothing: no `confirm` has been sent.
    expect(api.prepareKit).toHaveBeenCalledTimes(1);
    expect(api.prepareKit).toHaveBeenCalledWith('q1', {});
    expect(within(sheet).getByText('You submit each application yourself.')).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Prepare 1 kit' }));
    await waitFor(() => expect(api.prepareKit).toHaveBeenCalledTimes(2));
    const confirmed = api.prepareKit.mock.calls[1]!;
    expect(confirmed[0]).toBe('q1');
    expect(confirmed[1]).toEqual({ confirm: true });
    expect(confirmed[2]?.idempotencyKey).toEqual(expect.any(String));

    // The button is now a link to the application being prepared.
    const link = await screen.findByRole('link', { name: 'Being prepared' });
    expect(link).toHaveAttribute('href', '/ready/job1');
    expect(link).toHaveAttribute('data-place', 'preparing');
    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1', jobId: 'job1' }));
    expect(toasts()).toContain('Being prepared. It shows under Waiting for you when it needs your OK.');
  });

  it('cancelling the cost sheet spends nothing and leaves the button', async () => {
    renderWithBrand(<PrepareApplicationButton jobId="job1" />, { flags: ON });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    await screen.findByTestId('prepare-sheet');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('prepare-sheet')).toBeNull());
    expect(api.prepareKit.mock.calls.every((c) => c[1]?.confirm !== true)).toBe(true);
    expect(screen.getByRole('button', { name: 'Prepare application' })).toBeEnabled();
  });

  it('never prepares twice: a job the server already has past "picked" becomes a link', async () => {
    api.addToQueue.mockResolvedValue({ items: [item({ state: 'ready_for_review' })] });
    renderWithBrand(<PrepareApplicationButton jobId="job1" variant="primary" />, { flags: ON });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    const link = await screen.findByRole('link', { name: 'Check and open' });
    expect(link).toHaveAttribute('href', '/ready/job1');
    // The user's next move keeps the caller's emphasis.
    expect(link).toHaveClass('btn', 'primary');
    expect(screen.queryByTestId('prepare-sheet')).toBeNull();
    expect(api.prepareKit).not.toHaveBeenCalled();
  });

  it.each([
    ['preparing', 'Being prepared', '/ready/job1'],
    ['approved', 'Check and open', '/ready/job1'],
    ['applied', 'See application', '/applications?entry=t9'],
    ['expired', 'On your list', '/ready?tab=done'],
  ] as const)('a known state "%s" renders the link "%s" without any request', (queueState, name, href) => {
    renderWithBrand(<PrepareApplicationButton jobId="job1" queueState={queueState} trackerEntryId="t9" />, { flags: ON });
    expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
    expect(screen.queryByRole('button')).toBeNull();
    expect(api.addToQueue).not.toHaveBeenCalled();
  });

  it('a status link stays quiet even when the caller asked for a primary button', () => {
    renderWithBrand(<PrepareApplicationButton jobId="job1" queueState="preparing" variant="primary" />, { flags: ON });
    expect(screen.getByRole('link', { name: 'Being prepared' })).not.toHaveClass('primary');
  });

  it('a closed posting says so and prepares nothing', async () => {
    api.addToQueue.mockRejectedValue(apiError(410, 'gone', { reason: 'job_closed' }));
    renderWithBrand(<PrepareApplicationButton jobId="job1" />, { flags: ON });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    await waitFor(() => expect(toasts()).toContain('This job is no longer listed, so nothing was prepared.'));
    expect(api.prepareKit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('prepare-sheet')).toBeNull();
  });

  it('a full list says what to do and prepares nothing', async () => {
    api.addToQueue.mockRejectedValue(apiError(409, 'conflict', { reason: 'queue_full', room: 0 }));
    renderWithBrand(<PrepareApplicationButton jobId="job1" />, { flags: ON });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    await waitFor(() => expect(toasts()).toContain('Your list is full. Remove a job from Getting ready, then try again.'));
    expect(api.prepareKit).not.toHaveBeenCalled();
  });

  it('out of credits: the gate opens its sheet, nothing starts, and the button stays', async () => {
    api.prepareKit.mockImplementation(async (_id: string, body: { confirm?: boolean }) => {
      if (body.confirm) throw apiError(402, 'credits_exhausted', { bucket: 'ready_kits', resetsAt: RESETS, upgradable: true });
      return { credits: [{ bucket: 'tailor', cost: 1 }], confirmed: false };
    });
    renderWithBrand(<PrepareApplicationButton jobId="job1" />, { flags: ON });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    const sheet = await screen.findByTestId('prepare-sheet');
    await within(sheet).findByTestId('cost-tailor');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Prepare 1 kit' }));
    await waitFor(() => expect(__outOfCreditsStore.get()).toEqual({ bucket: 'ready_kits', resetsAt: RESETS, upgradable: true }));
    expect(screen.queryByRole('link', { name: 'Being prepared' })).toBeNull();
    expect(toasts()).not.toContain('Being prepared. It shows under Waiting for you when it needs your OK.');
  });

  it('no control implies the product applies or submits (D1)', async () => {
    renderWithBrand(<PrepareApplicationButton jobId="job1" />, { flags: ON });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    await screen.findByTestId('prepare-sheet');
    for (const el of [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')]) {
      expect(el.textContent ?? '').not.toMatch(/submit|apply for me|auto[- ]?apply/i);
    }
  });
});
