// Onboarding (Chat v4 — two-phase shell) — page test against the stub API.
//
// Drives the real page: mount → GET /onboarding/session 404 → S0 resume
// select (fixture variants, primary preselected) → Continue → bootstrap →
// chat phase with REAL ingest values (no Maya-Chen canned persona anywhere)
// and the editable LLM opening prompt pre-filled in the composer.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders } from '../utils/renderWithProviders';
import { resetRaV2Stub } from '../../lib/stub/raV2.stub';
import { mockAuthState, buildAuthValue } from '../utils/mockAuth';

// The onboarding page reads useAuth() (via useJobApplyingEnabled) to skip the
// auto-apply onboarding when the flag is off. Default the fixture to enabled so
// these tests exercise the normal onboarding flow.
vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/onboarding',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import OnboardingPage from '../../app/onboarding/page';

beforeEach(() => {
  // The stub store is module-level — a session created in one test must not
  // leak into the next test's restore path.
  resetRaV2Stub();
  push.mockClear();
  mockAuthState.value = buildAuthValue();
});

describe('Onboarding page (Chat v4)', () => {
  it('shows S0 with existing variants, primary preselected', async () => {
    renderWithProviders(<OnboardingPage />);

    // Session restore 404s against the fresh stub → resume select renders.
    await waitFor(
      () => {
        expect(screen.getByText('Master Resume')).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    // Newest-first list still preselects the PRIMARY variant (Master Resume),
    // not the newest (the tailored Anthropic one).
    const primary = screen
      .getAllByRole('radio')
      .find((el) => el.textContent?.includes('Master Resume'));
    expect(primary).toBeDefined();
    expect(primary).toHaveAttribute('aria-checked', 'true');

    // The continue CTA is live.
    expect(
      screen.getByRole('button', { name: /Continue with this resume/i }),
    ).toBeInTheDocument();
  });

  it('pick → bootstrap → chat phase with REAL ingest values (no Maya Chen)', async () => {
    renderWithProviders(<OnboardingPage />);

    // Wait until the variant list has landed AND the primary preselect
    // effect has run — the Continue CTA is disabled until a variant is
    // selected.
    await waitFor(
      () => {
        const primary = screen
          .getAllByRole('radio')
          .find((el) => el.textContent?.includes('Master Resume'));
        expect(primary).toHaveAttribute('aria-checked', 'true');
      },
      { timeout: 4000 },
    );

    fireEvent.click(
      screen.getByRole('button', { name: /Continue with this resume/i }),
    );

    // Bootstrap resolves → the greeting bubble (and later the ingest rows)
    // reference the real parsed headline from the fixture markdown.
    await waitFor(
      () => {
        expect(screen.getAllByText(/Alex Chen/).length).toBeGreaterThan(0);
      },
      { timeout: 6000 },
    );

    // The canned Maya-Chen persona is gone for good.
    expect(screen.queryByText(/Maya Chen/)).not.toBeInTheDocument();

    // The LLM opening prompt pre-fills the composer, editable.
    await waitFor(
      () => {
        const composer = screen.getByRole('textbox');
        expect((composer as HTMLTextAreaElement).value).toMatch(
          /exploring senior roles/i,
        );
      },
      { timeout: 4000 },
    );

    // Resume-grounded chips from the bootstrap render send-on-tap.
    expect(
      screen.getByRole('button', { name: 'Show me jobs now' }),
    ).toBeInTheDocument();
  }, 12000);

  it('skip routes to /home', async () => {
    renderWithProviders(<OnboardingPage />);

    await waitFor(
      () => {
        expect(screen.getByText('Master Resume')).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    fireEvent.click(screen.getByRole('button', { name: /Skip/i }));
    await waitFor(
      () => {
        expect(push).toHaveBeenCalledWith('/home');
      },
      { timeout: 4000 },
    );
  });
});
