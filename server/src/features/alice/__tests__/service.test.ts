// @vitest-environment node
//
// Alice's orchestrator end to end, with scripted subagents and fake seams:
// greeting → resume → intake → two profiles → pick → revise (computed diff) →
// restore → save (which search it drives) → jobs → the applications report
// (numbers checked, D3) and reminders. Plus the gates: AI consent before any
// model call, one running turn per thread, a failed subagent leaving the
// thread consistent, and D1 wording never shown.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { breaksD1, numbersAreFacts } from '../service.js';
import { PROFILE_A, USER, intakeOut, makeAlice } from './testkit.js';

const blocksOf = (thread: { messages: Array<{ blocks: Array<{ type: string }> }> }) => thread.messages.flatMap((m) => m.blocks.map((b) => b.type));

/** Walk a fresh thread to `choosing` (two profiles written). */
async function toChoosing(a: ReturnType<typeof makeAlice>) {
  a.scripted.intake.mockResolvedValueOnce(intakeOut({ question: 'Is product design what you want next?', topic: 'roles', quickReplies: ['Yes', 'Something else'] }));
  await a.turn({ kind: 'resume', resumeVariantId: 'rv1' });
  a.scripted.intake.mockResolvedValueOnce(
    intakeOut({ learned: { roles: ['Product designer'], levels: ['senior'], workModels: ['remote'] }, ack: 'Senior and remote, noted.', question: 'Which companies do you admire?', topic: 'companies' }),
  );
  await a.turn({ kind: 'message', text: 'Senior product design, remote please' });
  a.scripted.intake.mockResolvedValueOnce(intakeOut({ learned: { companies: ['Stripe'] }, ack: 'Stripe, good to know.', wantsProfiles: true, question: '' }));
  return a.turn({ kind: 'message', text: 'Stripe. Show me profiles now.' });
}

describe('Alice: from the greeting to two profiles', () => {
  it('greets once with the resume it can start from', async () => {
    const a = makeAlice();
    const thread = await a.service.getThread(USER, a.ctx);
    expect(thread.stage).toBe('intake');
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].blocks[0]).toEqual({ type: 'greeting', hasResume: true, resumeName: 'Maya resume' });
    await a.service.getThread(USER, a.ctx);
    expect(a.store.threads).toHaveLength(1);
  });

  it('reads the resume, asks one question with quick replies, and folds answers into the brief', async () => {
    const a = makeAlice();
    a.scripted.intake.mockResolvedValueOnce(intakeOut({ ack: 'I read it.', question: 'Is product design what you want next?', topic: 'roles', quickReplies: ['Yes', 'Something else'] }));
    const { events, thread } = await a.turn({ kind: 'resume', resumeVariantId: 'rv1' });
    expect(events.filter((e) => e.event === 'progress').map((e) => (e.event === 'progress' ? `${e.data.step}:${e.data.state}` : ''))).toEqual([
      'reading_resume:running',
      'reading_resume:done',
      'thinking:running',
      'thinking:done',
    ]);
    expect(thread.resume?.name).toBe('Maya resume');
    expect(thread.pending).toEqual({ topic: 'roles', quickReplies: ['Yes', 'Something else'], multiSelect: false });
    expect(blocksOf(thread)).toEqual(['greeting', 'action', 'resume']);
    expect(thread.messages.at(-1)?.text).toBe('I read it.\n\nIs product design what you want next?');
    // The first question is asked with the resume and no answer.
    expect(a.scripted.intake.mock.calls[0][0]).toMatchObject({ answer: null, resume: 'Product designer, 6 years, checkout.', suggestedTopic: 'roles' });
  });

  it('writes two profiles once the needed topics are covered and the person asks', async () => {
    const a = makeAlice();
    const { thread, events } = await toChoosing(a);
    expect(thread.stage).toBe('choosing');
    expect(thread.drafts.map((d) => d.label)).toEqual(['Steady climb', 'Step up']);
    expect(thread.analysis?.axis).toBe('scope');
    expect(thread.brief.roles).toEqual(['Product designer']);
    expect(thread.ready).toBe(true);
    expect(events.some((e) => e.event === 'progress' && e.data.step === 'writing_profiles')).toBe(true);
    const last = thread.messages.at(-1)!;
    expect(last.blocks).toEqual([{ type: 'profiles', labels: ['Steady climb', 'Step up'] }]);
    expect(last.text).toBe('Here are two directions. Which is closer?');
  });

  it('keeps asking while needed topics are open, even when the person asks for profiles', async () => {
    const a = makeAlice();
    a.scripted.intake.mockResolvedValueOnce(intakeOut({ learned: { roles: ['Product designer'] }, wantsProfiles: true, question: 'What level are you aiming for?', topic: 'level' }));
    const { thread } = await a.turn({ kind: 'message', text: 'Product design. Just show me profiles.' });
    expect(thread.stage).toBe('intake');
    expect(thread.pending?.topic).toBe('level');
    expect(a.scripted.writer).not.toHaveBeenCalled();
  });
});

describe('Alice: choosing, revising and restoring', () => {
  it('picks a profile as version 1, then revises it with a computed diff', async () => {
    const a = makeAlice();
    await toChoosing(a);
    const picked = await a.turn({ kind: 'choose', draftId: 'a' });
    expect(picked.thread.stage).toBe('refining');
    expect(picked.thread.revisions).toHaveLength(1);
    expect(picked.thread.revisions[0]).toMatchObject({ version: 1, origin: 'pick', changed: [] });
    expect(picked.thread.saveTarget).toEqual({ mode: 'choose', search: { id: 's_main', name: 'Main search' } });

    const revised = await a.turn({ kind: 'refine', comment: 'I would take hybrid too' });
    const v2 = revised.thread.revisions[1];
    expect(v2).toMatchObject({ version: 2, origin: 'edit', comment: 'I would take hybrid too', notes: ['Hybrid added'], changed: ['workModels'] });
    expect(revised.thread.currentVersion).toBe(2);
    expect(revised.thread.messages.at(-1)?.blocks).toEqual([{ type: 'revision', version: 2, changed: ['workModels'] }]);
  });

  it('says so when a comment changes nothing', async () => {
    const a = makeAlice();
    await toChoosing(a);
    await a.turn({ kind: 'choose', draftId: 'a' });
    a.scripted.editor.mockResolvedValueOnce({ profile: { ...PROFILE_A }, notes: [], message: 'That is already in it.', learned: {} });
    const { thread } = await a.turn({ kind: 'refine', comment: 'Remote please' });
    expect(thread.revisions).toHaveLength(1);
    expect(thread.messages.at(-1)?.blocks).toEqual([{ type: 'notice', code: 'nothing_changed' }]);
  });

  it('restores an earlier version as a new version', async () => {
    const a = makeAlice();
    await toChoosing(a);
    await a.turn({ kind: 'choose', draftId: 'a' });
    await a.turn({ kind: 'refine', comment: 'hybrid too' });
    const { thread } = await a.turn({ kind: 'restore', version: 1 });
    expect(thread.revisions.map((r) => [r.version, r.origin, r.changed])).toEqual([
      [1, 'pick', []],
      [2, 'edit', ['workModels']],
      [3, 'restore', ['workModels']],
    ]);
    expect(thread.revisions[2].profile.workModels).toEqual(['remote']);
  });

  it('chooses with a comment in one step (pick, then revise)', async () => {
    const a = makeAlice();
    await toChoosing(a);
    const { thread } = await a.turn({ kind: 'choose', draftId: 'b', comment: 'but hybrid is fine' });
    expect(thread.revisions.map((r) => r.version)).toEqual([1, 2]);
    expect(thread.revisions[0].profile.label).toBe('Step up');
    expect(a.scripted.editor.mock.calls[0][0]).toMatchObject({ comment: 'but hybrid is fine' });
  });

  it('writes a new pair when neither fits, avoiding the last one', async () => {
    const a = makeAlice();
    await toChoosing(a);
    await a.turn({ kind: 'regenerate', comment: 'Neither: I want to leave design for product management' });
    expect(a.scripted.analyst.mock.calls.at(-1)?.[0]).toMatchObject({ comment: 'Neither: I want to leave design for product management', previousAxis: 'scope' });
    expect(a.scripted.writer.mock.calls.at(-1)?.[0]).toMatchObject({ avoid: ['Steady climb: Senior product designer at a payments scale-up', 'Step up: Design lead at an early start-up'] });
  });
});

describe('Alice: saving and the search it drives', () => {
  async function refining(a: ReturnType<typeof makeAlice>) {
    await toChoosing(a);
    await a.turn({ kind: 'choose', draftId: 'a' });
  }

  it('with no room, refuses an automatic save and replaces only when told, keeping the old filters for Undo', async () => {
    const a = makeAlice();
    await refining(a);
    await expect(a.turn({ kind: 'save', search: 'auto' })).rejects.toMatchObject({ details: { reason: 'alice_search_full' } });
    const { thread } = await a.turn({ kind: 'save', search: 'replace' });
    expect(thread.stage).toBe('saved');
    expect(thread.savedProfile?.search).toEqual({ id: 's_main', name: 'Main search', isActive: true });
    expect(thread.savedProfile?.canUndoReplace).toBe(true);
    expect(a.world.searches[0].filters).toMatchObject({ titles: ['Senior Product Designer'], seniority: ['senior'], workModels: ['remote'], country: 'DE', preferredCompanies: ['Stripe'] });
    expect(a.store.profiles[0].previousFilters).toEqual({ titles: ['Designer'] });
    const saved = thread.messages.flatMap((m) => m.blocks).find((b) => b.type === 'saved');
    expect(saved).toMatchObject({ search: { id: 's_main', mode: 'replaced' } });
    // Saving finds the jobs that fit, with exactly the profile's filters.
    expect(thread.messages.at(-1)?.blocks).toEqual([{ type: 'matches', profileId: thread.savedProfile!.id, count: 2 }]);
    expect(a.world.lastMatchFilters?.titles).toEqual(['Senior Product Designer']);

    // Undo puts the old filters back and unlinks the profile.
    const undone = await a.service.patchProfile(USER, thread.savedProfile!.id, { undoReplace: true });
    expect(a.world.searches[0].filters).toEqual({ titles: ['Designer'] });
    expect(undone.search).toBeNull();
  });

  it('with room, creates a search named after the profile and uses it', async () => {
    const a = makeAlice({ world: { cap: 10 } });
    await refining(a);
    const { thread } = await a.turn({ kind: 'save', search: 'auto', name: 'Payments design' });
    expect(thread.savedProfile).toMatchObject({ name: 'Payments design', search: { name: 'Payments design', isActive: true } });
    expect(a.world.searches.filter((s) => s.isActive).map((s) => s.name)).toEqual(['Payments design']);
    expect(a.store.profiles[0].previousFilters).toBeNull();
  });

  it('saves without touching any search when asked', async () => {
    const a = makeAlice();
    await refining(a);
    const { thread } = await a.turn({ kind: 'save', search: 'none' });
    expect(thread.savedProfile?.search).toBeNull();
    expect(a.world.searches[0].filters).toEqual({ titles: ['Designer'] });
  });

  it('edits a saved profile and updates the search it already drives', async () => {
    const a = makeAlice({ world: { cap: 10 } });
    await refining(a);
    const first = await a.turn({ kind: 'save', search: 'auto' });
    const id = first.thread.savedProfile!.id;
    await a.turn({ kind: 'edit_profile', profileId: id });
    await a.turn({ kind: 'refine', comment: 'hybrid too' });
    const again = await a.turn({ kind: 'save', search: 'auto' });
    expect(again.thread.savedProfile).toMatchObject({ id, version: 2 });
    expect(a.world.searches).toHaveLength(2);
    expect(a.world.searches[1].filters.workModels).toEqual(['remote', 'hybrid']);
  });

  it('lists the matches of a saved profile with what each job meets', async () => {
    const a = makeAlice({ world: { cap: 10 } });
    await refining(a);
    const { thread } = await a.turn({ kind: 'save', search: 'auto' });
    const res = await a.service.matches(USER, thread.savedProfile!.id, 8, a.ctx);
    expect(res.items[0].meets).toEqual(['titles', 'levels', 'workModels', 'places', 'companies']);
    expect(res.items[0].atNamedCompany).toBe(true);
    expect(res.items[1].meets).not.toContain('workModels');
  });
});

describe('Alice: applications, reports and reminders', () => {
  const entries = [
    { id: 'e1', status: 'applied', company: 'Figma', title: 'Product Designer', dateApplied: '2026-11-01T00:00:00Z', followUpAt: null, updatedAt: '2026-11-01T00:00:00Z' },
    { id: 'e2', status: 'interviewing', company: 'Stripe', title: 'Senior Product Designer', dateApplied: '2026-11-20T00:00:00Z', followUpAt: '2026-11-23T12:00:00.000Z', updatedAt: '2026-11-21T00:00:00Z' },
    { id: 'e3', status: 'rejected', company: 'Linear', title: 'Designer', dateApplied: '2026-10-01T00:00:00Z', followUpAt: '2026-11-01T12:00:00.000Z', updatedAt: '2026-10-20T00:00:00Z' },
  ];
  const world = {
    entries,
    statusCounts: { applied: 1, interviewing: 1, rejected: 1 },
    facts: [{ entryId: 'e1', reason: 'no_reply_10d' as const, at: '2026-11-01T00:00:00Z', days: 22, companyName: 'Figma', title: 'Product Designer' }],
    ready: [{ queueItemId: 'q1', entryId: null, company: 'Notion', title: 'Designer', at: '2026-11-22T00:00:00Z' }],
  };

  it('counts from the rows: the ladder, what needs the person, due reminders (closed ones left out)', async () => {
    const a = makeAlice({ world });
    const board = await a.service.applications(USER);
    expect(board.stages.slice(0, 4)).toEqual([
      { status: 'bookmarked', count: 0 },
      { status: 'applied', count: 1 },
      { status: 'first_call', count: 0 },
      { status: 'interviewing', count: 1 },
    ]);
    expect(board.facts).toEqual({ active: 2, waiting: 1, interviewing: 1, offers: 0, needsYou: 2, noReply: 1, remindersDue: 1, readyToCheck: 1, appliedThisWeek: 1 });
    expect(board.reminders).toEqual([{ entryId: 'e2', company: 'Stripe', title: 'Senior Product Designer', status: 'interviewing', date: '2026-11-23', due: true }]);
    expect(board.needsYou.map((n) => n.kind)).toEqual(['ready_to_check', 'no_reply_10d']);
  });

  it('reads no Ready to apply facts with the agent capability off', async () => {
    const a = makeAlice({ world: { ...world, agentOn: false } });
    const board = await a.service.applications(USER);
    expect(board.facts.readyToCheck).toBeNull();
    expect(board.needsYou.map((n) => n.kind)).toEqual(['no_reply_10d']);
  });

  it('drops report wording with a number that is not a fact (D3), keeping the facts block', async () => {
    const a = makeAlice({ world });
    a.scripted.reporter.mockResolvedValueOnce({ message: 'You have 7 interviews this week.' });
    const { thread } = await a.turn({ kind: 'report' });
    const last = thread.messages.at(-1)!;
    expect(last.text).toBe('');
    expect(last.blocks[0]).toMatchObject({ type: 'report', facts: { active: 2 } });
    a.scripted.reporter.mockResolvedValueOnce({ message: 'Figma has had no reply for 22 days; 2 applications are open.' });
    const again = await a.turn({ kind: 'report' });
    expect(again.thread.messages.at(-1)?.text).toBe('Figma has had no reply for 22 days; 2 applications are open.');
  });

  it('sets a reminder the router resolved to one of the person’s applications, and asks when several match', async () => {
    const a = makeAlice({ world });
    await toChoosing(a);
    await a.turn({ kind: 'choose', draftId: 'a' });
    await a.turn({ kind: 'save', search: 'none' });
    a.scripted.router.mockResolvedValueOnce({ action: 'set_reminder', draftId: null, comment: '', entryIds: ['e1'], date: '2026-11-27', reply: '' });
    const { thread } = await a.turn({ kind: 'message', text: 'Remind me to follow up with Figma on Friday' });
    expect(thread.messages.at(-1)?.blocks).toEqual([{ type: 'reminder', entryId: 'e1', company: 'Figma', title: 'Product Designer', date: '2026-11-27' }]);
    expect(a.world.entries[0].followUpAt).toBe('2026-11-27T12:00:00.000Z');

    a.scripted.router.mockResolvedValueOnce({ action: 'set_reminder', draftId: null, comment: '', entryIds: ['e1', 'e2', 'e_not_mine'], date: '2026-11-28', reply: '' });
    const ambiguous = await a.turn({ kind: 'message', text: 'Remind me about the designer roles' });
    const choice = ambiguous.thread.messages.at(-1)!.blocks[0];
    expect(choice).toEqual({ type: 'choice', date: '2026-11-28', options: [{ entryId: 'e1', company: 'Figma', title: 'Product Designer' }, { entryId: 'e2', company: 'Stripe', title: 'Senior Product Designer' }] });

    a.scripted.router.mockResolvedValueOnce({ action: 'set_reminder', draftId: null, comment: '', entryIds: ['e1'], date: '2026-11-01', reply: 'Which day?' });
    const past = await a.turn({ kind: 'message', text: 'Remind me on the 1st' });
    expect(past.thread.messages.at(-1)?.blocks).toEqual([{ type: 'notice', code: 'reminder_unknown' }]);
  });
});

describe('Alice: gates and failures', () => {
  it('checks AI consent before any model call', async () => {
    const a = makeAlice({ world: { aiAllowed: false } });
    await expect(a.turn({ kind: 'message', text: 'hi' })).rejects.toMatchObject({ code: 'ai_unavailable', details: { reason: 'alice_ai_off' } });
    expect(a.scripted.intake).not.toHaveBeenCalled();
    // A turn without a model (start over) still works.
    await expect(a.turn({ kind: 'restart' })).resolves.toBeTruthy();
  });

  it('runs one turn per thread at a time', async () => {
    const a = makeAlice();
    await a.service.getThread(USER, a.ctx);
    let release!: () => void;
    a.scripted.intake.mockImplementationOnce(() => new Promise((r) => (release = () => r(intakeOut()))));
    const first = a.turn({ kind: 'message', text: 'first' });
    await new Promise((r) => setTimeout(r, 10));
    await expect(a.turn({ kind: 'message', text: 'second' })).rejects.toMatchObject({ details: { reason: 'alice_busy' } });
    release();
    await first;
  });

  it('a failed subagent leaves a notice in the thread and raises an error', async () => {
    const a = makeAlice();
    a.scripted.intake.mockRejectedValueOnce(new Error('model down'));
    const events: string[] = [];
    await expect(a.service.turn(USER, { kind: 'message', text: 'Product design' }, { ...a.ctx, emit: (e) => events.push(e.event) })).rejects.toMatchObject({
      code: 'ai_unavailable',
      details: { reason: 'alice_agent_failed' },
    });
    const thread = await a.service.getThread(USER, a.ctx);
    expect(thread.messages.at(-1)?.blocks).toEqual([{ type: 'notice', code: 'agent_failed' }]);
    expect(thread.messages.at(-2)?.text).toBe('Product design');
  });

  it('refuses an action that does not fit the stage before anything is stored', async () => {
    const a = makeAlice();
    await expect(a.turn({ kind: 'save', search: 'auto' })).rejects.toMatchObject({ details: { reason: 'alice_wrong_stage' } });
    const thread = await a.service.getThread(USER, a.ctx);
    expect(thread.messages).toHaveLength(1);
  });

  it('never shows D1 wording', async () => {
    expect(breaksD1('I will apply for you tomorrow.')).toBe(true);
    expect(breaksD1('I can submit it on your behalf.')).toBe(true);
    expect(breaksD1('You submit every application yourself.')).toBe(false);
    const a = makeAlice();
    a.scripted.intake.mockResolvedValueOnce(intakeOut({ ack: 'Great, I will apply for you to all of them.', question: '' }));
    const { thread } = await a.turn({ kind: 'message', text: 'designer' });
    expect(thread.messages.at(-1)?.text).toBe('');
  });

  it('checks report numbers digit by digit', () => {
    expect(numbersAreFacts('2 open, 1 waiting', new Set([1, 2]))).toBe(true);
    expect(numbersAreFacts('3 open', new Set([1, 2]))).toBe(false);
  });

  it('keeps one active thread: start over archives it and greets again', async () => {
    const a = makeAlice();
    await toChoosing(a);
    const { thread } = await a.turn({ kind: 'restart' });
    expect(thread.stage).toBe('intake');
    expect(thread.messages.map((m) => m.blocks[0]?.type)).toEqual(['greeting']);
    expect(a.store.threads.filter((t) => !t.archivedAt)).toHaveLength(1);
  });
});
