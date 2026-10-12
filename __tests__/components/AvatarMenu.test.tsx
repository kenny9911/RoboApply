// AvatarMenu — the monogram button in the Topbar and the menu behind it.
//
// It carries Settings, Billing and Sign out, which the rail no longer does.
// Because the Topbar renders at every width, this is the only route a phone
// user has to billing at all — so the test that matters most is that the menu
// exists and opens from both pointer and keyboard, and that Escape hands focus
// back rather than dropping it on <body>.
//
// Sign out (INT-12; wave-4 carry-over WP-93 #7) forgets this device first:
// the push subscription while the session can still authorise it, then the
// unsent resume-builder drafts — and only then ends the session. A failing
// cleanup never blocks sign-out.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState, buildAuthValue, buildFakeUser } from '../utils/mockAuth';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

/** The order things happened in during one sign-out. */
const steps: string[] = [];

const logoutMock = vi.fn(async () => {
  steps.push('logout');
  return { success: true as const };
});
vi.mock('../../lib/api/auth', () => ({
  logout: () => logoutMock(),
}));

const forgetPushMock = vi.fn(async () => {
  // Resolves a tick later, like the real one (it talks to the push service).
  await new Promise((r) => setTimeout(r, 5));
  steps.push('push-forget');
});
vi.mock('../../hooks/pwa', () => ({
  forgetPushDeviceOnSignOut: () => forgetPushMock(),
}));

const clearDraftsMock = vi.fn((_options?: { resumePhotos?: boolean }) => {
  steps.push('clear-drafts');
});
vi.mock('../../hooks/resume/useResumePhoto', () => ({
  clearResumeBuilderDeviceData: (options?: { resumePhotos?: boolean }) => clearDraftsMock(options),
}));

import { AvatarMenu, initialsFor } from '../../components/v3/shell/AvatarMenu';
import {
  cleanUpDeviceOnSignOut,
  clearDraftsOnSignOut,
  forgetPushOnSignOut,
  leaveSignedOut,
} from '../../components/v3/shell/signOutCleanup';

function openWithPointer() {
  fireEvent.click(screen.getByRole('button', { name: 'Your account' }));
  return screen.getByRole('menu');
}

describe('AvatarMenu', () => {
  beforeEach(() => {
    steps.length = 0;
    logoutMock.mockClear();
    forgetPushMock.mockClear();
    clearDraftsMock.mockClear();
    mockAuthState.value = buildAuthValue();
  });

  it('builds the monogram from a name, then an address; with neither there are no letters', () => {
    expect(initialsFor('Jane Seeker')).toBe('JS');
    expect(initialsFor('jane.seeker@example.com')).toBe('JS');
    expect(initialsFor('jane@example.com')).toBe('JE');
    expect(initialsFor('jane')).toBe('JA');
    // FIX-1: no made-up fallback ('RA' was RoboApply's initials on GoApply too); the trigger shows a person icon.
    expect(initialsFor('')).toBe('');
    expect(initialsFor(null)).toBe('');
  });

  it('renders a closed menu button carrying the user monogram', () => {
    renderWithProviders(<AvatarMenu />);
    const trigger = screen.getByRole('button', { name: 'Your account' });
    expect(trigger).toHaveTextContent('JS');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on click and offers Settings, Billing and Sign out', () => {
    renderWithProviders(<AvatarMenu />);
    const menu = openWithPointer();
    expect(screen.getByRole('button', { name: 'Your account' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Settings',
      'Billing',
      'Sign out',
    ]);
    expect(items[0]).toHaveAttribute('href', '/settings');
    expect(items[1]).toHaveAttribute('href', '/settings#billing');
    expect(items[2].tagName).toBe('BUTTON');
  });

  it('opening puts focus on the first item, so Tab does not skip the menu', () => {
    renderWithProviders(<AvatarMenu />);
    const menu = openWithPointer();
    expect(document.activeElement).toBe(
      within(menu).getAllByRole('menuitem')[0],
    );
  });

  it('opens from the keyboard with focus on the first item', () => {
    renderWithProviders(<AvatarMenu />);
    const trigger = screen.getByRole('button', { name: 'Your account' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
  });

  it('ArrowUp on the trigger opens with focus on the last item', () => {
    renderWithProviders(<AvatarMenu />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Your account' }), {
      key: 'ArrowUp',
    });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[2]);
  });

  it('arrow keys move between items and wrap; Home and End jump', () => {
    renderWithProviders(<AvatarMenu />);
    const trigger = screen.getByRole('button', { name: 'Your account' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[2]);
    // Wraps rather than dead-ending.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
  });

  it('Escape closes and hands focus back to the trigger', () => {
    renderWithProviders(<AvatarMenu />);
    const trigger = screen.getByRole('button', { name: 'Your account' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('a click outside closes it', () => {
    renderWithProviders(<AvatarMenu />);
    openWithPointer();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Sign out clears the server session, then the client, then leaves', async () => {
    const clear = vi.fn();
    mockAuthState.value = buildAuthValue({ user: buildFakeUser(), clear });
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign },
    });

    renderWithProviders(<AvatarMenu />);
    openWithPointer();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(logoutMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    // A hard navigation, not router.push — it is what drops the TanStack cache
    // holding the previous account's jobs and applications.
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('signs the client out even when the logout request fails', async () => {
    const clear = vi.fn();
    mockAuthState.value = buildAuthValue({ clear });
    logoutMock.mockRejectedValueOnce(new Error('offline'));
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign },
    });

    renderWithProviders(<AvatarMenu />);
    openWithPointer();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('Sign out forgets this device first: push, then builder drafts, then the session, then the client', async () => {
    const clear = vi.fn(() => steps.push('clear'));
    mockAuthState.value = buildAuthValue({ clear });
    const assign = vi.fn(() => steps.push('leave'));
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
    window.localStorage.setItem('auth_token', 'jwt');

    renderWithProviders(<AvatarMenu />);
    openWithPointer();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
    // The push subscription is removed while the session still exists; the
    // session cookie is cleared only after that (logout), then the client.
    expect(steps).toEqual(['push-forget', 'clear-drafts', 'logout', 'clear', 'leave']);
    expect(forgetPushMock).toHaveBeenCalledTimes(1);
    // Photos on saved resumes are not cleared (owner decision pending): no `resumePhotos`.
    expect(clearDraftsMock).toHaveBeenCalledTimes(1);
    expect(clearDraftsMock.mock.calls[0][0]).toBeUndefined();
    expect(window.localStorage.getItem('auth_token')).toBeNull();
  });

  it('a failing cleanup never blocks sign-out', async () => {
    forgetPushMock.mockRejectedValueOnce(new Error('push service down'));
    clearDraftsMock.mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });
    const clear = vi.fn();
    mockAuthState.value = buildAuthValue({ clear });
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });

    renderWithProviders(<AvatarMenu />);
    openWithPointer();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    // The second step still ran although the first one failed.
    expect(clearDraftsMock).toHaveBeenCalledTimes(1);
  });

  it('Sign out shows "Signing out…" while the cleanup runs, and a second click does not sign out twice', async () => {
    let release!: () => void;
    forgetPushMock.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (release = r));
      steps.push('push-forget');
    });
    const clear = vi.fn();
    mockAuthState.value = buildAuthValue({ clear });
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });

    renderWithProviders(<AvatarMenu />);
    openWithPointer();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    // The menu stays open and says what is happening.
    const busy = await screen.findByRole('menuitem', { name: 'Signing out…' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(busy);
    fireEvent.click(busy);
    expect(logoutMock).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
    expect(forgetPushMock).toHaveBeenCalledTimes(1);
    expect(clearDraftsMock).toHaveBeenCalledTimes(1);
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('the two cleanup steps run one by one for flows whose request can fail; leaveSignedOut drops the bearer fallback and leaves', async () => {
    await forgetPushOnSignOut();
    expect(steps).toEqual(['push-forget']);
    expect(clearDraftsMock).not.toHaveBeenCalled();
    clearDraftsOnSignOut();
    expect(steps).toEqual(['push-forget', 'clear-drafts']);

    forgetPushMock.mockRejectedValueOnce(new Error('x'));
    await expect(forgetPushOnSignOut()).resolves.toBeUndefined();
    clearDraftsMock.mockImplementationOnce(() => {
      throw new Error('y');
    });
    expect(() => clearDraftsOnSignOut()).not.toThrow();

    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
    window.localStorage.setItem('auth_token', 'jwt');
    leaveSignedOut();
    expect(window.localStorage.getItem('auth_token')).toBeNull();
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('cleanUpDeviceOnSignOut never rejects, whatever its steps do', async () => {
    forgetPushMock.mockRejectedValueOnce(new Error('x'));
    clearDraftsMock.mockImplementationOnce(() => {
      throw new Error('y');
    });
    await expect(cleanUpDeviceOnSignOut()).resolves.toBeUndefined();
  });
});
