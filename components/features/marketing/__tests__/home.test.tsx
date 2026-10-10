// WP-40 home pages per brand: gap-first hero with the real-count clause
// (dropped below 1,000), labelled Example, real counters with their source,
// quick search routing, CTA parameter preservation, the footer's /cancel
// link, no testimonials / user counts / competitor names, and the GoApply
// home (pillars, campus preview behind its capability, no literal brand).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getIndexStats: vi.fn(),
  getCreditCaps: vi.fn(),
  sendSupportMessage: vi.fn(),
  getPlans: vi.fn(),
  listPublicCampusEvents: vi.fn(),
  getToolsConfig: vi.fn(),
  push: vi.fn(),
  search: { value: '' },
}));

vi.mock('../../../../lib/api/support', () => ({
  getIndexStats: api.getIndexStats,
  getCreditCaps: api.getCreditCaps,
  sendSupportMessage: api.sendSupportMessage,
}));
vi.mock('../../../../lib/api/credits', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getPlans: api.getPlans }));
vi.mock('../../../../lib/api/campus', () => ({ listPublicCampusEvents: api.listPublicCampusEvents }));
vi.mock('../../../../lib/api/tools', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getToolsConfig: api.getToolsConfig }));
vi.mock('../../market', () => ({
  LegalFooter: () => <footer data-testid="legal-footer" />,
  PriceReference: () => null,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: api.push, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(api.search.value),
  useParams: () => ({}),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { capsFor } from '../../../../__tests__/shell/helpers';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import { ThemeProvider } from '../../../../lib/theme';
import { MarketingFooter } from '../SiteChrome';
import { messagesFor, renderMarketing as renderWithBrand } from './render';
import { plansView } from '../../credits/__tests__/fixtures';
import { GoApplyHome } from '../GoApplyHome';
import { RoboApplyHome } from '../RoboApplyHome';

const AS_OF = '2026-10-10T12:00:00.000Z';
function stats(open: number | null, week: number | null = null) {
  const s = (v: number | null) => (v === null ? null : { value: v, source: 'index', method: 'rounded_down_2_significant_figures', asOf: AS_OF });
  return { openRoles: s(open), addedThisWeek: s(week), popularLists: [{ taxonomyId: 'backend_engineer', label: 'Backend engineer', labelZh: '后端工程师' }], asOf: AS_OF };
}

beforeEach(() => {
  api.search.value = '';
  api.getPlans.mockImplementation(async () => plansView('roboapply'));
  api.getIndexStats.mockResolvedValue(stats(12_000, 1_300));
  api.listPublicCampusEvents.mockResolvedValue({ items: [] });
  api.getToolsConfig.mockResolvedValue({ available: false });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RoboApply home', () => {
  it('leads with the gap and adds the real open-roles count when ≥ 1,000', async () => {
    renderWithBrand(<RoboApplyHome />);
    expect(screen.getByRole('heading', { level: 1, name: "Find out why you're not getting interviews." })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/We read 12,000\+ open roles/)).toBeInTheDocument());
  });

  it('drops the count clause when the index holds 950 jobs (H20 test)', async () => {
    api.getIndexStats.mockResolvedValue(stats(950, 40));
    const { container } = renderWithBrand(<RoboApplyHome />);
    await waitFor(() => expect(api.getIndexStats).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-hero-count]')?.getAttribute('data-hero-count')).toBe(''));
    expect(screen.getByText(/We show you the open roles you can actually get/)).toBeInTheDocument();
    expect(screen.queryByText(/950/)).toBeNull();
    // Counters are hidden below the floor too.
    expect(container.querySelector('[data-index-counters]')).toBeNull();
  });

  it('shows counters only from the API, rounded, with the index source and hourly note', async () => {
    const { container } = renderWithBrand(<RoboApplyHome />);
    await waitFor(() => expect(container.querySelector('[data-index-counters]')).not.toBeNull());
    const counters = within(container.querySelector('[data-index-counters]') as HTMLElement);
    expect(counters.getByText('12,000+ open roles')).toBeInTheDocument();
    expect(counters.getByText('1,300+ added in the last 7 days')).toBeInTheDocument();
    expect(counters.getByText(/Counted from the RoboApply index, updated hourly/)).toBeInTheDocument();
    expect(counters.getByText(/Source: jobs listed with us/)).toBeInTheDocument();
  });

  it('renders no counters while the count is unknown', async () => {
    api.getIndexStats.mockRejectedValue(new Error('down'));
    const { container } = renderWithBrand(<RoboApplyHome />);
    await waitFor(() => expect(api.getIndexStats).toHaveBeenCalled());
    expect(container.querySelector('[data-index-counters]')).toBeNull();
    expect(screen.getByText(/We show you the open roles/)).toBeInTheDocument();
  });

  // INT-06 (wave4 WP-93 #13): the ticker slot the route fills with <JobTicker />.
  it('shows the ticker the route hands it between the counters and the quick search, and nothing in its place otherwise', async () => {
    const { JobTickerView } = await import('../../seo');
    const item = { id: 'cmjob0000000000000000001', idSlug: 'cmjob0000000000000000001-backend-engineer', path: '/job/cmjob0000000000000000001-backend-engineer', title: 'Backend engineer', companyName: 'Example Co', location: 'Berlin, Germany', firstSeenAt: '2026-10-10T11:30:00.000Z', postedAt: null };
    const withTicker = renderWithBrand(<RoboApplyHome ticker={<JobTickerView items={[item]} now={AS_OF} />} />);
    const ticker = withTicker.container.querySelector('[data-seo-ticker]') as HTMLElement;
    expect(within(ticker).getByRole('link', { name: 'Backend engineer' })).toHaveAttribute('href', item.path);
    expect(ticker).toHaveTextContent('Found 30 min ago');
    const search = withTicker.container.querySelector('form[role="search"]') as HTMLElement;
    expect(ticker.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    withTicker.unmount();

    // No public jobs: <JobTicker /> renders null, and the home shows no ticker, heading or placeholder.
    const without = renderWithBrand(<RoboApplyHome ticker={null} />);
    expect(without.container.querySelector('[data-seo-ticker]')).toBeNull();
    expect(screen.queryByRole('heading', { name: /just found|new jobs/i })).toBeNull();
  });

  it('labels the interactive sample "Example" and steps through the four verbs', () => {
    const { container } = renderWithBrand(<RoboApplyHome />);
    const sample = container.querySelector('[data-example]') as HTMLElement;
    expect(within(sample).getByText('Example')).toBeInTheDocument();
    expect(within(sample).getByText(/Made-up resume and jobs/)).toBeInTheDocument();
    expect(within(sample).getByText("They ask for Kubernetes twice. Your resume never mentions it.")).toBeInTheDocument();
    expect(within(sample).getByText('This is not your chance of getting hired.')).toBeInTheDocument();
    fireEvent.click(within(sample).getByRole('tab', { name: 'Practice' }));
    expect(within(sample).getByRole('tab', { name: 'Practice' })).toHaveAttribute('aria-selected', 'true');
    expect(within(sample).getByText(/A practice interview built from this job post/)).toBeInTheDocument();
    for (const verb of ['Find jobs that fit', 'See the gap first', 'Fix your resume for that job', 'Practice the interview']) {
      expect(screen.getByRole('heading', { name: verb })).toBeInTheDocument();
    }
  });

  it('every CTA goes to /signup?from=… and keeps job, ref and utm_*', () => {
    api.search.value = '?job=cm9&ref=FRIEND12&utm_source=newsletter&email=a@b.test&q=x';
    const { container } = renderWithBrand(<RoboApplyHome />);
    const ctas = Array.from(container.querySelectorAll('a[href^="/signup"]'));
    expect(ctas.length).toBeGreaterThanOrEqual(4);
    for (const a of ctas) {
      const url = new URL(a.getAttribute('href')!, 'https://x.test');
      expect(url.searchParams.get('from')).toMatch(/^home/);
      expect(url.searchParams.get('job')).toBe('cm9');
      expect(url.searchParams.get('ref')).toBe('FRIEND12');
      expect(url.searchParams.get('utm_source')).toBe('newsletter');
      expect(url.searchParams.has('email')).toBe(false);
      expect(url.searchParams.has('q')).toBe(false);
    }
  });

  it('quick search goes to signup while browse pages are off', () => {
    renderWithBrand(<RoboApplyHome />);
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Product designer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search jobs' }));
    expect(api.push).toHaveBeenCalledWith('/signup?from=home%3Asearch');
  });

  it('quick search goes to /browse when seo.browse is on', () => {
    renderWithBrand(<RoboApplyHome />, { flags: { 'seo.browse': true } });
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Product designer' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Toronto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search jobs' }));
    expect(api.push).toHaveBeenCalledWith('/browse/product-designer/toronto');
  });

  it('the footer links popular job lists only when browse pages are live', async () => {
    const off = renderWithBrand(<RoboApplyHome />);
    await waitFor(() => expect(api.getIndexStats).toHaveBeenCalled());
    expect(screen.queryByText('Popular job lists')).toBeNull();
    off.unmount();
    renderWithBrand(<RoboApplyHome />, { flags: { 'seo.browse': true } });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Backend engineer' })).toHaveAttribute('href', '/browse/backend-engineer'));
  });

  it('prices the summary from /billing/plans', async () => {
    renderWithBrand(<RoboApplyHome />);
    await waitFor(() => expect(screen.getByText('$24.99 / month')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Pro Monthly' })).toBeInTheDocument();
  });

  it('the footer carries /cancel, the legal footer and pages; gated features stay hidden', () => {
    const { container } = renderWithBrand(<RoboApplyHome />, { flags: { agent: false, copilot: false } });
    expect(screen.getByTestId('cancel-footer-link')).toHaveAttribute('href', '/cancel');
    expect(screen.getByTestId('legal-footer')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'How ranking works' })[0]).toHaveAttribute('href', '/help/ranking');
    expect(container.querySelector('[data-feature-link="job-matches"]')).not.toBeNull();
    expect(container.querySelector('[data-feature-link="ready-to-apply"]')).toBeNull();
    expect(container.querySelector('[data-feature-link="chrome-extension"]')).toBeNull();
    // Spoken practice needs the voice stack; off → no link.
    expect(container.querySelector('[data-feature-link="interview-practice"]')).toBeNull();
  });

  // FIX-7: the language button was announced as "Main" (the nav landmark's label).
  it('the header language button says what it does; the nav keeps its own label', () => {
    renderWithBrand(<RoboApplyHome />);
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('button', { name: 'Change language' })).toHaveAttribute('aria-haspopup', 'menu');
    expect(within(header).queryByRole('button', { name: 'Main' })).toBeNull();
    expect(within(header).getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  // FIX-7: a phone had no way to switch light/dark on the home page (the header button is hidden below 760 px).
  it('the footer carries the light/dark switch for phones, wired to the same theme state as the header', () => {
    document.documentElement.removeAttribute('data-theme');
    const { container } = renderWithProviders(
      <ThemeProvider>
        <BrandProvider brand={clientBrandFor('roboapply')} initialCapabilities={capsFor('roboapply', {})}>
          <RoboApplyHome />
        </BrandProvider>
      </ThemeProvider>,
      { intlMessages: messagesFor('roboapply') },
    );
    const footer = container.querySelector('[data-marketing-footer]') as HTMLElement;
    const inFooter = within(footer).getByRole('button', { name: 'Switch to dark' });
    expect(inFooter).toHaveAttribute('data-footer-theme');
    expect(inFooter).toHaveTextContent('Switch to dark');
    fireEvent.click(inFooter);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(within(footer).getByRole('button', { name: 'Switch to light' })).toBeInTheDocument();
    // The header button follows: one state, two controls.
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Switch to light' })).toBeInTheDocument();
    fireEvent.click(within(footer).getByRole('button', { name: 'Switch to light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('only the home pages put the switch in the footer (other public pages keep it in their header)', () => {
    const { container } = renderWithBrand(<MarketingFooter />);
    expect(container.querySelector('[data-footer-theme]')).toBeNull();
  });

  it('the phone switch is hidden above 760 px and shown below, where the header button is hidden', () => {
    const css = readFileSync(join(process.cwd(), 'components/features/marketing/marketing.module.css'), 'utf8');
    expect(css).toMatch(/\.footerTheme \{\s*display: none;/);
    const phone = css.slice(css.indexOf('@media (max-width: 760px)'));
    expect(phone).toMatch(/\.headerActions \.hideSmall \{\s*display: none;/);
    expect(phone).toMatch(/\.footerTheme \{\s*display: inline-flex;/);
  });

  // INT-06 (wave4 WP-93 #14): /tools in the site navigation and the footer.
  it('links the free tools from the header nav and the footer, without asking the API', async () => {
    const { container } = renderWithBrand(<RoboApplyHome />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Free tools' })).toHaveAttribute('href', '/tools');
    const footer = container.querySelector('[data-marketing-footer]') as HTMLElement;
    expect(within(footer).getByRole('link', { name: 'Free tools' })).toHaveAttribute('href', '/tools');
    await waitFor(() => expect(api.getIndexStats).toHaveBeenCalled());
    expect(api.getToolsConfig).not.toHaveBeenCalled();
  });

  it('links interview practice only while voice practice works', () => {
    const { container } = renderWithBrand(<RoboApplyHome />, { flags: { 'ai.interviewVoice': true } });
    expect(container.querySelector('[data-feature-link="interview-practice"]')).not.toBeNull();
  });

  it('shows no testimonials, user counts, competitor names or auto-apply claims', async () => {
    const { container } = renderWithBrand(<RoboApplyHome />);
    await waitFor(() => expect(api.getPlans).toHaveBeenCalled());
    const text = container.textContent ?? '';
    for (const banned of [/jobright/i, /linkedin premium/i, /\busers\b/i, /testimonial/i, /★/, /auto-?appl/i, /apply for you/i, /\$15\b/, /Starter/]) {
      expect(text).not.toMatch(banned);
    }
  });
});

describe('GoApply home', () => {
  beforeEach(() => {
    api.getPlans.mockImplementation(async () => plansView('goapply'));
  });

  it('renders the three pillars and never the RoboApply name', () => {
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { 'ai.text': true } });
    expect(screen.getByRole('heading', { level: 1, name: 'Fewer forms. No missed deadlines. Calmer interviews.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI interview practice' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The core is free' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/RoboApply/);
    expect(container.textContent).toMatch(/GoApply/);
    expect(container.textContent).not.toMatch(/北森|牛客|voice/i);
  });

  it('hides AI practice (pillar, hero clause, section, link) while ai.text is off (R-13)', () => {
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { 'ai.text': false } });
    expect(screen.getByRole('heading', { level: 1, name: 'Fewer forms. No missed deadlines. Calmer interviews.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fewer forms' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Calmer interviews' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'AI interview practice' })).toBeNull();
    expect(container.querySelector('[data-cn-practice]')).toBeNull();
    expect(container.querySelector('a[href*="home%3Apractice"]')).toBeNull();
    expect(container.querySelector('a[href="/features/interview-practice"]')).toBeNull();
    expect(container.textContent).not.toMatch(/practice the AI interview|AI interview formats/i);
  });

  it('says paid plans are not open only while /billing/plans says so (R-15)', async () => {
    renderWithBrand(<GoApplyHome />, { brand: 'goapply' });
    await waitFor(() => expect(screen.getByText('Paid plans are not open yet.')).toBeInTheDocument());
    cleanup();
    api.getPlans.mockImplementation(async () => ({ ...plansView('goapply'), paymentsOpen: true }));
    renderWithBrand(<GoApplyHome />, { brand: 'goapply' });
    await waitFor(() => expect(api.getPlans).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Paid plans are not open yet.')).toBeNull();
  });

  // INT-06: on GoApply the tools link waits for the tools to run there (not in CN-0).
  it('GoApply links the free tools only once the tools run on its stack', async () => {
    api.getToolsConfig.mockResolvedValue({ available: false });
    const closed = renderWithBrand(<GoApplyHome />, { brand: 'goapply' });
    await waitFor(() => expect(api.getToolsConfig).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Free tools' })).toBeNull();
    expect(closed.container.querySelector('[href="/tools"]')).toBeNull();
    closed.unmount();

    api.getToolsConfig.mockResolvedValue({ available: true });
    const open = renderWithBrand(<GoApplyHome />, { brand: 'goapply' });
    await waitFor(() => expect(open.container.querySelector('[data-footer-link="tools"]')).not.toBeNull());
    expect(open.container.querySelector('[data-nav="tools"]')).toHaveAttribute('href', '/tools');
    expect(open.container.querySelector('[data-footer-link="tools"]')).toHaveAttribute('href', '/tools');
  });

  it('the English GoApply page carries no Chinese text (footer tagline included)', () => {
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { 'ai.text': true } });
    expect(screen.getByText('Fewer forms. No missed deadlines. Calmer interviews. You submit every application yourself.')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('hides the campus preview while jobs.campusCalendar is off', () => {
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply' });
    expect(container.querySelector('[data-campus-preview]')).toBeNull();
    expect(api.listPublicCampusEvents).not.toHaveBeenCalled();
  });

  it('previews open programmes with closing date, source and last check when on', async () => {
    api.listPublicCampusEvents.mockResolvedValue({
      items: [
        {
          id: 'ev1',
          companyName: 'Example Bank',
          title: '2027 campus programme',
          graduationClass: '2027',
          kind: 'campus',
          applyOpensAt: null,
          applyClosesAt: '2026-10-31T15:59:59.000Z',
          stages: [],
          cities: [],
          roles: [],
          officialUrl: 'https://careers.example.cn/campus',
          sourceName: null,
          verifiedAt: '2026-10-08T00:00:00.000Z',
          needsReverify: false,
          subscribed: false,
        },
      ],
    });
    renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { 'jobs.campusCalendar': true } });
    await waitFor(() => expect(screen.getByText(/Example Bank · 2027 campus programme/)).toBeInTheDocument());
    expect(screen.getByText(/Applications close/)).toBeInTheDocument();
    expect(screen.getByText(/Source: careers.example.cn/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the campus calendar' })).toHaveAttribute('href', '/campus');
  });
});
