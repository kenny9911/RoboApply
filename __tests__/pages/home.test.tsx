// __tests__/pages/home.test.tsx
//
// Smoke test for the /home "Today" screen (V3 redesign — IA Route 1). Drives
// the page through the stub api (NEXT_PUBLIC_USE_STUB_API=true) and asserts the
// major pieces render: the Live eyebrow, the tone-aware headline, the 4-up hero
// stat strip, the matches header, and that scored match cards land from
// search.run. dcTheme has no provider here so the tone defaults to `casual`
// → the "direct" copy variant.

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
  it('renders the header, hero stats, and match feed against the stub API', async () => {
    renderWithProviders(<HomePage />);

    // The h1 + matches header render immediately (the headline uses the
    // direct-tone copy: "{n} applications shipped overnight.").
    expect(
      screen.getByRole('heading', { level: 1, name: /applications/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Today's matches/i)).toBeInTheDocument();

    // Hero stat strip captions land once activity.orbStats resolves.
    await waitFor(
      () => {
        expect(screen.getByText('Auto-applied')).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.getByText('Scanned overnight')).toBeInTheDocument();
    expect(screen.getByText('Matched ≥ 80')).toBeInTheDocument();

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
    // Exactly one card is expanded → exactly one Apply-now action (also guards
    // the accordion + valid ARIA: the card header is the toggle, not a button
    // wrapping the nested action buttons).
    expect(
      screen.getByRole('button', { name: /Apply now/i }),
    ).toBeInTheDocument();
  });
});
