// WP-56 views: browse page (every number from stats with its source line,
// "—" for an unpublishable median, sponsorship method, noindex note), job
// page (pay only as disclosed, posted date honesty, D1 actions per session),
// ticker wording "Found {n} min ago · posted {date}".

import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { mockAuthState, buildAuthValue } from '../../../../__tests__/utils/mockAuth';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';

vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

// Stand-ins that show what each mount is given (the share card renders nothing by design).
vi.mock('../../notify-cn', () => ({
  WechatShareCard: (p: { title: string; description?: string | null; path?: string | null }) => (
    <span data-testid="wechat-share" data-title={p.title} data-description={p.description ?? ''} data-path={p.path ?? ''} />
  ),
}));
vi.mock('../../visitor', () => ({
  VisitorAssistant: (p: { from: string; pageContext: Record<string, string> }) => <span data-testid="visitor-assistant" data-from={p.from} data-context={JSON.stringify(p.pageContext)} />,
}));

import type { ReactElement } from 'react';

import { capsFor } from '../../../../__tests__/shell/helpers';
import { BrandProvider, clientBrandFor, type BrandId } from '../../../../lib/brand';
import type { ResolvedFlags } from '../../../../server/src/platform/flags';
import { BrowsePage } from '../BrowsePage';
import { BrowseHub, BrowseUnknown } from '../BrowseHub';
import { JobPage } from '../JobPage';
import { JobTickerView, foundAgo } from '../JobTickerView';
import { job, n, page, ROLE, TAIPEI, TICKER } from './fixtures';

describe('BrowsePage', () => {
  it('renders title, stats with their source and the job list', () => {
    renderWithProviders(<BrowsePage data={page()} signupHref="/signup?from=browse" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Backend engineer jobs in Taipei' })).toBeInTheDocument();
    expect(screen.getByText(/26 open jobs on this list\./)).toBeInTheDocument();
    expect(screen.getByText(/4 were added in the last 7 days\./)).toBeInTheDocument();
    expect(screen.getByText('22 of 26')).toBeInTheDocument();
    // The median ships with N.
    expect(screen.getByText(/from 22 postings/)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-source-note]').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Backend Engineer' })).toHaveAttribute('href', '/job/cmjob1-backend-engineer-acme');
    expect(screen.getByRole('link', { name: 'Create a free account' })).toHaveAttribute('href', '/signup?from=browse');
    expect(document.querySelector('[data-indexable="true"]')).not.toBeNull();
  });

  it('an unpublishable median renders "—", never 0; pay not listed is named', () => {
    const data = page({ stats: { ...page().stats, medianPay: null }, jobs: [job({ pay: null })] });
    renderWithProviders(<BrowsePage data={data} signupHref="/signup" />);
    const median = screen.getByText('Median listed yearly pay').closest('div')!;
    expect(within(median).getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Pay not listed')).toBeInTheDocument();
    expect(screen.queryByText(/median yearly pay listed/i)).toBeNull();
  });

  it('sponsorship lists state the method and quote the posting', () => {
    const data = page({
      type: 'sponsorship_role',
      city: null,
      sponsorCountry: 'US',
      method: 'posting_quote',
      jobs: [job({ sponsorshipQuote: 'We sponsor H-1B visas.' })],
    });
    renderWithProviders(<BrowsePage data={data} signupHref="/signup" />);
    expect(screen.getByText(/a job is included only when its posting says the employer sponsors visas/)).toBeInTheDocument();
    expect(screen.getByText('From the posting: “We sponsor H-1B visas.”')).toBeInTheDocument();
  });

  it('below the floor says the list is short and links upward; empty lists say so', () => {
    renderWithProviders(<BrowsePage data={page({ indexable: false, jobs: [], stats: { ...page().stats, jobCount: { ...page().stats.jobCount, value: 3 } } })} signupHref="/signup" />);
    expect(screen.getByText(/This list is short/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'All Backend engineer jobs' })[0]).toHaveAttribute('href', '/browse/backend-engineer');
    expect(screen.getByText('No jobs on this list right now')).toBeInTheDocument();
  });

  it('shows role names in Chinese on zh', () => {
    renderWithProviders(<BrowsePage data={page()} signupHref="/signup" />, { intlLocale: 'zh' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('后端工程师');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('台北');
  });

  it('zh-TW never mixes the Simplified role name with Traditional city names', () => {
    renderWithProviders(<BrowsePage data={page()} signupHref="/signup" />, { intlLocale: 'zh-TW' });
    const h1 = screen.getByRole('heading', { level: 1 }).textContent ?? '';
    expect(h1).toContain('臺北');
    expect(h1).not.toContain('后端工程师');
  });

  it('narrower-list chip counts are index counts with a source line', () => {
    const children = [{ kind: 'city' as const, path: '/browse/backend-engineer/taipei', role: ROLE, city: TAIPEI, jobCount: n(12) }];
    renderWithProviders(<BrowsePage data={page({ type: 'role', city: null, children })} signupHref="/signup" />);
    const section = screen.getByRole('heading', { level: 2, name: 'Narrow this list' }).closest('section')!;
    expect(within(section).getByText('12 jobs')).toBeInTheDocument();
    expect(section.querySelector('[data-source-note]')).not.toBeNull();
  });

  it('hub and unknown-role pages list real lists with counts and their source', () => {
    const links = [{ kind: 'role' as const, path: '/browse/backend-engineer', role: ROLE, jobCount: n(30) }];
    renderWithProviders(<BrowseHub links={links} />);
    expect(screen.getByRole('link', { name: /Backend engineer jobs/ })).toHaveAttribute('href', '/browse/backend-engineer');
    expect(screen.getByText('30 jobs')).toBeInTheDocument();
    expect(document.querySelector('[data-source-note]')).not.toBeNull();
  });

  it('unknown role page', () => {
    renderWithProviders(<BrowseUnknown query={{ kind: 'role', role: 'basket weaver', city: null }} links={[]} />);
    expect(screen.getByRole('heading', { name: 'We don’t have a list for “basket weaver” yet'.replace('’', "'") })).toBeInTheDocument();
    expect(screen.getByText('No job lists yet. Check back soon.')).toBeInTheDocument();
  });

  it('unknown city page names the city, not a role', () => {
    renderWithProviders(<BrowseUnknown query={{ kind: 'city', role: 'backend engineer', city: 'atlantis' }} links={[]} />);
    expect(screen.getByRole('heading', { name: "We don't have a list of backend engineer jobs in “atlantis” yet" })).toBeInTheDocument();
    expect(screen.queryByText(/list for “atlantis”/)).toBeNull();
  });
});

describe('JobPage', () => {
  it('signed out: Apply on company site opens the employer page; the page says the user applies there', () => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    renderWithProviders(<JobPage job={job()} signupHref="/signup?from=job&job=cmjob1" />);
    const apply = screen.getByRole('link', { name: 'Apply on company site' });
    expect(apply).toHaveAttribute('href', 'https://jobs.acme.example/apply/1');
    expect(apply).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'See how it fits your resume' })).toHaveAttribute('href', '/signup?from=job&job=cmjob1');
    expect(screen.getByText(/You apply on the employer's site/)).toBeInTheDocument();
    expect(screen.getByText(/1,200,000 – .*1,600,000 a year/)).toBeInTheDocument();
    expect(screen.getByText('Build services.')).toBeInTheDocument();
    expect(screen.getByText('Run them well.')).toBeInTheDocument();
  });

  it('signed in: opens the job in the app (where applying is tracked)', () => {
    mockAuthState.value = buildAuthValue();
    renderWithProviders(<JobPage job={job()} signupHref="/signup" />);
    expect(screen.getByRole('link', { name: 'Open in RoboApply' })).toHaveAttribute('href', '/jobs/cmjob1');
    expect(screen.queryByRole('link', { name: 'Apply on company site' })).toBeNull();
  });

  it('honest unknowns: pay not listed, estimated posted date labelled, no closing date invented', () => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    renderWithProviders(<JobPage job={job({ pay: null, postedAt: null, expiresAt: null, workModel: null })} signupHref="/signup" />);
    const pay = screen.getByText('Pay').closest('div')!;
    expect(within(pay).getByText('Not listed')).toBeInTheDocument();
    expect(screen.getByText(/Not listed \(first found/)).toBeInTheDocument();
    expect(screen.queryByText('Closes')).toBeNull();
  });

  it('pay stated only as text (e.g. 面議) is shown as stated', () => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    renderWithProviders(<JobPage job={job({ pay: null, salaryText: '面議' })} signupHref="/signup" />);
    expect(screen.getByText('面議')).toBeInTheDocument();
  });
});

// INT-06 (wave5 WP-93 #24 and #30): the WeChat share card and the visitor assistant on the public job page.
function renderOn(brand: BrandId, ui: ReactElement, flags: Partial<ResolvedFlags> = {}) {
  return renderWithProviders(
    <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={capsFor(brand, flags)}>
      {ui}
    </BrandProvider>,
  );
}

describe('JobPage — WeChat share card (GoApply only)', () => {
  it('GoApply: "{title} · {company}", the place and the pay as listed, linking this public page (not the signed-in app path)', () => {
    mockAuthState.value = buildAuthValue();
    renderOn('goapply', <JobPage job={job()} signupHref="/signup" />);
    const card = screen.getByTestId('wechat-share');
    expect(card).toHaveAttribute('data-title', 'Backend Engineer · Acme');
    expect(card.getAttribute('data-description')).toMatch(/^Taipei, Taiwan · .*1,200,000 – .*1,600,000 a year$/);
    // Anyone who opens the shared card can read the page: /jobs/<id> would send them to sign-in.
    expect(card).toHaveAttribute('data-path', '/job/cmjob1-backend-engineer-acme');
  });

  it('pay stated only in words is shared as stated', () => {
    mockAuthState.value = buildAuthValue();
    renderOn('goapply', <JobPage job={job({ pay: null, salaryText: '面議' })} signupHref="/signup" />);
    expect(screen.getByTestId('wechat-share')).toHaveAttribute('data-description', 'Taipei, Taiwan · 面議');
  });

  it('no listed pay (or a zero figure): the place alone, never 0; the page itself says "Not listed"', () => {
    mockAuthState.value = buildAuthValue();
    for (const pay of [null, { min: 0, max: 0, currency: 'TWD', period: 'year' }, { min: null, max: null, currency: 'TWD', period: 'year' }]) {
      const view = renderOn('goapply', <JobPage job={job({ pay: pay as never, salaryText: null })} signupHref="/signup" />);
      const card = screen.getByTestId('wechat-share');
      expect(card).toHaveAttribute('data-description', 'Taipei, Taiwan');
      expect(card.getAttribute('data-description')).not.toMatch(/\d/);
      expect(within(screen.getByText('Pay').closest('div')!).getByText('Not listed')).toBeInTheDocument();
      view.unmount();
    }
  });

  it('neither place nor pay: no description (the card uses its own default line)', () => {
    mockAuthState.value = buildAuthValue();
    renderOn('goapply', <JobPage job={job({ location: null, pay: null, salaryText: '  ' })} signupHref="/signup" />);
    expect(screen.getByTestId('wechat-share')).toHaveAttribute('data-description', '');
  });

  it('RoboApply: no share card', () => {
    mockAuthState.value = buildAuthValue();
    renderOn('roboapply', <JobPage job={job()} signupHref="/signup" />);
    expect(screen.queryByTestId('wechat-share')).toBeNull();
  });
});

describe('JobPage — GoApply display lines (last checked, GoHire licence)', () => {
  const LICENCE = { holder: '示例人力资源有限公司', number: '(沪)人服证字[2026]第0100001号' };

  it('browse cards: GoApply adds the last-checked date under the source; RoboApply cards are unchanged', () => {
    const cn = renderOn('goapply', <BrowsePage data={page()} signupHref="/signup" />);
    const card = cn.container.querySelector('[data-job-id="cmjob1"]') as HTMLElement;
    expect(within(card).getByText('Source: RoboHire')).toBeInTheDocument();
    expect(card.querySelector('[data-last-checked]')?.textContent).toMatch(/^Last checked .*2026/);
    cn.unmount();
    const unknown = renderOn('goapply', <BrowsePage data={page({ jobs: [job({ lastVerifiedAt: null })] })} signupHref="/signup" />);
    expect(unknown.container.querySelector('[data-last-checked]')).toBeNull();
    unknown.unmount();
    const ra = renderOn('roboapply', <BrowsePage data={page()} signupHref="/signup" />);
    expect(ra.container.querySelector('[data-last-checked]')).toBeNull();
  });

  it('GoApply: the source block shows the source, the original link and the date we last checked the posting', () => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    renderOn('goapply', <JobPage job={job({ sourceName: '示例科技招聘官网', lastVerifiedAt: '2026-10-09T00:00:00.000Z' })} signupHref="/signup" />);
    const source = screen.getByText('Source').closest('div')!;
    expect(within(source).getByText(/示例科技招聘官网/)).toBeInTheDocument();
    expect(within(source).getByRole('link', { name: 'View the original posting' })).toHaveAttribute('href', 'https://jobs.acme.example/1');
    expect(within(source).getByText(/^Last checked .*2026/)).toBeInTheDocument();
    // No licence was sent: none is printed.
    expect(source.querySelector('[data-licence]')).toBeNull();
  });

  it('GoApply: a GoHire bank posting prints the licence the API sent, holder and number as given', () => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    renderOn('goapply', <JobPage job={job({ sourceName: 'GoHire', licence: LICENCE })} signupHref="/signup" />);
    const line = screen.getByText('Source').closest('div')!.querySelector('[data-licence]')!;
    expect(line.textContent).toBe(`${LICENCE.holder}, HR service licence ${LICENCE.number}`);
  });

  it('an unknown date or an API response without the fields prints neither line', () => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    const older = { ...job() } as Record<string, unknown>;
    delete older.lastVerifiedAt;
    delete older.licence;
    for (const j of [job({ lastVerifiedAt: null }), older as never]) {
      const view = renderOn('goapply', <JobPage job={j} signupHref="/signup" />);
      const source = screen.getByText('Source').closest('div')!;
      expect(source.querySelector('[data-last-checked]')).toBeNull();
      expect(source.querySelector('[data-licence]')).toBeNull();
      view.unmount();
    }
  });

  it('RoboApply: the page is unchanged (neither line, even when the API sends the date)', () => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    renderOn('roboapply', <JobPage job={job({ licence: LICENCE })} signupHref="/signup" />);
    const source = screen.getByText('Source').closest('div')!;
    expect(source.querySelector('[data-last-checked]')).toBeNull();
    expect(source.querySelector('[data-licence]')).toBeNull();
    expect(screen.queryByText(/Last checked/)).toBeNull();
  });
});

describe('JobPage — visitor assistant (flag `visitorAssistant`)', () => {
  it('RoboApply, signed out, flag on: mounted with the job as its page context', () => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    renderOn('roboapply', <JobPage job={job()} signupHref="/signup" />, { visitorAssistant: true });
    const el = screen.getByTestId('visitor-assistant');
    expect(el).toHaveAttribute('data-from', 'job');
    expect(JSON.parse(el.getAttribute('data-context')!)).toEqual({ path: '/job/cmjob1-backend-engineer-acme', role: 'Backend Engineer', city: 'Taipei', country: 'TW' });
  });

  it('GoApply, signed out, flag on: mounted too (the widget itself asks for the AI consent tick)', () => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    renderOn('goapply', <JobPage job={job()} signupHref="/signup" />, { visitorAssistant: true });
    const el = screen.getByTestId('visitor-assistant');
    expect(el).toHaveAttribute('data-from', 'job');
    expect(JSON.parse(el.getAttribute('data-context')!)).toMatchObject({ path: '/job/cmjob1-backend-engineer-acme', role: 'Backend Engineer' });
  });

  it('absent with the flag off (the default on both brands) and for a signed-in user', () => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    for (const brand of ['roboapply', 'goapply'] as const) {
      const off = renderOn(brand, <JobPage job={job()} signupHref="/signup" />, { visitorAssistant: false });
      expect(screen.queryByTestId('visitor-assistant')).toBeNull();
      off.unmount();
    }
    mockAuthState.value = buildAuthValue();
    for (const brand of ['roboapply', 'goapply'] as const) {
      const signedIn = renderOn(brand, <JobPage job={job()} signupHref="/signup" />, { visitorAssistant: true });
      expect(screen.queryByTestId('visitor-assistant')).toBeNull();
      signedIn.unmount();
    }
  });
});

describe('JobTickerView', () => {
  it('"Found {n} min ago · posted {date}", posted omitted when estimated', () => {
    renderWithProviders(<JobTickerView items={TICKER} now="2026-10-10T12:00:00.000Z" />);
    const first = screen.getByRole('link', { name: 'Data Analyst' }).closest('li')!;
    expect(first.textContent).toMatch(/Found 5 min ago · posted Oct 9, 2026/);
    const second = screen.getByRole('link', { name: 'Designer' }).closest('li')!;
    expect(second.textContent).toMatch(/Found 3 hours ago/);
    expect(second.textContent).not.toMatch(/posted/);
  });

  it('renders nothing without items; foundAgo buckets', () => {
    const { container } = renderWithProviders(<JobTickerView items={[]} now="2026-10-10T12:00:00.000Z" />);
    expect(container.querySelector('[data-seo-ticker]')).toBeNull();
    const now = new Date('2026-10-10T12:00:00.000Z');
    expect(foundAgo('2026-10-10T11:59:00.000Z', now)).toEqual({ key: 'foundMinutes', n: 1 });
    expect(foundAgo('2026-10-08T12:00:00.000Z', now)).toEqual({ key: 'foundDays', n: 2 });
    expect(foundAgo('2026-10-11T12:00:00.000Z', now)).toEqual({ key: 'foundMinutes', n: 0 });
  });
});
