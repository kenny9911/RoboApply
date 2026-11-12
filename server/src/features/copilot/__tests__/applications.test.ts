// @vitest-environment node
// The Assistant runs the loop (docs/agent-driven/REDESIGN.md §1, §9): it reads
// where a job stands on the user's list, proposes to put the job there, and
// proposes to prepare its application with the cost on the card before
// anything is spent. Applying goes through the applications agent's own calls
// (the list, the credit gate, the weekly allowance, the states), keyed by the
// proposal; nothing is ever submitted (D1). Fakes only: no network, no
// database, no model.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getBrand } from '../../../platform/brand/registry.js';
import { createAgentService } from '../../agent/service.js';
import { job as agentJob, makeDb as makeAgentDb, makeDeps as makeAgentDeps, usageLine } from '../../agent/__tests__/testkit.js';
import { APPLICATIONS_RULE, systemPrompt } from '../prompt.js';
import { STATE_MEANING } from '../tools/applications.js';
import { availableTools, runToolCall, SEEKER_TOOLS } from '../tools/registry.js';
import type { CopilotAreas, ToolContext } from '../types.js';
import { listItem, listJob, prepareQuote } from './areaFakes.js';
import { NOW, USER, fakeAreas, makeService, newThread, runTurn, type FakeAreas, type Harness } from './testkit.js';

const APPLICATION_TOOLS = ['application_status', 'add_to_list', 'prepare_application'];
const WRITES = ['addToList', 'prepareApplication', 'createTailorSession', 'createCoverLetter', 'patchFilters'] as const;

function ctxFor(over: Partial<ToolContext> & { areasOver?: Partial<CopilotAreas>; agent?: boolean } = {}) {
  const areas = fakeAreas(over.areasOver);
  const proposals: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  let n = 0;
  const brand = getBrand('roboapply');
  const ctx: ToolContext = {
    userId: USER,
    brand,
    market: brand.market,
    locale: 'en',
    now: NOW,
    messageId: 'msg_1',
    contextJobId: null,
    resumeId: null,
    scope: 'seeker',
    areas,
    isEnabled: async (key) => key === 'agent' && over.agent !== false,
    hiringContactsMode: () => 'deeplinks_only',
    propose: async (draft) => {
      proposals.push(draft);
      return { id: `prop_${proposals.length}`, expiresAt: new Date(NOW.getTime() + 86_400_000) };
    },
    creditsLeft: async () => ({ remaining: 2, resetsAt: '2026-10-11T00:00:00.000Z' }),
    hasConsent: async () => false,
    newCardId: () => `card_${++n}`,
    ...over,
  };
  return { ctx, areas: areas as FakeAreas, proposals };
}

const call = (name: string, args: unknown) => ({ id: 'c1', name, arguments: JSON.stringify(args), parsedArguments: args });

async function run(name: string, args: unknown, setup = ctxFor(), allowed: string[] = ['job_1']) {
  const tools = await availableTools('seeker', setup.ctx);
  return runToolCall(call(name, args), tools, setup.ctx, new Set(allowed));
}

function expectNoWrites(areas: FakeAreas) {
  for (const w of WRITES) expect(areas[w], w).not.toHaveBeenCalled();
}

describe('the tools are offered with the capability `agent` only', () => {
  it('on: all three; off: none of them (the list’s own capability)', async () => {
    const on = (await availableTools('seeker', ctxFor().ctx)).map((t) => t.name);
    expect(on).toEqual(expect.arrayContaining(APPLICATION_TOOLS));
    const off = (await availableTools('seeker', ctxFor({ agent: false }).ctx)).map((t) => t.name);
    for (const name of APPLICATION_TOOLS) expect(off).not.toContain(name);
    expect(SEEKER_TOOLS.map((t) => t.name).filter((n) => APPLICATION_TOOLS.includes(n))).toEqual(APPLICATION_TOOLS);
  });

  it('the prompt explains the list (and who submits) only when the tools are offered', () => {
    const brand = getBrand('roboapply');
    const withTools = systemPrompt({ brand, locale: 'en', today: '2026-10-10', scope: 'seeker', tools: ['search_jobs', 'prepare_application'] });
    expect(withTools).toContain(APPLICATIONS_RULE);
    expect(APPLICATIONS_RULE).toMatch(/opens it and submits it on the employer's site/);
    expect(APPLICATIONS_RULE).toMatch(/never say one was sent or submitted/);
    expect(systemPrompt({ brand, locale: 'en', today: '2026-10-10', scope: 'seeker', tools: ['search_jobs'] })).not.toContain(APPLICATIONS_RULE);
    expect(systemPrompt({ brand, locale: 'en', today: '2026-10-10', scope: 'public', tools: ['prepare_application'] })).not.toContain(APPLICATIONS_RULE);
  });
});

describe('application_status (read only)', () => {
  it('tells the model which jobs are on the list and where each application stands; no card, no write', async () => {
    const s = ctxFor({
      areasOver: {
        jobPlaces: async () => ({
          items: [
            { jobId: 'job_1', job: listJob(), item: listItem('job_1', 'ready_for_review') },
            { jobId: 'job_2', job: listJob({ title: 'BI Analyst' }), item: null },
            { jobId: 'job_3', job: listJob({ closed: true }), item: null },
            { jobId: 'job_4', job: null, item: null },
          ],
          listFull: false,
        }),
      },
    });
    const r = await run('application_status', { jobIds: ['job_1', 'job_2', 'job_3', 'job_4'] }, s, ['job_1', 'job_2', 'job_3', 'job_4']);
    expect(s.areas.jobPlaces).toHaveBeenCalledWith(USER, ['job_1', 'job_2', 'job_3', 'job_4']);
    expect(r.output.cards ?? []).toEqual([]);
    expect(r.output.data).toMatchObject({
      jobs: [
        { jobId: 'job_1', onList: true, state: 'ready_for_review', meaning: STATE_MEANING.ready_for_review, canPrepare: false },
        { jobId: 'job_2', title: 'BI Analyst', onList: false, canAdd: true },
        { jobId: 'job_3', onList: false, canAdd: false, reason: 'job_closed' },
        { jobId: 'job_4', onList: false, canAdd: false, reason: 'not_available_for_the_list' },
      ],
      listFull: false,
    });
    expect((r.output.data as { note: string }).note).toMatch(/submits it on the employer's site themselves/);
    expectNoWrites(s.areas);
    expect(s.proposals).toEqual([]);
  });

  it('a job id no tool returned is refused before the list is read', async () => {
    const s = ctxFor();
    const r = await run('application_status', { jobIds: ['job_x'] }, s, ['job_1']);
    expect(r.output.data).toMatchObject({ error: 'unknown_job_id', jobIds: ['job_x'] });
    expect(s.areas.jobPlaces).not.toHaveBeenCalled();
  });
});

describe('add_to_list (a proposal; no credit)', () => {
  it('stores a list_add proposal and returns its card; nothing is added until the user confirms', async () => {
    const s = ctxFor();
    const r = await run('add_to_list', { jobId: 'job_1' }, s);
    expect(s.proposals).toEqual([{ kind: 'list_add', payload: { jobId: 'job_1', messageId: 'msg_1' } }]);
    expect(r.output.cards?.[0]).toMatchObject({ type: 'list_add', data: { proposalId: 'prop_1', status: 'pending', jobId: 'job_1', jobTitle: 'Data Analyst', company: 'Acme' } });
    expect(r.output.data).toMatchObject({ proposed: true, added: false, creditsItUses: 0 });
    expect(r.output.jobIds).toEqual(['job_1']);
    expectNoWrites(s.areas);
  });

  it('a job already on the list: where it stands (a status card), nothing proposed', async () => {
    const s = ctxFor({ areasOver: { jobPlaces: async () => ({ items: [{ jobId: 'job_1', job: listJob(), item: listItem('job_1', 'preparing') }], listFull: true }) } });
    const r = await run('add_to_list', { jobId: 'job_1' }, s);
    expect(s.proposals).toEqual([]);
    expect(r.output.cards?.[0]).toMatchObject({ type: 'application_status', data: { jobId: 'job_1', state: 'preparing', jobTitle: 'Data Analyst', company: 'Acme', trackerEntryId: null } });
    expect(r.output.data).toMatchObject({ alreadyOnList: true, proposed: false, state: 'preparing' });
  });

  it('a closed post, a full list and a job the user cannot list are said, never proposed', async () => {
    const closed = ctxFor({ areasOver: { jobPlaces: async () => ({ items: [{ jobId: 'job_1', job: listJob({ closed: true }), item: null }], listFull: false }) } });
    expect((await run('add_to_list', { jobId: 'job_1' }, closed)).output.data).toMatchObject({ available: false, reason: 'job_closed' });
    const full = ctxFor({ areasOver: { jobPlaces: async () => ({ items: [{ jobId: 'job_1', job: listJob(), item: null }], listFull: true }) } });
    expect((await run('add_to_list', { jobId: 'job_1' }, full)).output.data).toMatchObject({ available: false, reason: 'list_full' });
    const missing = ctxFor();
    expect((await run('add_to_list', { jobId: 'missing_1' }, missing, ['missing_1'])).output.data).toMatchObject({ available: false, reason: 'job_not_found' });
    for (const s of [closed, full, missing]) expect(s.proposals).toEqual([]);
  });
});

describe('prepare_application (a proposal; the cost is on the card before anything is spent)', () => {
  it('the card carries the agent’s own cost lines (the weekly allowance first); nothing runs or is charged', async () => {
    const s = ctxFor();
    const r = await run('prepare_application', { jobId: 'job_1' }, s);
    expect(s.areas.prepareQuote).toHaveBeenCalledWith(USER, 'job_1');
    expect(s.proposals).toEqual([
      {
        kind: 'prepare_application',
        payload: {
          jobId: 'job_1',
          credits: [
            { bucket: 'ready_kits', cost: 1 },
            { bucket: 'tailor', cost: 1 },
          ],
          messageId: 'msg_1',
        },
      },
    ]);
    expect(r.output.cards?.[0]).toMatchObject({
      type: 'prepare_application',
      data: {
        proposalId: 'prop_1',
        status: 'pending',
        jobId: 'job_1',
        addsToList: true,
        enough: true,
        aiAvailable: true,
        tailorEach: true,
        credits: [
          { bucket: 'ready_kits', cost: 1, remaining: 3, window: 'week', resetsAt: '2026-10-12T04:00:00.000Z' },
          { bucket: 'tailor', cost: 1, remaining: 2, window: 'day', resetsAt: '2026-10-11T00:00:00.000Z' },
        ],
      },
    });
    expect(r.output.data).toMatchObject({ proposed: true, started: false, addsToList: true, enough: true, uses: [{ what: 'applications from the weekly allowance', count: 1, left: 3 }, { what: 'tailoring credits', count: 1, left: 2 }] });
    expectNoWrites(s.areas);
  });

  it('a job on the list and still to prepare (picked or failed) is proposed without adding it again', async () => {
    const s = ctxFor({ areasOver: { prepareQuote: async () => prepareQuote('job_1', { item: listItem('job_1', 'failed') }) } });
    const r = await run('prepare_application', { jobId: 'job_1' }, s);
    expect(r.output.cards?.[0]).toMatchObject({ type: 'prepare_application', data: { addsToList: false } });
  });

  it('short of credits: still proposed, with what is left on the card and the model told so', async () => {
    const short = prepareQuote('job_1');
    short.proposal!.enough = false;
    short.proposal!.credits[1]!.remaining = 0;
    const s = ctxFor({ areasOver: { prepareQuote: async () => short } });
    const r = await run('prepare_application', { jobId: 'job_1' }, s);
    expect(r.output.cards?.[0]).toMatchObject({ data: { enough: false, credits: [expect.anything(), expect.objectContaining({ bucket: 'tailor', remaining: 0 })] } });
    expect((r.output.data as { note: string }).note).toMatch(/Not enough credits are left/);
  });

  it('already being prepared, ready or opened: never prepared twice; the status card says where it stands', async () => {
    for (const state of ['preparing', 'ready_for_review', 'approved', 'opened', 'applied'] as const) {
      const s = ctxFor({ areasOver: { prepareQuote: async () => prepareQuote('job_1', { item: listItem('job_1', state, { trackerEntryId: state === 'opened' ? 'te_1' : null }), proposal: null }) } });
      const r = await run('prepare_application', { jobId: 'job_1' }, s);
      expect(s.proposals, state).toEqual([]);
      expect(r.output.cards?.[0], state).toMatchObject({ type: 'application_status', data: { state } });
    }
  });

  it('a closed post, a full list (the job not on it) and a job the user cannot list are said, never proposed', async () => {
    const closed = ctxFor({ areasOver: { prepareQuote: async () => prepareQuote('job_1', { job: listJob({ closed: true }), proposal: null }) } });
    expect((await run('prepare_application', { jobId: 'job_1' }, closed)).output.data).toMatchObject({ available: false, reason: 'job_closed' });
    const full = ctxFor({ areasOver: { prepareQuote: async () => prepareQuote('job_1', { listFull: true }) } });
    expect((await run('prepare_application', { jobId: 'job_1' }, full)).output.data).toMatchObject({ available: false, reason: 'list_full' });
    // On the list already, a full list does not matter.
    const onList = ctxFor({ areasOver: { prepareQuote: async () => prepareQuote('job_1', { listFull: true, item: listItem('job_1', 'picked') }) } });
    expect((await run('prepare_application', { jobId: 'job_1' }, onList)).output.cards?.[0]).toMatchObject({ type: 'prepare_application' });
    const missing = ctxFor();
    expect((await run('prepare_application', { jobId: 'missing_1' }, missing, ['missing_1'])).output.data).toMatchObject({ available: false, reason: 'job_not_found' });
    for (const s of [closed, full, missing]) expect(s.proposals).toEqual([]);
  });
});

// ── Applying (proposals.ts), over the fake areas ──────────────────────────────

async function proposalFrom(h: Harness, contextJobId = 'job_1'): Promise<{ id: string; messageId: string; threadId: string }> {
  const t = await newThread(h, contextJobId);
  const events = await runTurn(h, t, 'please', { contextJobId });
  const card = events.find((e) => e.event === 'card')!.data as { data: { proposalId: string } };
  const done = events.at(-1)!.data as { messageId: string };
  return { id: card.data.proposalId, messageId: done.messageId, threadId: t };
}

function withTool(name: 'add_to_list' | 'prepare_application', over: Parameters<typeof makeService>[0] = {}, jobId = 'job_1') {
  return makeService({ rounds: [{ toolCalls: [{ name, args: { jobId } }] }, { chunks: ['Review the card.'] }], flags: { agent: true }, ...over });
}

async function storedCards(h: Harness, messageId: string) {
  const msg = await h.store.getMessage(messageId);
  return (msg!.cards as Array<{ type: string; data: { status?: string; state?: string } }>).map((c) => [c.type, c.data.status ?? c.data.state]);
}

describe('applying list_add', () => {
  it('puts the job on the list through the agent (no credit) and appends where it stands', async () => {
    const h = withTool('add_to_list');
    const p = await proposalFrom(h);
    expect(h.areas.addToList).not.toHaveBeenCalled();
    const res = await h.service.proposals.apply(USER, p.id, { locale: 'en' });
    expect(h.areas.addToList).toHaveBeenCalledWith(USER, 'job_1');
    expect(h.areas.prepareApplication).not.toHaveBeenCalled();
    expect(res).toMatchObject({ applied: true, result: { card: { type: 'application_status', data: { jobId: 'job_1', state: 'picked', jobTitle: 'Data Analyst', company: 'Acme' } } } });
    expect(await storedCards(h, p.messageId)).toEqual([
      ['list_add', 'applied'],
      ['application_status', 'picked'],
    ]);
    // A second click does nothing.
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'proposal_closed', status: 'applied' } });
    expect(h.areas.addToList).toHaveBeenCalledTimes(1);
    // The assistant credit is the turn's only charge.
    expect(h.credits.reserve.mock.calls.map((c) => (c[0] as { bucket: string }).bucket)).toEqual(['assistant']);
  });

  it('a full list: 409 queue_full passes through and the suggestion stays usable', async () => {
    const h = withTool('add_to_list');
    const p = await proposalFrom(h);
    h.areas.addToList.mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'conflict', status: 409, details: { reason: 'queue_full', room: 0 } }));
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'queue_full' } });
    expect((await h.store.getProposal(p.id))!.status).toBe('pending');
    expect(await h.service.proposals.apply(USER, p.id)).toMatchObject({ applied: true });
  });
});

describe('applying prepare_application', () => {
  it('adds the job, then starts the preparation keyed by the proposal; the result links to where it stands', async () => {
    const h = withTool('prepare_application');
    const p = await proposalFrom(h);
    // Proposing spent nothing: no list write, no preparation.
    expect(h.areas.prepareQuote).toHaveBeenCalledTimes(1);
    expect(h.areas.addToList).not.toHaveBeenCalled();
    expect(h.areas.prepareApplication).not.toHaveBeenCalled();
    const res = await h.service.proposals.apply(USER, p.id, { locale: 'en' });
    expect(h.areas.addToList).toHaveBeenCalledWith(USER, 'job_1');
    expect(h.areas.prepareApplication).toHaveBeenCalledWith(USER, 'qi_job_1', `copilot:${p.id}`);
    expect(res).toMatchObject({ applied: true, result: { card: { type: 'application_status', data: { jobId: 'job_1', state: 'preparing' } } } });
    expect(await storedCards(h, p.messageId)).toEqual([
      ['prepare_application', 'applied'],
      ['application_status', 'preparing'],
    ]);
  });

  it('idempotent: a second click is refused and nothing is prepared or reserved twice', async () => {
    const h = withTool('prepare_application');
    const p = await proposalFrom(h);
    await h.service.proposals.apply(USER, p.id);
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'proposal_closed' } });
    expect(h.areas.prepareApplication).toHaveBeenCalledTimes(1);
  });

  it('out of credits: the 402 passes through (the client opens the out-of-credits sheet); the suggestion stays pending and a retry uses the same key', async () => {
    const h = withTool('prepare_application');
    const p = await proposalFrom(h);
    h.areas.prepareApplication.mockRejectedValueOnce(
      Object.assign(new Error('No tailor credits left in this day'), { code: 'credits_exhausted', status: 402, bucket: 'tailor', resetsAt: new Date('2026-10-11T00:00:00Z'), upgradable: true }),
    );
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'credits_exhausted', bucket: 'tailor' });
    expect((await h.store.getProposal(p.id))!.status).toBe('pending');
    expect(await storedCards(h, p.messageId)).toEqual([['prepare_application', 'pending']]);
    await h.service.proposals.apply(USER, p.id);
    expect(h.areas.prepareApplication.mock.calls.map((c) => c[2])).toEqual([`copilot:${p.id}`, `copilot:${p.id}`]);
  });

  it('already on the list and past "To prepare": nothing is prepared again; the result says where it stands', async () => {
    const h = withTool('prepare_application', { areas: { addToList: async (_u, jobId) => listItem(jobId, 'ready_for_review') } });
    const p = await proposalFrom(h);
    const res = await h.service.proposals.apply(USER, p.id);
    expect(h.areas.prepareApplication).not.toHaveBeenCalled();
    expect(res).toMatchObject({ applied: true, result: { card: { type: 'application_status', data: { state: 'ready_for_review' } } } });
  });

  it('started meanwhile from another window: that is where it stands, and this click used nothing', async () => {
    const h = withTool('prepare_application');
    const p = await proposalFrom(h);
    h.areas.prepareApplication.mockRejectedValueOnce(Object.assign(new Error('moved'), { code: 'conflict', status: 409, details: { reason: 'queue_invalid_transition' } }));
    h.areas.jobPlaces.mockResolvedValueOnce({ items: [{ jobId: 'job_1', job: listJob(), item: listItem('job_1', 'preparing') }], listFull: false });
    expect(await h.service.proposals.apply(USER, p.id)).toMatchObject({ applied: true, result: { card: { data: { state: 'preparing' } } } });
  });

  it('a closed post closes the suggestion: 409 job_closed, nothing added or used', async () => {
    const h = withTool('prepare_application');
    const p = await proposalFrom(h);
    h.areas.addToList.mockRejectedValueOnce(Object.assign(new Error('This job is no longer listed.'), { code: 'gone', status: 410, details: { reason: 'job_closed' } }));
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'conflict', status: 409, details: { reason: 'job_closed' } });
    expect(h.areas.prepareApplication).not.toHaveBeenCalled();
    expect((await h.store.getProposal(p.id))!.status).toBe('conflict');
    expect(await storedCards(h, p.messageId)).toEqual([['prepare_application', 'conflict']]);
  });
});

describe('the capability `agent` off', () => {
  it('no tool is offered: the model cannot propose; nothing is read or written', async () => {
    const h = withTool('prepare_application', { flags: { agent: false } });
    const t = await newThread(h, 'job_1');
    const events = await runTurn(h, t, 'prepare it', { contextJobId: 'job_1' });
    expect(events.some((e) => e.event === 'card')).toBe(false);
    expect(h.areas.prepareQuote).not.toHaveBeenCalled();
    expect(h.areas.addToList).not.toHaveBeenCalled();
    const offered = (h.llm.calls[0]!.opts.tools ?? []).map((tool) => tool.name);
    for (const name of APPLICATION_TOOLS) expect(offered).not.toContain(name);
  });

  it('switched off after the suggestion: applying is 404 feature_disabled before anything runs; the suggestion stays pending', async () => {
    const h = withTool('prepare_application');
    const p = await proposalFrom(h);
    (h.deps.isEnabled as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => key !== 'agent');
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'feature_disabled', status: 404, details: { reason: 'feature_disabled', feature: 'agent' } });
    expect(h.areas.addToList).not.toHaveBeenCalled();
    expect(h.areas.prepareApplication).not.toHaveBeenCalled();
    expect((await h.store.getProposal(p.id))!.status).toBe('pending');
  });
});

// ── End to end with the real applications agent (its service over its fake database) ──

describe('with the real applications agent behind the seam', () => {
  function world(agentOver: Parameters<typeof makeAgentDeps>[2] = {}) {
    const db = makeAgentDb({
      user: [{ id: USER, brand: 'roboapply' }],
      seekerProfile: [{ id: 'sp1', userId: USER, timezone: 'America/New_York' }],
      rAResumeVariant: [{ id: 'rv_base', userId: USER, kind: 'base', isPrimary: true, lastEditedAt: new Date('2026-10-01T00:00:00Z') }],
      rAJob: [agentJob('j1'), agentJob('j2', { descriptionPlain: 'Please include a cover letter.' })],
    });
    const fakes = makeAgentDeps(db, 'roboapply', {
      creditUsage: async () => ({ lines: { tailor: usageLine(2), cover_letter: usageLine(4), ready_kits: usageLine(3, 'week') }, upgradable: true }),
      ...agentOver,
    });
    const agent = createAgentService(fakes.deps);
    // The production adapter's calls (areas.ts), over this agent.
    const areas: Partial<CopilotAreas> = {
      jobPlaces: (userId, jobIds) => agent.jobPlaces(userId, jobIds),
      prepareQuote: (userId, jobId) => agent.quoteJob(userId, jobId),
      addToList: async (userId, jobId) => (await agent.addToQueue(userId, { jobIds: [jobId], addedVia: 'copilot' })).items.find((i) => i.jobId === jobId)!,
      prepareApplication: (userId, id, key) => agent.prepare(userId, [id], true, { idempotencyKey: key }),
    };
    const h = withTool('prepare_application', { areas }, 'j2');
    return { h, agent, calls: fakes.calls, db };
  }

  it('the card states what the cost sheet states; applying lists the job (via copilot), reserves one kit under the proposal key and starts it once', async () => {
    const { h, agent, calls } = world();
    const p = await proposalFrom(h, 'j2');
    const shown = (await h.store.getMessage(p.messageId))!.cards as Array<{ type: string; data: { credits: unknown[] } }>;
    // Nothing is on the list and nothing is reserved before the click.
    expect((await agent.listQueue(USER, {})).items).toEqual([]);
    expect(calls.reserved).toEqual([]);
    const res = await h.service.proposals.apply(USER, p.id);
    const [onList] = (await agent.listQueue(USER, {})).items;
    expect(onList).toMatchObject({ jobId: 'j2', state: 'preparing', addedVia: 'copilot' });
    expect(calls.reserved).toEqual([`copilot:${p.id}:${onList!.id}:1`]);
    expect(calls.enqueued).toHaveLength(1);
    expect(res).toMatchObject({ applied: true, result: { card: { type: 'application_status', data: { jobId: 'j2', state: 'preparing', jobTitle: 'Role j2' } } } });
    // The card's lines are the cost sheet's: what POST /agent/queue/:id/prepare (no confirm) answered for this job.
    expect(shown[0]!.data.credits).toEqual([
      { bucket: 'ready_kits', cost: 1, remaining: 3, window: 'week', resetsAt: '2026-10-13T04:00:00.000Z' },
      { bucket: 'tailor', cost: 1, remaining: 2, window: 'day', resetsAt: '2026-10-13T04:00:00.000Z' },
      { bucket: 'cover_letter', cost: 1, remaining: 4, window: 'day', resetsAt: '2026-10-13T04:00:00.000Z' },
    ]);
    // A second click: refused; no second kit.
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ details: { reason: 'proposal_closed' } });
    expect(calls.reserved).toHaveLength(1);
    // The worker prepares it; the next answer reads where it stands (never "submitted", D1).
    expect(await agent.runPrepare(calls.enqueued[0]!)).toBe('ready');
    const reader = ctxFor({ areasOver: { jobPlaces: agent.jobPlaces } });
    const status = await runToolCall(call('application_status', { jobIds: ['j2'] }), await availableTools('seeker', reader.ctx), reader.ctx, new Set(['j2']));
    expect(status.output.data).toMatchObject({ jobs: [{ jobId: 'j2', onList: true, state: 'ready_for_review', canPrepare: false }] });
  });

  it('out of a bucket (tailoring): 402 with the agent’s bucket, no kit reserved; the job waits on the list and the suggestion stays pending', async () => {
    const { h, agent, calls } = world({
      creditUsage: async () => ({ lines: { tailor: usageLine(0), cover_letter: usageLine(4), ready_kits: usageLine(3, 'week') }, upgradable: true }),
    });
    const p = await proposalFrom(h, 'j2');
    const card = ((await h.store.getMessage(p.messageId))!.cards as Array<{ data: { enough: boolean } }>)[0]!;
    expect(card.data.enough).toBe(false);
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'credits_exhausted', bucket: 'tailor', upgradable: true });
    expect(calls.reserved).toEqual([]);
    expect((await agent.listQueue(USER, {})).items).toMatchObject([{ jobId: 'j2', state: 'picked' }]);
    expect((await h.store.getProposal(p.id))!.status).toBe('pending');
  });
});
