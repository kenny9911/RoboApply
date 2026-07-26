// AvatarMenu — the monogram button in the Topbar and the menu behind it.
//
// It carries Settings, Billing and Sign out, which the rail no longer does.
// Because the Topbar renders at every width, this is the only route a phone
// user has to billing at all — so the test that matters most is that the menu
// exists and opens from both pointer and keyboard, and that Escape hands focus
// back rather than dropping it on <body>.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState, buildAuthValue, buildFakeUser } from '../utils/mockAuth';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const logoutMock = vi.fn(async () => ({ success: true as const }));
vi.mock('../../lib/api/auth', () => ({
  logout: () => logoutMock(),
}));

import { AvatarMenu, monogramFor } from '../../components/v3/shell/AvatarMenu';

function openWithPointer() {
  fireEvent.click(screen.getByRole('button', { name: 'Your account' }));
  return screen.getByRole('menu');
}

describe('AvatarMenu', () => {
  beforeEach(() => {
    logoutMock.mockClear();
    mockAuthState.value = buildAuthValue();
  });

  it('builds the monogram from a name, then an address, then a fallback', () => {
    expect(monogramFor('Jane Seeker')).toBe('JS');
    expect(monogramFor('jane.seeker@example.com')).toBe('JS');
    expect(monogramFor('jane@example.com')).toBe('JE');
    expect(monogramFor('jane')).toBe('JA');
    expect(monogramFor('')).toBe('RA');
    expect(monogramFor(null)).toBe('RA');
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
});
