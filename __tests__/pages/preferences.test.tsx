// __tests__/pages/preferences.test.tsx
//
// Smoke test for the /preferences screen (V3 redesign — IA Route 10, Lane H).
// Drives the page through the stub api (NEXT_PUBLIC_USE_STUB_API=true) and
// asserts:
//   1. the 8-section rail renders + the default (Job target) section lands,
//   2. editing a field surfaces the sticky SaveBar (dirty), and
//   3. Save clears the SaveBar (dirty → clean) against the stub.

import type { ReactNode } from 'react';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';

import PreferencesPage from '../../app/(auth)/preferences/page';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState } from '../utils/mockAuth';

beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

// The real AuthProvider fires GET /me on mount; page tests mock the module and
// point useAuth() at the shared fixture (per __tests__/utils/mockAuth.tsx).
vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockAuthState.value,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/preferences',
}));

describe('/preferences screen', () => {
  it('renders the section rail + default Job target section once prefs resolve', async () => {
    renderWithProviders(<PreferencesPage />);

    // Rail nav items (8 sections) land once the preferences query resolves.
    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /Job target/i }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.getByRole('button', { name: /Identity/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Danger zone/i })).toBeInTheDocument();

    // Default section is Job target → its h1 ("What I'm hunting for you.") shows.
    expect(
      screen.getByRole('heading', { level: 1, name: /hunting/i }),
    ).toBeInTheDocument();
    // The live "plain English" translation block renders.
    expect(screen.getByText(/agent reads this every run/i)).toBeInTheDocument();
  });

  it('shows the SaveBar on edit and clears it after Save', async () => {
    renderWithProviders(<PreferencesPage />);

    // Wait for hydration (rail present).
    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /Job target/i }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    // No SaveBar initially (form is clean against the server baseline).
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();

    // Edit the free-text intent textarea → form goes dirty → SaveBar appears.
    const intent = screen.getByLabelText('Plain language') as HTMLTextAreaElement;
    fireEvent.change(intent, { target: { value: 'Remote staff PM, climate.' } });

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    // Save → the stub persists, the page re-baselines, the SaveBar disappears.
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(
      () => {
        expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    // The edited value persists in the field after save.
    expect((screen.getByLabelText('Plain language') as HTMLTextAreaElement).value).toBe(
      'Remote staff PM, climate.',
    );
  });

  it('Danger zone: real delete-account modal, no data-wipe stub row', async () => {
    renderWithProviders(<PreferencesPage />);

    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /Danger zone/i }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    fireEvent.click(screen.getByRole('button', { name: /Danger zone/i }));

    // The data-only wipe row is hidden until a real endpoint exists (its old
    // confirm was a stub that deleted nothing).
    expect(screen.queryByText(/Delete all application data/i)).not.toBeInTheDocument();

    // "Delete account" opens the shared real confirm modal (same as /account):
    // type-your-email + reason, not the old close-only stub.
    fireEvent.click(screen.getByRole('button', { name: /Delete account$/ }));
    expect(screen.getByText('Confirm your email')).toBeInTheDocument();
    expect(screen.getByText('Reason')).toBeInTheDocument();

    // A wrong email is rejected locally — nothing is deleted.
    fireEvent.change(screen.getByPlaceholderText('jane@example.com'), {
      target: { value: 'wrong@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/match your account email/i);
    });
  });
});
