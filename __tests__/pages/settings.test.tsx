// __tests__/pages/settings.test.tsx
//
// Smoke test for /settings — ONE page with seven sections, reached from the
// avatar menu. Not a destination (ruling D2: there are exactly four, and
// settings is not one of them).
//
// This replaces __tests__/pages/preferences.test.tsx. What changed and why:
//   • Route: /preferences → /settings, and it absorbed /plans, /account and
//     /account/billing. Four routes became seven sections on one page.
//   • Section names are the C21/C6 vocabulary: "Your search" (not "Job
//     target"), "Plan and billing" (not "Plans"), "Danger zone" survives.
//   • The first section's H1 is the setup sentence, and it has exactly ONE
//     name in the whole product: "Tell us what you're looking for" (C21 —
//     "Tune my matches" and "Redo setup chat" are deleted).
//   • The plain-language block no longer mentions an agent reading anything
//     (D4/C9 — zero speakers).
//
// The billing assertion is the one that matters most: styles/v3.css hides the
// sidebar below 760px, so before this page existed a phone user could not
// reach billing at all — they could not change a plan or cancel a
// subscription. The section list here is what gives them that, and the test
// proves the section exists and renders rather than being a rail entry that
// leads nowhere.

import type { ReactNode } from 'react';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';

import SettingsPage from '../../app/(auth)/settings/page';
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
  usePathname: () => '/settings',
}));

describe('/settings', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/settings');
  });

  it('renders the seven sections and lands on Your search', async () => {
    renderWithProviders(<SettingsPage />);

    // The section list lands once the preferences query resolves.
    await waitFor(
      () => {
        expect(
          screen.getByRole('link', { name: 'Your search' }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    // All seven, in order. Each is a section on this page, not a route — a
    // fragment anchor, because the open section is the URL hash.
    const ids = ['search', 'resume', 'notif', 'appearance', 'billing', 'account', 'danger'];
    const names = [
      'Your search',
      'Resume',
      'Notifications',
      'Appearance',
      'Plan and billing',
      'Account',
      'Danger zone',
    ];
    names.forEach((name, i) => {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', `#${ids[i]}`);
    });
    expect(screen.getByRole('link', { name: 'Your search' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // Default section is Your search → its H1 is the one setup sentence
    // (C21). The heading is assembled from three keys, so match on the
    // distinctive middle rather than the whole string.
    expect(
      screen.getByRole('heading', { level: 1, name: /you're looking for/i }),
    ).toBeInTheDocument();

    // C21 deletes the competing names for the same panel.
    expect(screen.queryByText(/Tune my matches/i)).toBeNull();
    expect(screen.queryByText(/Redo setup chat/i)).toBeNull();
  });

  it('reaches Plan and billing — the section a phone user could not open before', async () => {
    renderWithProviders(<SettingsPage />);

    await waitFor(
      () => {
        expect(
          screen.getByRole('link', { name: 'Plan and billing' }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    fireEvent.click(screen.getByRole('link', { name: 'Plan and billing' }));
    // A fragment anchor: the browser moves the URL, then fires hashchange.
    await waitFor(() => expect(window.location.hash).toBe('#billing'));

    // The section swaps once the browser fires hashchange (a task later). Its
    // sub is unique to the body — the title itself collides with the rail link.
    expect(
      await screen.findByText(
        /What you are on now, what else you can move to, and where your receipts are\./i,
      ),
    ).toBeInTheDocument();

    // The plan body itself is served by accountApi, which has no stub and no
    // network in JSDOM — so this test asserts the branch that a phone user on
    // a bad connection actually hits. It must say what happened and what to do
    // next, never a blank panel and never "something went wrong on my end"
    // (voice rule: errors are factual, and there is no speaker to have an
    // "end"). The populated catalog is covered by PlanCatalog.test.tsx.
    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Your settings did not load.',
        );
      },
      { timeout: 4000 },
    );
    expect(screen.getByText(/Nothing was lost\./i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
  });

  it('opens the section the URL hash names — the deep link every "Billing" entry points at', async () => {
    // The avatar menu, the practice launcher's "Get credits" and the invoice
    // page's back link all point at /settings#billing. Before the hash drove
    // the section, every one of them landed on "Your search".
    window.history.replaceState(null, '', '/settings#billing');
    renderWithProviders(<SettingsPage />);

    await waitFor(
      () => {
        expect(
          screen.getByText(
            /What you are on now, what else you can move to, and where your receipts are\./i,
          ),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.getByRole('link', { name: 'Plan and billing' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Your search' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('shows the save bar on edit and clears it after saving', async () => {
    renderWithProviders(<SettingsPage />);

    await waitFor(
      () => {
        expect(
          screen.getByRole('link', { name: 'Your search' }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    // Clean against the server baseline → no save bar.
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument();

    // Edit the free-text intent field → the draft diverges from the baseline.
    const intent = screen.getByLabelText('What you want next') as HTMLTextAreaElement;
    fireEvent.change(intent, { target: { value: 'Remote staff PM, climate.' } });

    await waitFor(() => {
      expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
    });

    // Save → the stub persists, the page re-baselines, the bar goes away.
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(
      () => {
        expect(
          screen.queryByText('You have unsaved changes'),
        ).not.toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    // The edited value survives the re-baseline.
    expect(
      (screen.getByLabelText('What you want next') as HTMLTextAreaElement).value,
    ).toBe('Remote staff PM, climate.');
  });

  it('Danger zone: the data-wipe row opens a real type-to-confirm modal', async () => {
    renderWithProviders(<SettingsPage />);

    await waitFor(
      () => {
        expect(
          screen.getByRole('link', { name: 'Danger zone' }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    fireEvent.click(screen.getByRole('link', { name: 'Danger zone' }));

    // Before the modal opens, the row title is the only match. The copy names
    // what is destroyed and what survives, in the user's nouns — "job data",
    // not "application records" (C4: the product nouns are job, application,
    // resume, practice interview).
    expect(await screen.findByText('Delete your job data')).toBeInTheDocument();
    expect(
      screen.getByText(/Your account and resumes stay\./i),
    ).toBeInTheDocument();

    // Its button opens the REAL confirm modal — a type-to-confirm gate.
    fireEvent.click(screen.getByRole('button', { name: 'Delete job data' }));
    expect(screen.getByText(/Type DELETE to confirm\./i)).toBeInTheDocument();

    // A wrong keyword is rejected locally — nothing is cleared, no request
    // fires, and the error says exactly what to do next.
    fireEvent.change(screen.getByPlaceholderText('DELETE'), {
      target: { value: 'nope' },
    });
    // The confirm CTA repeats the row's verb, so scope to the dialog.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Delete job data' }),
    );
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Type DELETE exactly to confirm\./i,
      );
    });
  });
});
