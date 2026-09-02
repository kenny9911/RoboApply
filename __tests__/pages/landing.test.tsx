// Landing page — public marketing ("the gap report" v3).
//
// We verify the rendered hero copy + CTA hrefs, the stats band, the four
// steps, the loop grid, the interview-prep spotlight, the limits panel, the
// REAL pricing tiers (practice-interview credit plans), the GEO FAQ, and the
// crawlable footer locale links — all against the real en.json bundle.
//
// The last test is the one that matters most: ruling R1 retired auto-apply,
// so no auto-apply vocabulary may reappear on the public page. That is a
// truth claim about the product, not a style preference — a marketing page
// that promises submission the product cannot perform is the defect the
// whole overhaul exists to remove.

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
  it('renders the R2 hero headline + subheadline (translated)', () => {
    renderWithProviders(<LandingContent />);
    // Ruling R2: ONE sentence, one i18n key. The old two-span machine/human
    // h1 carried the retired "We apply. You interview." tagline.
    expect(
      screen.getByRole('heading', {
        name: /Automate Job Applications\. Find out why you're not getting interviews\./i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Tired of wasting your time applying to jobs\? .*We read 1,000\+ open roles/i),
    ).toBeInTheDocument();
  });

  it('quotes the plans in US dollars by default and in RMB for mainland China', () => {
    // A location rule, not a language one: the market comes from the request's
    // country header (lib/serverMarket.ts) and is handed in as a prop.
    const { unmount } = renderWithProviders(<LandingContent />);
    expect(screen.getByText('$15')).toBeInTheDocument();
    expect(screen.getByText('$29')).toBeInTheDocument();
    expect(screen.queryByText('¥19')).toBeNull();
    unmount();

    renderWithProviders(<LandingContent market="cn" />);
    expect(screen.getByText('¥19')).toBeInTheDocument();
    expect(screen.getByText('¥45')).toBeInTheDocument();
    expect(screen.queryByText('$15')).toBeNull();
    expect(screen.queryByText('$29')).toBeNull();
  });

  it('primary CTAs link to /signup (header, hero, studio, pricing, final, sticky)', () => {
    renderWithProviders(<LandingContent />);
    const ctas = screen
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href') === '/signup');
    expect(ctas.length).toBeGreaterThanOrEqual(6);
  });

  it('Sign in link in the header points to /login', () => {
    renderWithProviders(<LandingContent />);
    const signin = screen.getByRole('link', { name: /Sign in/i });
    expect(signin).toHaveAttribute('href', '/login');
  });

  it('renders the gap-report panel (sr summary + sample label)', () => {
    renderWithProviders(<LandingContent />);
    // The animated body is aria-hidden; the sr-only summary carries it.
    expect(screen.getByText(/A sample gap report/i)).toBeInTheDocument();
    expect(screen.getByText(/roboapply — gap report/i)).toBeInTheDocument();
  });

  it('renders the why-bots-lose stats band with citable numbers', () => {
    renderWithProviders(<LandingContent />);
    expect(
      screen.getByRole('heading', { name: /More applications is not the answer\./i }),
    ).toBeInTheDocument();
    expect(screen.getByText('242')).toBeInTheDocument();
    expect(screen.getByText('+400%')).toBeInTheDocument();
    expect(screen.getByText('41%')).toBeInTheDocument();
  });

  it('renders the four verbs as step headings (find, understand, fix, practice)', () => {
    renderWithProviders(<LandingContent />);
    expect(
      screen.getByRole('heading', { name: /It reads the market/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /It names the gap/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /You fix the resume/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Then you practice the interview/i }),
    ).toBeInTheDocument();
  });

  it('renders the loop grid, and the apply card says the user applies', () => {
    renderWithProviders(<LandingContent />);
    expect(
      screen.getByRole('heading', { name: /Jobs ranked by how well you fit/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /A resume you can actually fix/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: /Every application, and what happened to it/i,
      }),
    ).toBeInTheDocument();
    // Said on the loop card and again in the FAQ — both are load-bearing.
    expect(
      screen.getAllByText(/You apply on the company's site/i).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('renders the interview-studio spotlight with the report receipt', () => {
    renderWithProviders(<LandingContent />);
    expect(
      screen.getByRole('heading', {
        name: /Getting the interview is half of it\s*\.\s*This is the other half\s*\./i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: /18 field playbooks, not trivia lists/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/session-042/i)).toBeInTheDocument();
    expect(
      screen.getByText(/The 40% cost cut arrived at the end of your answer/i),
    ).toBeInTheDocument();
  });

  it('renders the limits panel, led by "nothing is sent for you"', () => {
    renderWithProviders(<LandingContent />);
    expect(
      screen.getByRole('heading', { name: /Four things we do not do\./i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/limits\.txt/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is sent for you/i)).toBeInTheDocument();
    expect(screen.getByText(/The score is not a prediction/i)).toBeInTheDocument();
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
    // Credits + prices — must match the billing catalog
    // (mockInterviewPlans.ts), NOT the retired $19/$49 apps-per-day tiers.
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
        name: /Does RoboApply apply to jobs for me\?/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: /How much does it cost\?/i,
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

  it('never promises auto-apply anywhere on the page (ruling R1)', () => {
    const { container } = renderWithProviders(<LandingContent />);
    const text = container.textContent ?? '';
    for (const banned of [
      /auto-?appl/i,
      /autopilot/i,
      /review hold/i,
      /consent layer/i,
      /we apply/i,
      /while you sleep/i,
      /night shift/i,
    ]) {
      expect(text).not.toMatch(banned);
    }
  });
});
