// __tests__/pages/home.test.tsx
//
// Smoke test for the /home "Today" screen (V3 redesign — IA Route 1). Drives
// the page through the stub api (NEXT_PUBLIC_USE_STUB_API=true) and asserts the
// major pieces render: the counted headline, the measured "Updated {time}" sub,
// the matches header, and that scored match cards land from search.run.
//
// What this test used to assert and why it no longer does (OVERHAUL_SPEC §6.3):
//   • The tone-forked overnight headline ("{n} applications shipped overnight.")
//     — the tone knob is deleted, and the headline now states a measured count.
//   • TodayStatStrip ("Auto-applied" / "Scanned overnight" / "Matched ≥ 80") —
//     deleted outright; two of its three numbers were never measured.
//   • "Apply now" — the primary action is honest about what it does now: it
//     opens the posting on the company's site (ruling C-set, nothing is sent).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import HomePage from '../../app/(auth)/home/page';
import { renderWithProviders } from '../utils/renderWithProviders';

// Match the dev default — the stub api selector reads this at module load.
beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

// next/navigation isn't available in JSDOM unit tests; mock the bits we use.
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
  usePathname: () => '/home',
}));

describe('/home Today screen', () => {
  it('renders the counted header, updated stamp, and match feed against the stub API', async () => {
    renderWithProviders(<HomePage />);

    // The h1 + matches header render immediately. While the feed is in flight
    // the headline is uncounted ("Jobs that fit you.") — it never guesses a
    // number it has not measured.
    const h1 = screen.getByRole('heading', { level: 1, name: /jobs that fit/i });
    expect(h1).toBeInTheDocument();
    expect(screen.getByText(/Today's matches/i)).toBeInTheDocument();

    // Once search.run lands, the headline states the count the feed actually
    // returned. Asserting the shape (not a hardcoded fixture length) still
    // proves the ICU interpolation ran: a missing key would leave the literal
    // "today.headline", and a broken one would leave a raw "{count}".
    await waitFor(
      () => {
        expect(h1.textContent).toMatch(/^\d+ jobs? that fits? you\.$/);
      },
      { timeout: 4000 },
    );

    // The sub is the query's own dataUpdatedAt, formatted client-side in an
    // effect — so it appears only after the response lands, and it is the only
    // number in the header besides the count. Both are measured (rule D9).
    expect(screen.getByText(/^Updated .+\.$/)).toBeInTheDocument();

    // The match feed hydrates from search.run — at least one fixture job
    // title shows up as a card heading.
    await waitFor(
      () => {
        expect(
          screen.getAllByRole('heading', { level: 3 }).length,
        ).toBeGreaterThan(0);
      },
      { timeout: 4000 },
    );

    // The first card is auto-expanded → its AI reasoning + facet strip resolve
    // once jobs.score (very_slow stub) lands, and the Apply action shows.
    await waitFor(
      () => {
        expect(screen.getByText('Why I think this fits')).toBeInTheDocument();
        expect(screen.getByText('Salary fit')).toBeInTheDocument();
      },
      { timeout: 6000 },
    );
    // Exactly one card is expanded → exactly one apply action (also guards the
    // accordion + valid ARIA: the card header is the toggle, not a button
    // wrapping the nested action buttons). getByRole throws on >1 match.
    expect(
      screen.getByRole('button', { name: /Apply on company site/i }),
    ).toBeInTheDocument();
  });
});
