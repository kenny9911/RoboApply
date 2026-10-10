// WP-59 — /practice/questions and /practice/questions/[company] (lib/api/prep mocked).
//
// Acceptance covered here: the source line renders on every item; AI items are
// labelled "Written by AI from the job post — not reported by candidates" and
// never carry a company; GoApply AI items render AiGeneratedBadge; the job set
// has "Practice for this job"; company pages show only user reports with month
// and count; nothing calls a model on page load; the capability hides the page.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { RoboApiError } from '../../../../lib/api/client';
import type { CompaniesResponse, CompanyQuestionsResponse, JobQuestionSetResponse, QuestionDetail, QuestionView } from '../../../../lib/api/contracts/prep';

const api = vi.hoisted(() => ({
  listPrepCompanies: vi.fn(),
  listCompanyQuestions: vi.fn(),
  listCuratedQuestions: vi.fn(),
  getQuestion: vi.fn(),
  generateQuestionGuide: vi.fn(),
  reportQuestion: vi.fn(),
  contributeQuestion: vi.fn(),
  getJobQuestions: vi.fn(),
  generateJobQuestions: vi.fn(),
}));
vi.mock('../../../../lib/api/prep', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));

import PracticeQuestionsRoute from '../../../../app/(auth)/practice/questions/page';
import PracticeQuestionsCompanyRoute from '../../../../app/(auth)/practice/questions/[company]/page';

const q = (over: Partial<QuestionView>): QuestionView => ({
  id: 'q1',
  companySlug: null,
  companyName: null,
  title: 'Talk about a hard trade-off',
  body: 'Tell me about a time you had to choose between speed and quality.',
  category: 'behavioral',
  difficulty: null,
  seniority: null,
  locale: 'en',
  sourceKind: 'curated',
  sourceLabelKey: 'source.curated',
  reportedPeriod: null,
  aiGenerated: false,
  ...over,
});

const CURATED = q({ id: 'cur1' });
const AI_1 = q({ id: 'ai1', title: 'Database performance', body: 'How would you find a slow query?', sourceKind: 'ai_practice', sourceLabelKey: 'source.aiPractice', aiGenerated: true, category: 'coding', difficulty: 'medium' });
const AI_2 = q({ id: 'ai2', title: 'A read path', body: 'How would you design the read path for a busy feed?', sourceKind: 'ai_practice', sourceLabelKey: 'source.aiPractice', aiGenerated: true, category: 'system_design' });
const REPORT = q({ id: 'rep1', title: 'Changing your mind', body: 'Tell me about a time you changed your mind.', sourceKind: 'user_report', sourceLabelKey: 'source.userReport', reportedPeriod: '2026-08', companySlug: 'acme', companyName: 'Acme' });

const COMPANIES: CompaniesResponse = {
  items: [{ slug: 'acme', name: 'Acme', hasCompanyRecord: true, questionCount: { value: 3, source: 'user_reports', method: 'moderated_user_reports', asOf: '2026-10-10T12:00:00.000Z' }, latestPeriod: '2026-09' }],
  cursor: null,
};

const SET_EMPTY: JobQuestionSetResponse = { jobId: 'job_1', jobTitle: 'Backend Engineer', companyName: 'Acme', companySlug: 'acme', status: 'not_generated', generatedAt: null, aiQuestions: [], companyReports: [REPORT] };
const SET_READY: JobQuestionSetResponse = { ...SET_EMPTY, status: 'ready', generatedAt: '2026-10-10T12:00:00.000Z', aiQuestions: [AI_1, AI_2] };

async function renderIndex(search: Record<string, string> = {}, brand: 'roboapply' | 'goapply' = 'roboapply', flags = { interviewBank: true }) {
  const el = await PracticeQuestionsRoute({ searchParams: Promise.resolve(search) });
  return renderWithBrand(el, { brand, flags });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listPrepCompanies.mockResolvedValue(COMPANIES);
  api.listCuratedQuestions.mockResolvedValue({ items: [CURATED], cursor: null });
  api.getJobQuestions.mockResolvedValue(SET_EMPTY);
  api.generateJobQuestions.mockResolvedValue(SET_READY);
});

describe('/practice/questions', () => {
  it('lists staff questions with their source line and companies with real counts', async () => {
    await renderIndex();
    expect(screen.getByRole('heading', { name: 'Practice questions' })).toBeInTheDocument();
    const card = await screen.findByRole('article', { name: 'Talk about a hard trade-off' });
    expect(within(card).getByText('Written by RoboApply staff — not reported by candidates')).toBeInTheDocument();
    const company = await screen.findByRole('link', { name: /Acme/ });
    expect(company).toHaveAttribute('href', '/practice/questions/acme');
    expect(within(company).getByText(/3 shared questions · most recent from September 2026/)).toBeInTheDocument();
    expect(within(company).getByText(/Count of questions shared with us, as of/)).toBeInTheDocument();
    expect(api.getJobQuestions).not.toHaveBeenCalled();
  });

  it('every item carries a source line', async () => {
    api.getJobQuestions.mockResolvedValue(SET_READY);
    const { container } = await renderIndex({ job: 'job_1' });
    await screen.findByRole('article', { name: 'Database performance' });
    await screen.findByRole('article', { name: 'Talk about a hard trade-off' });
    const cards = container.querySelectorAll('[data-testid="question-card"]');
    expect(cards.length).toBe(4);
    for (const card of cards) {
      const kind = card.getAttribute('data-source-kind');
      expect(card.querySelector(`[data-source-kind="${kind}"] span:last-child`)?.textContent).toBeTruthy();
    }
  });

  it('?job=: nothing is written on load; "Write practice questions" writes the AI set, labelled and unattributed', async () => {
    await renderIndex({ job: 'job_1' });
    const set = await screen.findByTestId('job-question-set');
    expect(within(set).getByRole('heading', { name: 'Practice for Backend Engineer' })).toBeInTheDocument();
    expect(within(set).getByRole('link', { name: 'Practice for this job' })).toHaveAttribute('href', '/practice?job=job_1&from=questions');
    // The user report about the company shows with its month.
    const report = within(set).getByRole('article', { name: 'Changing your mind' });
    expect(within(report).getByText('Shared by a RoboApply user, August 2026')).toBeInTheDocument();
    expect(api.generateJobQuestions).not.toHaveBeenCalled();

    fireEvent.click(within(set).getByRole('button', { name: 'Write practice questions from this job post' }));
    const ai = await within(set).findByRole('article', { name: 'Database performance' });
    expect(api.generateJobQuestions).toHaveBeenCalledWith('job_1');
    expect(within(ai).getByText('Written by AI from the job post — not reported by candidates')).toBeInTheDocument();
    expect(within(ai).queryByText('Acme')).toBeNull();
    // RoboApply: no AI badge (it labels AI with its own line).
    expect(set.querySelectorAll('[data-ai-label]')).toHaveLength(0);
  });

  it('GoApply: AI items render AiGeneratedBadge', async () => {
    api.getJobQuestions.mockResolvedValue(SET_READY);
    await renderIndex({ job: 'job_1' }, 'goapply');
    const set = await screen.findByTestId('job-question-set');
    await within(set).findByRole('article', { name: 'Database performance' });
    expect(set.querySelectorAll('[data-ai-label]')).toHaveLength(2);
  });

  it('AI off: says so, no write button', async () => {
    api.getJobQuestions.mockResolvedValue({ ...SET_EMPTY, status: 'ai_unavailable' });
    await renderIndex({ job: 'job_1' });
    const set = await screen.findByTestId('job-question-set');
    expect(await within(set).findByText(/AI writing isn.t available right now/)).toBeInTheDocument();
    expect(within(set).queryByRole('button', { name: /Write practice questions/ })).toBeNull();
  });

  it('a daily limit answer is plain copy', async () => {
    api.generateJobQuestions.mockRejectedValue(new RoboApiError('Too many', { code: 'rate_limited', status: 429, payload: { success: false, code: 'rate_limited', details: { reason: 'job_set_daily_limit' } } }));
    await renderIndex({ job: 'job_1' });
    const set = await screen.findByTestId('job-question-set');
    fireEvent.click(await within(set).findByRole('button', { name: 'Write practice questions from this job post' }));
    expect(await within(set).findByText(/written a lot of question sets today/)).toBeInTheDocument();
  });

  it('"How to answer" writes the guide on first view and labels it as AI', async () => {
    const detail: QuestionDetail = { ...CURATED, guide: null, guideStatus: 'not_generated' };
    api.getQuestion.mockResolvedValue(detail);
    api.generateQuestionGuide.mockResolvedValue({ ...detail, guideStatus: 'ready', guide: { approach: 'Name the trade-off and the result.', rubric: ['States what was given up'] } });
    await renderIndex();
    const card = await screen.findByRole('article', { name: 'Talk about a hard trade-off' });
    fireEvent.click(within(card).getByRole('button', { name: 'How to answer' }));
    expect(await within(card).findByText('Name the trade-off and the result.')).toBeInTheDocument();
    expect(within(card).getByText('Guide written by AI. Check it against your own experience.')).toBeInTheDocument();
    expect(within(card).getByText('States what was given up')).toBeInTheDocument();
    expect(api.generateQuestionGuide).toHaveBeenCalledTimes(1);
    expect(within(card).getByRole('button', { name: 'Hide how to answer' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('a guide is never written when AI is off', async () => {
    api.getQuestion.mockResolvedValue({ ...CURATED, guide: null, guideStatus: 'ai_unavailable' });
    await renderIndex();
    const card = await screen.findByRole('article', { name: 'Talk about a hard trade-off' });
    fireEvent.click(within(card).getByRole('button', { name: 'How to answer' }));
    expect(await within(card).findByText("A guide isn't available for this question right now.")).toBeInTheDocument();
    expect(api.generateQuestionGuide).not.toHaveBeenCalled();
  });

  it('report a question', async () => {
    api.reportQuestion.mockResolvedValue({ reported: true, hidden: false });
    await renderIndex();
    const card = await screen.findByRole('article', { name: 'Talk about a hard trade-off' });
    fireEvent.click(within(card).getByRole('button', { name: 'Report' }));
    fireEvent.click(within(card).getByLabelText('It repeats another question'));
    fireEvent.click(within(card).getByRole('button', { name: 'Send report' }));
    expect(await within(card).findByText('Thanks. Our staff will look at it.')).toBeInTheDocument();
    expect(api.reportQuestion).toHaveBeenCalledWith('cur1', { reason: 'duplicate' });
  });

  it('share a question: moderated, with the month', async () => {
    api.contributeQuestion.mockResolvedValue({ id: 'c1', status: 'pending' });
    await renderIndex();
    fireEvent.click(screen.getByRole('button', { name: 'Share a question you were asked' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/don't share test or assessment questions/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Company'), { target: { value: 'Acme' } });
    fireEvent.change(within(dialog).getByLabelText('When were you asked?'), { target: { value: '2026-09' } });
    fireEvent.change(within(dialog).getByLabelText('The question'), { target: { value: 'Why do you want to work on payments?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for checking' }));
    expect(await within(dialog).findByText('Thanks. Our staff will check it before it shows.')).toBeInTheDocument();
    expect(api.contributeQuestion).toHaveBeenCalledWith({ company: 'Acme', question: 'Why do you want to work on payments?', period: '2026-09' });
  });

  it('share a question: a month the server refuses gets its own message', async () => {
    api.contributeQuestion.mockRejectedValue(
      new RoboApiError('Pick the month', { code: 'invalid_request', status: 422, payload: { success: false, code: 'invalid_request', details: { reason: 'invalid_period' } } }),
    );
    await renderIndex();
    fireEvent.click(screen.getByRole('button', { name: 'Share a question you were asked' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Company'), { target: { value: 'Acme' } });
    fireEvent.change(within(dialog).getByLabelText('When were you asked?'), { target: { value: '2026-09' } });
    fireEvent.change(within(dialog).getByLabelText('The question'), { target: { value: 'Why do you want to work on payments?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for checking' }));
    expect(await within(dialog).findByText(/Pick the month you were asked/)).toBeInTheDocument();
  });

  it('with interviewBank off nothing is fetched', async () => {
    await renderIndex({}, 'roboapply', { interviewBank: false });
    expect(screen.getByText("Practice questions aren't available here yet")).toBeInTheDocument();
    expect(api.listCuratedQuestions).not.toHaveBeenCalled();
    expect(api.listPrepCompanies).not.toHaveBeenCalled();
  });

  it('GoApply offers the HR round group', async () => {
    await renderIndex({}, 'goapply');
    expect(await screen.findByRole('button', { name: 'HR round' })).toBeInTheDocument();
  });
});

describe('/practice/questions/[company]', () => {
  const PAGE: CompanyQuestionsResponse = {
    company: { slug: 'acme', name: 'Acme', hasCompanyRecord: true },
    count: { value: 1, source: 'user_reports', method: 'moderated_user_reports', asOf: '2026-10-10T12:00:00.000Z' },
    latestPeriod: '2026-08',
    items: [REPORT],
    cursor: null,
  };

  it('shows only user reports with month and count', async () => {
    api.listCompanyQuestions.mockResolvedValue(PAGE);
    const el = await PracticeQuestionsCompanyRoute({ params: Promise.resolve({ company: 'acme' }), searchParams: Promise.resolve({}) });
    renderWithBrand(el, { flags: { interviewBank: true } });
    expect(await screen.findByRole('heading', { name: 'Questions about Acme' })).toBeInTheDocument();
    expect(await screen.findByText(/1 question shared by RoboApply users · most recent from August 2026 · as of/)).toBeInTheDocument();
    const card = screen.getByRole('article', { name: 'Changing your mind' });
    expect(within(card).getByText('Shared by a RoboApply user, August 2026')).toBeInTheDocument();
    expect(api.listCompanyQuestions).toHaveBeenCalledWith('acme', {}, expect.anything());
    expect(api.getJobQuestions).not.toHaveBeenCalled();
  });

  it('"Share a question" is prefilled with the resolved company name, not the route slug', async () => {
    let resolve: (v: CompanyQuestionsResponse) => void = () => {};
    api.listCompanyQuestions.mockReturnValue(new Promise<CompanyQuestionsResponse>((r) => (resolve = r)));
    const el = await PracticeQuestionsCompanyRoute({ params: Promise.resolve({ company: 'acme-inc' }), searchParams: Promise.resolve({}) });
    renderWithBrand(el, { flags: { interviewBank: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Share a question you were asked' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Company')).toHaveValue('');
    resolve({ ...PAGE, company: { slug: 'acme-inc', name: 'Acme Inc.', hasCompanyRecord: true } });
    await waitFor(() => expect(within(dialog).getByLabelText('Company')).toHaveValue('Acme Inc.'));
  });

  it("the user's own edit of the company field is kept when the name loads", async () => {
    let resolve: (v: CompanyQuestionsResponse) => void = () => {};
    api.listCompanyQuestions.mockReturnValue(new Promise<CompanyQuestionsResponse>((r) => (resolve = r)));
    const el = await PracticeQuestionsCompanyRoute({ params: Promise.resolve({ company: 'acme-inc' }), searchParams: Promise.resolve({}) });
    renderWithBrand(el, { flags: { interviewBank: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Share a question you were asked' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Company'), { target: { value: 'Acme Payments' } });
    resolve(PAGE);
    expect(await screen.findByRole('heading', { name: 'Questions about Acme' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Company')).toHaveValue('Acme Payments');
  });

  it('decodes a company name segment and shows the empty state without a count', async () => {
    api.listCompanyQuestions.mockResolvedValue({ ...PAGE, company: { slug: 'Tiny Startup', name: 'Tiny Startup', hasCompanyRecord: false }, count: null, latestPeriod: null, items: [] });
    const el = await PracticeQuestionsCompanyRoute({ params: Promise.resolve({ company: 'Tiny%20Startup' }), searchParams: Promise.resolve({ job: 'job_2' }) });
    api.getJobQuestions.mockResolvedValue({ ...SET_EMPTY, jobId: 'job_2', companyName: 'Tiny Startup', companySlug: 'Tiny Startup', companyReports: [] });
    renderWithBrand(el, { flags: { interviewBank: true } });
    expect(await screen.findByText('No one has shared questions about Tiny Startup yet.', { selector: 'section[aria-labelledby="prep-company-list"] p' })).toBeInTheDocument();
    expect(api.listCompanyQuestions).toHaveBeenCalledWith('Tiny Startup', {}, expect.anything());
    await waitFor(() => expect(api.getJobQuestions).toHaveBeenCalledWith('job_2', expect.anything()));
    expect(screen.queryByText(/shared by RoboApply users ·/)).toBeNull();
  });
});
