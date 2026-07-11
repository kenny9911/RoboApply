// Landing page — public marketing ("night shift / overnight log" v2).
//
// We verify the rendered hero copy + CTA hrefs, the stats band, the shift
// timeline, the full-loop grid (incl. the honest EARLY ACCESS chip), the
// interview-studio spotlight, the operating-rules panel, the REAL pricing
// tiers (mock-interview credit plans), the GEO FAQ, and the crawlable
// footer locale links — all against the real en.json bundle.

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

import { LandingContent } from '../../components/landing/LandingContent';
import {
  SEO_READY_LOCALES,
  localePath,
} from '../../lib/localeConfig';

describe('Landing page', () => {
  it('renders hero headline + consent subheadline (translated)', () => {
    renderWithProviders(<LandingContent />);
    // Two-voice h1 (machine grotesk + human serif spans) must still compute
    // the canonical accessible name — accent periods included.
    expect(
      screen.getByRole('heading', {
        name: /We apply\s*\.\s*You interview\s*\./i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing sends without you/i)).toBeInTheDocument();
  });

  it('primary CTAs link to /onboarding (header, hero, studio, pricing, final, sticky)', () => {
    renderWithProviders(<LandingContent />);
    const ctas = screen
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href') === '/onboarding');
    expect(ctas.length).toBeGreaterThanOrEqual(6);
  });

  it('Sign in link in the header points to /login', () => {
    renderWithProviders(<LandingContent />);
    const signin = screen.getByRole('link', { name: /Sign in/i });
    expect(signin).toHaveAttribute('href', '/login');
  });

  it('renders the overnight log panel (sr summary + LIVE feed)', () => {
    renderWithProviders(<LandingContent />);
    // The animated log body is aria-hidden; the sr-only summary carries it.
    expect(
      screen.getByText(/Sample overnight activity log/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/overnight\.log/i)).toBeInTheDocument();
  });

  it('renders the why-bots-lose stats band with citable numbers', () => {
    renderWithProviders(<LandingContent />);
    expect(
      screen.getByRole('heading', { name: /The volume game is rigged\./i }),
    ).toBeInTheDocument();
    expect(screen.getByText('242')).toBeInTheDocument();
    expect(screen.getByText('+400%')).toBeInTheDocument();
    expect(screen.getByText('41%')).toBeInTheDocument();
  });

  it('renders the shift timeline steps as headings', () => {
    renderWithProviders(<LandingContent />);
    expect(
      screen.getByRole('heading', { name: /It hunts while you sleep/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /It writes with receipts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /You hold the veto/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /then the real prep starts/i }),
    ).toBeInTheDocument();
  });

  it('renders the full-loop grid with the honest EARLY ACCESS chip', () => {
    renderWithProviders(<LandingContent />);
    expect(
      screen.getByRole('heading', { name: /Matching that reads your resume/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /A resume that rewrites itself/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: /Applications with a consent layer/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/AUTOPILOT · EARLY ACCESS/i)).toBeInTheDocument();
  });

  it('renders the interview-studio spotlight with the report receipt', () => {
    renderWithProviders(<LandingContent />);
    expect(
      screen.getByRole('heading', {
        name: /We get you the interview\s*\.\s*then we get you ready\s*\./i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: /18 domain playbooks, not trivia decks/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/session-042/i)).toBeInTheDocument();
    expect(
      screen.getByText(/you buried the 40% cost reduction/i),
    ).toBeInTheDocument();
  });

  it('renders the operating rules (guarantees.conf) panel', () => {
    renderWithProviders(<LandingContent />);
    expect(
      screen.getByRole('heading', { name: /Hard-coded, not fine print\./i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/guarantees\.conf/i)).toBeInTheDocument();
    expect(screen.getByText(/Real letters only/i)).toBeInTheDocument();
    expect(screen.getByText(/The review hold/i)).toBeInTheDocument();
  });

  it('renders the REAL pricing plans (mock-interview credits)', () => {
    renderWithProviders(<LandingContent />);
    expect(screen.getByRole('heading', { name: 'Free' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Starter' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Growth' }),
    ).toBeInTheDocument();
    // Credits + prices — must match /plans (mockInterviewPlans.ts), NOT the
    // retired $19/$49 apps-per-day tiers.
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('28')).toBeInTheDocument();
    expect(screen.getByText('$0')).toBeInTheDocument();
    expect(screen.getByText('$15')).toBeInTheDocument();
    expect(screen.getByText('$29')).toBeInTheDocument();
  });

  it('renders the FAQ with question-shaped headings (GEO surface)', () => {
    renderWithProviders(<LandingContent />);
    expect(
      screen.getByRole('heading', { name: /What is RoboApply\?/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: /Will RoboApply apply to jobs without my permission\?/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: /How much does RoboApply cost\?/i,
      }),
    ).toBeInTheDocument();
  });

  it('renders crawlable locale links for every SEO-ready locale in the footer', () => {
    renderWithProviders(<LandingContent />);
    const nav = screen.getByRole('navigation', {
      name: /RoboApply in your language/i,
    });
    const links = Array.from(nav.querySelectorAll('a'));
    // The footer (and language menu) must track SEO_READY_LOCALES exactly —
    // linking an untranslated locale surfaces an English page under a
    // foreign URL, and a translated one missing here stays undiscoverable.
    expect(links.map((a) => a.getAttribute('href')).sort()).toEqual(
      SEO_READY_LOCALES.map((l) => localePath(l)).sort(),
    );
  });
});
