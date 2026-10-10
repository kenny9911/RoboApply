// WP-33 — Explore (F-FEED-13/17), the report sheet (F-FEED-12), the skills
// check (F-FEED-09) and the Jobs nav badge (PRODUCT §3.3).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { __setPopupGate } from '../../../lib/ui/popupGate';
import { __toastStore } from '../../v3/primitives/Toast';
import { BrandProvider, clientBrandFor } from '../../../lib/brand';
import { capsFor } from '../../../__tests__/shell/helpers';
import { useJobsBadge } from '../../../hooks/feed/useJobsBadge';
import { searchKeys } from '../../../hooks/search';
import { Explore } from './Explore';
import { JobsWorkspace } from './JobsWorkspace';
import { SkillsCheck, withConfirmedSkill } from './SkillsCheck';
import { reportReasonsFor } from './ReportSheet';
import { ratingFixes } from './RatingCard';
import { sortsFor } from './SortMenu';
import {
  EMPTY_UI_STATE,
  feedItem,
  fail,
  installFetch,
  installPopupGate,
  ok,
  page,
  profileList,
  renderFeed,
  searchProfile,
  type Route,
} from './feed.testkit';

const FEED = '/api/v1/roboapply/feed';
const PROFILES = '/api/v1/roboapply/search-profiles';
const UI_STATE = '/api/v1/roboapply/ui-state';


const nav = vi.hoisted(() => ({ search: '', push: [] as string[], replace: [] as string[] }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/jobs/explore',
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({
    push: (href: string) => nav.push.push(href),
    replace: (href: string) => nav.replace.push(href),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({}),
}));

vi.mock('../job', () => ({ JobDetailPanel: () => null }));

const CATEGORIES = {
  asOf: '2026-10-10T00:00:00.000Z',
  categories: [
    { taxonomyId: 'software_engineering', label: 'Software engineering', count: 1240 },
    { taxonomyId: 'data', label: 'Data and analytics', count: 0 },
  ],
};

function routes(over: Record<string, Route> = {}): Record<string, Route> {
  return {
    [`GET ${PROFILES}`]: () => ok(profileList([searchProfile({ filters: { workModels: ['hybrid'] } })])),
    [`GET ${UI_STATE}`]: () => ok(EMPTY_UI_STATE),
    [`PATCH ${UI_STATE}`]: () => ok(EMPTY_UI_STATE),
    [`GET ${FEED}/explore`]: () => ok(CATEGORIES),
    [`POST ${FEED}/impressions`]: () => ok(null),
    ...over,
  };
}

beforeEach(() => {
  nav.search = '';
  nav.push = [];
  nav.replace = [];
  installPopupGate();
  __toastStore.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setPopupGate(null);
});

describe('Explore', () => {
  it('lists kinds of work with live counts and their source, and opens a category', async () => {
    installFetch(routes());
    renderFeed(<Explore />);
    expect(screen.getByRole('tab', { name: 'Explore' })).toHaveAttribute('aria-selected', 'true');
    const button = await screen.findByRole('button', { name: /Software engineering/ });
    expect(button).toHaveTextContent('1,240 jobs');
    // Zero is shown only after the count loaded, in words.
    expect(screen.getByRole('button', { name: /Data and analytics/ })).toHaveTextContent('No open jobs');
    expect(document.querySelector('[data-source-note]')).not.toBeNull();
    fireEvent.click(button);
    expect(nav.replace).toEqual(['/jobs/explore?category=software_engineering']);
  });

  it('a category lists its jobs as a query-only override', async () => {
    nav.search = 'category=software_engineering';
    const net = installFetch(routes({ [`POST ${FEED}/query`]: () => ok(page([feedItem(1), feedItem(2)])) }));
    renderFeed(<Explore />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
    expect(screen.getByRole('heading', { name: 'Jobs in Software engineering' })).toBeInTheDocument();
    // A browse of the category (the same set the tile counts): no saved search underneath.
    expect(net.to('POST', `${FEED}/query`)[0].body).toEqual({ sort: 'recommended', fitTier: 'all', overrides: { taxonomyIds: ['software_engineering'] } });
    expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(0);
  });

  it('a sentence becomes a filter change the user confirms before it is saved', async () => {
    const net = installFetch(
      routes({
        [`POST ${FEED}/nl-query`]: () =>
          ok({
            diff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [{ op: 'set', path: 'workModels', value: ['remote'] }, { op: 'add', path: 'skills', value: 'SQL' }], countAfter: null },
            explanation: 'Remote data jobs.',
          }),
        [`PATCH ${PROFILES}/sp_main`]: () => ok(searchProfile({ version: 4 })),
      }),
    );
    renderFeed(<Explore />);
    fireEvent.change(screen.getByLabelText('Describe the job you want'), { target: { value: 'remote data jobs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn into filters' }));
    const proposal = await screen.findByTestId('nl-proposal');
    expect(within(proposal).getByText('Remote data jobs.')).toBeInTheDocument();
    expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(0);
    fireEvent.click(within(proposal).getByRole('button', { name: 'Use these filters' }));
    await waitFor(() => expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${PROFILES}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { workModels: ['remote'], skills: ['SQL'] } });
    await waitFor(() => expect(nav.push).toEqual(['/jobs']));
  });

  it('says plainly when the sentence search is unavailable or changes nothing', async () => {
    installFetch(routes({ [`POST ${FEED}/nl-query`]: () => fail(503, 'ai_unavailable') }));
    const { unmount } = renderFeed(<Explore />);
    fireEvent.change(screen.getByLabelText('Describe the job you want'), { target: { value: 'remote data jobs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn into filters' }));
    expect(await screen.findByText(/isn't available right now/)).toBeInTheDocument();
    unmount();

    installFetch(routes({ [`POST ${FEED}/nl-query`]: () => ok({ diff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [], countAfter: null }, explanation: '' }) }));
    renderFeed(<Explore />);
    fireEvent.change(screen.getByLabelText('Describe the job you want'), { target: { value: 'anything' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn into filters' }));
    expect(await screen.findByText(/doesn't change your current search/)).toBeInTheDocument();
  });

  it('a sentence whose changes map to nothing (unknown paths, values already set) is "no change", with no proposal', async () => {
    installFetch(
      routes({
        [`POST ${FEED}/nl-query`]: () =>
          ok({
            diff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [{ op: 'set', path: 'geo/radius', value: 50 }, { op: 'add', path: 'workModels', value: 'hybrid' }], countAfter: null },
            explanation: 'Hybrid jobs.',
          }),
      }),
    );
    const { client } = renderFeed(<Explore />);
    // The saved search (already hybrid) has loaded.
    await waitFor(() => expect(client.getQueryState(searchKeys.profiles())?.status).toBe('success'));
    fireEvent.change(screen.getByLabelText('Describe the job you want'), { target: { value: 'hybrid jobs nearby' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn into filters' }));
    expect(await screen.findByText(/doesn't change your current search/)).toBeInTheDocument();
    expect(screen.queryByTestId('nl-proposal')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use these filters' })).toBeNull();
  });

  it('GoApply labels the explanation as AI generated', async () => {
    installFetch(
      routes({
        [`POST ${FEED}/nl-query`]: () => ok({ diff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [{ op: 'set', path: 'q', value: '数据' }], countAfter: null }, explanation: '数据岗位' }),
      }),
    );
    renderFeed(<Explore />, { brand: 'goapply' });
    fireEvent.change(screen.getByLabelText('Describe the job you want'), { target: { value: '北京数据岗位' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn into filters' }));
    const proposal = await screen.findByTestId('nl-proposal');
    expect(proposal.querySelector('[data-ai-label]')).not.toBeNull();
  });

  it('no feed: Explore offers only added jobs and asks nothing', async () => {
    const net = installFetch(routes());
    renderFeed(<Explore />, { brand: 'goapply', flags: { 'jobs.feed': false } });
    expect(screen.getByRole('link', { name: 'Add a job' })).toBeInTheDocument();
    await act(async () => undefined);
    expect(net.to('GET', `${FEED}/explore`)).toHaveLength(0);
  });
});

describe('Report a problem', () => {
  it('GoApply adds the training-loan, pay-to-train and fee reasons', () => {
    expect(reportReasonsFor('intl')).not.toContain('training_loan');
    expect(reportReasonsFor('cn')).toEqual(expect.arrayContaining(['training_loan', 'pay_to_work', 'fee_required']));
    expect(reportReasonsFor('cn').at(-1)).toBe('other');
  });

  it('a scam report hides the job and offers to hide agency posts (confirmed, not silent)', async () => {
    const net = installFetch(
      routes({
        [`POST ${FEED}/query`]: () => ok(page([feedItem(1), feedItem(2)])),
        'POST /api/v1/roboapply/feed/jobs/job_1/report': () => ok(null),
        [`PATCH ${PROFILES}/sp_main`]: () => ok(searchProfile({ version: 4, filters: { excludeAgencies: true } })),
      }),
    );
    renderFeed(<JobsWorkspace />);
    const card = (await screen.findAllByTestId('job-card'))[0];
    fireEvent.click(within(card).getByRole('button', { name: 'More options' }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Report a problem' }));
    const sheet = await screen.findByTestId('sheet');
    fireEvent.click(within(sheet).getByLabelText('Scam or fake'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send report' }));
    expect(await within(screen.getByTestId('sheet')).findByText(/Agency posts are listed by staffing firms/)).toBeInTheDocument();
    expect(net.to('POST', '/api/v1/roboapply/feed/jobs/job_1/report')[0].body).toEqual({ reason: 'scam' });
    expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId('sheet')).getByRole('button', { name: 'Hide agency posts' }));
    await waitFor(() => expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${PROFILES}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { excludeAgencies: true } });
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(1));
  });
});

describe('Skills check', () => {
  const data = { skills: [{ skill: 'Kubernetes', askedIn: 64, outOf: 212 }, { skill: 'Terraform', askedIn: 30, outOf: 212 }] };

  it('shows "asked in X of Y"; Yes adds a confirmed profile skill (PUT /profile/skills)', async () => {
    const net = installFetch(
      routes({
        'GET /api/v1/roboapply/profile': () => ok({ skills: [{ name: 'Go', confirmed: false }] }),
        'PUT /api/v1/roboapply/profile/skills': () => ok({ skills: [] }),
      }),
    );
    const onClose = vi.fn();
    renderFeed(<SkillsCheck data={data} onClose={onClose} />);
    expect(screen.getByText('Asked in 64 of 212 posts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I have Kubernetes' }));
    await waitFor(() => expect(net.to('PUT', '/api/v1/roboapply/profile/skills')).toHaveLength(1));
    expect(net.to('PUT', '/api/v1/roboapply/profile/skills')[0].body).toEqual({
      skills: [{ name: 'Go', confirmed: false }, { name: 'Kubernetes', confirmed: true }],
    });
    await waitFor(() => expect(screen.queryByText('Asked in 64 of 212 posts')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('No shows the filter change first, then adds the skill to excludedSkills', async () => {
    const net = installFetch(routes({ [`PATCH ${PROFILES}/sp_main`]: () => ok(searchProfile({ version: 4 })) }));
    renderFeed(<SkillsCheck data={{ skills: [data.skills[0]] }} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: "I don't have Kubernetes" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: "I don't have Kubernetes" }));
    expect(await screen.findByText('Hide jobs that ask for Kubernetes?')).toBeInTheDocument();
    expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Hide these jobs' }));
    await waitFor(() => expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${PROFILES}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { excludedSkills: ['Kubernetes'] } });
  });

  it('confirms an existing skill instead of duplicating it', () => {
    expect(withConfirmedSkill([{ name: 'kubernetes', confirmed: false }], 'Kubernetes')).toEqual([{ name: 'kubernetes', confirmed: true }]);
  });

  it('shows in the feed only after today\'s rating, through the popup gate', async () => {
    const rated = { ...EMPTY_UI_STATE, state: { ...EMPTY_UI_STATE.state, dismissals: { 'feed.rating': { count: 1, at: new Date().toISOString() } } } };
    installFetch(
      routes({
        [`GET ${UI_STATE}`]: () => ok(rated),
        [`POST ${FEED}/query`]: () => ok(page([feedItem(1)])),
        [`GET ${FEED}/skills-check`]: () => ok(data),
      }),
    );
    renderFeed(<JobsWorkspace />);
    expect(await screen.findByTestId('skills-check')).toBeInTheDocument();
  });
});

describe('small rules', () => {
  it('rating reasons map to filter changes; jobs_old only when the window is wider than a week', () => {
    expect(ratingFixes(['jobs_old'], {})).toEqual([{ reason: 'jobs_old', kind: 'patch', patch: { postedWithinDays: 7 } }]);
    expect(ratingFixes(['jobs_old'], { postedWithinDays: 3 })).toEqual([]);
    expect(ratingFixes(['wrong_level', 'unwanted_companies', 'missing_skills'], {}).map((f) => f.kind === 'drawer' && f.section)).toEqual(['basic', 'companies', 'interests']);
  });

  it('the deadline sort is GoApply only', () => {
    expect(sortsFor('intl')).not.toContain('deadline');
    expect(sortsFor('cn')).toContain('deadline');
  });
});

describe('useJobsBadge', () => {
  function wrapper(flags: Record<string, boolean>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return function W({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={client}>
          <BrandProvider brand={clientBrandFor('roboapply')} initialCapabilities={capsFor('roboapply', flags)}>
            {children}
          </BrandProvider>
        </QueryClientProvider>
      );
    };
  }

  it('renders the real new-count and nothing for zero or with the feed off', async () => {
    let count = 6;
    const net = installFetch({ [`GET ${FEED}/new-count`]: () => ok({ count, since: '2026-10-09T00:00:00.000Z' }) });
    const on = renderHook(() => useJobsBadge(), { wrapper: wrapper({ 'jobs.feed': true }) });
    await waitFor(() => expect(on.result.current).toEqual({ kind: 'count', count: 6 }));
    count = 0;
    const zero = renderHook(() => useJobsBadge(), { wrapper: wrapper({ 'jobs.feed': true }) });
    await waitFor(() => expect(net.to('GET', `${FEED}/new-count`)).toHaveLength(2));
    expect(zero.result.current).toBeNull();
    const off = renderHook(() => useJobsBadge(), { wrapper: wrapper({ 'jobs.feed': false }) });
    expect(off.result.current).toBeNull();
    expect(net.to('GET', `${FEED}/new-count`)).toHaveLength(2);
  });
});
