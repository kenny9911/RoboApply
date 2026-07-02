// Landing page — public marketing, renders hero, CTA links to /onboarding.
//
// This page is implemented (not a placeholder) per app/page.tsx. We verify
// the rendered hero copy + the CTA hrefs.

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../utils/renderWithProviders';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import LandingPage from '../../app/page';

describe('Landing page', () => {
  it('renders hero headline + subheadline (translated)', () => {
    renderWithProviders(<LandingPage />);
    expect(
      screen.getByRole('heading', { name: /We apply\. You interview\./i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/scouts jobs at night, drafts every cover letter/i),
    ).toBeInTheDocument();
  });

  it('CTA links to /onboarding (hero + pricing-strip both point there)', () => {
    renderWithProviders(<LandingPage />);
    const ctas = screen.getAllByRole('link').filter((a) => a.getAttribute('href') === '/onboarding');
    // Two CTAs: hero + pricing block.
    expect(ctas.length).toBeGreaterThanOrEqual(2);
  });

  it('Sign in link in the header points to /login', () => {
    renderWithProviders(<LandingPage />);
    const signin = screen.getByRole('link', { name: /Sign in/i });
    expect(signin).toHaveAttribute('href', '/login');
  });

  it('renders the 3 feature cards', () => {
    renderWithProviders(<LandingPage />);
    expect(
      screen.getByRole('heading', { name: /Scouts overnight/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Drafts cover letters/i }),
    ).toBeInTheDocument();
    // "Submits at 9am" appears in both the subheadline and the feature card
    // title; the latter is the only heading-level instance.
    expect(
      screen.getByRole('heading', { name: /Submits at 9am/i }),
    ).toBeInTheDocument();
  });

  it('renders the pricing strip with 3 tiers', () => {
    renderWithProviders(<LandingPage />);
    expect(screen.getByText(/Free · 3 apps\/day/i)).toBeInTheDocument();
    expect(screen.getByText(/Premium · \$19\/mo/i)).toBeInTheDocument();
    expect(screen.getByText(/Premium\+ · \$49\/mo/i)).toBeInTheDocument();
  });
});
