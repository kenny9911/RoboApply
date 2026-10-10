// The avatar while there is no name to show (verify finding FIX-1 #6).
//
// The trigger's initials fell back to the literal 'RA' — RoboApply's initials — so
// every reload showed "RA" until /auth/me answered, on GoApply too. And a
// GoApply phone account has no name and a placeholder address
// (`u-<random>@users.goapply.invalid`), which produced the initials "UU":
// letters that stand for nothing about the person.
//
// With nothing real to abbreviate the avatar shows a person icon.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type User = { id: string; email: string; name?: string | null; role: string; roles: string[] };
const auth: { status: 'loading' | 'authenticated'; user: User | null } = { status: 'loading', user: null };
vi.mock('../../../lib/auth/useAuth', () => ({
  useAuth: () => ({ status: auth.status, user: auth.user, clear: () => undefined }),
}));
vi.mock('../../../lib/api/auth', () => ({ logout: async () => undefined }));
vi.mock('./signOutCleanup', () => ({
  cleanUpDeviceOnSignOut: async () => undefined,
  leaveSignedOut: () => undefined,
}));

import { AvatarMenu, initialsFor } from './AvatarMenu';

const messages = { nav: { account_menu: 'Your account', settings: 'Settings', billing: 'Billing', sign_out: 'Sign out', signing_out: 'Signing out…' } };
const renderMenu = () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <AvatarMenu />
    </NextIntlClientProvider>,
  );
const user = (over: Partial<User>): User => ({ id: 'u1', email: 'jane@example.com', name: null, role: 'seeker', roles: ['seeker'], ...over });

beforeEach(() => {
  auth.status = 'loading';
  auth.user = null;
});

describe('initialsFor', () => {
  it('abbreviates a name, or a real address', () => {
    expect(initialsFor('Jane Seeker')).toBe('JS');
    expect(initialsFor('jane.seeker@example.com')).toBe('JS');
    expect(initialsFor('jane')).toBe('JA');
    expect(initialsFor('张伟')).toBe('张伟');
  });

  it('has no fallback letters: nothing in, nothing out', () => {
    expect(initialsFor('')).toBe('');
    expect(initialsFor('   ')).toBe('');
    expect(initialsFor(null)).toBe('');
    expect(initialsFor(undefined)).toBe('');
  });

  it('does not abbreviate a placeholder address', () => {
    expect(initialsFor('u-5f1c0a9b7d3e42a1b6c8d9e0@users.goapply.invalid')).toBe('');
    expect(initialsFor('U-ABC@USERS.GOAPPLY.INVALID')).toBe('');
  });
});

describe('AvatarMenu trigger', () => {
  it('is not built on the deprecated helper that still returns made-up letters', () => {
    // `monogramFor` survives only for an older test; the trigger must not call it.
    const source = readFileSync(join(process.cwd(), 'components/v3/shell/AvatarMenu.tsx'), 'utf8');
    expect(source.match(/monogramFor\(/g)).toHaveLength(1); // its own declaration
  });


  it('shows a person icon, not letters, while the session is loading', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Your account' });
    expect(trigger).toHaveTextContent('');
    expect(trigger.textContent).not.toMatch(/RA/);
    const icon = trigger.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows a person icon for a phone account with no name', () => {
    auth.status = 'authenticated';
    auth.user = user({ name: null, email: 'u-5f1c0a9b7d3e42a1b6c8d9e0@users.goapply.invalid' });
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Your account' });
    expect(trigger).toHaveTextContent('');
    expect(trigger.querySelector('svg')).not.toBeNull();
  });

  it('shows the initials once there is a name', () => {
    auth.status = 'authenticated';
    auth.user = user({ name: 'Jane Seeker' });
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Your account' });
    expect(trigger).toHaveTextContent('JS');
    expect(trigger.querySelector('svg')).toBeNull();
  });
});
