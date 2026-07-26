// __tests__/pages/jobs.test.tsx
//
// Smoke test for /jobs — destination 1 of 4, "what should I apply to?".
// Drives the page through the stub api (NEXT_PUBLIC_USE_STUB_API=true) and
// asserts the pieces that carry the ruling: the measured headline, the
// measured "Updated {time}" sub, the feed header, and — once jobs.score
// resolves — the fit vocabulary and the honest primary action.
//
// This replaces __tests__/pages/home.test.tsx, which tested the same screen at
// its old route. What changed in the assertions, and why:
//   • Route + component: /home → /jobs (ruling D2 — route, nav label, H1 and
//     i18n namespace share one name).
//   • "Why I think this fits" → "Why you fit". Ruling C9 removes every speaker
//     from the product; the old string had an unnamed "I" in the most-read
//     sentence in the app.
//   • "Salary fit" → "Pay" (C6 — the rubric speaks in sentences, not analyst
//     nouns).
//   • The primary action stays "Apply on company site" and stays honest: it
//     opens the posting, nothing is submitted on the user's behalf (R1).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import JobsPage from '../../app/(auth)/jobs/page';
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
  usePathname: () => '/jobs',
}));

describe('/jobs', () => {
  it('renders the measured header, updated stamp, and job feed against the stub API', async () => {
    renderWithProviders(<JobsPage />);

    // The h1 + feed header render immediately. While the feed is in flight the
    // headline is uncounted ("Jobs that fit you.") — it never guesses a number
    // it has not measured (rule D9).
    const h1 = screen.getByRole('heading', { level: 1, name: /jobs that fit/i });
    expect(h1).toBeInTheDocument();
    expect(screen.getByText(/Jobs that fit you, best fit first/i)).toBeInTheDocument();

    // Once search.run lands, the headline states the count the feed actually
    // returned. Asserting the shape (not a hardcoded fixture length) still
    // proves the ICU interpolation ran: a missing key would leave the literal
    // "jobs.headline" — next-intl renders the dotted path rather than throwing
    // (C30) — and a broken one would leave a raw "{count}".
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

    // The feed hydrates from search.run — at least one fixture job title shows
    // up as a card heading.
    await waitFor(
      () => {
        expect(
          screen.getAllByRole('heading', { level: 3 }).length,
        ).toBeGreaterThan(0);
      },
      { timeout: 4000 },
    );

    // The first card is auto-expanded → its reasoning + facet strip resolve
    // once jobs.score (very_slow stub) lands. Both strings are the post-ruling
    // vocabulary: no speaker, no analyst noun.
    await waitFor(
      () => {
        expect(screen.getByText('Why you fit')).toBeInTheDocument();
        expect(screen.getByText('Pay')).toBeInTheDocument();
      },
      { timeout: 6000 },
    );

    // Exactly one card is expanded → exactly one apply action (also guards the
    // accordion + valid ARIA: the card header is the toggle, not a button
    // wrapping the nested action buttons). getByRole throws on >1 match.
    expect(
      screen.getByRole('button', { name: /Apply on company site/i }),
    ).toBeInTheDocument();

    // Ruling C7: "Pass" is a guaranteed mistranslation in the exact spot where
    // a wrong tap deletes a job, so the dismiss action names the outcome.
    expect(
      screen.getByRole('button', { name: /Not interested/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pass$/i })).toBeNull();
  });
});
