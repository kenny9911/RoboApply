// @vitest-environment node
// WP-50 proposals: apply / dismiss, baseVersion conflicts, 24 h expiry,
// one-shot claims, credit actions charged only on apply, memory rules.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { COPILOT_MEMORY_MAX, PROPOSAL_TTL_MS } from '../contract.js';
import { NOW, USER, makeService, newThread, profile, runTurn, type Harness } from './testkit.js';

async function proposalFrom(h: Harness, tool: string, args: unknown, contextJobId?: string): Promise<{ id: string; messageId: string; threadId: string }> {
  const t = await newThread(h, contextJobId);
  h.llm.streamChatWithTools.mockClear();
  const events = await runTurn(h, t, 'please', { contextJobId });
  const card = events.find((e) => e.event === 'card')!.data as { data: { proposalId: string } };
  const done = events.at(-1)!.data as { messageId: string };
  return { id: card.data.proposalId, messageId: done.messageId, threadId: t };
}

function withTool(name: string, args: unknown, over: Parameters<typeof makeService>[0] = {}) {
  return makeService({ rounds: [{ toolCalls: [{ name, args }] }, { chunks: ['Review the card.'] }], ...over });
}

async function storedCardStatus(h: Harness, messageId: string) {
  const msg = await h.store.getMessage(messageId);
  return (msg!.cards as Array<{ type: string; data: { status?: string } }>).map((c) => [c.type, c.data.status]);
}

describe('filter_change', () => {
  it('applies the patch at baseVersion and marks the card applied', async () => {
    const h = withTool('propose_filter_change', { ops: [{ op: 'set', path: 'workModels', value: ['onsite'] }], reason: 'on-site' });
    const p = await proposalFrom(h, 'propose_filter_change', {});
    const res = await h.service.proposals.apply(USER, p.id);
    expect(h.areas.patchFilters).toHaveBeenCalledWith(USER, 'sp_1', 3, { workModels: ['onsite'] });
    expect(res).toMatchObject({ applied: true, result: { searchProfileId: 'sp_1', version: 4, countAfter: { count: { value: 40, source: 'index' }, capped: false } } });
    expect(await storedCardStatus(h, p.messageId)).toEqual([['filter_diff', 'applied']]);
    // a second click does nothing
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'proposal_closed' } });
    expect(h.areas.patchFilters).toHaveBeenCalledTimes(1);
    // listed messages show the live status
    const list = await h.service.listMessages(USER, p.threadId, {});
    expect(list.items.at(-1)!.cards[0]!.data).toMatchObject({ status: 'applied' });
    expect(list.items.at(-1)!.aiGenerated).toBe(true);
  });

  it('baseVersion mismatch → 409 version_conflict with a fresh diff card (a new pending proposal)', async () => {
    const h = withTool('propose_filter_change', { ops: [{ op: 'set', path: 'workModels', value: ['onsite'] }], reason: 'on-site' });
    const p = await proposalFrom(h, 'propose_filter_change', {});
    h.areas.searchProfile.mockResolvedValue(profile({ version: 7, filters: { titles: ['BI Analyst'] } }));
    const err = await h.service.proposals.apply(USER, p.id).catch((e) => e);
    expect(err).toMatchObject({ code: 'version_conflict', status: 409, details: { currentVersion: 7 } });
    const fresh = (err.details as { card: { type: string; data: { proposalId: string; baseVersion: number; status: string } } }).card;
    expect(fresh).toMatchObject({ type: 'filter_diff', data: { baseVersion: 7, status: 'pending' } });
    expect(fresh.data.proposalId).not.toBe(p.id);
    expect(h.areas.patchFilters).not.toHaveBeenCalled();
    expect((await h.store.getProposal(p.id))!.status).toBe('conflict');
    // the fresh one applies at the new version
    await h.service.proposals.apply(USER, fresh.data.proposalId);
    expect(h.areas.patchFilters).toHaveBeenCalledWith(USER, 'sp_1', 7, { workModels: ['onsite'] });
  });

  it('a race lost inside patchFilters is also a conflict', async () => {
    const h = withTool('propose_filter_change', { ops: [{ op: 'add', path: 'excludedCompanies', value: 'Acme' }], reason: 'x' });
    const p = await proposalFrom(h, 'propose_filter_change', {});
    h.areas.patchFilters.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'version_conflict', currentVersion: 4 }));
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'version_conflict' });
    expect((await h.store.getProposal(p.id))!.status).toBe('conflict');
  });

  it('expires after 24 h', async () => {
    let now = NOW;
    const h = withTool('propose_filter_change', { ops: [{ op: 'set', path: 'workModels', value: ['onsite'] }], reason: 'x' }, { now: () => now });
    const p = await proposalFrom(h, 'propose_filter_change', {});
    now = new Date(NOW.getTime() + PROPOSAL_TTL_MS + 1);
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'proposal_expired' } });
    expect(h.areas.patchFilters).not.toHaveBeenCalled();
    expect(await storedCardStatus(h, p.messageId)).toEqual([['filter_diff', 'expired']]);
  });

  it("another user's proposal is a 404", async () => {
    const h = withTool('propose_filter_change', { ops: [{ op: 'set', path: 'workModels', value: ['onsite'] }], reason: 'x' });
    const p = await proposalFrom(h, 'propose_filter_change', {});
    await expect(h.service.proposals.apply('intruder', p.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.service.proposals.dismiss('intruder', p.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('credit actions: charged only on apply', () => {
  it('tailor runs the resume seam with the proposal key and appends a tailor_ready card', async () => {
    const h = withTool('tailor_resume', { jobId: 'job_1' });
    const p = await proposalFrom(h, 'tailor_resume', {}, 'job_1');
    expect(h.areas.createTailorSession).not.toHaveBeenCalled();
    const res = await h.service.proposals.apply(USER, p.id, { locale: 'en' });
    expect(h.areas.createTailorSession).toHaveBeenCalledWith(USER, { baseVariantId: 'res_1', jobId: 'job_1', idempotencyKey: `copilot:${p.id}`, locale: 'en' });
    expect(res.result).toMatchObject({ card: { type: 'tailor_ready', data: { sessionId: 'ts_1', href: '/resume/res_1?tailor=job_1' } } });
    expect(await storedCardStatus(h, p.messageId)).toEqual([
      ['credit_action', 'applied'],
      ['tailor_ready', undefined],
    ]);
  });

  it('a failed action (credits exhausted) leaves the proposal pending and charges nothing here', async () => {
    const h = withTool('write_cover_letter', { jobId: 'job_1' });
    const p = await proposalFrom(h, 'write_cover_letter', {}, 'job_1');
    h.areas.createCoverLetter.mockRejectedValueOnce(Object.assign(new Error('none left'), { code: 'credits_exhausted', status: 402 }));
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'credits_exhausted' });
    expect((await h.store.getProposal(p.id))!.status).toBe('pending');
    const res = await h.service.proposals.apply(USER, p.id);
    expect(res.result).toMatchObject({ card: { type: 'cover_letter', data: { letterId: 'cl_1', href: '/resume/letters/cl_1' } } });
    expect(h.areas.createCoverLetter).toHaveBeenLastCalledWith(USER, { jobId: 'job_1', resumeVariantId: 'res_1', tone: undefined, length: undefined }, `copilot:${p.id}`);
  });

  it('job import reads the link, then saves the confirmed draft as source "assistant"', async () => {
    const h = withTool('add_external_job', { url: 'https://beta.example/jobs/9' });
    const p = await proposalFrom(h, 'add_external_job', {});
    const res = await h.service.proposals.apply(USER, p.id);
    expect(h.areas.importJob).toHaveBeenCalledWith(USER, { url: 'https://beta.example/jobs/9' }, `copilot:${p.id}:read`);
    expect(h.areas.saveImportedJob).toHaveBeenCalledWith(USER, expect.objectContaining({ title: 'Analyst', company: 'Beta', applyUrl: 'https://beta.example/j' }), { importId: 'draft_1', idempotencyKey: `copilot:${p.id}` });
    expect(res.result).toMatchObject({ card: { type: 'job_imported', data: { status: 'done', jobId: 'job_new', href: '/jobs/job_new' } } });
  });

  it('rewrite returns suggestions only; the resume is not changed', async () => {
    const h = makeService({ rounds: [{ toolCalls: [{ name: 'rewrite_resume_section', args: { issueId: 'iss_1' } }] }, { chunks: ['Review the card.'] }] });
    const t = await newThread(h);
    const events = await runTurn(h, t, 'rewrite', { resumeId: 'res_1' });
    const id = (events.find((e) => e.event === 'card')!.data as { data: { proposalId: string } }).data.proposalId;
    const res = await h.service.proposals.apply(USER, id);
    expect(h.areas.fixResumeIssue).toHaveBeenCalledWith(USER, 'res_1', 'iss_1', expect.objectContaining({ variant: 'ai', idempotencyKey: `copilot:${id}` }));
    expect(res.result).toMatchObject({ card: { type: 'rewrite_ready', data: { suggestions: [{ text: 'Built weekly reports', aiWritten: true }] } } });
  });
});

describe('memory_add', () => {
  it('RoboApply: confirming stores the fact', async () => {
    const h = withTool('remember', { fact: 'Prefers remote work' });
    const p = await proposalFrom(h, 'remember', {});
    expect(await h.db.rACopilotMemory.count({})).toBe(0);
    const res = await h.service.proposals.apply(USER, p.id);
    expect(res.result).toMatchObject({ memory: { fact: 'Prefers remote work' } });
    expect((await h.service.listMemory(USER)).items.map((m) => m.fact)).toEqual(['Prefers remote work']);
  });

  it('GoApply: 403 without the copilot_memory consent; the proposal stays pending', async () => {
    const h = withTool('remember', { fact: '想去上海' }, { brand: 'goapply' });
    const p = await proposalFrom(h, 'remember', {});
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'copilot_memory_consent_required' } });
    expect((await h.store.getProposal(p.id))!.status).toBe('pending');
    h.consents.add('copilot_memory');
    await h.service.proposals.apply(USER, p.id);
    expect(await h.db.rACopilotMemory.count({})).toBe(1);
  });

  it(`keeps at most ${COPILOT_MEMORY_MAX} facts`, async () => {
    const h = withTool('remember', { fact: 'One more fact' });
    for (let i = 0; i < COPILOT_MEMORY_MAX; i += 1) await h.store.createMemory({ userId: USER, fact: `f${i}`, source: 'user_confirmed' });
    const p = await proposalFrom(h, 'remember', {});
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'memory_full' } });
  });

  it('the cap holds when two applies race past the fast check (count and create are one locked step)', async () => {
    const h = withTool('remember', { fact: 'One more fact' });
    for (let i = 0; i < COPILOT_MEMORY_MAX; i += 1) await h.store.createMemory({ userId: USER, fact: `f${i}`, source: 'user_confirmed' });
    const p = await proposalFrom(h, 'remember', {});
    // the other apply stored the 50th fact after this one's fast check read 49
    vi.spyOn(h.store, 'countMemory').mockResolvedValueOnce(COPILOT_MEMORY_MAX - 1);
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'memory_full' } });
    expect(await h.db.rACopilotMemory.count({ where: { userId: USER, deletedAt: null } })).toBe(COPILOT_MEMORY_MAX);
    expect((await h.store.getProposal(p.id))!.status).toBe('pending');
    expect(h.db.$sql.calls.some((c) => c.text.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('deleting a fact clears its text', async () => {
    const h = makeService();
    const m = await h.store.createMemory({ userId: USER, fact: 'secret-ish', source: 'user_confirmed' });
    await h.service.deleteMemory(USER, m.id);
    expect((await h.service.listMemory(USER)).items).toEqual([]);
    expect((await h.db.rACopilotMemory.findUnique({ where: { id: m.id } }))!.fact).toBe('');
    await expect(h.service.deleteMemory(USER, m.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('message cards', () => {
  it('two proposals on one message keep both statuses and the result card (row-locked read-modify-write)', async () => {
    const h = makeService({
      rounds: [
        { toolCalls: [{ name: 'remember', args: { fact: 'Likes data work' } }, { name: 'remember', args: { fact: 'Prefers remote' } }] },
        { chunks: ['Review the cards.'] },
      ],
    });
    const t = await newThread(h);
    const events = await runTurn(h, t, 'please');
    const ids = events.filter((e) => e.event === 'card').map((e) => (e.data as { data: { proposalId: string } }).data.proposalId);
    const messageId = (events.at(-1)!.data as { messageId: string }).messageId;
    expect(ids).toHaveLength(2);
    await Promise.all([h.service.proposals.apply(USER, ids[0]!), h.service.proposals.dismiss(USER, ids[1]!)]);
    expect(await storedCardStatus(h, messageId)).toEqual([
      ['memory_add', 'applied'],
      ['memory_add', 'dismissed'],
    ]);
    const locks = h.db.$sql.calls.filter((c) => /FROM "RACopilotMessage" WHERE id = \$1 FOR UPDATE/.test(c.text));
    expect(locks.length).toBeGreaterThanOrEqual(2);
    expect(locks.every((c) => c.values[0] === messageId)).toBe(true);
  });
});

describe('dismiss', () => {
  it('dismisses a pending proposal once; dismissing again is a no-op; an applied one cannot be dismissed', async () => {
    const h = withTool('remember', { fact: 'Likes data work' });
    const p = await proposalFrom(h, 'remember', {});
    await h.service.proposals.dismiss(USER, p.id);
    await h.service.proposals.dismiss(USER, p.id);
    expect((await h.store.getProposal(p.id))!.status).toBe('dismissed');
    await expect(h.service.proposals.apply(USER, p.id)).rejects.toMatchObject({ code: 'conflict' });
    const h2 = withTool('remember', { fact: 'Likes data work' });
    const p2 = await proposalFrom(h2, 'remember', {});
    await h2.service.proposals.apply(USER, p2.id);
    await expect(h2.service.proposals.dismiss(USER, p2.id)).rejects.toMatchObject({ code: 'conflict' });
  });
});
