// WP-33 — Explore (F-FEED-13/17), the report sheet (F-FEED-12), the skills
// check (F-FEED-09) and the Jobs nav badge (PRODUCT §3.3).
// MKT-4F (SM-9): what a plain-language search left over is said in two lines
// ("Ranked by closeness to …", "Not checked: …"), and applying the proposal
// hands the ranking terms to the /jobs list.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { __setPopupGate } from '../../../lib/ui/popupGate';
import { __toastStore } from '../../v3/primitives/Toast';
import { BrandProvider, clientBrandFor } from '../../../lib/brand';
import { capsFor } from '../../../__tests__/shell/helpers';
import { useJobsBadge } from '../../../hooks/feed/useJobsBadge';
import { __listRelevanceStore } from '../../../hooks/feed/useExplore';
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
  __listRelevanceStore.reset();
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
            explanation: '',
            unmatched: [],
            rankedBy: [],
          }),
        [`PATCH ${PROFILES}/sp_main`]: () => ok(searchProfile({ version: 4 })),
      }),
    );
    renderFeed(<Explore />);
    fireEvent.change(screen.getByLabelText('Describe the job you want'), { target: { value: 'remote data jobs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn into filters' }));
    const proposal = await screen.findByTestId('nl-proposal');
    // Every part of the sentence became a filter: there is nothing to rank by and nothing left unchecked.
    expect(within(proposal).queryByTestId('nl-ranked-by')).toBeNull();
    expect(within(proposal).queryByTestId('nl-not-checked')).toBeNull();
    expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(0);
    fireEvent.click(within(proposal).getByRole('button', { name: 'Use these filters' }));
    await waitFor(() => expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${PROFILES}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { workModels: ['remote'], skills: ['SQL'] } });
    await waitFor(() => expect(nav.push).toEqual(['/jobs']));
    expect(__listRelevanceStore.get()).toBeNull();
  });

  it('"backend jobs at climate startups using Rust": says what the list is ranked by and what was not checked, and hands the terms to the list on Apply', async () => {
    const net = installFetch(
      routes({
        [`POST ${FEED}/nl-query`]: () =>
          ok({
            diff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [{ op: 'set', path: 'titles', value: ['Backend Engineer'] }], countAfter: 41 },
            explanation: 'Ranked by closeness to: climate startups, Rust. Not checked as requirements: salary above 150k.',
            unmatched: ['climate startups', 'using Rust', 'salary above 150k'],
            rankedBy: ['climate startups', 'Rust'],
          }),
        [`PATCH ${PROFILES}/sp_main`]: () => ok(searchProfile({ version: 4 })),
      }),
    );
    renderFeed(<Explore />);
    fireEvent.change(screen.getByLabelText('Describe the job you want'), { target: { value: 'backend jobs at climate startups using Rust, salary above 150k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn into filters' }));
    const proposal = await screen.findByTestId('nl-proposal');
    // Two lines, in the person's own words: ranking, never a checked requirement.
    expect(within(proposal).getByTestId('nl-ranked-by')).toHaveTextContent('Ranked by closeness to: climate startups, Rust. These were not checked as requirements.');
    expect(within(proposal).getByTestId('nl-not-checked')).toHaveTextContent('Not checked: salary above 150k.');
    // The phrases the ranking terms came from are not repeated as "not checked".
    expect(within(proposal).getByTestId('nl-not-checked')).not.toHaveTextContent(/climate|Rust/);
    // RoboApply: no AI label; nothing is handed to the list before the person applies.
    expect(proposal.querySelector('[data-ai-label]')).toBeNull();
    expect(__listRelevanceStore.get()).toBeNull();
    fireEvent.click(within(proposal).getByRole('button', { name: 'Use these filters' }));
    await waitFor(() => expect(nav.push).toEqual(['/jobs']));
    expect(net.to('PATCH', `${PROFILES}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { titles: ['Backend Engineer'] } });
    // Only filters are saved; the ranking terms go to the list state, joined by a space.
    expect(__listRelevanceStore.get()).toEqual({ searchProfileId: 'sp_main', terms: ['climate startups', 'Rust'], text: 'climate startups Rust', baseVersion: 3, version: null });
  });

  it('cancelling a proposal, or a save that fails, hands nothing to the list; a new search with no ranking terms clears the earlier ones', async () => {
    let patchOk = false;
    let rankedBy: string[] = ['climate startups'];
    installFetch(
      routes({
        [`POST ${FEED}/nl-query`]: () =>
          ok({ diff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [{ op: 'set', path: 'workModels', value: ['remote'] }], countAfter: null }, explanation: '', unmatched: rankedBy, rankedBy }),
        [`PATCH ${PROFILES}/sp_main`]: () => (patchOk ? ok(searchProfile({ version: 4 })) : fail(500, 'internal_error')),
      }),
    );
    renderFeed(<Explore />);
    const ask = async () => {
      fireEvent.change(screen.getByLabelText('Describe the job you want'), { target: { value: 'remote jobs at climate startups' } });
      fireEvent.click(screen.getByRole('button', { name: 'Turn into filters' }));
      return screen.findByTestId('nl-proposal');
    };
    fireEvent.click(within(await ask()).getByRole('button', { name: 'Cancel' }));
    expect(__listRelevanceStore.get()).toBeNull();
    fireEvent.click(within(await ask()).getByRole('button', { name: 'Use these filters' }));
    await waitFor(() => expect(__toastStore.get().length).toBeGreaterThan(0));
    expect(__listRelevanceStore.get()).toBeNull();
    expect(nav.push).toEqual([]);
    patchOk = true;
    fireEvent.click(within(await ask()).getByRole('button', { name: 'Use these filters' }));
    await waitFor(() => expect(nav.push).toEqual(['/jobs']));
    expect(__listRelevanceStore.get()?.text).toBe('climate startups');
    // The next search leaves nothing to rank by: the list goes back to its plain order.
    rankedBy = [];
    fireEvent.click(within(await ask()).getByRole('button', { name: 'Use these filters' }));
    await waitFor(() => expect(nav.push).toEqual(['/jobs', '/jobs']));
    expect(__listRelevanceStore.get()).toBeNull();
  });

  it('a response without the two lists (an older server) shows no line and breaks nothing', async () => {
    installFetch(
      routes({
        [`POST ${FEED}/nl-query`]: () => ok({ diff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [{ op: 'set', path: 'workModels', value: ['remote'] }], countAfter: null }, explanation: 'Remote jobs.' }),
      }),
    );
    renderFeed(<Explore />);
    fireEvent.change(screen.getByLabelText('Describe the job you want'), { target: { value: 'remote jobs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn into filters' }));
    const proposal = await screen.findByTestId('nl-proposal');
    expect(within(proposal).queryByTestId('nl-ranked-by')).toBeNull();
    expect(within(proposal).queryByTestId('nl-not-checked')).toBeNull();
    expect(within(proposal).getByRole('button', { name: 'Use these filters' })).toBeInTheDocument();
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

  it('a sentence that changes no filter but leaves topics: says so, and offers to rank the list by them without saving anything', async () => {
    const net = installFetch(
      routes({
        [`POST ${FEED}/nl-query`]: () =>
          ok({
            // The saved search is already hybrid: the only filter the sentence names changes nothing.
            diff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [{ op: 'add', path: 'workModels', value: 'hybrid' }], countAfter: null },
            explanation: 'Ranked by closeness to: climate startups, Rust. Not checked as requirements: salary above 150k.',
            unmatched: ['climate startups', 'using Rust', 'salary above 150k'],
            rankedBy: ['climate startups', 'Rust'],
          }),
      }),
    );
    const { client } = renderFeed(<Explore />);
    await waitFor(() => expect(client.getQueryState(searchKeys.profiles())?.status).toBe('success'));
    fireEvent.change(screen.getByLabelText('Describe the job you want'), { target: { value: 'hybrid jobs at climate startups using Rust, salary above 150k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn into filters' }));
    // No filter changes, and the page says so; there is no proposal to save.
    expect(await screen.findByText(/doesn't change your current search/)).toBeInTheDocument();
    expect(screen.queryByTestId('nl-proposal')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use these filters' })).toBeNull();
    // The words that became no filter are not thrown away.
    const offer = screen.getByTestId('nl-rank-only');
    expect(within(offer).getByRole('heading', { name: 'Your filters stay as they are' })).toBeInTheDocument();
    expect(within(offer).getByTestId('nl-ranked-by')).toHaveTextContent('Ranked by closeness to: climate startups, Rust. These were not checked as requirements.');
    expect(within(offer).getByTestId('nl-not-checked')).toHaveTextContent('Not checked: salary above 150k.');
    expect(offer.querySelector('[data-ai-label]')).toBeNull();
    expect(__listRelevanceStore.get()).toBeNull();
    fireEvent.click(within(offer).getByRole('button', { name: 'Rank my list by these words' }));
    // Nothing is saved: the terms belong to the search's version as it is (3), so its next change ends them.
    expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(0);
    expect(__listRelevanceStore.get()).toEqual({ searchProfileId: 'sp_main', terms: ['climate startups', 'Rust'], text: 'climate startups Rust', baseVersion: 3, version: 3 });
    expect(nav.push).toEqual(['/jobs']);
  });

  it('the offer to rank can be dismissed, a new search replaces it, and GoApply labels its lines as AI generated', async () => {
    let rankedBy: string[] = ['新能源', 'Rust'];
    installFetch(
      routes({
        [`POST ${FEED}/nl-query`]: () => ok({ diff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [], countAfter: null }, explanation: '', unmatched: rankedBy, rankedBy }),
      }),
    );
    renderFeed(<Explore />, { brand: 'goapply' });
    const ask = () => {
      fireEvent.change(screen.getByLabelText('Describe the job you want'), { target: { value: '新能源 Rust 岗位' } });
      fireEvent.click(screen.getByRole('button', { name: 'Turn into filters' }));
    };
    ask();
    const offer = await screen.findByTestId('nl-rank-only');
    expect(within(offer).getByTestId('nl-ranked-by').querySelector('[data-ai-label]')).not.toBeNull();
    expect(within(offer).queryByTestId('nl-not-checked')).toBeNull();
    fireEvent.click(within(offer).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('nl-rank-only')).toBeNull();
    expect(__listRelevanceStore.get()).toBeNull();
    expect(nav.push).toEqual([]);
    // The next sentence leaves nothing to rank by: no offer.
    rankedBy = [];
    ask();
    expect(await screen.findByText(/doesn't change your current search/)).toBeInTheDocument();
    await act(async () => undefined);
    expect(screen.queryByTestId('nl-rank-only')).toBeNull();
  });

  it('GoApply: the same two lines, each labelled as AI generated', async () => {
    installFetch(
      routes({
        [`POST ${FEED}/nl-query`]: () =>
          ok({
            diff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [{ op: 'set', path: 'q', value: '数据' }], countAfter: null },
            explanation: 'Ranked by closeness to: 新能源, Rust. Not checked as requirements: 双休.',
            unmatched: ['新能源', 'Rust', '双休'],
            rankedBy: ['新能源', 'Rust'],
          }),
        [`PATCH ${PROFILES}/sp_main`]: () => ok(searchProfile({ version: 4 })),
      }),
    );
    renderFeed(<Explore />, { brand: 'goapply' });
    fireEvent.change(screen.getByLabelText('Describe the job you want'), { target: { value: '北京数据岗位' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn into filters' }));
    const proposal = await screen.findByTestId('nl-proposal');
    const ranked = within(proposal).getByTestId('nl-ranked-by');
    expect(ranked).toHaveTextContent('Ranked by closeness to: 新能源, Rust. These were not checked as requirements.');
    expect(ranked.querySelector('[data-ai-label]')).not.toBeNull();
    const unchecked = within(proposal).getByTestId('nl-not-checked');
    expect(unchecked).toHaveTextContent('Not checked: 双休.');
    expect(unchecked.querySelector('[data-ai-label]')).not.toBeNull();
    // The flow is the same on both brands (D5): applying hands the terms to the list.
    fireEvent.click(within(proposal).getByRole('button', { name: 'Use these filters' }));
    await waitFor(() => expect(nav.push).toEqual(['/jobs']));
    expect(__listRelevanceStore.get()?.text).toBe('新能源 Rust');
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
