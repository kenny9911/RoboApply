// FillSession: the supervised fill (ARCHITECTURE.md §6.4, PRODUCT F-EXT-04, D1).

import { describe, expect, it, vi } from 'vitest';

import { greenhouseAdapter } from '../src/adapters/intl/greenhouse';
import { leverAdapter } from '../src/adapters/intl/lever';
import { AiApprovalRequiredError, FillSession, summarize } from '../src/content/fill';
import type { ApiCall } from '../src/shared/messages';
import { fail, fakeApi, field, loadFixture, ok, sampleProfile } from './helpers';

const GH_URL = 'https://boards.greenhouse.io/exampleco/jobs/1001';
const WHY = 'job_application_answers_attributes_3_text_value';

function session(over: Partial<ConstructorParameters<typeof FillSession>[0]> = {}, api = fakeApi()) {
  const doc = loadFixture('greenhouse', 'classic');
  const s = new FillSession({ adapter: greenhouseAdapter, doc, url: GH_URL, api: api.api, jobId: 'job_1', aiAvailable: true, ...over });
  return { s, api, doc };
}

function item(s: FillSession, label: string | RegExp) {
  const it = s.getState().items.find((i) => (typeof label === 'string' ? i.label === label : label.test(i.label)));
  if (!it) throw new Error(`no item ${label}`);
  return it;
}

describe('FillSession.start', () => {
  it('fills profile fields, work authorization and the resume; leaves questions to the user', async () => {
    const { s, api } = session();
    await s.start();
    expect(field('#first_name').value).toBe('Avery');
    expect(field('#last_name').value).toBe('Lin');
    expect(field('#email').value).toBe('avery@example.test');
    expect(field('#phone').value).toBe('+15125550100');
    expect(field('#job_application_answers_attributes_0_text_value').value).toBe('https://www.linkedin.com/in/avery-example');
    expect(field<HTMLSelectElement>('#job_application_answers_attributes_1_boolean_value').selectedOptions[0].textContent).toBe('Yes');
    expect(field<HTMLSelectElement>('#job_application_answers_attributes_2_boolean_value').selectedOptions[0].textContent).toBe('No');
    expect(field('#resume_file').files?.[0]?.name).toBe('Avery_Lin_Resume.pdf');

    expect(item(s, 'Resume/CV')).toMatchObject({ status: 'filled', source: 'resume', fileName: 'Avery_Lin_Resume.pdf' });
    expect(item(s, 'Cover Letter')).toMatchObject({ status: 'needs_you', note: 'cover_letter' });
    expect(item(s, 'What are your salary expectations?')).toMatchObject({ status: 'skipped', note: 'protected', protectedType: 'salary_expectation', canDraft: false });
    expect(item(s, 'Why do you want to work at Example Co?')).toMatchObject({ status: 'needs_you', canDraft: true });
    expect(field<HTMLTextAreaElement>(`#${WHY}`).value).toBe('');

    // Equal-opportunity answers are not in the payload without consent: left alone.
    expect(field<HTMLSelectElement>('#job_application_gender').value).toBe('');
    expect(item(s, 'Gender')).toMatchObject({ status: 'skipped', note: 'protected' });

    expect(api.ops()).toEqual(['createRun', 'autofillProfile', 'resumeForJob', 'fetchFile', 'patchRun']);
    const create = api.calls[0] as Extract<ApiCall, { op: 'createRun' }>;
    expect(create.body).toMatchObject({ host: 'boards.greenhouse.io', atsType: 'greenhouse', jobId: 'job_1', fieldsTotal: 13 });
    expect(create.idempotencyKey).toBeTruthy();
    const patch = api.calls.at(-1) as Extract<ApiCall, { op: 'patchRun' }>;
    expect(patch).toMatchObject({ id: 'run_1', body: { fieldsFilled: 8, outcome: 'partial' } });
    expect(patch.body.userMarkedSubmitted).toBeUndefined();
    expect(s.getState().phase).toBe('done');
  });

  it('fills equal-opportunity answers only when the sensitive payload is present, and flags them for review', async () => {
    const api = fakeApi({}, sampleProfile({ sensitive: { eeo: { gender: 'Female', veteran: 'I am not a protected veteran' } } }));
    const { s } = session({}, api);
    await s.start();
    expect(field<HTMLSelectElement>('#job_application_gender').selectedOptions[0].textContent).toBe('Female');
    expect(item(s, 'Gender')).toMatchObject({ status: 'filled', sensitive: true });
    expect(item(s, 'Veteran Status')).toMatchObject({ status: 'filled', sensitive: true });
  });

  it('fills a saved answer from the answer bank, including protected questions', async () => {
    const api = fakeApi(
      {},
      sampleProfile({
        answers: [
          { questionKey: 'why_company', questionText: 'Why do you want to work at Example Co?', answer: 'Saved answer.' },
          { questionKey: 'salary', questionText: 'What are your salary expectations?', answer: '120,000 USD' },
        ],
      }),
    );
    const { s } = session({}, api);
    await s.start();
    expect(field<HTMLTextAreaElement>(`#${WHY}`).value).toBe('Saved answer.');
    expect(field('#job_application_answers_attributes_4_text_value').value).toBe('120,000 USD');
    expect(item(s, 'What are your salary expectations?')).toMatchObject({ status: 'filled', source: 'bank' });
    expect(api.ops()).not.toContain('answer');
  });

  it('an answer saved from the panel for another employer is not filled by itself: the question is left for a draft the user approves', async () => {
    // "Save this answer" on Globex's form; this form asks the same thing about Example Co (a close match).
    const saved = { questionKey: 'custom:0123456789abcdef', questionText: 'Why do you want to work at Globex Co?', answer: 'I admire Globex and its rockets.', source: 'ai_confirmed' as const };
    const api = fakeApi({ answer: () => ok({ answer: saved.answer, source: 'bank', saveable: false }) }, sampleProfile({ answers: [saved] }));
    const { s } = session({}, api);
    await s.start();
    expect(field<HTMLTextAreaElement>(`#${WHY}`).value).toBe('');
    const why = item(s, 'Why do you want to work at Example Co?');
    expect(why).toMatchObject({ status: 'needs_you', canDraft: true });
    expect(why.source).toBeUndefined();
    // It can still be offered, in the panel, and reaches the form only on "Use this answer".
    await s.requestDraft(why.id);
    expect(field<HTMLTextAreaElement>(`#${WHY}`).value).toBe('');
    expect(item(s, why.label).draft).toMatchObject({ text: saved.answer, source: 'bank' });
  });

  it('an answer saved from the panel fills the same question by itself; an answer the user typed in the app still fills a close match', async () => {
    const same = fakeApi({}, sampleProfile({ answers: [{ questionKey: 'custom:aa', questionText: 'Why do you want to work at Example Co?', answer: 'Saved here before.', source: 'ai_confirmed' }] }));
    const first = session({}, same);
    await first.s.start();
    expect(field<HTMLTextAreaElement>(`#${WHY}`).value).toBe('Saved here before.');
    expect(item(first.s, 'Why do you want to work at Example Co?')).toMatchObject({ status: 'filled', source: 'bank' });

    const typed = fakeApi({}, sampleProfile({ answers: [{ questionKey: 'custom:bb', questionText: 'Why do you want to work at Globex Co?', answer: 'Typed in the app.', source: 'user' }] }));
    const second = session({}, typed);
    await second.s.start();
    expect(field<HTMLTextAreaElement>(`#${WHY}`).value).toBe('Typed in the app.');
  });

  it('without a matched job the main resume is asked for by run only, and attached', async () => {
    const { s, api } = session({ jobId: null });
    await s.start();
    const call = api.calls.find((c) => c.op === 'resumeForJob') as Extract<ApiCall, { op: 'resumeForJob' }>;
    expect(call.body).toEqual({ runId: 'run_1' });
    expect(item(s, 'Resume/CV')).toMatchObject({ status: 'filled', source: 'resume' });
  });

  it('with a matched job the resume is asked for that job', async () => {
    const { s, api } = session({ jobId: 'job_1' });
    await s.start();
    expect((api.calls.find((c) => c.op === 'resumeForJob') as Extract<ApiCall, { op: 'resumeForJob' }>).body).toEqual({ jobId: 'job_1', runId: 'run_1' });
  });

  it('the job the server linked to the run is used when the page lookup found none', async () => {
    const api = fakeApi({ createRun: () => ok({ runId: 'run_1', jobId: 'job_9' }) });
    const { s } = session({ jobId: null }, api);
    await s.start();
    expect(s.getState().jobId).toBe('job_9');
    expect((api.calls.find((c) => c.op === 'resumeForJob') as Extract<ApiCall, { op: 'resumeForJob' }>).body).toEqual({ jobId: 'job_9', runId: 'run_1' });
  });

  it('asks the user to attach the resume when the account has none', async () => {
    const api = fakeApi({ resumeForJob: () => fail('not_found', 404, { reason: 'no_resume' }) });
    const { s } = session({ jobId: null }, api);
    await s.start();
    expect(item(s, 'Resume/CV')).toMatchObject({ status: 'needs_you', note: 'resume_unavailable' });
  });

  it('stops before touching the page when no credit is left', async () => {
    const api = fakeApi({ createRun: () => fail('credits_exhausted', 402, { bucket: 'autofill', resetsAt: '2026-10-11T00:00:00.000Z', upgradable: true }) });
    const { s } = session({}, api);
    await s.start();
    expect(s.getState()).toMatchObject({ phase: 'error', error: 'credits_exhausted', resetsAt: '2026-10-11T00:00:00.000Z' });
    expect(field('#first_name').value).toBe('');
    expect(api.ops()).toEqual(['createRun']);
  });

  it('releases the run when the profile cannot be loaded', async () => {
    const api = fakeApi({ autofillProfile: () => fail('network_error', 0) });
    const { s } = session({}, api);
    await s.start();
    expect(s.getState().error).toBe('network');
    expect(api.calls.at(-1)).toMatchObject({ op: 'patchRun', body: { fieldsFilled: 0, outcome: 'failed' } });
  });

  it('reports outcome "failed" (credit released) when nothing could be filled', async () => {
    const api = fakeApi({ resumeForJob: () => fail('not_found', 404, { reason: 'no_resume' }) }, { profile: {}, education: [], experience: [], links: {}, workAuth: [], answers: [], sensitive: null });
    const { s } = session({ jobId: null }, api);
    await s.start();
    expect(api.calls.at(-1)).toMatchObject({ op: 'patchRun', body: { fieldsFilled: 0, outcome: 'failed' } });
  });
});

describe('one run per application (R4)', () => {
  it('a second pass reuses the run: one createRun, running totals in every PATCH', async () => {
    const { s, api } = session();
    await s.start({ pageKey: 'one' });
    const first = api.calls.filter((c) => c.op === 'patchRun').at(-1) as Extract<ApiCall, { op: 'patchRun' }>;
    expect(first.body).toMatchObject({ fieldsFilled: 8, fieldsTotal: 13 });

    // The next page of the same application (here: the same fixture again under another key).
    await s.start({ pageKey: 'two' });
    expect(api.ops().filter((o) => o === 'createRun')).toHaveLength(1);
    const second = api.calls.filter((c) => c.op === 'patchRun').at(-1) as Extract<ApiCall, { op: 'patchRun' }>;
    expect(second.id).toBe('run_1');
    expect(second.body).toMatchObject({ fieldsFilled: 16, fieldsTotal: 26 });

    // Filling the same page again replaces that page's counts instead of adding to them.
    await s.start({ pageKey: 'two' });
    expect(api.ops().filter((o) => o === 'createRun')).toHaveLength(1);
    expect((api.calls.filter((c) => c.op === 'patchRun').at(-1) as Extract<ApiCall, { op: 'patchRun' }>).body).toMatchObject({ fieldsFilled: 16, fieldsTotal: 26 });

    await s.markSubmitted(true);
    expect(api.calls.at(-1)).toMatchObject({ op: 'patchRun', id: 'run_1', body: { fieldsFilled: 16, fieldsTotal: 26, userMarkedSubmitted: true } });
  });

  it('a page-by-page form adds to the counts of a run the server handed back (reloaded tab)', async () => {
    const api = fakeApi({ createRun: () => ok({ runId: 'run_7', jobId: 'job_1', reused: true, fieldsFilled: 5, fieldsTotal: 9 }) });
    const { s } = session({ multiPage: true }, api);
    await s.start({ pageKey: 'My Experience' });
    expect((api.calls.filter((c) => c.op === 'patchRun').at(-1) as Extract<ApiCall, { op: 'patchRun' }>).body).toMatchObject({ fieldsFilled: 13, fieldsTotal: 22 });
  });

  it('a single-page form does not add them (a refill after a reload is the same page)', async () => {
    const api = fakeApi({ createRun: () => ok({ runId: 'run_7', jobId: 'job_1', reused: true, fieldsFilled: 5, fieldsTotal: 9 }) });
    const { s } = session({}, api);
    await s.start();
    expect((api.calls.filter((c) => c.op === 'patchRun').at(-1) as Extract<ApiCall, { op: 'patchRun' }>).body).toMatchObject({ fieldsFilled: 8, fieldsTotal: 13 });
  });

  it('Undo covers the latest pass only; a new pass asks "Did you submit?" again unless the answer was yes', async () => {
    const { s } = session();
    await s.start({ pageKey: 'one' });
    await s.markSubmitted(false);
    expect(s.getState().submitted).toBe('not_yet');
    await s.start({ pageKey: 'two' });
    expect(s.getState().submitted).toBe('unknown');
    expect(s.undo().restored).toBeGreaterThan(0);
    await s.markSubmitted(true);
    await s.start({ pageKey: 'three' });
    expect(s.getState().submitted).toBe('yes');
  });
});

describe('"Save this answer" (F-EXT-04)', () => {
  it('saves the answer the user used, with their edits, only on the click', async () => {
    const { s, api } = session();
    await s.start();
    const why = item(s, 'Why do you want to work at Example Co?');
    await s.requestDraft(why.id);
    expect(api.ops()).not.toContain('saveAnswer');
    await s.useDraft(why.id, 'My own words.');
    expect(item(s, why.label)).toMatchObject({ status: 'filled', savable: { text: 'My own words.' }, saved: false });
    expect(api.ops()).not.toContain('saveAnswer');

    expect(await s.saveDraftAnswer(why.id)).toBe(true);
    expect(api.calls.at(-1)).toEqual({ op: 'saveAnswer', body: { runId: 'run_1', question: 'Why do you want to work at Example Co?', answer: 'My own words.' } });
    expect(item(s, why.label)).toMatchObject({ saved: true, saving: false });
    // Once saved there is nothing more to send.
    expect(await s.saveDraftAnswer(why.id)).toBe(false);
    expect(api.ops().filter((o) => o === 'saveAnswer')).toHaveLength(1);
  });

  it('a saved answer the server found (bank) is not offered for saving again', async () => {
    const api = fakeApi({ answer: () => ok({ answer: 'From my bank.', source: 'bank', saveable: false }) });
    const { s } = session({}, api);
    await s.start();
    const why = item(s, 'Why do you want to work at Example Co?');
    await s.requestDraft(why.id);
    await s.useDraft(why.id);
    expect(item(s, why.label).savable).toBeUndefined();
    expect(await s.saveDraftAnswer(why.id)).toBe(false);
  });

  it('a refusal for a protected question says so and removes the button; another failure can be retried', async () => {
    let n = 0;
    const api = fakeApi({ saveAnswer: () => (n++ === 0 ? fail('network_error', 0) : fail('invalid_request', 422, { reason: 'protected_question', type: 'grades' })) });
    const { s } = session({}, api);
    await s.start();
    const why = item(s, 'Why do you want to work at Example Co?');
    await s.requestDraft(why.id);
    await s.useDraft(why.id);
    expect(await s.saveDraftAnswer(why.id)).toBe(false);
    expect(item(s, why.label)).toMatchObject({ saveError: 'failed', savable: { text: 'I like small teams that ship often.' } });
    expect(await s.saveDraftAnswer(why.id)).toBe(false);
    expect(item(s, why.label)).toMatchObject({ saveError: 'protected', protectedType: 'grades' });
    expect(item(s, why.label).savable).toBeUndefined();
  });
});

describe('AI answers: shown in the panel only, filled only after "Use this answer"', () => {
  it('a requested draft never reaches the page field until the user approves that field', async () => {
    const { s, api } = session();
    await s.start();
    const why = item(s, 'Why do you want to work at Example Co?');
    await s.requestDraft(why.id);
    expect(api.ops()).toContain('answer');
    const answerCall = api.calls.find((c) => c.op === 'answer') as Extract<ApiCall, { op: 'answer' }>;
    expect(answerCall.body).toMatchObject({ runId: 'run_1', question: 'Why do you want to work at Example Co?', fieldType: 'textarea' });
    expect(answerCall.idempotencyKey).toBeTruthy();

    expect(item(s, why.label).draft).toEqual({ text: 'I like small teams that ship often.', source: 'ai', saveable: true });
    expect(field<HTMLTextAreaElement>(`#${WHY}`).value).toBe('');
    expect(item(s, why.label).status).toBe('needs_you');

    const ok = await s.useDraft(why.id, 'I like small teams that ship often. Edited.');
    expect(ok).toBe(true);
    expect(field<HTMLTextAreaElement>(`#${WHY}`).value).toBe('I like small teams that ship often. Edited.');
    expect(item(s, why.label)).toMatchObject({ status: 'filled', source: 'ai', draft: undefined });
  });

  it('the write path refuses AI text for a field without that approval', async () => {
    const { s } = session();
    await s.start();
    const why = item(s, 'Why do you want to work at Example Co?');
    const apply = (s as unknown as { apply: (id: string, v: unknown, src: string) => Promise<unknown> }).apply.bind(s);
    await expect(apply(why.id, { kind: 'text', text: 'sneaky' }, 'ai')).rejects.toBeInstanceOf(AiApprovalRequiredError);
    expect(field<HTMLTextAreaElement>(`#${WHY}`).value).toBe('');
  });

  it('an approval is single-use and per field', async () => {
    const { s } = session();
    await s.start();
    const why = item(s, 'Why do you want to work at Example Co?');
    await s.requestDraft(why.id);
    await s.useDraft(why.id);
    const apply = (s as unknown as { apply: (id: string, v: unknown, src: string) => Promise<unknown> }).apply.bind(s);
    await expect(apply(why.id, { kind: 'text', text: 'again' }, 'ai')).rejects.toBeInstanceOf(AiApprovalRequiredError);
  });

  it('no draft is ever requested on its own: start() makes no AI call', async () => {
    const { api, s } = session();
    await s.start();
    expect(api.ops()).not.toContain('answer');
  });

  it('protected questions never offer a draft, even if asked', async () => {
    const { s, api } = session();
    await s.start();
    const salary = item(s, 'What are your salary expectations?');
    await s.requestDraft(salary.id);
    expect(api.ops()).not.toContain('answer');
  });

  it('with AI unavailable (e.g. GoApply without AI consent) nothing calls for an answer', async () => {
    const { s, api } = session({ aiAvailable: false });
    await s.start();
    expect(s.getState().items.every((i) => !i.canDraft)).toBe(true);
    for (const i of s.getState().items) await s.requestDraft(i.id);
    expect(api.ops()).not.toContain('answer');
  });

  it('turns drafts off for the session when the server says AI is unavailable', async () => {
    const api = fakeApi({ answer: () => fail('ai_unavailable', 503) });
    const { s } = session({}, api);
    await s.start();
    const why = item(s, 'Why do you want to work at Example Co?');
    await s.requestDraft(why.id);
    expect(s.getState().items.every((i) => !i.canDraft)).toBe(true);
    expect(item(s, why.label).note).toBe('ai_unavailable');
  });

  it('the server refuses a protected question as invalid_request with details.reason and details.type', async () => {
    const api = fakeApi({ answer: () => fail('invalid_request', 422, { reason: 'protected_question', type: 'grades' }) });
    const { s } = session({}, api);
    await s.start();
    const why = item(s, 'Why do you want to work at Example Co?');
    await s.requestDraft(why.id);
    expect(item(s, why.label)).toMatchObject({ canDraft: false, drafting: false, note: 'protected', protectedType: 'grades' });
    expect(item(s, why.label).draft).toBeUndefined();
  });

  it('a question the server calls protected loses its draft button and says why', async () => {
    const api = fakeApi({ answer: () => fail('protected_question', 422, { type: 'notice_period' }) });
    const { s } = session({}, api);
    await s.start();
    const why = item(s, 'Why do you want to work at Example Co?');
    await s.requestDraft(why.id);
    expect(item(s, why.label)).toMatchObject({ canDraft: false, drafting: false, note: 'protected', protectedType: 'notice_period' });
    expect(item(s, why.label).draft).toBeUndefined();
    expect(field<HTMLTextAreaElement>(`#${WHY}`).value).toBe('');
  });

  it('dismissing a draft leaves the field empty', async () => {
    const { s } = session();
    await s.start();
    const why = item(s, 'Why do you want to work at Example Co?');
    await s.requestDraft(why.id);
    s.dismissDraft(why.id);
    expect(item(s, why.label).draft).toBeUndefined();
    expect(field<HTMLTextAreaElement>(`#${WHY}`).value).toBe('');
  });
});

describe('after filling', () => {
  it('"Did you submit this application?" — Yes is the only source of userMarkedSubmitted', async () => {
    const { s, api } = session();
    await s.start();
    expect(api.calls.some((c) => c.op === 'patchRun' && c.body.userMarkedSubmitted)).toBe(false);
    await s.markSubmitted(false);
    expect(api.calls.filter((c) => c.op === 'patchRun')).toHaveLength(1);
    expect(s.getState().submitted).toBe('not_yet');
    await s.markSubmitted(true);
    expect(api.calls.at(-1)).toMatchObject({ op: 'patchRun', id: 'run_1', body: { userMarkedSubmitted: true, fieldsFilled: 8 } });
    expect(s.getState().submitted).toBe('yes');
  });

  it('Undo autofill restores the previous values', async () => {
    const { s } = session();
    field('#phone').value = '+1 000';
    await s.start();
    expect(field('#phone').value).toBe('+15125550100');
    const res = s.undo();
    expect(field('#first_name').value).toBe('');
    expect(field('#phone').value).toBe('+1 000');
    expect(field<HTMLSelectElement>('#job_application_answers_attributes_1_boolean_value').value).toBe('');
    expect(field('#resume_file').files?.length ?? 0).toBe(0);
    expect(res.restored).toBeGreaterThanOrEqual(8);
    expect(summarize(s.getState().items).filled).toBe(0);
  });

  it('does not watch the page: no submit listener is added and no form is submitted', async () => {
    const add = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => {});
    const { s } = session();
    await s.start();
    await s.requestDraft(item(s, /Why do you want/).id);
    await s.useDraft(item(s, /Why do you want/).id);
    await s.markSubmitted(true);
    expect(add.mock.calls.filter(([type]) => type === 'submit')).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    add.mockRestore();
    submit.mockRestore();
    requestSubmit.mockRestore();
  });

  it('works on Lever radio questions from work authorization', async () => {
    const doc = loadFixture('lever', 'standard');
    const api = fakeApi();
    const s = new FillSession({ adapter: leverAdapter, doc, url: 'https://jobs.lever.co/exampleco/abc-123/apply', api: api.api, jobId: 'job_1', aiAvailable: true });
    await s.start();
    expect(document.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe('Avery Lin');
    expect(document.querySelector<HTMLInputElement>('input[name="org"]')!.value).toBe('Prior Corp');
    expect(document.querySelector<HTMLInputElement>('input[name="cards[c1][field0]"][value="Yes"]')!.checked).toBe(true);
    expect(item(s, 'Anything else you want us to know?')).toMatchObject({ status: 'skipped', canDraft: true });
  });
});
