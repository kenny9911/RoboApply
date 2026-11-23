// Alice's page with the API answered by fixtures (lib/api/alice mocked):
// the greeting and its resume start, the two profiles compared with Alice's
// "differs" marks, picking one (a `choose` turn), a version showing what
// changed with the old value, the save card's choice when no search is free,
// and the page that says Alice is not switched on yet.

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AliceJobProfile, AliceStreamEvent, AliceThreadView } from '../../../../lib/api/contracts/alice';
import { RoboApiError } from '../../../../lib/api/client';

vi.mock('next/navigation', () => ({
  usePathname: () => '/alice',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const api = vi.hoisted(() => ({
  thread: null as unknown,
  threadError: null as unknown,
  turns: [] as unknown[],
  turnEvents: [] as unknown[],
}));

vi.mock('../../../../lib/api/alice', () => ({
  getAliceThread: vi.fn(async () => {
    if (api.threadError) throw api.threadError;
    return api.thread;
  }),
  aliceTurn: vi.fn(async (body: unknown, opts: { onEvent: (e: unknown) => void }) => {
    api.turns.push(body);
    for (const e of api.turnEvents) opts.onEvent(e);
    return { status: 'done' };
  }),
  getAliceApplications: vi.fn(async () => ({
    market: 'intl',
    stages: [{ status: 'applied', count: 2 }],
    facts: { active: 2, waiting: 2, interviewing: 0, offers: 0, needsYou: 0, noReply: 0, remindersDue: 0, readyToCheck: null, appliedThisWeek: 1 },
    needsYou: [],
    reminders: [],
    open: [],
    asOf: '2026-11-23T09:00:00.000Z',
  })),
  listAliceProfiles: vi.fn(async () => ({ items: [] })),
  getAliceMatches: vi.fn(async () => ({ profileId: 'jp1', items: [], searchId: null })),
  patchAliceProfile: vi.fn(),
  setAliceReminder: vi.fn(),
  clearAliceReminder: vi.fn(),
}));

vi.mock('../../../../hooks/useResumes', () => ({
  useResumeList: () => ({ data: { resumes: [{ id: 'rv1', name: 'Maya resume', kind: 'base', isPrimary: true }] }, isLoading: false }),
  useUploadResumeMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('../../../../lib/api/compliance', () => ({
  getConsents: vi.fn(async () => ({ items: [] })),
  recordConsent: vi.fn(),
}));

import { renderToday } from '../../today/today.testkit';
import { AlicePage } from '../AlicePage';

const A: AliceJobProfile = {
  id: 'a',
  label: 'Steady climb',
  headline: 'Senior product designer at a payments scale-up',
  summary: 'Grow in payments design.',
  titles: ['Senior Product Designer'],
  searchTitles: [],
  levels: ['senior'],
  workModels: ['remote'],
  places: [{ label: 'Berlin', city: 'Berlin', country: 'DE' }],
  pay: { amount: 85000, currency: 'EUR', period: 'year' },
  industries: ['Fintech'],
  companyKinds: ['scaleup'],
  companySizes: [],
  companies: [{ name: 'Stripe', source: 'you' }, { name: 'Adyen', source: 'alice' }],
  skills: [],
  mustHaves: [],
  niceToHaves: [],
  dealbreakers: ['Weekly travel'],
  whyItFits: [],
  tradeoff: 'Less scope than a lead role.',
  jobTypes: [],
};
const B: AliceJobProfile = { ...A, id: 'b', label: 'Step up', headline: 'Design lead at a start-up', levels: ['lead_staff'], companyKinds: ['startup'] };

function thread(over: Partial<AliceThreadView>): AliceThreadView {
  return {
    id: 'th1',
    stage: 'intake',
    locale: 'en',
    resume: null,
    resumeSkipped: false,
    brief: {
      roles: [],
      levels: [],
      workModels: [],
      places: [],
      pay: null,
      industries: [],
      avoidIndustries: [],
      companyKinds: [],
      companySizes: [],
      companies: [],
      avoidCompanies: [],
      dreamJob: null,
      values: [],
      dealbreakers: [],
      timing: null,
      jobTypes: [],
      needsSponsorship: null,
      notes: [],
    },
    topics: { all: ['roles', 'level', 'workSetting', 'places'], required: ['roles', 'level'], covered: [], declined: [] },
    ready: false,
    pending: null,
    analysis: null,
    drafts: [],
    revisions: [],
    currentVersion: 0,
    savedProfile: null,
    saveTarget: null,
    messages: [{ id: 'm0', role: 'alice', text: '', blocks: [{ type: 'greeting', hasResume: true, resumeName: 'Maya resume' }], agent: 'system', at: '2026-11-23T09:00:00.000Z' }],
    createdAt: '2026-11-23T09:00:00.000Z',
    updatedAt: '2026-11-23T09:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  api.thread = thread({});
  api.threadError = null;
  api.turns = [];
  api.turnEvents = [];
});

describe('Alice', () => {
  it('greets as an AI agent, says the person submits, and offers the resume to start from', async () => {
    renderToday(<AlicePage />, { flags: { alice: true } });
    expect(await screen.findByText(/I'm Alice, an AI agent/)).toBeInTheDocument();
    expect(screen.getByText(/You submit every application yourself/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use "Maya resume"' }));
    await waitFor(() => expect(api.turns).toEqual([{ kind: 'resume', resumeVariantId: 'rv1' }]));
  });

  it('compares the two profiles row by row, marks the rows that differ, and picks one', async () => {
    api.thread = thread({
      stage: 'choosing',
      drafts: [A, B],
      ready: true,
      analysis: { summary: 'Two roads.', strengths: [], motivations: [], constraints: [], axis: 'scope', question: 'Stay senior or step up?', directions: [{ id: 'a', label: 'Steady climb', summary: '' }, { id: 'b', label: 'Step up', summary: '' }] },
    });
    renderToday(<AlicePage />, { flags: { alice: true } });
    expect(await screen.findByRole('heading', { name: 'Stay senior or step up?' })).toBeInTheDocument();
    const cardA = screen.getByRole('article', { name: 'Steady climb' });
    // Level and kind of company differ: the rows say so to a screen reader too.
    expect(within(cardA).getAllByText(/differs/)).toHaveLength(2);
    // A company the person named reads as theirs; Alice's example is labelled hers.
    expect(within(cardA).getByText(/\(You named it\)/)).toBeInTheDocument();
    expect(within(cardA).getByText(/\(Alice's example\)/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tell Alice what to change'), { target: { value: 'but hybrid is fine' } });
    fireEvent.click(within(cardA).getByRole('button', { name: /This one is closer/ }));
    await waitFor(() => expect(api.turns).toEqual([{ kind: 'choose', draftId: 'a', comment: 'but hybrid is fine' }]));
  });

  it('shows a version with what changed and the old value, and the save choice when no search is free', async () => {
    const v1 = { version: 1, profile: { ...A, id: 'p' }, comment: null, notes: [], changed: [], origin: 'pick' as const, at: '' };
    const v2 = { version: 2, profile: { ...A, id: 'p', workModels: ['remote' as const, 'hybrid' as const] }, comment: 'hybrid too', notes: ['Hybrid added'], changed: ['workModels' as const], origin: 'edit' as const, at: '' };
    api.thread = thread({ stage: 'refining', revisions: [v1, v2], currentVersion: 2, saveTarget: { mode: 'choose', search: { id: 's1', name: 'Main search' } } });
    renderToday(<AlicePage />, { flags: { alice: true } });
    expect(await screen.findByText('Version 2', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Changed')).toBeInTheDocument();
    expect(screen.getByText('Was: Remote')).toBeInTheDocument();
    expect(screen.getByText('Hybrid added')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use it for my search "Main search"' }));
    await waitFor(() => expect(api.turns).toEqual([{ kind: 'save', search: 'replace', name: 'Steady climb' }]));
    // Restoring version 1 is one tap from the trail.
    fireEvent.click(screen.getByRole('button', { name: /Restore/ }));
    await waitFor(() => expect(api.turns.at(-1)).toEqual({ kind: 'restore', version: 1 }));
  });

  it('shows the steps a turn really runs, from the stream', async () => {
    api.thread = thread({ stage: 'intake', resumeSkipped: true });
    let release!: () => void;
    const { aliceTurn } = await import('../../../../lib/api/alice');
    vi.mocked(aliceTurn).mockImplementationOnce(async (_body, opts) => {
      opts.onEvent({ event: 'progress', data: { step: 'writing_profiles', state: 'running' } } as AliceStreamEvent);
      await new Promise<void>((r) => (release = r));
      return { status: 'done' };
    });
    renderToday(<AlicePage />, { flags: { alice: true } });
    const box = await screen.findByLabelText('Message Alice');
    fireEvent.change(box, { target: { value: 'Product design' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Writing two job profiles')).toBeInTheDocument();
    expect(screen.getAllByText('Alice is working on it').length).toBeGreaterThan(0);
    await act(async () => release());
    await waitFor(() => expect(screen.queryByText('Writing two job profiles')).toBeNull());
  });

  it('says Alice is not switched on yet when the database has no Alice tables', async () => {
    api.threadError = new RoboApiError('not ready', { code: 'ai_unavailable', status: 503, payload: { code: 'ai_unavailable', details: { reason: 'alice_not_ready' } } });
    renderToday(<AlicePage />, { flags: { alice: true } });
    expect(await screen.findByRole('heading', { name: "Alice isn't switched on here yet" })).toBeInTheDocument();
  });
});
