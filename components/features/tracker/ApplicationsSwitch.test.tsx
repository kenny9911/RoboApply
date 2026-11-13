// ApplicationsSwitch — "Getting ready · Sent" at the top of /ready and
// /applications (docs/agent-driven/REDESIGN.md §7).
//
//   links        two real <a>s (each view is its own page), never tabs
//   current      the page the user is on carries aria-current="page"
//   count        the server's "ready and not opened yet" number beside Getting
//                ready, only when it is above zero, with a sentence for screen
//                readers; unknown, loading and failed draw nothing (D3)
//   flag `agent` off → nothing is rendered and nothing is asked
//
// The switch on the pages themselves: tracker.test.tsx (/applications) and
// components/features/agent/agent.test.tsx (/ready).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({ getReadyBadge: vi.fn() }));
vi.mock('../../../lib/api/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/agent')>()),
  getReadyBadge: api.getReadyBadge,
}));

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { RoboApiError } from '../../../lib/api/client';
import { APPLICATIONS_VIEW_HREF, ApplicationsSwitch } from './ApplicationsSwitch';

const ON = { agent: true };
const nav = () => screen.getByRole('navigation', { name: 'Your applications' });
const ready = () => within(nav()).getByRole('link', { name: /^Getting ready/ });
const sent = () => within(nav()).getByRole('link', { name: 'Sent' });

beforeEach(() => {
  vi.clearAllMocks();
  api.getReadyBadge.mockResolvedValue({ readyNotOpened: 0 });
});

describe('ApplicationsSwitch', () => {
  it('is two links to the two pages, and marks the one the user is on', async () => {
    const onSent = renderWithBrand(<ApplicationsSwitch current="sent" />, { flags: ON });
    expect(within(nav()).getAllByRole('link')).toHaveLength(2);
    expect(ready()).toHaveAttribute('href', '/ready');
    expect(sent()).toHaveAttribute('href', '/applications');
    expect(sent()).toHaveAttribute('aria-current', 'page');
    expect(ready()).not.toHaveAttribute('aria-current');
    onSent.unmount();

    renderWithBrand(<ApplicationsSwitch current="ready" />, { flags: ON });
    expect(ready()).toHaveAttribute('aria-current', 'page');
    expect(sent()).not.toHaveAttribute('aria-current');
    expect(APPLICATIONS_VIEW_HREF).toEqual({ ready: '/ready', sent: '/applications' });
  });

  it('is navigation, not a tab list: each page keeps its own address and content', () => {
    renderWithBrand(<ApplicationsSwitch current="ready" />, { flags: ON });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    for (const link of within(nav()).getAllByRole('link')) expect(link.tagName).toBe('A');
  });

  it('shows how many applications are ready and waiting, with a sentence a screen reader reads', async () => {
    api.getReadyBadge.mockResolvedValue({ readyNotOpened: 3 });
    renderWithBrand(<ApplicationsSwitch current="sent" />, { flags: ON });
    const count = await screen.findByTestId('applications-switch-count');
    expect(count).toHaveTextContent(/^3$/);
    // The bare number is decoration; the link's name carries the sentence.
    expect(count).toHaveAttribute('aria-hidden', 'true');
    expect(ready()).toHaveAccessibleName('Getting ready 3 applications are ready and waiting for you');
    expect(api.getReadyBadge).toHaveBeenCalledTimes(1);
  });

  it('says one application in the singular', async () => {
    api.getReadyBadge.mockResolvedValue({ readyNotOpened: 1 });
    renderWithBrand(<ApplicationsSwitch current="ready" />, { flags: ON });
    await screen.findByTestId('applications-switch-count');
    expect(ready()).toHaveAccessibleName('Getting ready 1 application is ready and waiting for you');
  });

  it.each([
    ['zero', () => api.getReadyBadge.mockResolvedValue({ readyNotOpened: 0 })],
    ['a number that is not one', () => api.getReadyBadge.mockResolvedValue({ readyNotOpened: null })],
    ['a failed read', () => api.getReadyBadge.mockRejectedValue(new RoboApiError('not_implemented', { code: 'not_implemented', status: 501 }))],
  ])('draws no count for %s (never "0")', async (_name, arrange) => {
    arrange();
    renderWithBrand(<ApplicationsSwitch current="sent" />, { flags: ON });
    await waitFor(() => expect(api.getReadyBadge).toHaveBeenCalled());
    await waitFor(() => expect(ready()).toHaveAccessibleName('Getting ready'));
    expect(screen.queryByTestId('applications-switch-count')).toBeNull();
    expect(nav()).not.toHaveTextContent('0');
  });

  it('renders nothing and asks nothing with the `agent` flag off', () => {
    const { container } = renderWithBrand(<ApplicationsSwitch current="sent" />, { flags: {} });
    expect(container.querySelector('[data-testid="applications-switch"]')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('Getting ready')).toBeNull();
    expect(api.getReadyBadge).not.toHaveBeenCalled();
  });

  it('GoApply gets the same switch (D5)', () => {
    renderWithBrand(<ApplicationsSwitch current="sent" />, { brand: 'goapply', flags: ON });
    expect(ready()).toHaveAttribute('href', '/ready');
    expect(sent()).toHaveAttribute('aria-current', 'page');
  });
});
