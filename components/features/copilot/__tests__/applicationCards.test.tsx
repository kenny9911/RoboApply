// The Assistant's applications cards (docs/agent-driven/REDESIGN.md §1, §9):
// list_add, prepare_application and application_status, rendered from what the
// server's tools and apply path really send (wireCards.ts runs them over the
// server's area fakes). The cost is on the card before anything is spent, the
// button spends through the weekly-allowance credit gate with an idempotency
// key, failures say what happened, and the result links to the application the
// way the "Prepare application" button does. Nothing here submits (D1).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { CopilotCardView, applicationLink } from '../cards';
import { placeOf } from '../../agent';
import { __outOfCreditsStore } from '../../../../hooks/shared/useCreditGate';
import { listItem, prepareQuote } from '../../../../server/src/features/copilot/__tests__/areaFakes';
import { CREDITS, card, fail, installFetch, ok, renderUi, type Route } from './testkit';
import { wireApplication } from './wireCards';

vi.mock('../../../../server/src/services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return { ...real, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), forward: vi.fn() }), usePathname: () => '/jobs' };
});

/** The credit summary with the weekly allowance (`ready_kits`) next to the daily buckets. */
function creditsWithKits(kitsLeft = 3) {
  const c = CREDITS();
  (c.summary.buckets as Record<string, unknown>).ready_kits = { window: 'week', cap: 3, used: 3 - kitsLeft, remaining: kitsLeft, grantRemaining: 0, resetsAt: '2026-10-12T04:00:00.000Z' };
  return c;
}

function routes(extra: Record<string, Route> = {}, kitsLeft = 3): Record<string, Route> {
  return { 'GET /api/v1/roboapply/credits': () => ok(creditsWithKits(kitsLeft)), ...extra };
}

const applyPath = (proposalId: string) => `/api/v1/roboapply/copilot/proposals/${proposalId}/apply`;
const idOf = (c: { data: unknown }) => (c.data as { proposalId: string }).proposalId;

beforeEach(() => {
  __outOfCreditsStore.reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prepare_application', () => {
  it('states the cost before anything is spent, in the cost sheet’s own lines, and spends only on the press, with an idempotency key', async () => {
    const { proposal, applied } = await wireApplication('prepare_application');
    const http = installFetch(routes({ [`POST ${applyPath(idOf(proposal))}`]: () => ok(applied) }));
    renderUi(<CopilotCardView card={proposal} />);
    expect(screen.getByRole('heading', { name: 'Prepare your application for Data Analyst · Acme' })).toBeInTheDocument();
    expect(screen.getByText('It goes on your list first. That uses no credit.')).toBeInTheDocument();
    // The weekly allowance first, then tailoring, each with what is left (the server's summary).
    await screen.findByText('Uses 1 kit; you have 3 left this week.');
    expect(screen.getByText('Uses 1 tailoring credit; you have 2 left today.')).toBeInTheDocument();
    expect(screen.getByText('Kits are prepared in the background. Nothing is sent to any company.')).toBeInTheDocument();
    expect(screen.getByText('You submit each application yourself.')).toBeInTheDocument();
    expect(http.to('POST', applyPath(idOf(proposal)))).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    const link = await screen.findByRole('link', { name: 'Open it in Getting ready' });
    expect(link).toHaveAttribute('href', '/ready/job_1');
    expect(screen.getByText('Done.')).toBeInTheDocument();
    expect(screen.getByText('Being prepared. It shows under Waiting for you when it needs your OK.')).toBeInTheDocument();
    expect(screen.getByText('Preparing')).toBeInTheDocument();
    expect(screen.getByText('You submit each application yourself.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare application' })).not.toBeInTheDocument();
    const calls = http.to('POST', applyPath(idOf(proposal)));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['Idempotency-Key']).toBeTruthy();
  });

  it('with no kit left this week the out-of-credits sheet opens and nothing is sent', async () => {
    const { proposal } = await wireApplication('prepare_application');
    const http = installFetch(routes({}, 0));
    renderUi(<CopilotCardView card={proposal} />);
    await screen.findByText(/Uses 1 kit; you have 0 left this week\./);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    await waitFor(() => expect(__outOfCreditsStore.get()).toMatchObject({ bucket: 'ready_kits' }));
    expect(http.to('POST', applyPath(idOf(proposal)))).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Prepare application' })).toBeEnabled();
  });

  it('a 402 for another bucket opens the sheet with the server’s bucket; the card stays open', async () => {
    const { proposal } = await wireApplication('prepare_application');
    installFetch(routes({ [`POST ${applyPath(idOf(proposal))}`]: () => fail(402, 'credits_exhausted', { bucket: 'tailor', resetsAt: '2026-10-11T00:00:00.000Z', upgradable: true }) }));
    renderUi(<CopilotCardView card={proposal} />);
    await screen.findByText('Uses 1 kit; you have 3 left this week.');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    await waitFor(() => expect(__outOfCreditsStore.get()).toMatchObject({ bucket: 'tailor', upgradable: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare application' })).toBeEnabled());
    expect(screen.queryByText('Done.')).not.toBeInTheDocument();
  });

  it('a full list says so and can be tried again; a closed post closes the card; a switched-off account says so', async () => {
    // The list is full (409 queue_full, as the applications agent answers).
    const full = await wireApplication('prepare_application', { addToList: async () => Promise.reject(Object.assign(new Error('full'), { code: 'conflict', status: 409, details: { reason: 'queue_full', room: 0 } })) });
    expect(full.error).toMatchObject({ code: 'conflict', details: { reason: 'queue_full' } });
    installFetch(routes({ [`POST ${applyPath(idOf(full.proposal))}`]: () => fail(409, full.error!.code, full.error!.details) }));
    const a = renderUi(<CopilotCardView card={full.proposal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your list is full. Remove a job from Getting ready, then try again.');
    expect(screen.getByRole('button', { name: 'Prepare application' })).toBeEnabled();
    a.unmount();

    // The post closed (410 from the list, turned into 409 job_closed by the apply).
    const closed = await wireApplication('prepare_application', { addToList: async () => Promise.reject(Object.assign(new Error('gone'), { code: 'gone', status: 410, details: { reason: 'job_closed' } })) });
    expect(closed.error).toMatchObject({ code: 'conflict', details: { reason: 'job_closed' } });
    installFetch(routes({ [`POST ${applyPath(idOf(closed.proposal))}`]: () => fail(409, closed.error!.code, closed.error!.details) }));
    const b = renderUi(<CopilotCardView card={closed.proposal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    expect(await screen.findByTestId('proposal-closed')).toHaveTextContent('This job is no longer listed, so nothing was prepared.');
    expect(screen.queryByRole('button', { name: 'Prepare application' })).not.toBeInTheDocument();
    b.unmount();

    // The capability is off for the account (404 feature_disabled; the suggestion stays pending).
    const off = await wireApplication('prepare_application', {}, { agent: false });
    expect(off.error).toMatchObject({ code: 'feature_disabled', details: { reason: 'feature_disabled' } });
    installFetch(routes({ [`POST ${applyPath(idOf(off.proposal))}`]: () => fail(404, off.error!.code, off.error!.details) }));
    renderUi(<CopilotCardView card={off.proposal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Preparing applications isn't available for your account.");
  });

  it('a click an earlier click already applied: the closed line, never "Done." without a result, and the thread’s cards are read again', async () => {
    const { proposal } = await wireApplication('prepare_application');
    installFetch(routes({ [`POST ${applyPath(idOf(proposal))}`]: () => fail(409, 'conflict', { reason: 'proposal_closed', status: 'applied' }) }));
    const refresh = vi.fn();
    const { container } = renderUi(<CopilotCardView card={proposal} ctx={{ refresh }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    await screen.findByText('This suggestion can no longer be used. Ask again for a fresh one.');
    expect(container.textContent).not.toContain('Done.');
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('reads the server’s status on reload: applied, dismissed, expired and closed cards offer no button; Not now spends nothing', async () => {
    const { proposal } = await wireApplication('prepare_application');
    installFetch(routes({ [`POST ${applyPath(idOf(proposal)).replace('/apply', '/dismiss')}`]: () => ok(null) }));
    for (const [status, text] of [
      ['applied', 'Done.'],
      ['dismissed', 'Not done.'],
      ['expired', 'This suggestion expired. Ask again for a fresh one.'],
      ['conflict', 'This suggestion can no longer be used. Ask again for a fresh one.'],
    ] as const) {
      const view = renderUi(<CopilotCardView card={{ ...proposal, data: { ...(proposal.data as object), status } }} />);
      expect(screen.getByText(text), status).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Prepare application' }), status).not.toBeInTheDocument();
      view.unmount();
    }
    renderUi(<CopilotCardView card={proposal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await screen.findByText('Not done.');
  });

  it('without AI the card says the resume is used as it is, and shows no tailoring cost', async () => {
    const quote = prepareQuote('job_1');
    quote.proposal = { ...quote.proposal!, aiAvailable: false, credits: [quote.proposal!.credits[0]!] };
    const { proposal } = await wireApplication('prepare_application', { prepareQuote: async () => quote });
    installFetch(routes());
    renderUi(<CopilotCardView card={proposal} />);
    await screen.findByText('Uses 1 kit; you have 3 left this week.');
    expect(screen.getByText('AI writing is off for your account, so kits use your resume as it is.')).toBeInTheDocument();
    expect(screen.queryByText(/tailoring credit/)).not.toBeInTheDocument();
  });

  it('a card that cannot say what it uses (no weekly-allowance line) renders nothing', () => {
    installFetch(routes());
    const { container } = renderUi(
      <CopilotCardView card={card('prepare_application', { proposalId: 'p1', jobId: 'job_1', status: 'pending', credits: [{ bucket: 'tailor', cost: 1 }] })} />,
    );
    expect(container.querySelector('[data-card]')).toBeNull();
  });
});

describe('list_add', () => {
  it('no credit, nothing prepared; Add to my list puts the job on the list and links to it', async () => {
    const { proposal, applied } = await wireApplication('add_to_list');
    const http = installFetch(routes({ [`POST ${applyPath(idOf(proposal))}`]: () => ok(applied) }));
    const { container } = renderUi(<CopilotCardView card={proposal} />);
    expect(screen.getByRole('heading', { name: 'Put Data Analyst · Acme on your list' })).toBeInTheDocument();
    expect(screen.getByText('No credit is used, and nothing is prepared until you ask.')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Uses \d/);
    fireEvent.click(screen.getByRole('button', { name: 'Add to my list' }));
    const link = await screen.findByRole('link', { name: 'Open it in Getting ready' });
    expect(link).toHaveAttribute('href', '/ready/job_1');
    expect(screen.getByText('Not prepared yet')).toBeInTheDocument();
    expect(screen.getByText("It's on your list. Prepare it from there when you're ready.")).toBeInTheDocument();
    expect(screen.getByText('You submit each application yourself.')).toBeInTheDocument();
    expect(http.to('POST', applyPath(idOf(proposal)))[0]!.headers['Idempotency-Key']).toBeTruthy();
  });

  it('a closed post closes the card with its reason', async () => {
    const closed = await wireApplication('add_to_list', { addToList: async () => Promise.reject(Object.assign(new Error('gone'), { code: 'gone', status: 410, details: { reason: 'job_closed' } })) });
    installFetch(routes({ [`POST ${applyPath(idOf(closed.proposal))}`]: () => fail(409, closed.error!.code, closed.error!.details) }));
    renderUi(<CopilotCardView card={closed.proposal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to my list' }));
    expect(await screen.findByTestId('proposal-closed')).toHaveTextContent('This job is no longer listed, so nothing was added.');
  });
});

describe('application_status', () => {
  it('a job already on the list (the tool’s own card): its state in the list’s words, and the link the Prepare application button would give', async () => {
    const { proposal: status } = await wireApplication('prepare_application', { prepareQuote: async () => prepareQuote('job_1', { item: listItem('job_1', 'ready_for_review'), proposal: null }) });
    expect(status.type).toBe('application_status');
    installFetch(routes());
    renderUi(<CopilotCardView card={status} />);
    expect(screen.getByRole('heading', { name: 'Your application for Data Analyst · Acme' })).toBeInTheDocument();
    expect(screen.getByText('Ready for your review')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check and open' })).toHaveAttribute('href', '/ready/job_1');
    expect(screen.getByText('You submit each application yourself.')).toBeInTheDocument();
  });

  it.each([
    ['picked', null, 'Open it in Getting ready', '/ready/job_1'],
    ['failed', null, 'Open it in Getting ready', '/ready/job_1'],
    ['preparing', null, 'Open it in Getting ready', '/ready/job_1'],
    ['approved', null, 'Check and open', '/ready/job_1'],
    ['opened', 'te_1', 'See application', '/applications?entry=te_1'],
    ['applied', null, 'See application', '/applications'],
    ['skipped', null, 'Open it in Getting ready', '/ready?tab=done'],
    ['expired', null, 'Open it in Getting ready', '/ready?tab=done'],
  ] as const)('%s links to %s', (state, trackerEntryId, name, href) => {
    installFetch(routes());
    renderUi(<CopilotCardView card={card('application_status', { jobId: 'job_1', state, jobTitle: 'Data Analyst', company: 'Acme', trackerEntryId })} />);
    expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
    expect(screen.getByText('You submit each application yourself.')).toBeInTheDocument();
    // No state is ever "submitted" (D1).
    expect(document.body.textContent).not.toMatch(/submitted/i);
  });

  it('applicationLink follows the Prepare application button’s place for every state', () => {
    const states = ['picked', 'preparing', 'ready_for_review', 'approved', 'opened', 'applied', 'skipped', 'expired', 'failed'] as const;
    for (const state of states) {
      const link = applicationLink({ jobId: 'j 1', state, trackerEntryId: 'te_1' });
      const place = placeOf(state);
      if (place === 'sent') expect(link, state).toEqual({ href: '/applications?entry=te_1', label: 'sent' });
      else if (place === 'listed') expect(link, state).toEqual({ href: '/ready?tab=done', label: 'open' });
      else expect(link, state).toEqual({ href: '/ready/j%201', label: place === 'review' ? 'review' : 'open' });
    }
  });

  it('a state the list does not have renders nothing', () => {
    installFetch(routes());
    const { container } = renderUi(<CopilotCardView card={card('application_status', { jobId: 'job_1', state: 'submitted' })} />);
    expect(container.querySelector('[data-card]')).toBeNull();
  });
});
