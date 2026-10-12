// PracticeTargetPicker — "Which job are you interviewing for?", the practice
// setup's first input. It only renders: the page owns the state and the prep
// queries, so every test hands it props and reads what it asks for back.
//
// Pinned here:
//   - the two ways in (find a job, paste the post);
//   - the job search's states: searching, results (roles that match, open
//     jobs with where each was found and a link to the post), the last answer
//     kept while the next one loads, no postings / no results, error + retry;
//   - browsing by industry, including the candidate's own "Other industry…";
//   - the optional target company;
//   - picking a posting or a role hands the target to the page;
//   - the chosen target's card, the pasted post, and a job from `?job=`.

import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import { PracticeTargetPicker, type LoadState } from '../PracticeTargetPicker';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import {
  INDUSTRY_ROLES,
  POSTING_BOARD,
  POSTING_OURS,
  PREP_INDUSTRIES,
  ROLE_PLATFORM,
  prepPosting,
  prepSearchResult,
} from '../../../../__tests__/utils/prepFixtures';

type PickerProps = ComponentProps<typeof PracticeTargetPicker>;

const DAY_MS = 24 * 60 * 60 * 1000;

function renderPicker(overrides: Partial<PickerProps> = {}) {
  const props: PickerProps = {
    sourceMode: 'role',
    onSourceModeChange: vi.fn(),
    query: '',
    onQueryChange: vi.fn(),
    company: '',
    onCompanyChange: vi.fn(),
    industries: PREP_INDUSTRIES,
    industry: null,
    onIndustryChange: vi.fn(),
    industryRoles: { state: 'idle', roles: [] },
    onRetryIndustryRoles: vi.fn(),
    search: { state: 'idle', pending: false, result: null },
    onRetrySearch: vi.fn(),
    target: null,
    onSelectTarget: vi.fn(),
    onClearTarget: vi.fn(),
    jdText: '',
    onJdTextChange: vi.fn(),
    ...overrides,
  };
  renderWithProviders(<PracticeTargetPicker {...props} />);
  return props;
}

function searching(state: LoadState, result = prepSearchResult(), pending = false): Partial<PickerProps> {
  return { query: 'backend', search: { state, pending, result: state === 'ready' || pending ? result : null } };
}

describe('PracticeTargetPicker: the two ways in', () => {
  it('finds a job by default and switches to pasting the post', () => {
    const props = renderPicker();
    expect(screen.getByRole('heading', { name: 'Which job are you interviewing for?' })).toBeInTheDocument();
    const find = screen.getByRole('radio', { name: 'Find a job' });
    expect(find).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Paste a job post' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('searchbox', { name: 'Job title' })).toHaveAttribute(
      'placeholder',
      'Job title, e.g. AI forward deployed engineer',
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Paste a job post' }));
    expect(props.onSourceModeChange).toHaveBeenLastCalledWith('jd');
    // The arrow keys move between the two, like any radio group.
    fireEvent.keyDown(find, { key: 'ArrowRight' });
    expect(props.onSourceModeChange).toHaveBeenLastCalledWith('jd');
  });

  it('typing a title asks the page to search', () => {
    const props = renderPicker();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Job title' }), { target: { value: 'AI FDE' } });
    expect(props.onQueryChange).toHaveBeenCalledWith('AI FDE');
  });
});

describe('PracticeTargetPicker: the job search', () => {
  it('says it is searching while the first answer loads, in place of the industries', () => {
    renderPicker({ query: 'backend', search: { state: 'loading', pending: true, result: null } });
    expect(screen.getByText('Searching jobs…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Not sure yet? Browse by industry' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Open jobs' })).toBeNull();
  });

  it('lists the roles that match and the open jobs, each with where it was found and a link to the post', () => {
    const postedAt = new Date(Date.now() - 2 * DAY_MS).toISOString();
    const props = renderPicker(searching('ready', prepSearchResult({
      market: { key: 'de', country: 'DE' },
      postings: [{ ...POSTING_OURS, postedAt }, POSTING_BOARD],
    })));

    const roles = screen.getByRole('group', { name: 'Roles that match' });
    expect(within(roles).getAllByRole('button').map((chip) => chip.querySelector('strong')?.textContent)).toEqual([
      'Backend Engineer',
      'Platform Engineer',
    ]);
    expect(within(roles).getByRole('button', { name: /^Platform Engineer/ })).toHaveTextContent('Runs the internal developer platform');

    // The job market is named; each posting says where it came from.
    expect(screen.getByRole('heading', { name: 'Open jobs in Germany' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Open jobs' });
    const [ours, board] = within(list).getAllByRole('listitem');
    expect(ours).toHaveTextContent('Senior Backend Engineer');
    expect(ours).toHaveTextContent('Stripe · Berlin · 2 days ago');
    expect(ours).toHaveTextContent('Own the payments API.');
    expect(ours).toHaveTextContent('RoboApply jobs');
    expect(board).toHaveTextContent('Monzo · London');
    expect(board).toHaveTextContent('Job board');

    const links = within(list).getAllByRole('link', { name: 'View post' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([POSTING_OURS.url, POSTING_BOARD.url]);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    // Opening the post is not choosing it.
    fireEvent.click(links[0]);
    expect(props.onSelectTarget).not.toHaveBeenCalled();
    // No web finds and every board answered: no caveat lines.
    expect(screen.queryByText(/Found on the web/)).toBeNull();
    expect(screen.queryByText(/Some job boards didn't answer/)).toBeNull();
  });

  it('flags web finds and job boards that did not answer', () => {
    const web = prepPosting({ ref: 'web:1', source: 'web', provider: 'careers.example.org', title: 'Backend Engineer', url: 'https://careers.example.org/1' });
    renderPicker(searching('ready', prepSearchResult({
      postings: [web],
      sources: [
        { id: 'index', status: 'empty', count: 0 },
        { id: 'providers', status: 'unavailable', count: 0 },
        { id: 'web', status: 'ok', count: 1 },
      ],
    })));
    expect(screen.getByRole('heading', { name: 'Open jobs' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Open jobs' })).getByText('Web · careers.example.org')).toBeInTheDocument();
    expect(screen.getByText("Found on the web: open the post to check that it's still open.")).toBeInTheDocument();
    expect(screen.getByText("Some job boards didn't answer, so these are the jobs we could reach.")).toBeInTheDocument();
  });

  it('keeps the last answer on screen while the next one loads', () => {
    renderPicker(searching('ready', prepSearchResult(), true));
    expect(screen.getByText('Searching jobs…')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Roles that match' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Open jobs' }).closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
  });

  it('with no open jobs it says so and still offers the roles', () => {
    renderPicker(searching('ready', prepSearchResult({ postings: [] })));
    expect(screen.getByText('No open jobs found for “backend”. You can still practice the role, or paste a job post.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Roles that match' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Open jobs' })).toBeNull();
  });

  it('with nothing that matched it suggests another title or the post', () => {
    renderPicker(searching('ready', prepSearchResult({ roles: [], postings: [] })));
    expect(screen.getByText('Nothing matched “backend”. Try another title, or paste a job post.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Roles that match' })).toBeNull();
  });

  it('a search that failed says so and tries again on request', () => {
    const props = renderPicker({ query: 'backend', search: { state: 'error', pending: false, result: null } });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("The job search didn't answer.");
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(props.onRetrySearch).toHaveBeenCalledTimes(1);
  });
});

describe('PracticeTargetPicker: choosing the target', () => {
  it('picking a posting practices for that posting', () => {
    const props = renderPicker(searching('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'Practice for Senior Backend Engineer at Stripe' }));
    expect(props.onSelectTarget).toHaveBeenCalledWith({ kind: 'posting', posting: POSTING_OURS });
    fireEvent.click(screen.getByRole('button', { name: 'Practice for Backend Engineer, Payments at Monzo' }));
    expect(props.onSelectTarget).toHaveBeenLastCalledWith({ kind: 'posting', posting: POSTING_BOARD });
  });

  it('a posting without a company is named by its title alone', () => {
    const props = renderPicker(searching('ready', prepSearchResult({ postings: [prepPosting({ ref: 'p:1', title: 'Backend Engineer' })] })));
    fireEvent.click(screen.getByRole('button', { name: 'Practice for Backend Engineer' }));
    expect(props.onSelectTarget).toHaveBeenCalledWith({ kind: 'posting', posting: expect.objectContaining({ ref: 'p:1' }) });
  });

  it('picking a role practices for the role, named in the UI language when the taxonomy knows it', () => {
    const taxonomyRole = { title: 'Backend Engineer', titleEn: null, source: 'taxonomy' as const, context: null, taxonomyId: 'backend_engineer' };
    const props = renderPicker({
      ...searching('ready', prepSearchResult({ roles: [taxonomyRole, ROLE_PLATFORM] })),
      localizeTaxonomy: (id, fallback) => (id === 'backend_engineer' ? '后端工程师' : fallback),
    });
    const roles = screen.getByRole('group', { name: 'Roles that match' });
    fireEvent.click(within(roles).getByRole('button', { name: /^后端工程师/ }));
    // The English title travels with it, so "Find open jobs" can search the boards in English.
    expect(props.onSelectTarget).toHaveBeenCalledWith({ kind: 'role', title: '后端工程师', titleEn: 'Backend Engineer' });
    fireEvent.click(within(roles).getByRole('button', { name: /^Platform Engineer/ }));
    expect(props.onSelectTarget).toHaveBeenLastCalledWith({ kind: 'role', title: 'Platform Engineer', titleEn: null });
  });
});

describe('PracticeTargetPicker: browsing by industry', () => {
  it('with nothing typed it offers the industries; placeholders until they load', () => {
    renderPicker({ industries: null });
    const group = screen.getByRole('group', { name: 'Not sure yet? Browse by industry' });
    expect(within(group).queryAllByRole('button')).toHaveLength(0);
  });

  it('lists the industries as toggles; picking one again clears it', () => {
    const props = renderPicker();
    const group = screen.getByRole('group', { name: 'Not sure yet? Browse by industry' });
    const health = within(group).getByRole('button', { name: 'Healthcare' });
    expect(health).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(health);
    expect(props.onIndustryChange).toHaveBeenCalledWith('health');
  });

  it('an industry that is chosen is pressed, and a second press clears it', () => {
    const props = renderPicker({ industry: 'health', industryRoles: { state: 'ready', roles: INDUSTRY_ROLES } });
    const health = within(screen.getByRole('group', { name: 'Not sure yet? Browse by industry' })).getByRole('button', { name: 'Healthcare' });
    expect(health).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(health);
    expect(props.onIndustryChange).toHaveBeenCalledWith(null);
  });

  it('shows the top industries first and the rest behind "More industries"', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ id: `i${index}`, label: `Industry ${index}`, top: index < 6 }));
    renderPicker({ industries: [...many, { id: 'space', label: 'Space', top: false }] });
    const group = screen.getByRole('group', { name: 'Not sure yet? Browse by industry' });
    expect(within(group).queryByRole('button', { name: 'Space' })).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'More industries' }));
    expect(within(group).getByRole('button', { name: 'Space' })).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: 'Fewer industries' }));
    expect(within(group).queryByRole('button', { name: 'Space' })).toBeNull();
  });

  it('"Other industry…" takes the candidate’s own words', () => {
    const props = renderPicker();
    const other = screen.getByRole('button', { name: 'Other industry…' });
    expect(other).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(other);
    expect(other).toHaveAttribute('aria-expanded', 'true');

    const input = screen.getByRole('textbox', { name: 'Type an industry, e.g. space technology' });
    const apply = screen.getByRole('button', { name: 'Show roles' });
    expect(apply).toBeDisabled();
    fireEvent.change(input, { target: { value: '  space technology ' } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(props.onIndustryChange).toHaveBeenCalledWith('space technology');
    // The form closes once the industry is applied.
    expect(screen.queryByRole('textbox', { name: 'Type an industry, e.g. space technology' })).toBeNull();
  });

  it('a typed industry shows as its own chip with its roles, and picking one practices for it', () => {
    const props = renderPicker({ industry: 'space technology', industryRoles: { state: 'ready', roles: INDUSTRY_ROLES } });
    const group = screen.getByRole('group', { name: 'Not sure yet? Browse by industry' });
    // Its own pressed chip replaces "Other industry…"; pressing it clears the industry.
    expect(within(group).queryByRole('button', { name: 'Other industry…' })).toBeNull();
    const own = within(group).getByRole('button', { name: 'space technology' });
    expect(own).toHaveAttribute('aria-pressed', 'true');

    expect(screen.getByRole('heading', { name: 'Roles in space technology' })).toBeInTheDocument();
    const roles = screen.getByRole('group', { name: 'Roles in space technology' });
    fireEvent.click(within(roles).getByRole('button', { name: /^Data Engineer/ }));
    expect(props.onSelectTarget).toHaveBeenCalledWith({ kind: 'role', title: 'Data Engineer', titleEn: null });

    fireEvent.click(own);
    expect(props.onIndustryChange).toHaveBeenCalledWith(null);
  });

  it('says it is finding an industry’s roles while they load', () => {
    renderPicker({ industry: 'health', industryRoles: { state: 'loading', roles: [] } });
    expect(screen.getByText('Finding the roles Healthcare hires for…')).toBeInTheDocument();
  });

  it('a failed role list retries on request', () => {
    const props = renderPicker({ industry: 'health', industryRoles: { state: 'error', roles: [] } });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("We couldn't list the roles for this industry.");
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(props.onRetryIndustryRoles).toHaveBeenCalledTimes(1);
  });
});

describe('PracticeTargetPicker: the target company', () => {
  it('is optional, explained, and can be cleared', () => {
    const props = renderPicker();
    const input = screen.getByLabelText('Target company (optional)');
    expect(screen.getByText("Name a company and the interview follows the way it's known to interview.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear the company' })).toBeNull();
    fireEvent.change(input, { target: { value: 'Acme' } });
    expect(props.onCompanyChange).toHaveBeenCalledWith('Acme');
  });

  it('a named company has a clear button', () => {
    const props = renderPicker({ company: 'Acme' });
    expect(screen.getByLabelText('Target company (optional)')).toHaveValue('Acme');
    fireEvent.click(screen.getByRole('button', { name: 'Clear the company' }));
    expect(props.onCompanyChange).toHaveBeenCalledWith('');
  });
});

describe('PracticeTargetPicker: the chosen target', () => {
  it('a posting: what it is, where and when it was posted, a link to it, and Change', () => {
    const postedAt = new Date(Date.now() - 2 * DAY_MS).toISOString();
    const props = renderPicker({ target: { kind: 'posting', posting: { ...POSTING_OURS, postedAt } }, company: 'Stripe' });
    expect(screen.getByText("You're practicing for")).toBeInTheDocument();
    expect(screen.getByText('Senior Backend Engineer')).toBeInTheDocument();
    expect(screen.getByText('Stripe · Berlin · 2 days ago')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View post' })).toHaveAttribute('href', POSTING_OURS.url);
    // The search is gone; the company stays editable.
    expect(screen.queryByRole('searchbox', { name: 'Job title' })).toBeNull();
    expect(screen.getByLabelText('Target company (optional)')).toHaveValue('Stripe');
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(props.onClearTarget).toHaveBeenCalledTimes(1);
  });

  it('a role: practiced in general, with a way to find its open jobs', () => {
    const props = renderPicker({ target: { kind: 'role', title: '后端工程师', titleEn: 'Backend Engineer' } });
    expect(screen.getByText('后端工程师')).toBeInTheDocument();
    expect(screen.getByText('The role in general, not one job post')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View post' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Find open jobs for this role' }));
    // Searched by its English title, then the role is let go.
    expect(props.onQueryChange).toHaveBeenCalledWith('Backend Engineer');
    expect(props.onClearTarget).toHaveBeenCalledTimes(1);
  });
});

describe('PracticeTargetPicker: a pasted post and a job from the link', () => {
  it('the post is counted and asked to be longer until it is enough to plan from', () => {
    const props = renderPicker({ sourceMode: 'jd', jdText: 'Backend role' });
    const textarea = screen.getByRole('textbox', { name: /^Paste the full job post/ });
    expect(screen.getByText(/^Add a bit more\./)).toBeInTheDocument();
    expect(screen.getByText('12 characters')).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: 'Backend role: build the payments API.' } });
    expect(props.onJdTextChange).toHaveBeenCalledWith('Backend role: build the payments API.');
    // The company can be named for a pasted post too.
    expect(screen.getByLabelText('Target company (optional)')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: 'Job title' })).toBeNull();
  });

  it('a post long enough to plan from shows the plain hint', () => {
    renderPicker({ sourceMode: 'jd', jdText: 'Backend Engineer. Build and run the payments API in Go.' });
    expect(screen.getByText('Paste the full job post. The questions get built from what it asks for.')).toBeInTheDocument();
  });

  it('a job from `?job=` replaces the tabs and the search; the company stays', () => {
    renderPicker({ jobBanner: <p data-testid="banner">Backend Engineer at Acme</p>, company: 'Acme' });
    expect(screen.getByTestId('banner')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Job title' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Not sure yet? Browse by industry' })).toBeNull();
    expect(screen.getByLabelText('Target company (optional)')).toHaveValue('Acme');
  });
});
