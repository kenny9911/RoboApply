// __tests__/pages/tracker.test.tsx
//
// Smoke + persistence test for the /tracker "Pipeline" screen (V3 redesign —
// IA Route 8). Drives the page through the stub api
// (NEXT_PUBLIC_USE_STUB_API=true) and asserts:
//   • the tone-aware headline + the 4 kanban columns render,
//   • cards land from tracker.list (a known fixture company shows up),
//   • changing a card's status via its <select> control PERSISTS through
//     tracker.patch (re-reading the stub shows the new status).
//
// We exercise the <select> (the accessible move path) rather than native HTML5
// drag-and-drop, which JSDOM cannot simulate. The board's onMove is shared by
// both, so this covers the persistence contract.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import PipelinePage from '../../app/(auth)/tracker/page';
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
  usePathname: () => '/tracker',
}));

describe('/tracker Pipeline screen', () => {
  it('renders the columns + cards and persists a status change', async () => {
    renderWithProviders(<PipelinePage />);

    // Headline (default tone → "direct" variant: "Where each conversation
    // stands.") renders immediately.
    expect(
      screen.getByRole('heading', { level: 1, name: /Where each/i }),
    ).toBeInTheDocument();

    // The four kanban column headers render (label text is unique per column).
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(screen.getByText('Interview')).toBeInTheDocument();
    expect(screen.getByText('Offer')).toBeInTheDocument();

    // Cards land once tracker.list resolves — a known fixture company appears.
    await waitFor(
      () => {
        expect(screen.getByText('Stripe')).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    // The Stripe entry (cm_tr_001) starts as `bookmarked` (Saved column). Find
    // its card's status <select> and move it to "Applied".
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
