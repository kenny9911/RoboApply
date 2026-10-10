// @vitest-environment node
//
// WP-59 service tests (in-memory store; no database, no model):
//   - D3 attribution: a curated or AI item with a company is rejected by the service;
//     AI questions are never attributed to a company, and ones claiming "asked at" are dropped;
//   - company pages list only moderated user reports, with month and count;
//   - the AI guide is written on first view, kept, limited per day, and never written
//     when AI is off (zero model calls);
//   - reports (one per user, auto-hide), contributions (period rules, daily limit);
//   - moderation: approve / reject, the NDA/copyright screen, races.

import { beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../platform/http.js';
import { AUTO_HIDE_REPORTS, PREP_ERROR_CODES, type QuestionView } from './contract.js';
import { createPrepFixture, FIXTURE_ADMIN as ADMIN, FIXTURE_USER as U, type PrepFixture } from './fixtures.js';
import type { NewQuestion } from './store.js';

let f: PrepFixture;
beforeEach(() => {
  f = createPrepFixture();
});

const base: NewQuestion = {
  market: 'intl',
  companyId: null,
  companyNameNormalized: null,
  taxonomyId: null,
  category: 'behavioral',
  difficulty: null,
  seniority: null,
  title: 'A hard bug',
  body: 'Tell me about a hard bug you fixed.',
  locale: 'en',
  sourceKind: 'curated',
  reportedPeriod: null,
  contributionId: null,
};

async function expectHttp(p: Promise<unknown>, code: string, reason?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).code).toBe(code);
  if (reason) expect((err as HttpError).details).toMatchObject({ reason });
  return err as HttpError;
}

async function approvedReport(company = 'Acme', period = '2026-08', text = 'Tell me about a time you disagreed with your manager.') {
  const receipt = await f.service.contribute(U, { company, question: text, period });
  return f.service.approve(ADMIN, receipt.id, { category: 'behavioral', title: 'Disagreeing with a manager', body: text });
}

describe('attribution (D3)', () => {
  it('rejects a curated item that carries a companyId', async () => {
    await expectHttp(f.service.createQuestion({ ...base, sourceKind: 'curated', companyId: 'co_acme' }), 'invalid_request', PREP_ERROR_CODES.companyOnNonReport);
    expect(f.store.questions).toHaveLength(0);
  });

  it('rejects an AI item that carries a company name', async () => {
    await expectHttp(f.service.createQuestion({ ...base, sourceKind: 'ai_practice', companyNameNormalized: 'acme' }), 'invalid_request', PREP_ERROR_CODES.companyOnNonReport);
    expect(f.store.questions).toHaveLength(0);
  });

  it('accepts a user report with a company, and requires one', async () => {
    const row = await f.service.createQuestion({ ...base, sourceKind: 'user_report', companyNameNormalized: 'acme', reportedPeriod: '2026-09' });
    expect(row.companyNameNormalized).toBe('acme');
    await expectHttp(f.service.createQuestion({ ...base, sourceKind: 'user_report' }), 'invalid_request', 'company_required');
    await expectHttp(f.service.createQuestion({ ...base, sourceKind: 'scraped' }), 'invalid_request', 'unknown_source_kind');
  });
});

describe('AI questions from a job post', () => {
  it('GET never calls the model; status says whether a set can be written', async () => {
    const res = await f.service.jobSet(U, 'job_1', 'en');
    expect(res.status).toBe('not_generated');
    expect(res.aiQuestions).toEqual([]);
    f.state.ai = false;
    expect((await f.service.jobSet(U, 'job_1', 'en')).status).toBe('ai_unavailable');
    expect(f.calls.set).toHaveLength(0);
  });

  it('writes a labelled set with no company, drops "asked at" claims, and reuses it', async () => {
    f.jobs.get('job_1')!.text = 'Own database performance.';
    f.store.jobs.push({ id: 'job_9', title: 'Data Engineer', companyId: 'co_acme', companyNameNormalized: 'acme', market: 'intl', visibility: 'public', open: true });
    const res = await f.service.generateJobSet(U, 'job_1', 'en');
    expect(res.status).toBe('ready');
    expect(res.aiQuestions).toHaveLength(2);
    for (const q of res.aiQuestions) {
      expect(q.sourceKind).toBe('ai_practice');
      expect(q.sourceLabelKey).toBe('source.aiPractice');
      expect(q.aiGenerated).toBe(true);
      expect(q.companySlug).toBeNull();
      expect(q.companyName).toBeNull();
      expect(q.body).not.toMatch(/asked at/i);
    }
    // Stored rows never name the company either.
    for (const row of f.store.questions) {
      expect(row.companyId).toBeNull();
      expect(row.companyNameNormalized).toBeNull();
    }
    // The prompt input carries the post and the other titles, nothing about the user.
    expect(f.calls.set[0]).toMatchObject({ job: { title: 'Backend Engineer', company: 'Acme' }, otherTitles: ['Data Engineer'], includeHrRound: false });

    const again = await f.service.generateJobSet(U, 'job_1', 'en');
    expect(again.aiQuestions.map((q) => q.id)).toEqual(res.aiQuestions.map((q) => q.id));
    expect(f.calls.set).toHaveLength(1);
    expect((await f.service.jobSet(U, 'job_1', 'en')).status).toBe('ready');
  });

  it('with AI off: 503 ai_unavailable and zero model calls', async () => {
    f.state.ai = false;
    await expectHttp(f.service.generateJobSet(U, 'job_1', 'en'), 'ai_unavailable');
    expect(f.calls.set).toHaveLength(0);
    expect(f.calls.budget).toHaveLength(0);
  });

  it('the daily limit answers 429 job_set_daily_limit before any model call', async () => {
    f.state.budgetLeft.jobSet = 0;
    const err = await expectHttp(f.service.generateJobSet(U, 'job_1', 'en'), 'rate_limited', PREP_ERROR_CODES.jobSetLimit);
    expect(err.headers?.['Retry-After']).toBe('3600');
    expect(f.calls.set).toHaveLength(0);
  });

  it('GoApply asks for HR-round questions too', async () => {
    f.state.market = 'cn';
    await f.service.generateJobSet(U, 'job_1', 'zh');
    expect(f.calls.set[0]?.includeHrRound).toBe(true);
  });

  it('a model answer with nothing usable is ai_unavailable, nothing stored', async () => {
    const empty = createPrepFixture({ set: [{ title: 'x', body: 'Candidates report this was asked by Acme in real interviews.', category: 'behavioral', difficulty: null }] });
    await expectHttp(empty.service.generateJobSet(U, 'job_1', 'en'), 'ai_unavailable', 'empty_output');
    expect(empty.store.questions).toHaveLength(0);
  });

  it('a job the user cannot see is 404', async () => {
    await expectHttp(f.service.jobSet(U, 'job_missing', 'en'), 'not_found');
  });

  it('planForJob: AI set then company reports, each with its own sourceKind', async () => {
    await approvedReport();
    const plan = await f.service.planForJob(U, 'job_1', 'en', { write: true });
    expect(plan.questions.map((q) => q.sourceKind)).toEqual(['ai_practice', 'ai_practice', 'user_report']);
    expect(plan.companyReports[0]).toMatchObject({ companyName: 'Acme', companySlug: 'acme', reportedPeriod: '2026-08' });
    expect(plan.companySlug).toBe('acme');
  });

  it('planForJob falls back to what exists when AI is off', async () => {
    await approvedReport();
    f.state.ai = false;
    const plan = await f.service.planForJob(U, 'job_1', 'en');
    expect(plan.status).toBe('ai_unavailable');
    expect(plan.questions.map((q) => q.sourceKind)).toEqual(['user_report']);
    expect(f.calls.set).toHaveLength(0);
  });

  it('planForJob is read only unless the caller asks to write: a missing set costs no model call or limit', async () => {
    await approvedReport();
    const plan = await f.service.planForJob(U, 'job_1', 'en');
    expect(plan.status).toBe('not_generated');
    expect(plan.questions.map((q) => q.sourceKind)).toEqual(['user_report']);
    expect(f.calls.set).toHaveLength(0);
    expect(f.calls.budget.filter((b) => b.kind === 'jobSet')).toHaveLength(0);
    // Once written (an explicit action), the read-only call returns it.
    await f.service.generateJobSet(U, 'job_1', 'en');
    const again = await f.service.planForJob(U, 'job_1', 'en');
    expect(again.status).toBe('ready');
    expect(again.aiQuestions).toHaveLength(2);
    expect(f.calls.set).toHaveLength(1);
  });

  it.todo('SR-59-1: job set survives a cold start (Prisma index)');

  it('a job with no company record links the company page by name', async () => {
    const res = await f.service.jobSet(U, 'job_2', 'en');
    expect(res.companySlug).toBe('Nameless Ltd');
  });
});

describe('company pages', () => {
  beforeEach(() => {
    f.store.companies.push({ id: 'co_acme', slug: 'acme', displayName: 'Acme', nameNormalized: 'acme', market: 'intl' });
  });

  it('show only moderated user reports, with month and a count from stored rows', async () => {
    await approvedReport('Acme', '2026-08');
    await approvedReport('Acme Inc', '2026-09', 'How would you explain a delay to a customer?');
    await f.service.createQuestion({ ...base, sourceKind: 'curated' });
    await f.service.generateJobSet(U, 'job_1', 'en');
    await f.service.contribute(U, { company: 'Acme', question: 'Still pending: why us?', period: '2026-09' });

    const page = await f.service.companyQuestions('acme', {});
    expect(page.company).toEqual({ slug: 'acme', name: 'Acme', hasCompanyRecord: true });
    expect(page.items.map((q) => q.sourceKind)).toEqual(['user_report', 'user_report']);
    expect(page.items[0]).toMatchObject({ reportedPeriod: '2026-09', companyName: 'Acme', sourceLabelKey: 'source.userReport' });
    expect(page.count).toMatchObject({ value: 2, source: 'user_reports' });
    expect(page.latestPeriod).toBe('2026-09');
  });

  it('a company without a record resolves by the name a user typed', async () => {
    await approvedReport('Tiny Startup', '2026-07');
    const page = await f.service.companyQuestions(encodeURIComponent('Tiny Startup').replace(/%20/g, ' '), {});
    expect(page.company).toEqual({ slug: 'Tiny Startup', name: 'Tiny Startup', hasCompanyRecord: false });
    expect(page.items).toHaveLength(1);
  });

  it('a company with no reports has count null (never 0 shown as data)', async () => {
    const page = await f.service.companyQuestions('acme', {});
    expect(page.count).toBeNull();
    expect(page.items).toEqual([]);
  });

  it('lists companies with counts, filtered by name', async () => {
    await approvedReport('Acme', '2026-08');
    await approvedReport('Acme', '2026-09', 'Describe a project you are proud of.');
    await approvedReport('Globex', '2026-05');
    const all = await f.service.listCompanies({});
    expect(all.items.map((c) => [c.name, c.questionCount.value, c.latestPeriod])).toEqual([
      ['Acme', 2, '2026-09'],
      ['Globex', 1, '2026-05'],
    ]);
    expect(all.items[0]?.slug).toBe('acme');
    expect(all.items[1]).toMatchObject({ slug: 'Globex', hasCompanyRecord: false });
    expect((await f.service.listCompanies({ q: 'glob' })).items.map((c) => c.name)).toEqual(['Globex']);
  });

  it('a company counts once when only some of its reports carry the company record', async () => {
    f.store.companies.length = 0;
    await approvedReport('Initech', '2026-05');
    f.store.companies.push({ id: 'co_initech', slug: 'initech', displayName: 'Initech', nameNormalized: 'initech', market: 'intl' });
    await approvedReport('Initech', '2026-07', 'Describe a project you are proud of.');
    expect(f.store.questions.map((q) => q.companyId)).toEqual([null, 'co_initech']);
    const all = await f.service.listCompanies({});
    expect(all.items).toHaveLength(1);
    expect(all.items[0]).toMatchObject({ slug: 'initech', name: 'Initech', hasCompanyRecord: true, latestPeriod: '2026-07' });
    expect(all.items[0]?.questionCount.value).toBe(2);
  });

  it('other markets never leak', async () => {
    await approvedReport('Acme', '2026-08');
    f.state.market = 'cn';
    expect((await f.service.listCompanies({})).items).toEqual([]);
    expect((await f.service.companyQuestions('Acme', {})).items).toEqual([]);
  });
});

describe('guides', () => {
  let q: QuestionView;
  beforeEach(async () => {
    q = f.service.toView(await f.service.createQuestion({ ...base }));
  });

  it('first view reports not_generated; the guide is written once and kept', async () => {
    expect((await f.service.getQuestion(U, q.id)).guideStatus).toBe('not_generated');
    const written = await f.service.generateGuide(U, q.id, 'en');
    expect(written.guideStatus).toBe('ready');
    expect(written.guide?.approach).toMatch(/concrete example/);
    await f.service.generateGuide(U, q.id, 'en');
    expect(f.calls.guide).toHaveLength(1);
    expect(f.store.questions[0]?.guideModel).toBe('test-model');
    expect((await f.service.getQuestion(U, q.id)).guideStatus).toBe('ready');
  });

  it('AI off: status ai_unavailable, POST 503, zero model calls', async () => {
    f.state.ai = false;
    expect((await f.service.getQuestion(U, q.id)).guideStatus).toBe('ai_unavailable');
    await expectHttp(f.service.generateGuide(U, q.id, 'en'), 'ai_unavailable');
    expect(f.calls.guide).toHaveLength(0);
  });

  it('30/day limit → 429 guide_daily_limit', async () => {
    f.state.budgetLeft.guide = 0;
    await expectHttp(f.service.generateGuide(U, q.id, 'en'), 'rate_limited', PREP_ERROR_CODES.guideLimit);
    expect(f.calls.guide).toHaveLength(0);
  });

  it('hidden questions and other markets are 404', async () => {
    await f.service.setQuestionStatus(q.id, 'hidden');
    await expectHttp(f.service.getQuestion(U, q.id), 'not_found');
    await f.service.setQuestionStatus(q.id, 'published');
    f.state.market = 'cn';
    await expectHttp(f.service.getQuestion(U, q.id), 'not_found');
  });
});

describe('reports', () => {
  it('one per user; enough different users hide the question', async () => {
    const q = await f.service.createQuestion({ ...base });
    expect(await f.service.report(U, q.id, { reason: 'wrong' })).toEqual({ reported: true, hidden: false });
    expect(await f.service.report(U, q.id, { reason: 'wrong' })).toEqual({ reported: true, hidden: false });
    expect(f.store.questions[0]?.reportsCount).toBe(1);
    for (let i = 2; i <= AUTO_HIDE_REPORTS; i++) {
      f.state.now = new Date(f.state.now.getTime() + 60_000);
      const res = await f.service.report(`user_${i}`, q.id, { reason: 'duplicate', note: 'Same as another' });
      expect(res.hidden).toBe(i === AUTO_HIDE_REPORTS);
    }
    expect(f.store.questions[0]?.status).toBe('hidden');
    const listed = await f.service.adminQuestions({ filter: 'hidden' });
    expect(listed.items[0]).toMatchObject({ status: 'hidden', reportsCount: AUTO_HIDE_REPORTS });
    expect(listed.items[0]?.reports[0]).toMatchObject({ reason: 'duplicate', note: 'Same as another' });
  });

  it('showing a question again clears its reports: one new report does not hide it, and it leaves the Reported list', async () => {
    const q = await f.service.createQuestion({ ...base });
    for (let i = 1; i <= AUTO_HIDE_REPORTS; i++) await f.service.report(`user_${i}`, q.id, { reason: 'wrong' });
    expect(f.store.questions[0]?.status).toBe('hidden');
    await f.service.setQuestionStatus(q.id, 'published');
    expect(f.store.questions[0]).toMatchObject({ status: 'published', reportsCount: 0 });
    expect((await f.service.adminQuestions({ filter: 'reported' })).items).toEqual([]);
    expect(await f.service.report('user_late', q.id, { reason: 'other' })).toEqual({ reported: true, hidden: false });
    expect(f.store.questions[0]).toMatchObject({ status: 'published', reportsCount: 1 });
    // A reporter from before the review cannot undo it by reporting again.
    expect((await f.service.report('user_1', q.id, { reason: 'wrong' })).hidden).toBe(false);
    expect((await f.service.adminQuestions({ filter: 'reported' })).items.map((i) => i.reportsCount)).toEqual([1]);
  });

  it('staff can keep a reported question shown (clears its reports)', async () => {
    const q = await f.service.createQuestion({ ...base });
    await f.service.report(U, q.id, { reason: 'wrong' });
    expect((await f.service.adminQuestions({ filter: 'reported' })).items).toHaveLength(1);
    await f.service.setQuestionStatus(q.id, 'published');
    expect((await f.service.adminQuestions({ filter: 'reported' })).items).toEqual([]);
  });

  it('daily limit', async () => {
    const q = await f.service.createQuestion({ ...base });
    f.state.budgetLeft.report = 0;
    await expectHttp(f.service.report(U, q.id, { reason: 'other' }), 'rate_limited', 'report_daily_limit');
  });
});

describe('contributions and moderation', () => {
  it('a contribution needs a past month and stays pending (nothing published)', async () => {
    await expectHttp(f.service.contribute(U, { company: 'Acme', question: 'Why do you want this job?', period: '2027-01' }), 'invalid_request', 'invalid_period');
    await expectHttp(f.service.contribute(U, { company: 'Acme', question: 'Why do you want this job?', period: '1999-12' }), 'invalid_request', 'invalid_period');
    const receipt = await f.service.contribute(U, { company: 'Acme', role: 'Analyst', question: 'Why do you want this job?', period: '2026-10' });
    expect(receipt.status).toBe('pending');
    expect(f.store.questions).toHaveLength(0);
    const queue = await f.service.listContributions({});
    expect(queue.items[0]).toMatchObject({ companyName: 'Acme', role: 'Analyst', period: '2026-10', status: 'pending', flags: [] });
  });

  it('daily contribution limit', async () => {
    f.state.budgetLeft.contribution = 0;
    await expectHttp(f.service.contribute(U, { company: 'Acme', question: 'Why do you want this job?', period: '2026-10' }), 'rate_limited', 'contribution_daily_limit');
  });

  it('approval publishes a user report linked to the company record, labelled with the month', async () => {
    f.store.companies.push({ id: 'co_acme', slug: 'acme', displayName: 'Acme', nameNormalized: 'acme', market: 'intl' });
    const view = await approvedReport('ACME Inc', '2026-06');
    expect(view).toMatchObject({ sourceKind: 'user_report', companySlug: 'acme', companyName: 'Acme', reportedPeriod: '2026-06', aiGenerated: false });
    expect(f.store.questions[0]).toMatchObject({ companyId: 'co_acme', companyNameNormalized: 'acme', contributionId: expect.any(String) });
    expect(f.store.audits[0]).toMatchObject({ userId: U, eventType: 'question_contribution_moderated', payload: { decision: 'approved', moderatorId: ADMIN } });
    expect((await f.service.listContributions({ status: 'approved' })).items).toHaveLength(1);
  });

  it('flagged text (possible test content under NDA) needs explicit confirmation', async () => {
    const text = 'This was the HackerRank online assessment question, under NDA: implement an LRU cache?';
    const receipt = await f.service.contribute(U, { company: 'Acme', question: text, period: '2026-09' });
    const queue = await f.service.listContributions({});
    expect(queue.items[0]?.flags).toContain('nda_or_test_content');
    await expectHttp(
      f.service.approve(ADMIN, receipt.id, { category: 'coding', title: 'LRU cache', body: text }),
      'conflict',
      PREP_ERROR_CODES.screenNotConfirmed,
    );
    expect(f.store.questions).toHaveLength(0);
    const rejected = await f.service.reject(ADMIN, receipt.id, { reason: 'nda_or_test_content', note: 'Assessment item' });
    expect(rejected.status).toBe('rejected');
    expect(f.store.audits.at(-1)?.payload).toMatchObject({ decision: 'rejected', reason: 'nda_or_test_content' });
    await expectHttp(f.service.approve(ADMIN, receipt.id, { category: 'coding', title: 'LRU', body: text, confirmScreened: true }), 'conflict', PREP_ERROR_CODES.alreadyModerated);
  });

  it("staff's company name is the one public pages show, not the typed one", async () => {
    const receipt = await f.service.contribute(U, { company: 'globex', question: 'Tell me about a time you led a project?', period: '2026-08' });
    const view = await f.service.approve(ADMIN, receipt.id, { category: 'behavioral', title: 'Leading a project', body: 'Tell me about a time you led a project?', companyName: 'Globex' });
    expect(view.companyName).toBe('Globex');
    expect((await f.service.listCompanies({})).items.map((c) => c.name)).toEqual(['Globex']);
    const page = await f.service.companyQuestions('globex', {});
    expect(page.company.name).toBe('Globex');
    expect(page.items[0]?.companyName).toBe('Globex');
    expect((await f.service.listContributions({ status: 'approved' })).items[0]?.companyName).toBe('Globex');
    // The contributor's own wording stays on the record.
    expect(f.store.audits.at(-1)?.payload).toMatchObject({ decision: 'approved', submittedCompanyName: 'globex' });
  });

  it('the language is guessed from the script (kana → ja, Hangul → ko, Han → zh-TW) and staff can set it', async () => {
    const cases: Array<[string, string]> = [
      ['日本語のテスト質問です、なぜ弊社ですか？', 'ja'],
      ['왜 우리 회사에 지원했습니까?', 'ko'],
      ['為什麼想加入我們的團隊？', 'zh-TW'],
      ['Why do you want to join this team?', 'en'],
    ];
    for (const [text, locale] of cases) {
      const receipt = await f.service.contribute(U, { company: 'Acme', question: text, period: '2026-09' });
      const queued = (await f.service.listContributions({})).items.find((c) => c.id === receipt.id);
      expect(queued?.locale).toBe(locale);
      const view = await f.service.approve(ADMIN, receipt.id, { category: 'behavioral', title: 'Why us', body: text });
      expect(view.locale).toBe(locale);
    }
    const receipt = await f.service.contribute(U, { company: 'Acme', question: '為什麼想加入我們的團隊？', period: '2026-09' });
    expect((await f.service.approve(ADMIN, receipt.id, { category: 'behavioral', title: 'Why us', body: '為什麼想加入我們的團隊？', locale: 'ja' })).locale).toBe('ja');
  });

  it('the screen covers the title too: flagged text only in the title needs confirmation', async () => {
    const receipt = await f.service.contribute(U, { company: 'Acme', question: 'Why do you want to join this team?', period: '2026-09' });
    await expectHttp(
      f.service.approve(ADMIN, receipt.id, { category: 'behavioral', title: 'Ask jane@acme.test about it', body: 'Why do you want to join this team?' }),
      'conflict',
      PREP_ERROR_CODES.screenNotConfirmed,
    );
    expect(f.store.questions).toHaveLength(0);
    const view = await f.service.approve(ADMIN, receipt.id, { category: 'behavioral', title: 'Ask jane@acme.test about it', body: 'Why do you want to join this team?', confirmScreened: true });
    expect(view.sourceKind).toBe('user_report');
  });

  it('staff can tidy flagged wording and confirm', async () => {
    const receipt = await f.service.contribute(U, { company: 'Acme', question: 'My interviewer jane@acme.test asked: why this team?', period: '2026-09' });
    const view = await f.service.approve(ADMIN, receipt.id, { category: 'behavioral', title: 'Why this team', body: 'Why do you want to join this team?' });
    expect(view.body).toBe('Why do you want to join this team?');
  });

  it('approval is all or nothing: when the question cannot be stored, the contribution stays pending', async () => {
    const receipt = await f.service.contribute(U, { company: 'Acme', question: 'Why do you want this job?', period: '2026-10' });
    const create = f.store.createQuestion;
    f.store.createQuestion = async () => {
      throw new Error('connection reset');
    };
    await expect(f.service.approve(ADMIN, receipt.id, { category: 'behavioral', title: 'Why this job', body: 'Why do you want this job?' })).rejects.toThrow('connection reset');
    expect(f.store.contributions[0]).toMatchObject({ status: 'pending', moderatorId: null, moderatedAt: null });
    expect(f.store.questions).toHaveLength(0);
    expect(f.store.audits).toHaveLength(0);
    f.store.createQuestion = create;
    const view = await f.service.approve(ADMIN, receipt.id, { category: 'behavioral', title: 'Why this job', body: 'Why do you want this job?' });
    expect(view.sourceKind).toBe('user_report');
    expect(f.store.contributions[0]?.status).toBe('approved');
  });

  it('a failed company check leaves the contribution pending', async () => {
    const receipt = await f.service.contribute(U, { company: 'Acme', question: 'Why do you want this job?', period: '2026-10' });
    await expectHttp(f.service.approve(ADMIN, receipt.id, { category: 'behavioral', title: 'Why', body: 'Why do you want this job?', companyName: '   ' }), 'invalid_request', 'company_required');
    expect(f.store.contributions[0]?.status).toBe('pending');
  });

  it('contributions from another market are 404', async () => {
    const receipt = await f.service.contribute(U, { company: 'Acme', question: 'Why do you want this job?', period: '2026-10' });
    f.state.market = 'cn';
    await expectHttp(f.service.reject(ADMIN, receipt.id, { reason: 'other' }), 'not_found');
  });

  it('staff-written questions are generic and labelled as staff', async () => {
    const view = await f.service.createCurated({ title: 'Your plans', body: '你未来三到五年的职业规划是什么？', category: 'hr', locale: 'zh' });
    expect(view).toMatchObject({ sourceKind: 'curated', sourceLabelKey: 'source.curated', companySlug: null, aiGenerated: false });
    expect((await f.service.curatedQuestions({ category: 'hr' }, 'zh')).items).toHaveLength(1);
    expect((await f.service.curatedQuestions({ category: 'coding' }, 'zh')).items).toHaveLength(0);
  });

  it("staff questions list in the reader's language, with the site language as fallback", async () => {
    await f.service.createCurated({ title: 'A hard bug', body: 'Tell me about a hard bug you fixed.', category: 'behavioral', locale: 'en' });
    await f.service.createCurated({ title: '困難的錯誤', body: '請說說你修過最難的一個錯誤。', category: 'behavioral', locale: 'zh-TW' });
    const titles = async (locale?: string) => (await f.service.curatedQuestions({}, locale)).items.map((i) => i.title);
    expect(await titles('en')).toEqual(['A hard bug']);
    expect(await titles('zh-TW')).toEqual(['困難的錯誤']);
    expect(await titles('ja')).toEqual(['A hard bug']);
    expect(await titles()).toEqual(['A hard bug']);
    f.state.market = 'cn';
    await f.service.createCurated({ title: '职业规划', body: '你未来三到五年的职业规划是什么？', category: 'hr', locale: 'zh' });
    expect(await titles('en')).toEqual(['职业规划']);
  });
});
