// Assistant cards (WP-51; F-ORION-12): every card type renders from fixture
// data; an unknown type or data that does not parse renders nothing; the
// proposal cards change nothing until confirmed; GoApply asks the memory
// consent before anything is saved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { ACTION_CARD_CAPS, CopilotCardView } from '../cards';
import { countsByLabel } from '../cards/ApplicationsCard';
import { ALL_TRACKER_STATUSES } from '../../../../server/src/features/tracker/contract';
import { CARD_TYPES } from '../../../../server/src/features/copilot/contract';
import { __assistantChangeStore } from '../../../../hooks/feed/useCalibration';
import { __outOfCreditsStore } from '../../../../hooks/shared/useCreditGate';
import { CREDITS, MEMORY_CONSENT, PROFILES, card, fail, installFetch, ok, renderUi, type Route } from './testkit';

const push = vi.fn();
vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return { ...real, useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), forward: vi.fn() }), usePathname: () => '/jobs' };
});

const AS_OF = '2026-10-01T00:00:00.000Z';

/** One valid fixture per card type (fictional data). */
const FIXTURES: Record<string, unknown> = {
  job_list: {
    items: [
      { jobId: 'job_1', title: 'Data analyst', company: { name: 'Example Co' }, location: 'Berlin', pay: { min: 60000, max: 70000, currency: 'EUR', period: 'year', text: null }, fit: { tier: 'good', score: 70 } },
      { jobId: 'job_2', title: 'BI analyst', company: 'Sample GmbH', location: null, pay: null },
    ],
  },
  filters: { filters: { workModels: ['remote'] }, searchProfileId: 'sp_main' },
  filter_diff: { proposalId: 'p_f', searchProfileId: 'sp_main', baseVersion: 3, ops: [{ op: 'add', path: 'workModels', value: 'hybrid' }], countAfter: 12, expiresAt: '2099-01-01T00:00:00.000Z' },
  fit_analysis: { jobId: 'job_1', tier: 'possible', aligned: ['SQL in two roles'], missing: ['Kubernetes'], highlights: [] },
  company: { name: 'Example Co', facts: [{ key: 'size', value: { value: '51–200', source: 'company_website', asOf: AS_OF } }] },
  contacts: { company: 'Example Co', people: [{ id: 'c1', name: 'Alex Sample', title: 'Recruiter', sourceName: 'RoboHire' }], searchLinks: [{ url: 'https://www.linkedin.com/search/results/people/?keywords=Example%20Co' }] },
  credit_action: { proposalId: 'p_c', action: 'tailor', bucket: 'tailor', cost: 1, jobId: 'job_1', jobTitle: 'Data analyst', company: 'Example Co' },
  tailor_ready: { resumeId: 'res_9', jobTitle: 'Data analyst' },
  cover_letter: { letterId: 'cl_1', preview: 'Dear team, …' },
  interview_plan: { jobId: 'job_1', questions: [{ text: 'Walk us through a dashboard you built.', sourceKind: 'bank' }, { text: 'How would you size the data?', sourceKind: 'ai' }] },
  salary: { title: 'Data analyst', location: 'Berlin', range: { value: { min: 55000, max: 72000, currency: 'EUR', period: 'year' }, source: 'index', sampleSize: 40, asOf: AS_OF } },
  applications: { counts: [{ status: 'applied', count: 4 }, { status: 'interviewing', count: 1 }], followUps: [{ jobId: 'job_3', title: 'Analyst', company: 'Example Co', dueAt: '2026-10-14' }] },
  job_imported: { jobId: 'job_4', title: 'Analyst', company: 'Example Co' },
  memory_add: { proposalId: 'p_m', fact: 'Prefers remote jobs in Berlin time zones.' },
  profile_gaps: { gaps: [{ key: 'skills' }, { key: 'workAuth', href: '/profile#work' }] },
  action: { kind: 'set_sort', sort: 'newest' },
  notice: { code: 'copilot_budget_exhausted' },
  campus_deadlines: { items: [{ company: '示例公司', programme: '2027 校招', closesAt: '2026-10-20', sourceUrl: 'https://campus.example.com', sourceName: '示例公司官网' }] },
  competitiveness: { jobId: 'job_1' },
};

const FLAGS = { competitiveness: true, campusCalendar: true };

function routes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    'GET /api/v1/roboapply/credits': () => ok(CREDITS()),
    'GET /api/v1/roboapply/search-profiles': () => ok(PROFILES()),
    ...extra,
  };
}

beforeEach(() => {
  push.mockReset();
  __assistantChangeStore.reset();
  __outOfCreditsStore.reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('every card type renders', () => {
  // The sort link is gated until /jobs reads ?sort= (see the action test below);
  // here every type is rendered with its destination available.
  beforeEach(() => {
    ACTION_CARD_CAPS.sortLink = true;
  });
  afterEach(() => {
    ACTION_CARD_CAPS.sortLink = false;
  });

  it('has a fixture for every contract card type', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...CARD_TYPES].sort());
  });

  it.each([...CARD_TYPES])('%s', async (type) => {
    installFetch(routes());
    const { container } = renderUi(<CopilotCardView card={card(type, FIXTURES[type])} />, { flags: FLAGS });
    await waitFor(() => expect(container.querySelector(`[data-card="${type}"]`)).not.toBeNull());
  });

  it.each([...CARD_TYPES])('%s with malformed data renders nothing', (type) => {
    installFetch(routes());
    const { container } = renderUi(<CopilotCardView card={card(type, { nonsense: true })} />, { flags: FLAGS });
    expect(container.querySelector('[data-card]')).toBeNull();
  });

  it('an unknown card type renders nothing', () => {
    const { container } = renderUi(<CopilotCardView card={card('retention_offer', { pct: 50 })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('card content', () => {
  it('action set_sort renders nothing while /jobs does not honour ?sort= (no promise the page cannot keep)', () => {
    installFetch(routes());
    expect(ACTION_CARD_CAPS.sortLink).toBe(false);
    const { container } = renderUi(<CopilotCardView card={card('action', FIXTURES.action)} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('link', { name: 'Show jobs sorted this way' })).not.toBeInTheDocument();
  });

  it('applications: real tracker statuses get their own labels; bookmarked is Saved; legacy statuses fold', () => {
    installFetch(routes());
    const data = {
      counts: [
        { status: 'bookmarked', count: 5 },
        { status: 'first_call', count: 2 },
        { status: 'final_round', count: 1 },
        { status: 'applying', count: 1 },
        { status: 'applied', count: 3 },
        { status: 'withdrawn', count: 1 },
        { status: 'mystery_stage', count: 2 },
      ],
      followUps: [],
    };
    const { container } = renderUi(<CopilotCardView card={card('applications', data)} />);
    const rows = [...container.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows).toEqual(['Saved: 5', 'Applied: 4', 'First call: 2', 'Final round: 1', 'Withdrawn: 1', 'Other: 2']);
  });

  it('countsByLabel covers every tracker status without falling back to Other', () => {
    expect(countsByLabel(ALL_TRACKER_STATUSES.map((status) => ({ status, count: 1 }))).some((r) => r.label === 'other')).toBe(false);
  });

  it('a malformed entry in card.sources is dropped instead of crashing the conversation', () => {
    installFetch(routes());
    const bad = {
      ...card('applications', FIXTURES.applications),
      sources: [{ value: 1, asOf: AS_OF }, { value: 2, source: 'index', asOf: AS_OF, url: 'ftp://example.com/x' }, null],
    } as never;
    const { container } = renderUi(<CopilotCardView card={bad} />);
    expect(container.querySelector('[data-card="applications"]')).not.toBeNull();
    expect(container.querySelector('a[href^="ftp:"]')).toBeNull();
  });

  it('job_list: links, pay or "Pay not listed", tier word and the fit line', () => {
    installFetch(routes());
    renderUi(<CopilotCardView card={card('job_list', FIXTURES.job_list)} />);
    expect(screen.getByRole('link', { name: 'Data analyst' })).toHaveAttribute('href', expect.stringContaining('job_1'));
    expect(screen.getByText('Pay not listed')).toBeInTheDocument();
    expect(screen.getByText('Good fit')).toBeInTheDocument();
    expect(screen.getByText('This is not your chance of getting hired.')).toBeInTheDocument();
  });

  it('fit_analysis shows the AI badge on GoApply only', () => {
    installFetch(routes());
    const { container, unmount } = renderUi(<CopilotCardView card={card('fit_analysis', FIXTURES.fit_analysis)} />, { brand: 'goapply' });
    expect(container.querySelector('[data-ai-label]')).not.toBeNull();
    unmount();
    const ra = renderUi(<CopilotCardView card={card('fit_analysis', FIXTURES.fit_analysis)} />);
    expect(ra.container.querySelector('[data-ai-label]')).toBeNull();
    expect(screen.getByText('Kubernetes')).toBeInTheDocument();
  });

  it('salary below 20 posts renders "—" and says there is not enough data', () => {
    installFetch(routes());
    const small = { ...(FIXTURES.salary as object), range: { value: { min: 1, max: 2, currency: 'EUR', period: 'year' }, source: 'index', sampleSize: 12, asOf: AS_OF } };
    const { container } = renderUi(<CopilotCardView card={card('salary', small)} />);
    expect(container.textContent).toContain('—');
    expect(container.textContent).not.toContain('€1');
    expect(container.textContent).toContain('Not enough data yet');
  });

  it('job_list shows the pay unit, and never invents one the post did not state', () => {
    installFetch(routes());
    const items = [
      { jobId: 'job_y', title: 'Yearly', pay: { min: 60000, max: 70000, currency: 'EUR', period: 'year', text: null } },
      { jobId: 'job_h', title: 'Hourly', pay: { min: 25, max: 30, currency: 'USD', period: 'hour', text: null } },
      { jobId: 'job_u', title: 'No unit', pay: { min: 25, max: 30, currency: 'USD', text: null } },
      { jobId: 'job_t', title: 'Text only', pay: { min: 25, max: 30, currency: 'USD', period: 'fortnight', text: 'Competitive' } },
    ];
    const { container } = renderUi(<CopilotCardView card={card('job_list', { items })} />);
    const row = (id: string) => container.querySelector(`[data-job="${id}"]`)?.textContent ?? '';
    expect(row('job_y')).toMatch(/60K.*70K a year/);
    expect(row('job_h')).toMatch(/25.*30 an hour/);
    expect(row('job_u')).toContain('Pay not listed');
    expect(row('job_u')).not.toMatch(/a year|an hour/);
    expect(row('job_t')).toContain('Competitive');
    expect(row('job_t')).not.toMatch(/a year|\$25/);
  });

  it('salary without a sample size renders nothing (the one-sample rule cannot be checked)', () => {
    installFetch(routes());
    const noN = { ...(FIXTURES.salary as object), range: { value: { min: 55000, max: 72000, currency: 'EUR', period: 'year' }, source: 'index', asOf: AS_OF } };
    const { container } = renderUi(<CopilotCardView card={card('salary', noN)} />);
    expect(container).toBeEmptyDOMElement();
    expect(container.textContent).not.toMatch(/55,000/);
  });

  it('salary at 40 posts shows the range and N', () => {
    installFetch(routes());
    const { container } = renderUi(<CopilotCardView card={card('salary', FIXTURES.salary)} />);
    expect(container.textContent).toMatch(/55,000/);
    expect(container.textContent).toMatch(/40/);
  });

  it('contacts never shows a person without a named source', () => {
    installFetch(routes());
    const data = { company: 'Example Co', people: [{ id: 'x', name: 'No Source' }], searchLinks: [] };
    const { container } = renderUi(<CopilotCardView card={card('contacts', data)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a card link that is not an app path or http(s) URL is dropped', () => {
    installFetch(routes());
    const { container } = renderUi(<CopilotCardView card={card('tailor_ready', { href: 'javascript:alert(1)' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('interview_plan: source labels and Practice for this job', () => {
    installFetch(routes());
    renderUi(<CopilotCardView card={card('interview_plan', FIXTURES.interview_plan)} />);
    expect(screen.getByText('From our question bank')).toBeInTheDocument();
    expect(screen.getByText('Written by AI')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Practice for this job' }));
    expect(push).toHaveBeenCalledWith('/practice?job=job_1&from=assistant');
  });

  it('competitiveness and campus_deadlines hide when their flags are off', () => {
    installFetch(routes());
    const a = renderUi(<CopilotCardView card={card('competitiveness', FIXTURES.competitiveness)} />);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    const b = renderUi(<CopilotCardView card={card('campus_deadlines', FIXTURES.campus_deadlines)} />);
    expect(b.container).toBeEmptyDOMElement();
  });
});

describe('filter_diff (F-ORION-04)', () => {
  it('shows the diff and the count, and changes nothing until Apply changes', async () => {
    const http = installFetch(routes({ 'POST /api/v1/roboapply/copilot/proposals/p_f/apply': () => ok({ applied: true, result: null }) }));
    renderUi(<CopilotCardView card={card('filter_diff', FIXTURES.filter_diff)} />);
    await screen.findByRole('button', { name: 'Apply changes' });
    expect(screen.getByText('Your search would show 12 jobs.')).toBeInTheDocument();
    expect(screen.getByText('Add')).toBeInTheDocument();
    expect(http.to('POST', '/api/v1/roboapply/copilot/proposals/p_f/apply')).toHaveLength(0);
    expect(http.calls.some((c) => c.method === 'PATCH')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    await screen.findByText('Changes applied.');
    expect(http.to('POST', '/api/v1/roboapply/copilot/proposals/p_f/apply')[0].body).toEqual({ baseVersion: 3 });
    expect(screen.getByRole('link', { name: 'Show 12 jobs' })).toHaveAttribute('href', '/jobs');
    expect(__assistantChangeStore.get()).toMatchObject({ searchProfileId: 'sp_main', before: { workModels: ['remote'] } });
  });

  it('Looks better keeps it; Not quite puts the previous filters back', async () => {
    const http = installFetch(
      routes({
        'POST /api/v1/roboapply/copilot/proposals/p_f/apply': () => ok({ applied: true, result: null }),
        'PATCH /api/v1/roboapply/search-profiles/sp_main': () => ok({ profile: PROFILES().profiles[0] }),
      }),
    );
    renderUi(<CopilotCardView card={card('filter_diff', FIXTURES.filter_diff)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Not quite' }));
    await waitFor(() => expect(http.to('PATCH', '/api/v1/roboapply/search-profiles/sp_main')).toHaveLength(1));
    expect(http.to('PATCH', '/api/v1/roboapply/search-profiles/sp_main')[0].body).toMatchObject({ filters: { workModels: ['remote'] } });
    expect(__assistantChangeStore.get()).toBeNull();
  });

  it('a version conflict re-reads the search and shows the fresh diff', async () => {
    let reads = 0;
    installFetch(
      routes({
        'GET /api/v1/roboapply/search-profiles': () => {
          reads += 1;
          return ok(PROFILES([{ ...PROFILES().profiles[0], version: reads > 1 ? 4 : 3 }]));
        },
        'POST /api/v1/roboapply/copilot/proposals/p_f/apply': () => fail(409, 'conflict', { reason: 'version_conflict' }),
      }),
    );
    renderUi(<CopilotCardView card={card('filter_diff', FIXTURES.filter_diff)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply changes' }));
    await screen.findByText(/Your search changed after this suggestion/);
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeEnabled();
  });

  it('uses only the saved search the proposal names, never the active one', async () => {
    const other = { ...PROFILES().profiles[0], id: 'sp_other', isActive: true, version: 9, filters: { workModels: ['onsite'] } };
    const http = installFetch(routes({ 'GET /api/v1/roboapply/search-profiles': () => ok(PROFILES([other])) }));
    renderUi(<CopilotCardView card={card('filter_diff', FIXTURES.filter_diff)} />);
    expect(await screen.findByTestId('filter-diff-no-target')).toHaveTextContent('no longer there');
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument();
    expect(http.to('POST', '/api/v1/roboapply/copilot/proposals/p_f/apply')).toHaveLength(0);
  });

  it('previews and applies against the named search when another one is active', async () => {
    const active = { ...PROFILES().profiles[0], id: 'sp_other', isActive: true, version: 9, filters: { workModels: ['onsite'] } };
    const named = { ...PROFILES().profiles[0], isActive: false, isDefault: false, version: 3 };
    const http = installFetch(
      routes({
        'GET /api/v1/roboapply/search-profiles': () => ok({ ...PROFILES([active, named]), maxProfiles: 10 }),
        'POST /api/v1/roboapply/copilot/proposals/p_f/apply': () => ok({ applied: true, result: null }),
      }),
    );
    renderUi(<CopilotCardView card={card('filter_diff', FIXTURES.filter_diff)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply changes' }));
    await screen.findByText('Changes applied.');
    expect(http.to('POST', '/api/v1/roboapply/copilot/proposals/p_f/apply')[0].body).toEqual({ baseVersion: 3 });
    expect(__assistantChangeStore.get()).toMatchObject({ searchProfileId: 'sp_main', before: { workModels: ['remote'] } });
  });

  it('after a conflict the proposal-time count is not shown', async () => {
    let applies = 0;
    installFetch(
      routes({
        'POST /api/v1/roboapply/copilot/proposals/p_f/apply': () => {
          applies += 1;
          return applies === 1 ? fail(409, 'conflict', { reason: 'version_conflict' }) : ok({ applied: true, result: null });
        },
      }),
    );
    renderUi(<CopilotCardView card={card('filter_diff', FIXTURES.filter_diff)} />);
    expect(await screen.findByText('Your search would show 12 jobs.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    await screen.findByText(/Your search changed after this suggestion/);
    expect(screen.queryByText(/would show/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    await screen.findByText('Changes applied.');
    expect(screen.getByRole('link', { name: 'Show jobs' })).toHaveAttribute('href', '/jobs');
    expect(screen.queryByText(/12/)).not.toBeInTheDocument();
  });

  it('after a conflict a fresh count from the server is shown', async () => {
    installFetch(routes({ 'POST /api/v1/roboapply/copilot/proposals/p_f/apply': () => fail(409, 'conflict', { reason: 'version_conflict', countAfter: 7 }) }));
    renderUi(<CopilotCardView card={card('filter_diff', FIXTURES.filter_diff)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply changes' }));
    expect(await screen.findByText('Your search would show 7 jobs.')).toBeInTheDocument();
  });

  it('a search that moved past the proposal shows no proposal-time count and gets the server conflict reply first', async () => {
    let applies = 0;
    const http = installFetch(
      routes({
        'GET /api/v1/roboapply/search-profiles': () => ok(PROFILES([{ ...PROFILES().profiles[0], version: 4 }])),
        'POST /api/v1/roboapply/copilot/proposals/p_f/apply': () => {
          applies += 1;
          return applies === 1 ? fail(409, 'conflict', { reason: 'version_conflict', countAfter: 5 }) : ok({ applied: true, result: null });
        },
      }),
    );
    const { container } = renderUi(<CopilotCardView card={card('filter_diff', FIXTURES.filter_diff)} />);
    await screen.findByRole('button', { name: 'Apply changes' });
    expect(screen.getByTestId('filter-diff-conflict')).toHaveTextContent(/Your search changed after this suggestion/);
    expect(container.textContent).not.toContain('12');
    expect(screen.queryByText(/would show/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(await screen.findByText('Your search would show 5 jobs.')).toBeInTheDocument();
    expect(http.to('POST', '/api/v1/roboapply/copilot/proposals/p_f/apply')[0].body).toEqual({ baseVersion: 3 });
    expect(container.textContent).not.toContain('12');

    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    await screen.findByText('Changes applied.');
    expect(http.to('POST', '/api/v1/roboapply/copilot/proposals/p_f/apply')[1].body).toEqual({ baseVersion: 4 });
    expect(screen.getByRole('link', { name: 'Show 5 jobs' })).toHaveAttribute('href', '/jobs');
  });

  it('Not quite retries once with the current profile when the revert hits a version conflict', async () => {
    let patches = 0;
    const current = { ...PROFILES().profiles[0], version: 7, filters: { workModels: ['remote', 'hybrid'] } };
    const http = installFetch(
      routes({
        'POST /api/v1/roboapply/copilot/proposals/p_f/apply': () => ok({ applied: true, result: null }),
        'PATCH /api/v1/roboapply/search-profiles/sp_main': () => {
          patches += 1;
          return patches === 1 ? fail(409, 'version_conflict', { profile: current }) : ok({ ...PROFILES().profiles[0], version: 8 });
        },
      }),
    );
    renderUi(<CopilotCardView card={card('filter_diff', FIXTURES.filter_diff)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Not quite' }));
    await screen.findByText('Your previous search is back.');
    const sent = http.to('PATCH', '/api/v1/roboapply/search-profiles/sp_main');
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toMatchObject({ baseVersion: 7, filters: { workModels: ['remote'] } });
  });

  it('an expired suggestion cannot be applied', () => {
    installFetch(routes());
    renderUi(<CopilotCardView card={card('filter_diff', { ...(FIXTURES.filter_diff as object), expiresAt: '2020-01-01T00:00:00.000Z' })} />);
    expect(screen.getByText('This suggestion expired. Ask again for a fresh one.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument();
  });
});

describe('credit_action', () => {
  it('shows the cost before anything runs and spends only on confirm, with an idempotency key', async () => {
    const http = installFetch(
      routes({ 'POST /api/v1/roboapply/copilot/proposals/p_c/apply': () => ok({ applied: true, result: { card: { type: 'tailor_ready', id: 'x', data: { resumeId: 'res_9' } } } }) }),
    );
    renderUi(<CopilotCardView card={card('credit_action', FIXTURES.credit_action)} />);
    expect(screen.getByText('Uses 1 credit, only when you confirm.')).toBeInTheDocument();
    await screen.findByText('Uses 1 of your 2 left today');
    fireEvent.click(screen.getByRole('button', { name: 'Tailor my resume' }));
    const link = await screen.findByRole('link', { name: 'Open the tailored resume' });
    expect(link).toHaveAttribute('href', '/resume/res_9');
    const apply = http.to('POST', '/api/v1/roboapply/copilot/proposals/p_c/apply')[0];
    expect(apply.headers['Idempotency-Key']).toBeTruthy();
  });

  it('with no credits left it opens the out-of-credits sheet and sends nothing', async () => {
    const empty = CREDITS();
    (empty.summary.buckets as Record<string, { remaining: number }>).tailor.remaining = 0;
    const http = installFetch(routes({ 'GET /api/v1/roboapply/credits': () => ok(empty) }));
    renderUi(<CopilotCardView card={card('credit_action', FIXTURES.credit_action)} />);
    await screen.findByText(/None left today/);
    fireEvent.click(screen.getByRole('button', { name: 'Tailor my resume' }));
    await waitFor(() => expect(__outOfCreditsStore.get()).toMatchObject({ bucket: 'tailor' }));
    expect(http.to('POST', '/api/v1/roboapply/copilot/proposals/p_c/apply')).toHaveLength(0);
  });

  it('Not now dismisses without spending', async () => {
    const http = installFetch(routes({ 'POST /api/v1/roboapply/copilot/proposals/p_c/dismiss': () => ok(null) }));
    renderUi(<CopilotCardView card={card('credit_action', FIXTURES.credit_action)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await screen.findByText('Not done.');
    expect(http.to('POST', '/api/v1/roboapply/copilot/proposals/p_c/apply')).toHaveLength(0);
  });
});

describe('memory_add', () => {
  it('RoboApply: Remember this applies the proposal', async () => {
    const http = installFetch(routes({ 'POST /api/v1/roboapply/copilot/proposals/p_m/apply': () => ok({ applied: true, result: null }) }));
    renderUi(<CopilotCardView card={card('memory_add', FIXTURES.memory_add)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remember this' }));
    await screen.findByText('Saved. You can see or delete it in Settings.');
    expect(http.to('POST', '/api/v1/roboapply/compliance/consents')).toHaveLength(0);
  });

  it('GoApply: asks copilot_memory first, records it, then saves', async () => {
    const http = installFetch(
      routes({
        'GET /api/v1/roboapply/compliance/consents': () => ok(MEMORY_CONSENT(null)),
        'POST /api/v1/roboapply/compliance/consents': () => ok({ type: 'copilot_memory', granted: true, proseVersion: 'v1', proseHash: 'h1' }),
        'POST /api/v1/roboapply/copilot/proposals/p_m/apply': () => ok({ applied: true, result: null }),
      }),
    );
    renderUi(<CopilotCardView card={card('memory_add', FIXTURES.memory_add)} />, { brand: 'goapply' });
    expect(screen.getByTestId('memory-consent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remember this' })).not.toBeInTheDocument();
    await screen.findByText(/Let the Assistant remember preferences/);
    fireEvent.click(screen.getByRole('button', { name: 'Allow and remember' }));
    await screen.findByText('Saved. You can see or delete it in Settings.');
    const order = http.calls.filter((c) => c.method === 'POST').map((c) => c.path);
    expect(order).toEqual(['/api/v1/roboapply/compliance/consents', '/api/v1/roboapply/copilot/proposals/p_m/apply']);
    expect(http.to('POST', '/api/v1/roboapply/compliance/consents')[0].body).toMatchObject({ type: 'copilot_memory', granted: true, proseVersion: 'v1' });
  });

  it('GoApply: when the consent cannot be recorded nothing is saved', async () => {
    const http = installFetch(
      routes({
        'GET /api/v1/roboapply/compliance/consents': () => ok(MEMORY_CONSENT(null)),
        'POST /api/v1/roboapply/compliance/consents': () => fail(500, 'server_error'),
      }),
    );
    renderUi(<CopilotCardView card={card('memory_add', FIXTURES.memory_add)} />, { brand: 'goapply' });
    await screen.findByText(/Let the Assistant remember preferences/);
    fireEvent.click(screen.getByRole('button', { name: 'Allow and remember' }));
    await waitFor(() => expect(http.to('POST', '/api/v1/roboapply/compliance/consents')).toHaveLength(1));
    expect(http.to('POST', '/api/v1/roboapply/copilot/proposals/p_m/apply')).toHaveLength(0);
  });

  it('GoApply: with the consent already on it saves directly', async () => {
    const http = installFetch(
      routes({
        'GET /api/v1/roboapply/compliance/consents': () => ok(MEMORY_CONSENT(true)),
        'POST /api/v1/roboapply/copilot/proposals/p_m/apply': () => ok({ applied: true, result: null }),
      }),
    );
    renderUi(<CopilotCardView card={card('memory_add', FIXTURES.memory_add)} />, { brand: 'goapply' });
    fireEvent.click(await screen.findByRole('button', { name: 'Remember this' }));
    await screen.findByText('Saved. You can see or delete it in Settings.');
    expect(http.to('POST', '/api/v1/roboapply/compliance/consents')).toHaveLength(0);
  });
});
