// __tests__/pages/applications.test.tsx
//
// Smoke + persistence test for /applications — destination 3 of 4, "where did
// I apply, and what happened?". Drives the page through the stub api
// (NEXT_PUBLIC_USE_STUB_API=true) and asserts:
//   • the headline is the question the user says out loud, and the stage
//     columns render under the C1 ladder,
//   • cards land from tracker.list (a known fixture company shows up),
//   • changing a card's stage via its <select> PERSISTS through tracker.patch
//     (re-reading the stub shows the new status).
//
// We exercise the <select> (the accessible move path) rather than native HTML5
// drag-and-drop, which JSDOM cannot simulate. The board's onMove is shared by
// both, so this covers the persistence contract.
//
// This replaces __tests__/pages/tracker.test.tsx. What changed and why:
//   • Route + component: /tracker → /applications (ruling D2). "Tracker" names
//     the filing cabinet, not the question.
//   • The headline is no longer tone-forked ("Where each conversation
//     stands." was one of three variants selected from the deleted tone knob);
//     it is one string, and it is the question the destination answers.
//   • Column label "Interview" → "Interviewing" (ruling C1 fixes the ladder at
//     Saved · Applied · First call · Interviewing · Final round · Offer ·
//     Rejected). Only four rungs render today because RATrackerStatus has no
//     first_call/final_round member yet — see components/v3/pipeline/columns.ts
//     for the data change (C32) that unlocks the rest. Asserting the four that
//     DO render, plus the absence of the retired label, is the honest test.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import ApplicationsPage from '../../app/(auth)/applications/page';
import { renderWithProviders } from '../utils/renderWithProviders';
import { raV2Api } from '../../lib/api/v2';

beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

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
  usePathname: () => '/applications',
}));

describe('/applications', () => {
  it('renders the stage columns + cards and persists a stage change', async () => {
    renderWithProviders(<ApplicationsPage />);

    // The H1 is the question this destination answers, verbatim from the IA.
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /Where did you apply, and what happened\?/i,
      }),
    ).toBeInTheDocument();

    // The stage columns render under the C1 ladder (label text is unique per
    // column).
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(screen.getByText('Interviewing')).toBeInTheDocument();
    expect(screen.getByText('Offer')).toBeInTheDocument();
    // The pre-ruling label is gone, not merely unused: "Interview" as a stage
    // name reads as an event, and C1 wants the state.
    expect(screen.queryByText(/^Interview$/)).toBeNull();

    // Cards land once tracker.list resolves — a known fixture company appears.
    await waitFor(
      () => {
        expect(screen.getByText('Stripe')).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    // The Stripe entry (cm_tr_001) starts as `bookmarked` (Saved column). Find
    // its card's stage <select> and move it to "Applied".
    const stripeCard = screen.getByText('Stripe').closest('.pipe-card');
    expect(stripeCard).not.toBeNull();
    const select = stripeCard!.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe('bookmarked');

    fireEvent.change(select, { target: { value: 'applied' } });

    // The mutation persists through the stub — re-reading the tracker shows the
    // entry now in `applied`.
    await waitFor(
      async () => {
        const res = await raV2Api.tracker.list({ limit: 200 });
        const entry = res.entries.find((e) => e.id === 'cm_tr_001');
        expect(entry?.status).toBe('applied');
      },
      { timeout: 4000 },
    );
  });
});
