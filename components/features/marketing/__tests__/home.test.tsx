// WP-40 home pages per brand: gap-first hero with the real-count clause
// (dropped below 1,000), labelled Example, real counters with their source,
// quick search routing, CTA parameter preservation, the footer's /cancel
// link, no testimonials / user counts / competitor names, and the GoApply
// home: the same visitor functions over GoApply data (pillars, feature cards,
// real counters, the ticker slot, quick search, campus preview behind its
// capability, the CNY pricing summary, six questions; no literal brand).

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

  // D5: GoApply's home says "Paid passes can't be bought yet." while payments are closed; RoboApply's
  // listed the Pro price and said nothing (the state of any deployment without a usable Stripe key and
  // webhook secret: every plan `payments_disabled`, `paymentsOpen: false`, `defaultSelection: null`).
  it('says paid plans cannot be bought only while /billing/plans says so, and still shows the price', async () => {
    const closed = () => {
      const view = plansView('roboapply');
      return {
        ...view,
        paymentsOpen: false,
        defaultSelection: null,
        plans: view.plans.map((p) => (p.kind === 'free' ? p : { ...p, sellable: false, unsellableReason: 'payments_disabled' as const, isDefaultSelection: false })),
      };
    };
    api.getPlans.mockImplementation(async () => closed());
    const shut = renderWithBrand(<RoboApplyHome />);
    await waitFor(() => expect(screen.getByText("Paid plans can't be bought yet.")).toBeInTheDocument());
    expect(shut.container.querySelector('[data-pricing-summary] [data-payments-closed]')).toHaveTextContent("Paid plans can't be bought yet.");
    expect(screen.getByText('$24.99 / month')).toBeInTheDocument();
    cleanup();
    // Open: no note.
    api.getPlans.mockImplementation(async () => ({ ...plansView('roboapply'), paymentsOpen: true }));
    renderWithBrand(<RoboApplyHome />);
    await waitFor(() => expect(screen.getByText('$24.99 / month')).toBeInTheDocument());
    expect(screen.queryByText("Paid plans can't be bought yet.")).toBeNull();
    // Unknown (first paint, a failed read): nothing claims payments are closed.
    cleanup();
    api.getPlans.mockRejectedValue(new Error('down'));
    renderWithBrand(<RoboApplyHome />);
    await waitFor(() => expect(api.getPlans).toHaveBeenCalled());
    expect(screen.queryByText("Paid plans can't be bought yet.")).toBeNull();
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
  /** GoApply plans as the API sends them once a rail can charge (the default with the Alipay credential). */
  const openPlans = () => {
    const view = plansView('goapply');
    return { ...view, paymentsOpen: true, checkout: { ...view.checkout, rails: ['alipay' as const] }, plans: view.plans.map((p) => ({ ...p, sellable: p.kind !== 'free', unsellableReason: null })) };
  };
  const cnStats = (open: number | null, week: number | null = null) => ({ ...stats(open, week), popularLists: [] });
  /** Listed jobs are on by default on GoApply (`jobs.feed`); the test helper starts every flag at false. */
  const FEED_ON = { 'jobs.feed': true } as const;

  beforeEach(() => {
    api.getPlans.mockImplementation(async () => openPlans());
    api.getIndexStats.mockResolvedValue(cnStats(null));
  });

  it('renders the three pillars and never the RoboApply name', () => {
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { ...FEED_ON, 'ai.text': true } });
    expect(screen.getByRole('heading', { level: 1, name: 'Fewer forms. No missed deadlines. Calmer interviews.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI interview practice' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The core is free' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/RoboApply/);
    expect(container.textContent).toMatch(/GoApply/);
    expect(container.textContent).not.toMatch(/北森|牛客/);
  });

  // D5 (G117): the same visitor functions as the RoboApply home, over GoApply data.
  it('offers quick search, the feature cards, the pricing summary and a six-question FAQ with no CN_ switch set', async () => {
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { ...FEED_ON, 'ai.text': true, copilot: true, agent: true, 'jobs.campusCalendar': true, 'cn.referralCodes': true } });
    // Quick search: one country (mainland China), so no country picker; examples from the market.
    const search = container.querySelector('form[role="search"]') as HTMLElement;
    expect(within(search).getByLabelText('Job title')).toHaveAttribute('placeholder', 'e.g. Data analyst');
    expect(within(search).getByLabelText('City')).toHaveAttribute('placeholder', 'e.g. Shanghai');
    expect(within(search).queryByLabelText('Country')).toBeNull();
    // Feature cards from GoApply's catalog, gated ones included once their capability is on.
    const cards = [...container.querySelectorAll('[data-feature-link]')].map((c) => c.getAttribute('data-feature-link'));
    expect(cards).toEqual(['job-matches', 'resume-tailoring', 'cover-letters', 'ready-to-apply', 'campus-calendar', 'resume', 'interview-practice', 'assistant', 'referral-codes']);
    expect(container.querySelector('[data-feature-link="job-matches"]')).toHaveAttribute('href', '/features/job-matches');
    // No published extension: no form-filler card. Never RoboApply's market-only page.
    expect(container.querySelector('[data-feature-link="form-filler"]')).toBeNull();
    expect(container.querySelector('[data-feature-link="visa-sponsorship"]')).toBeNull();
    // Pricing summary from /billing/plans: the preselected pass in CNY.
    const pricing = container.querySelector('[data-pricing-summary]') as HTMLElement;
    await waitFor(() => expect(within(pricing).getByText('¥39, paid once')).toBeInTheDocument());
    expect(within(pricing).getByRole('heading', { name: 'Member 30-day pass' })).toBeInTheDocument();
    expect(within(pricing).getByText(/never renews by itself/)).toBeInTheDocument();
    expect(within(pricing).getByRole('link', { name: 'See every pass, pack and limit' })).toHaveAttribute('href', '/pricing');
    expect(pricing.id).toBe('free');
    expect(container.querySelector('a[href="#free"]')).not.toBeNull();
    expect(pricing.textContent).not.toMatch(/\$|Pro\b/);
    // Six questions, each with an answer.
    const faq = container.querySelector('#faq') as HTMLElement;
    expect(within(faq).getAllByRole('article')).toHaveLength(6);
    expect(within(faq).getByRole('heading', { name: 'Where do the jobs come from?' })).toBeInTheDocument();
    expect(within(faq).getByText(/GoApply does not list every job on the market/)).toBeInTheDocument();
    expect(within(faq).getByRole('heading', { name: 'What does it cost?' })).toBeInTheDocument();
    expect(within(faq).getByRole('heading', { name: 'What does the fit score mean?' })).toBeInTheDocument();
  });

  // The operator closed postings (CN_RECRUITMENT_INFO_MODE=off turns jobs.feed off): nothing on the home
  // counts, lists or searches jobs, or says where jobs come from (D3; R-04: no entry to a disabled feature).
  it('with jobs.feed off: no counters, ticker, quick search, jobs question or job-matches card; the rest stays', async () => {
    const { JobTickerView } = await import('../../seo');
    const item = { id: 'cmcn0000000000000000001', idSlug: 'cmcn0000000000000000001', path: '/job/cmcn0000000000000000001', title: '数据分析师', companyName: '示例科技', location: '上海', firstSeenAt: '2026-10-10T11:30:00.000Z', postedAt: null };
    // The count endpoint and a cached ticker may still answer in that mode: the page must not print them.
    api.getIndexStats.mockResolvedValue(cnStats(1_800, 240));
    const { container } = renderWithBrand(<GoApplyHome ticker={<JobTickerView items={[item]} now={AS_OF} />} />, {
      brand: 'goapply',
      flags: { 'jobs.feed': false, 'ai.text': true, 'seo.browse': true },
    });
    await waitFor(() => expect(within(container.querySelector('[data-pricing-summary]') as HTMLElement).getByText('¥39, paid once')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-index-counters]')).toBeNull();
    expect(container.querySelector('[data-seo-ticker]')).toBeNull();
    expect(container.querySelector('form[role="search"]')).toBeNull();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/open roles|Search jobs|see jobs that fit you|数据分析师/);
    const faq = container.querySelector('#faq') as HTMLElement;
    expect(within(faq).getAllByRole('article')).toHaveLength(5);
    expect(within(faq).queryByRole('heading', { name: 'Where do the jobs come from?' })).toBeNull();
    expect(text).not.toMatch(/Every job shows its source/);
    // No card and no footer link to the job-matches page; the other ungated pages keep theirs.
    expect(container.querySelector('a[href="/features/job-matches"]')).toBeNull();
    const cards = [...container.querySelectorAll('[data-feature-link]')].map((c) => c.getAttribute('data-feature-link'));
    expect(cards).toEqual(['resume-tailoring', 'cover-letters', 'resume', 'interview-practice']);
    // The toolkit half of the page is all there.
    expect(screen.getByRole('heading', { level: 1, name: 'Fewer forms. No missed deadlines. Calmer interviews.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The core is free' })).toBeInTheDocument();
    expect(within(faq).getByRole('heading', { name: 'What does it cost?' })).toBeInTheDocument();
  });

  // The server renders the page before the capabilities arrive. Listed jobs are on by default, so the
  // static parts are in that first HTML; the counters are a number and wait until the capability is known.
  it('before the capabilities are known: quick search, the jobs question and the job-matches card print; counters do not', async () => {
    api.getIndexStats.mockResolvedValue(cnStats(1_800, 240));
    const pending = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    try {
      const { container } = renderWithProviders(
        <BrandProvider brand={clientBrandFor('goapply')} initialCapabilities={null}>
          <GoApplyHome />
        </BrandProvider>,
        { intlMessages: messagesFor('goapply') },
      );
      expect(container.querySelector('form[role="search"]')).not.toBeNull();
      expect(within(container.querySelector('#faq') as HTMLElement).getByRole('heading', { name: 'Where do the jobs come from?' })).toBeInTheDocument();
      expect(container.querySelector('[data-feature-link="job-matches"]')).not.toBeNull();
      await waitFor(() => expect(api.getIndexStats).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(container.querySelector('[data-index-counters]')).toBeNull();
    } finally {
      pending.mockRestore();
    }
  });

  it('gated feature cards stay hidden while their capability is off (fail closed)', () => {
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: FEED_ON });
    const cards = [...container.querySelectorAll('[data-feature-link]')].map((c) => c.getAttribute('data-feature-link'));
    expect(cards).toEqual(['job-matches', 'resume-tailoring', 'cover-letters', 'resume']);
  });

  it('quick search goes to signup while browse pages are off and to /browse when seo.browse is on, like RoboApply', () => {
    const off = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: FEED_ON });
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: '数据分析师' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search jobs' }));
    expect(api.push).toHaveBeenCalledWith('/signup?from=home%3Asearch');
    off.unmount();
    api.push.mockClear();
    renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { ...FEED_ON, 'seo.browse': true } });
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: '数据分析师' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: '上海' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search jobs' }));
    expect(api.push).toHaveBeenCalledWith('/browse/数据分析师/上海');
  });

  // D3: counters and ticker are the real index or nothing.
  it('shows live counters only from the index, and an honest reduced layout when it is empty or small', async () => {
    api.getIndexStats.mockResolvedValue(cnStats(1_800, 240));
    const full = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: FEED_ON });
    await waitFor(() => expect(full.container.querySelector('[data-index-counters]')).not.toBeNull());
    const counters = within(full.container.querySelector('[data-index-counters]') as HTMLElement);
    expect(counters.getByText('1,800+ open roles')).toBeInTheDocument();
    expect(counters.getByText('240+ added in the last 7 days')).toBeInTheDocument();
    expect(counters.getByText(/Counted from the GoApply index, updated hourly/)).toBeInTheDocument();
    full.unmount();

    for (const value of [cnStats(null), cnStats(0), cnStats(320, 12)]) {
      api.getIndexStats.mockResolvedValue(value);
      const view = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: FEED_ON });
      await waitFor(() => expect(api.getIndexStats).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(view.container.querySelector('[data-index-counters]')).toBeNull();
      expect(view.container.querySelector('[data-seo-ticker]')).toBeNull();
      // The rest of the page is still there: search, cards, pricing, FAQ.
      expect(view.container.querySelector('form[role="search"]')).not.toBeNull();
      expect(view.container.querySelector('[data-pricing-summary]')).not.toBeNull();
      expect(view.container.textContent).not.toMatch(/\d[\d,]*\+? open roles|\+ added/);
      view.unmount();
      api.getIndexStats.mockClear();
    }
  });

  it('shows the ticker the route hands it between the counters and the quick search, and nothing in its place otherwise', async () => {
    const { JobTickerView } = await import('../../seo');
    const item = { id: 'cmcn0000000000000000001', idSlug: 'cmcn0000000000000000001', path: '/job/cmcn0000000000000000001', title: '数据分析师', companyName: '示例科技', location: '上海', firstSeenAt: '2026-10-10T11:30:00.000Z', postedAt: null };
    const withTicker = renderWithBrand(<GoApplyHome ticker={<JobTickerView items={[item]} now={AS_OF} />} />, { brand: 'goapply', flags: FEED_ON });
    const ticker = withTicker.container.querySelector('[data-seo-ticker]') as HTMLElement;
    expect(within(ticker).getByRole('link', { name: '数据分析师' })).toHaveAttribute('href', item.path);
    expect(ticker).toHaveTextContent('Found 30 min ago');
    const search = withTicker.container.querySelector('form[role="search"]') as HTMLElement;
    expect(ticker.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    withTicker.unmount();
    const without = renderWithBrand(<GoApplyHome ticker={null} />, { brand: 'goapply', flags: FEED_ON });
    expect(without.container.querySelector('[data-seo-ticker]')).toBeNull();
  });

  // The operator's AI off switch (R-04); the default on GoApply is on, with no domestic model.
  it('hides AI practice (pillar, hero clause, section, link) only while ai.text is off', () => {
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { ...FEED_ON, 'ai.text': false } });
    expect(screen.getByRole('heading', { level: 1, name: 'Fewer forms. No missed deadlines. Calmer interviews.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fewer forms' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Calmer interviews' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'AI interview practice' })).toBeNull();
    expect(container.querySelector('[data-cn-practice]')).toBeNull();
    expect(container.querySelector('a[href*="home%3Apractice"]')).toBeNull();
    expect(container.querySelector('a[href="/features/interview-practice"]')).toBeNull();
    expect(container.textContent).not.toMatch(/practice the AI interview|AI interview formats/i);
  });

  it('mentions answering out loud only while voice practice works', () => {
    const on = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { ...FEED_ON, 'ai.text': true, 'ai.interviewVoice': true } });
    expect(on.container.querySelector('[data-cn-practice-voice]')).toHaveTextContent('You can answer out loud to an AI interviewer, or type your answers.');
    expect(screen.getByRole('heading', { name: 'Calmer interviews' })).toBeInTheDocument();
    on.unmount();
    const off = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { ...FEED_ON, 'ai.text': true, 'ai.interviewVoice': false } });
    expect(off.container.querySelector('[data-cn-practice]')).not.toBeNull();
    expect(off.container.querySelector('[data-cn-practice-voice]')).toBeNull();
    expect(off.container.textContent).not.toMatch(/out loud/);
  });

  it('says paid passes cannot be bought only while /billing/plans says so', async () => {
    api.getPlans.mockImplementation(async () => ({ ...openPlans(), paymentsOpen: false }));
    renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: FEED_ON });
    await waitFor(() => expect(screen.getByText("Paid passes can't be bought yet.")).toBeInTheDocument());
    // Prices still show: the plans are listed, only the purchase is closed.
    expect(screen.getByText('¥39, paid once')).toBeInTheDocument();
    cleanup();
    api.getPlans.mockImplementation(async () => openPlans());
    renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: FEED_ON });
    await waitFor(() => expect(screen.getByText('¥39, paid once')).toBeInTheDocument());
    expect(screen.queryByText("Paid passes can't be bought yet.")).toBeNull();
    // While the answer is unknown (first paint, a failed read) nothing claims payments are closed.
    cleanup();
    api.getPlans.mockRejectedValue(new Error('down'));
    renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: FEED_ON });
    await waitFor(() => expect(api.getPlans).toHaveBeenCalled());
    expect(screen.queryByText("Paid passes can't be bought yet.")).toBeNull();
  });

  it('never says "Price not set yet": not before the plans answer, not when the request fails, not for a response without an amount (M-13)', async () => {
    // Before the answer (the server HTML and the first paint): the paid card is named, no price is claimed.
    let release: (v: unknown) => void = () => undefined;
    api.getPlans.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const first = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: FEED_ON });
    const pricing = () => first.container.querySelector('[data-pricing-summary]') as HTMLElement;
    await waitFor(() => expect(api.getPlans).toHaveBeenCalled());
    expect(pricing().textContent).not.toContain('Price not set yet');
    expect(pricing().querySelector('[data-price-unset]')).toBeNull();
    expect(within(pricing()).getByRole('heading', { name: 'Member 30-day pass' })).toBeInTheDocument();
    release(openPlans());
    await waitFor(() => expect(within(pricing()).getByText('¥39, paid once')).toBeInTheDocument());
    expect(pricing().textContent).not.toContain('Price not set yet');
    // A failed read says nothing about the price either.
    cleanup();
    api.getPlans.mockReset();
    api.getPlans.mockRejectedValue(new Error('down'));
    const failed = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: FEED_ON });
    await waitFor(() => expect(api.getPlans).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(failed.container.querySelector('[data-pricing-summary]')!.textContent).not.toContain('Price not set yet');
    // Every plan has a catalog amount since market wave M1, so no plan is "not set". A response that still
    // carries no amount (an older server) names the plan and prints no price line, as /pricing leaves it out.
    cleanup();
    api.getPlans.mockReset();
    api.getPlans.mockImplementation(async () => {
      const view = plansView('roboapply');
      return { ...view, plans: view.plans.map((p) => (p.kind === 'free' ? p : { ...p, amountMinor: null })) };
    });
    const unset = renderWithBrand(<RoboApplyHome />);
    await waitFor(() => expect(api.getPlans).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    const summary = unset.container.querySelector('[data-pricing-summary]') as HTMLElement;
    expect(summary.querySelector('[data-price-unset]')).toBeNull();
    expect(summary.textContent).not.toContain('Price not set yet');
    expect(summary.querySelector('a[href="/pricing"]')).not.toBeNull();
  });

  // D5: the free tools run on GoApply, so its chrome links them like RoboApply's, without asking the API.
  it('GoApply links the free tools from the header nav and the footer', async () => {
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: FEED_ON });
    expect(container.querySelector('[data-nav="tools"]')).toHaveAttribute('href', '/tools');
    expect(container.querySelector('[data-footer-link="tools"]')).toHaveAttribute('href', '/tools');
    await waitFor(() => expect(api.getIndexStats).toHaveBeenCalled());
    expect(api.getToolsConfig).not.toHaveBeenCalled();
  });

  it('the footer has no "cancel a subscription" entry (passes end by themselves); RoboApply keeps it', () => {
    const go = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: FEED_ON });
    expect(within(go.container.querySelector('[data-marketing-footer]') as HTMLElement).queryByTestId('cancel-footer-link')).toBeNull();
    go.unmount();
    api.getPlans.mockImplementation(async () => plansView('roboapply'));
    const ra = renderWithBrand(<RoboApplyHome />);
    expect(within(ra.container.querySelector('[data-marketing-footer]') as HTMLElement).getByTestId('cancel-footer-link')).toHaveAttribute('href', '/cancel');
  });

  it('the English GoApply page carries no Chinese text (footer tagline included)', () => {
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { ...FEED_ON, 'ai.text': true } });
    expect(screen.getByText('Fewer forms. No missed deadlines. Calmer interviews. You submit every application yourself.')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });

  it('shows no testimonials, user counts, competitor names or claims that it applies for the user', async () => {
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { ...FEED_ON, 'ai.text': true, agent: true, copilot: true } });
    await waitFor(() => expect(api.getPlans).toHaveBeenCalled());
    const text = container.textContent ?? '';
    for (const banned of [/jobright/i, /\busers\b/i, /testimonial/i, /★/, /auto-?appl/i, /apply for you/i, /submits? (it |them )?for you/i, /一键投递|自动投递/]) {
      expect(text).not.toMatch(banned);
    }
    expect(text).toMatch(/You submit every application yourself/);
  });

  it('hides the campus preview while jobs.campusCalendar is off', () => {
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: FEED_ON });
    expect(container.querySelector('[data-campus-preview]')).toBeNull();
    expect(api.listPublicCampusEvents).not.toHaveBeenCalled();
  });

  it('an empty campus calendar says it is being put together (no programme is invented)', async () => {
    api.listPublicCampusEvents.mockResolvedValue({ items: [] });
    const { container } = renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { ...FEED_ON, 'jobs.campusCalendar': true } });
    const preview = container.querySelector('[data-campus-preview]') as HTMLElement;
    await waitFor(() => expect(within(preview).getByText(/The calendar is being put together/)).toBeInTheDocument());
    expect(preview.querySelector('li')).toBeNull();
    expect(within(preview).getByRole('link', { name: 'Open the campus calendar' })).toHaveAttribute('href', '/campus');
  });

  it('previews open programmes with closing date (a Beijing-time date), source and last check when on', async () => {
    api.listPublicCampusEvents.mockResolvedValue({
      items: [
        {
          id: 'ev1',
          companyName: 'Example Bank',
          title: '2027 campus programme',
          graduationClass: '2027',
          kind: 'campus',
          applyOpensAt: null,
          // 23:59:59 on 31 Oct in Beijing. In a zone west of it this instant is still 31 Oct; it must never read 1 Nov or 30 Oct.
          applyClosesAt: '2026-10-31T15:59:59.000Z',
          stages: [],
          cities: [],
          roles: [],
          officialUrl: 'https://careers.example.cn/campus',
          sourceName: null,
          // 01:00 on 9 Oct in Beijing, which is still 8 Oct in UTC.
          verifiedAt: '2026-10-08T17:00:00.000Z',
          needsReverify: false,
          subscribed: false,
        },
      ],
    });
    renderWithBrand(<GoApplyHome />, { brand: 'goapply', flags: { ...FEED_ON, 'jobs.campusCalendar': true } });
    await waitFor(() => expect(screen.getByText(/Example Bank · 2027 campus programme/)).toBeInTheDocument());
    expect(screen.getByText('Applications close Oct 31, 2026')).toBeInTheDocument();
    expect(screen.getByText('Source: careers.example.cn · checked Oct 9, 2026')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the campus calendar' })).toHaveAttribute('href', '/campus');
  });
});
