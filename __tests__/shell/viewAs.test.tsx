// Admin "view as" in the web app (server platform/viewAs): the banner above
// every screen while viewing (who, read-only, time left, Exit), its reactions
// to the API client (a refused write, a view the server ended, the time
// running out), and the admin "View as" button (who may be viewed, the full
// page load into the person's landing page, the server's refusal reasons).
// API wrappers are mocked; nothing reaches the network.

import type { ReactNode } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithBrand } from './helpers';
import { buildAuthValue, buildFakeUser, mockAuthState } from '../utils/mockAuth';

vi.mock('../../lib/auth/AuthProvider', () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children, useAuth: () => mockAuthState.value }));
const api = vi.hoisted(() => ({ startViewAs: vi.fn(), stopViewAs: vi.fn() }));
vi.mock('../../lib/api/admin', async (orig) => ({ ...(await orig<typeof import('../../lib/api/admin')>()), ...api }));

import { ViewAsBanner, VIEW_AS_ENDED_ROUTE, minutesLeft } from '../../components/v3/shell/ViewAsBanner';
import { ViewAsButton, viewAsBlockedReasonFor } from '../../components/v3/admin/ViewAsButton';
import { RoboApiError, noteViewAsResponse } from '../../lib/api/client';

const subject = buildFakeUser({ id: 'user-1', name: 'Jane Seeker', email: 'jane@example.com' });

function viewing(expiresInMs = 42.5 * 60_000) {
  const now = Date.now();
  mockAuthState.value = {
    ...buildAuthValue({ user: subject }),
    me: {
      user: subject,
      profile: null,
      viewAs: {
        admin: { id: 'admin-1', email: 'admin@example.com', name: 'Ada' },
        startedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + expiresInMs).toISOString(),
      },
    },
  } as typeof mockAuthState.value;
}

beforeEach(() => {
  api.startViewAs.mockReset();
  api.stopViewAs.mockReset().mockResolvedValue({ ended: true });
});
afterEach(() => {
  document.documentElement.style.removeProperty('--view-as-h');
});

describe('ViewAsBanner', () => {
  it('renders nothing outside a view', () => {
    mockAuthState.value = buildAuthValue();
    const { container } = renderWithBrand(<ViewAsBanner navigate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says whose app this is, that it is read-only and how long the view lasts, and makes room for itself', () => {
    viewing();
    renderWithBrand(<ViewAsBanner navigate={vi.fn()} />);
    const banner = screen.getByRole('region', { name: "Admin view of someone else's account" });
    expect(banner).toHaveTextContent('Viewing as Jane Seeker');
    expect(banner).toHaveTextContent('jane@example.com');
    expect(banner).toHaveTextContent('Read-only. Nothing you do here is saved or sent.');
    expect(banner).toHaveTextContent('Ends in 43 minutes');
    expect(document.documentElement.style.getPropertyValue('--view-as-h')).toMatch(/px$/);
  });

  it('Exit ends the view, then reloads into the person\'s admin page', async () => {
    viewing();
    const navigate = vi.fn();
    renderWithBrand(<ViewAsBanner navigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Exit view' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin/users/user-1'));
    expect(api.stopViewAs).toHaveBeenCalledTimes(1);
  });

  it('still leaves when ending the view fails (the cookie expires on its own)', async () => {
    viewing();
    api.stopViewAs.mockRejectedValue(new RoboApiError('down', { code: 'network_error' }));
    const navigate = vi.fn();
    renderWithBrand(<ViewAsBanner navigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Exit view' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin/users/user-1'));
  });

  it('says "Not saved" when the server refuses a write', () => {
    viewing();
    renderWithBrand(<ViewAsBanner navigate={vi.fn()} />);
    act(() => noteViewAsResponse({ headers: new Headers() }, 'view_as_read_only'));
    expect(screen.getByText('Not saved: this view is read-only.')).toBeInTheDocument();
  });

  it('goes back to the admin console when the server ended the view', () => {
    viewing();
    const navigate = vi.fn();
    renderWithBrand(<ViewAsBanner navigate={navigate} />);
    act(() => noteViewAsResponse({ headers: new Headers({ 'x-ra-view-as': 'ended' }) }, null));
    expect(navigate).toHaveBeenCalledWith(VIEW_AS_ENDED_ROUTE);
    expect(api.stopViewAs).not.toHaveBeenCalled();
  });

  it('ends the view by itself when its time is up', async () => {
    viewing(-1000);
    const navigate = vi.fn();
    renderWithBrand(<ViewAsBanner navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(VIEW_AS_ENDED_ROUTE));
    expect(api.stopViewAs).toHaveBeenCalledTimes(1);
  });

  it('counts whole minutes, never "0 minutes" while time is left', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    expect(minutesLeft('2026-10-21T10:59:01Z', now)).toBe(60);
    expect(minutesLeft('2026-10-21T10:00:20Z', now)).toBe(1);
    expect(minutesLeft('2026-10-21T09:59:59Z', now)).toBe(0);
    expect(minutesLeft('not a date', now)).toBe(0);
  });
});

describe('ViewAsButton', () => {
  beforeEach(() => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ id: 'admin-1', role: 'admin', name: 'Ada', email: 'admin@example.com' }) });
  });

  it('starts a view and reloads into the page the person lands on', async () => {
    api.startViewAs.mockResolvedValue({ landing: '/onboarding/resume' });
    const navigate = vi.fn();
    renderWithBrand(<ViewAsButton target={{ userId: 'user-2', name: 'Li Wei', brand: 'roboapply', hasProfile: true }} navigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'View the app as Li Wei, read-only' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/onboarding/resume'));
    expect(api.startViewAs).toHaveBeenCalledWith('user-2');
  });

  it.each([
    [{ userId: 'admin-1' }, 'This is your own account.'],
    [{ userId: 'u3', isAdmin: true }, 'Admin accounts cannot be viewed.'],
    [{ userId: 'u4', hasProfile: false }, 'This account has never used the app.'],
    [{ userId: 'u5', deleted: true }, 'This account was deleted.'],
    [{ userId: 'u6', brand: 'goapply' }, "This account uses GoApply. View it from that site's admin."],
  ])('is off for an account the server refuses (%j)', (target, reason) => {
    renderWithBrand(<ViewAsButton target={target} navigate={vi.fn()} />);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', reason);
    fireEvent.click(button);
    expect(api.startViewAs).not.toHaveBeenCalled();
  });

  it('shows the server\'s refusal under the button', async () => {
    api.startViewAs.mockRejectedValue(new RoboApiError('deleted', { code: 'conflict', status: 409, payload: { details: { reason: 'deleted' } } }));
    const navigate = vi.fn();
    renderWithBrand(<ViewAsButton variant="button" target={{ userId: 'user-2', name: 'Li Wei' }} navigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'View as Li Wei' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This account was deleted.');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('decides like the server for the row it is given', () => {
    const me = { id: 'admin-1' };
    expect(viewAsBlockedReasonFor({ userId: 'u', brand: null }, me, 'goapply')).toBeNull();
    expect(viewAsBlockedReasonFor({ userId: 'u', brand: 'goapply' }, me, 'goapply')).toBeNull();
    expect(viewAsBlockedReasonFor({ userId: 'u', brand: 'roboapply' }, me, 'goapply')).toBe('other_brand');
  });
});
