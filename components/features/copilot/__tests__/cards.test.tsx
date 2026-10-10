// Assistant cards (WP-51; F-ORION-12): every card type renders from what the
// WP-50 tools really send (wireCards.ts runs them over the server's area
// fakes); an unknown type or data that does not parse renders nothing; the
// proposal cards change nothing until confirmed; GoApply asks the memory
// consent before anything is saved.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { ACTION_CARD_CAPS, CREDIT_ACTIONS, CopilotCardView } from '../cards';
import { NUDGE_KINDS } from '../../../../hooks/copilot/nudges';
import { countsByLabel } from '../cards/ApplicationsCard';
import { ALL_TRACKER_STATUSES } from '../../../../server/src/features/tracker/contract';
import { CARD_TYPES, CREDIT_ACTIONS as SERVER_CREDIT_ACTIONS, NUDGE_KINDS as SERVER_NUDGE_KINDS } from '../../../../server/src/features/copilot/contract';
import { __assistantChangeStore } from '../../../../hooks/feed/useCalibration';
import { __outOfCreditsStore } from '../../../../hooks/shared/useCreditGate';
import { CREDITS, MEMORY_CONSENT, PROFILE, PROFILES, card, fail, installFetch, ok, renderUi, type Route } from './testkit';
import { wireCard, wireCards } from './wireCards';
import type { CopilotCard } from '../../../../lib/api/contracts/copilot';

vi.mock('../../../../server/src/services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const push = vi.fn();
vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return { ...real, useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), forward: vi.fn() }), usePathname: () => '/jobs' };
});

const AS_OF = '2026-10-01T00:00:00.000Z';

/** One card per contract type, as the server's tools produce it (filled in beforeAll). */
let WIRE: Record<string, CopilotCard> = {};
const wire = (type: string): unknown => WIRE[type]!.data;
beforeAll(async () => {
  WIRE = await wireCards();
});

/**
 * Scenario cards for the proposal flows below: the producers' shapes with the
 * ids, versions and counts each scenario needs. (`filter_diff` keeps a plain
 * `countAfter` number here: the CountView count is a WP-93 carry-over.)
 */
const FIXTURES: Record<string, unknown> = {
  filter_diff: { proposalId: 'p_f', status: 'pending', searchProfileId: 'sp_main', baseVersion: 3, reason: 'You asked for hybrid jobs.', ops: [{ op: 'add', path: 'workModels', value: 'hybrid' }], changes: [], countBefore: null, countAfter: 12, expiresAt: '2099-01-01T00:00:00.000Z' },
  credit_action: { proposalId: 'p_c', status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z', action: 'tailor', bucket: 'tailor', cost: 1, jobId: 'job_1', remaining: 2, resetsAt: '2026-10-11T00:00:00.000Z' },
  memory_add: { proposalId: 'p_m', status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z', fact: 'Prefers remote jobs in Berlin time zones.', consentRequired: false },
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

  it('a server tool produces every contract card type', () => {
    expect(Object.keys(WIRE).sort()).toEqual([...CARD_TYPES].sort());
  });

  it.each([...CARD_TYPES])('%s (as the server sends it)', async (type) => {
    installFetch(routes({ 'GET /api/v1/roboapply/search-profiles': () => ok(PROFILES([PROFILE({ id: 'sp_1', version: 3 })])) }));
    const { container } = renderUi(<CopilotCardView card={WIRE[type]!} />, { flags: FLAGS });
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
    const { container } = renderUi(<CopilotCardView card={card('action', wire('action'))} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('link', { name: 'Show jobs sorted this way' })).not.toBeInTheDocument();
  });

  it('applications: real tracker statuses get their own labels; bookmarked is Saved; legacy statuses fold', () => {
    installFetch(routes());
    const data = { byStatus: { bookmarked: 5, first_call: 2, final_round: 1, applying: 1, applied: 3, withdrawn: 1, mystery_stage: 2, offer: 0 }, followUps: [] };
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
      ...card('applications', wire('applications')),
      sources: [{ value: 1, asOf: AS_OF }, { value: 2, source: 'index', asOf: AS_OF, url: 'ftp://example.com/x' }, null],
    } as never;
    const { container } = renderUi(<CopilotCardView card={bad} />);
    expect(container.querySelector('[data-card="applications"]')).not.toBeNull();
    expect(container.querySelector('a[href^="ftp:"]')).toBeNull();
  });

  it('job_list: links, tier word and the fit line', () => {
    installFetch(routes());
    renderUi(<CopilotCardView card={card('job_list', wire('job_list'))} />);
    expect(screen.getAllByRole('link', { name: 'Data Analyst' })[0]).toHaveAttribute('href', expect.stringContaining('job_1'));
    expect(screen.getAllByText('Good fit').length).toBeGreaterThan(0);
    expect(screen.getByText('This is not your chance of getting hired.')).toBeInTheDocument();
  });

  it('fit_analysis shows the AI badge on GoApply only', () => {
    installFetch(routes());
    const { container, unmount } = renderUi(<CopilotCardView card={card('fit_analysis', wire('fit_analysis'))} />, { brand: 'goapply' });
    expect(container.querySelector('[data-ai-label]')).not.toBeNull();
    unmount();
    const ra = renderUi(<CopilotCardView card={card('fit_analysis', wire('fit_analysis'))} />);
    expect(ra.container.querySelector('[data-ai-label]')).toBeNull();
  });

  it('fit_analysis: the deterministic skills under their own headings, the AI gaps apart from missing skills', () => {
    installFetch(routes());
    const { container } = renderUi(<CopilotCardView card={card('fit_analysis', wire('fit_analysis'))} />);
    const section = (title: string) => {
      const h = [...container.querySelectorAll('h4')].find((x) => x.textContent === title);
      return h?.nextElementSibling?.textContent ?? '';
    };
    expect(section('What lines up')).toBe('SQL');
    expect(section('What the post asks for that your resume does not show')).toBe('GraphQL');
    expect(section('Worth mentioning')).toBe('Four years of SQL reporting');
    expect(section('What could be stronger')).toBe('No dashboard work described');
  });

  it('fit_analysis for a quick estimate has no AI badge', () => {
    installFetch(routes());
    const pre = { ...(wire('fit_analysis') as object), kind: 'pre', aiWritten: false, strengths: [], gaps: [] };
    const { container } = renderUi(<CopilotCardView card={card('fit_analysis', pre)} />, { brand: 'goapply' });
    expect(container.querySelector('[data-card="fit_analysis"]')).not.toBeNull();
    expect(container.querySelector('[data-ai-label]')).toBeNull();
  });

  /** The salary card's data with `stats` replaced (posted pay dropped unless given). */
  const salaryWith = (stats: Record<string, unknown>, posted: unknown = null) => {
    const real = wire('salary') as { stats: Record<string, unknown> };
    return { ...real, posted, stats: { ...real.stats, ...stats } };
  };

  it('salary below 20 posts renders "—" and says there is not enough data', () => {
    installFetch(routes());
    const small = salaryWith({ median: null, p25: null, p75: null, listedCount: { value: 12, source: 'index', sampleSize: 12, asOf: AS_OF, method: 'computed' } });
    const { container } = renderUi(<CopilotCardView card={card('salary', small)} />);
    expect(container.textContent).toContain('—');
    expect(container.textContent).not.toMatch(/\$\d/);
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
    const noN = salaryWith({ median: { value: 105000, source: 'index', asOf: AS_OF, method: 'computed' }, listedCount: null });
    const { container } = renderUi(<CopilotCardView card={card('salary', noN)} />);
    expect(container).toBeEmptyDOMElement();
    expect(container.textContent).not.toMatch(/105,000/);
  });

  it('salary: the post\'s own pay and the middle half across N similar posts, each with its source', () => {
    installFetch(routes());
    const { container } = renderUi(<CopilotCardView card={card('salary', wire('salary'))} />);
    expect(container.textContent).toContain('In this post');
    expect(container.textContent).toMatch(/\$90,000.*\$120,000/);
    expect(container.textContent).toMatch(/\$95,000.*\$118,000/);
    expect(container.textContent).toMatch(/32/);
    expect(container.querySelectorAll('[data-source-note]').length).toBe(2);
  });

  it('contacts never shows a person without a named source', () => {
    installFetch(routes());
    const data = { fromYourCompanies: [{ id: 'x', fullName: 'No Source', source: 'mystery' }], fromYourSchools: [], recruiters: [{ id: 'y', fullName: 'Unnamed Bank', source: 'bank_recruiter', sourceName: null }], searchLinks: [] };
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
    renderUi(<CopilotCardView card={card('interview_plan', wire('interview_plan'))} />);
    expect(screen.getByText('From our question bank')).toBeInTheDocument();
    expect(screen.getByText('Written by AI')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Practice for this job' }));
    expect(push).toHaveBeenCalledWith('/practice?job=job_1&from=assistant');
  });

  it('competitiveness and campus_deadlines hide when their flags are off', () => {
    installFetch(routes());
    const a = renderUi(<CopilotCardView card={card('competitiveness', wire('competitiveness'))} />);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    const b = renderUi(<CopilotCardView card={card('campus_deadlines', wire('campus_deadlines'))} />);
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

describe('WP-50 producers ↔ WP-51 cards (Wave 4 gate)', () => {
  it('client and server share one credit-action and one nudge vocabulary', () => {
    expect([...CREDIT_ACTIONS].sort()).toEqual([...SERVER_CREDIT_ACTIONS].sort());
    expect([...NUDGE_KINDS].sort()).toEqual([...SERVER_NUDGE_KINDS].sort());
  });

  it('propose_filter_change: the card previews the ops and offers Apply changes', async () => {
    installFetch(routes({ 'GET /api/v1/roboapply/search-profiles': () => ok(PROFILES([PROFILE({ id: 'sp_1', version: 3 })])) }));
    renderUi(<CopilotCardView card={WIRE.filter_diff!} />);
    await screen.findByRole('button', { name: 'Apply changes' });
    expect(screen.getByText('Add')).toBeInTheDocument();
  });

  it('rewrite_resume_section: the rewrite proposal shows its cost, and applying links to the suggestions', async () => {
    const proposal = await wireCard('rewrite_proposal');
    const proposalId = (proposal.data as { proposalId: string }).proposalId;
    const http = installFetch(routes({ [`POST /api/v1/roboapply/copilot/proposals/${proposalId}/apply`]: () => ok({ applied: true, result: { card: WIRE.rewrite_ready } }) }));
    renderUi(<CopilotCardView card={proposal} />);
    expect(screen.getByText('Rewrite this part of your resume')).toBeInTheDocument();
    expect(screen.getByText('Uses 1 credit, only when you confirm.')).toBeInTheDocument();
    expect(http.to('POST', `/api/v1/roboapply/copilot/proposals/${proposalId}/apply`)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Write the rewrites' }));
    const link = await screen.findByRole('link', { name: 'Review and apply in the resume check' });
    expect(link).toHaveAttribute('href', '/resume/res_1/check?issue=iss_1');
  });

  it('add_external_job: after applying, the card links to the added job', async () => {
    const proposal = await wireCard('job_import_proposal');
    const proposalId = (proposal.data as { proposalId: string }).proposalId;
    installFetch(routes({ [`POST /api/v1/roboapply/copilot/proposals/${proposalId}/apply`]: () => ok({ applied: true, result: { card: WIRE.job_imported } }) }));
    renderUi(<CopilotCardView card={proposal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add the job' }));
    expect(await screen.findByRole('link', { name: 'Open the job' })).toHaveAttribute('href', '/jobs/job_new');
  });

  it('job_imported names the job from the import draft; an unfinished import links to Added jobs', () => {
    installFetch(routes());
    const done = renderUi(<CopilotCardView card={WIRE.job_imported!} />);
    expect(screen.getByText('Analyst · Beta')).toBeInTheDocument();
    done.unmount();
    const unfinished = { status: 'needs_fields', jobId: null, importId: 'imp_1', title: null, company: null, href: '/jobs/added?import=imp_1' };
    renderUi(<CopilotCardView card={card('job_imported', unfinished)} />);
    expect(screen.getByText('This job is not added yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Finish adding the job' })).toHaveAttribute('href', '/jobs/added?import=imp_1');
  });

  it('draft_outreach: the open_link action links to the job\'s People tab', async () => {
    installFetch(routes());
    renderUi(<CopilotCardView card={await wireCard('outreach_link')} />);
    expect(screen.getByRole('link', { name: 'Open the People tab for this job' })).toHaveAttribute('href', '/jobs/job_1?tab=people');
  });

  it('an open_link to anything but an app path renders nothing', () => {
    installFetch(routes());
    const { container } = renderUi(<CopilotCardView card={card('action', { kind: 'open_link', href: 'https://evil.example', label: 'people' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('resume_tips renders the localized check text for the issue type, not the stored English', () => {
    installFetch(routes());
    renderUi(<CopilotCardView card={WIRE.resume_tips!} />);
    expect(screen.getByText('Weak opener: "Helped with"')).toBeInTheDocument();
    expect(screen.queryByText('Weak verb')).not.toBeInTheDocument();
  });

  it('resume_tips falls back to the stored text for a type this build does not know', () => {
    installFetch(routes());
    const data = { ...(wire('resume_tips') as object), issues: [{ id: 'i9', type: 'brand_new_rule', why: 'Server fallback text.', how: '', section: 'summary' }] };
    renderUi(<CopilotCardView card={card('resume_tips', data)} />);
    expect(screen.getByText('Server fallback text.')).toBeInTheDocument();
  });

  it('applications: counts by status and the tracker\'s follow-up facts', () => {
    installFetch(routes());
    const { container } = renderUi(<CopilotCardView card={WIRE.applications!} />);
    expect(container.textContent).toContain('Saved: 2');
    expect(container.textContent).toContain('Applied: 3');
    expect(container.textContent).toContain('Acme: no reply for 12 days');
    expect(container.textContent).toContain('BI Analyst: interview within 24 hours');
  });

  it('profile_gaps uses the profile page\'s field labels', () => {
    installFetch(routes());
    const { container } = renderUi(<CopilotCardView card={WIRE.profile_gaps!} />);
    expect(container.textContent).toContain('At least one skill');
    expect(container.textContent).toContain('Where you can work');
  });

  it('campus_deadlines links the official page and says when no other source was used', () => {
    installFetch(routes());
    renderUi(<CopilotCardView card={WIRE.campus_deadlines!} />, { flags: FLAGS });
    expect(screen.getByRole('link', { name: '示例公司 · 2027 校园招聘' })).toHaveAttribute('href', 'https://campus.example.com/2027');
    expect(screen.getByText('Official page')).toBeInTheDocument();
  });

  it('contacts: the opted-in recruiter with its bank and the user\'s own contact with its source', () => {
    installFetch(routes());
    const { container } = renderUi(<CopilotCardView card={WIRE.contacts!} />);
    expect(screen.getByText('People at Acme')).toBeInTheDocument();
    expect(container.textContent).toContain('Sam Example');
    expect(container.textContent).toContain('From RoboHire');
    expect(container.textContent).toContain('Alex Sample');
    expect(container.textContent).toContain('From your imported connections');
  });

  it('company: each sourced fact once, with its own source line', () => {
    installFetch(routes());
    const { container } = renderUi(<CopilotCardView card={WIRE.company!} />);
    expect(screen.getByText('About Acme')).toBeInTheDocument();
    expect(container.textContent).toContain('Software');
    expect(container.querySelectorAll('[data-source-note]').length).toBe(1);
  });
});
