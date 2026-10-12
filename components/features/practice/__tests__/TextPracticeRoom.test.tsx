// TextPracticeRoom (WP-43): the written practice — start (with the job),
// answer, finish, score; a counted practice refreshes the checklist and the
// balance; a refused start goes back to the setup page.
//
// INT-09 (WP-66): on GoApply's AI-interview format each question shows its
// thinking and answer time from the server's plan, the result is followed by
// the practice report (three areas, STAR check, filler words), and every AI
// block carries the AI label. RoboApply shows none of these.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';

import { TextPracticeRoom, type TextPracticeRoomProps } from '../TextPracticeRoom';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import { IntlWrapper } from '../../../../__tests__/utils/mockTranslations';
import { CHECKLIST_QUERY_KEY } from '../../../../hooks/growth';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import { buildCnPracticeReport, normalizeCnTurns } from '../../practice-cn';

const m = vi.hoisted(() => ({ start: vi.fn(), nextTurn: vi.fn(), score: vi.fn() }));
vi.mock('../../../../lib/api/interviewEngine', () => ({
  textPracticeApi: { start: m.start, nextTurn: m.nextTurn, score: m.score },
}));

beforeEach(() => {
  vi.clearAllMocks();
  m.start.mockResolvedValue({
    sessionId: 't1',
    questions: [
      { q: 'Tell me about yourself.', hint: 'Keep it short', coachTip: null },
      { q: 'Why this team?', hint: '', coachTip: null },
    ],
  });
  m.nextTurn
    .mockResolvedValueOnce({ nextIndex: 1, turns: [{ who: 'them', text: 'Thanks. Next one.' }], coachTip: null })
    .mockResolvedValueOnce({ nextIndex: null, turns: [], coachTip: null });
  m.score.mockResolvedValue({
    overall: 64, delta: null, breakdown: [], strengths: ['Clear story'], gaps: ['Add a number'], durationMinutes: 5,
    practiceCounted: true, jobId: 'j1',
  });
});

function renderRoom(onExit = vi.fn(), extra: Partial<TextPracticeRoomProps> = {}) {
  renderWithProviders(
    <TextPracticeRoom role="Backend Engineer" interviewerId="maya" typeId="behavioral" language="zh" onExit={onExit} {...extra} />,
  );
  return onExit;
}

async function answerAll() {
  fireEvent.change(await screen.findByLabelText('Your answer'), { target: { value: 'I build APIs.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  await screen.findByText('Why this team?');
  fireEvent.click(screen.getByRole('button', { name: 'Skip this question' }));
  fireEvent.click(await screen.findByRole('button', { name: 'See my results' }));
}

describe('TextPracticeRoom', () => {
  it('runs a written practice end to end', async () => {
    renderRoom();
    expect(await screen.findByText('Tell me about yourself.')).toBeTruthy();
    expect(m.start).toHaveBeenCalledWith({
      role: 'Backend Engineer', interviewerId: 'maya', typeId: 'behavioral', language: 'zh', durationMinutes: undefined, jobId: null,
    });
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'I build APIs.' } });
    fireEvent.click(send);
    expect(await screen.findByText('Why this team?')).toBeTruthy();
    expect(screen.getByText('I build APIs.')).toBeTruthy();
    expect(screen.getByText('Thanks. Next one.')).toBeTruthy();
    expect(m.nextTurn).toHaveBeenCalledWith({ sessionId: 't1', answer: 'I build APIs.', questionIndex: 0 });

    fireEvent.click(screen.getByRole('button', { name: 'Skip this question' }));
    fireEvent.click(await screen.findByRole('button', { name: 'See my results' }));
    expect(await screen.findByText('64')).toBeTruthy();
    expect(screen.getByText('Clear story')).toBeTruthy();
    expect(screen.getByText('Add a number')).toBeTruthy();
    expect(screen.getByText("Scores come from your answers in this practice. They don't predict a real interview.")).toBeTruthy();
  });

  it('practises for the job and, once scored, refreshes the checklist and the balance', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <IntlWrapper>
          <TextPracticeRoom role="Backend Engineer" interviewerId="maya" typeId="behavioral" jobId="j1" onExit={vi.fn()} />
        </IntlWrapper>
      </QueryClientProvider>,
    );
    await answerAll();
    expect(await screen.findByText('64')).toBeTruthy();
    expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'j1' }));
    expect(m.score).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: CHECKLIST_QUERY_KEY }));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['account', 'credits'] });
  });

  it('an unanswered practice does not refresh the checklist', async () => {
    m.score.mockResolvedValue({
      overall: 0, delta: null, breakdown: [], strengths: [], gaps: [], durationMinutes: 1, practiceCounted: false, jobId: null,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <IntlWrapper>
          <TextPracticeRoom role="Backend Engineer" interviewerId="maya" typeId="behavioral" onExit={vi.fn()} />
        </IntlWrapper>
      </QueryClientProvider>,
    );
    await answerAll();
    // Nothing was answered: the score shows "—", not a 0 out of 100.
    const score = await screen.findByTestId('text-practice-score');
    expect(score.textContent).toContain('—');
    expect(score.textContent).not.toMatch(/0|\/100/);
    expect(spy).not.toHaveBeenCalledWith({ queryKey: CHECKLIST_QUERY_KEY });
  });

  // FIX-6: the interviewer writes light markdown (the server contract says so).
  it('renders the interviewer’s markdown instead of showing the ** markers', async () => {
    m.start.mockResolvedValue({
      sessionId: 't1',
      questions: [
        { q: 'Design a Top-K over **256MB** of memory.', hint: 'Give the **complexity** of each option.', coachTip: null },
        { q: 'Why this team?', hint: '', coachTip: null },
      ],
    });
    m.nextTurn.mockReset();
    m.nextTurn.mockResolvedValueOnce({
      nextIndex: 1,
      turns: [{ who: 'them', text: 'Right direction, but **you gave no numbers**.\n\nNext: why this team?' }],
      coachTip: null,
    });
    renderRoom();
    const bold = await screen.findByText('256MB');
    expect(bold.tagName).toBe('STRONG');
    expect(screen.getByText('complexity').tagName).toBe('STRONG');
    expect(document.body.textContent).not.toContain('**');

    // What the user types is shown as typed, markers included.
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Use a **heap** of size K.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByText('Use a **heap** of size K.')).toBeTruthy();

    const reply = await screen.findByText('you gave no numbers');
    expect(reply.tagName).toBe('STRONG');
    const turn = reply.closest('li')!;
    // Bold text in a reply is not styled as the speaker label, and paragraphs stay apart.
    expect(turn.querySelector('[data-turn-who]')!.textContent).toBe('Interviewer');
    expect(reply.hasAttribute('data-turn-who')).toBe(false);
    expect(turn.querySelectorAll('p')).toHaveLength(2);
    expect(turn.textContent).not.toContain('**');
  });

  // FIX-6 review: the written brief asks for code and multi-part questions, so
  // the interviewer's text is block markdown. A fenced block with a blank line
  // stays one block, a numbered list keeps its list, and neither sits in a <p>.
  it('keeps a code block whole and a numbered list numbered', async () => {
    const code = '```python\ndef f(x):\n    a = 1\n\n    return a\n```';
    m.start.mockResolvedValue({
      sessionId: 't1',
      questions: [
        { q: `Read this:\n\n${code}\n\nThen answer:\n\n1. What is the complexity?\n2. Where is the bug?`, hint: 'Start with the loop.', coachTip: null },
        { q: 'Why this team?', hint: '', coachTip: null },
      ],
    });
    m.nextTurn.mockReset();
    m.nextTurn.mockResolvedValueOnce({
      nextIndex: 1,
      turns: [{ who: 'them', text: `Close. Look again:\n\n${code}\n\n1. First point\n2. Second point` }],
      coachTip: null,
    });
    renderRoom();

    const card = (await screen.findByText('Read this:')).closest('[data-question-card]')!;
    const pres = card.querySelectorAll('pre');
    expect(pres).toHaveLength(1);
    expect(pres[0]!.textContent).toBe('def f(x):\n    a = 1\n\n    return a\n');
    const list = card.querySelector('ol')!;
    expect(list.querySelectorAll('li')).toHaveLength(2);
    // Tailwind's reset removes list markers; the block renderer puts them back.
    expect(list.style.listStyle).toContain('decimal');
    expect(card.querySelector('p pre, p ol, p ul, p p, p div')).toBeNull();
    expect(card.textContent).not.toContain('```');
    // The hint still reads on the same line as its label.
    expect(screen.getByText('Start with the loop.').tagName).toBe('P');

    // Typed code keeps its own line breaks and is not parsed.
    const typed = 'for x in xs:\n    print(x)\n\n1. done';
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));

    const reply = (await screen.findByText('Close. Look again:')).closest('li')!;
    expect(reply.querySelectorAll('pre')).toHaveLength(1);
    expect(reply.querySelector('pre')!.textContent).toBe('def f(x):\n    a = 1\n\n    return a\n');
    expect(reply.querySelectorAll('ol > li')).toHaveLength(2);
    expect(reply.querySelector('p pre, p ol, p ul, p p, p div')).toBeNull();

    const mine = screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === typed);
    expect(mine.querySelector('ol, pre')).toBeNull();
  });

  it('a start the setup page handles (402, gate) leaves without a retry', async () => {
    const refusal = new Error('402');
    m.start.mockRejectedValueOnce(refusal);
    const onStartRefused = vi.fn(() => true);
    renderRoom(vi.fn(), { onStartRefused });
    await waitFor(() => expect(onStartRefused).toHaveBeenCalledWith(refusal));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a failed start offers a retry and a way back', async () => {
    m.start.mockRejectedValueOnce(new Error('down'));
    const onExit = renderRoom();
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Back to setup' }));
    expect(onExit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(m.start).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Tell me about yourself.')).toBeTruthy();
  });
});

// ─── INT-09: the GoApply AI-interview format in the written practice ──────

const CN_QUESTIONS = [
  { q: '请用两分钟做一个自我介绍。', hint: '先说你是谁。', coachTip: null },
  { q: '请讲一次你在团队中和他人合作完成一项任务的经历。', hint: '讲一个真实经历。', coachTip: null },
];
const CN_FORMAT = {
  formatId: 'cn_ai_interview',
  minutes: 25,
  questions: [
    { prepSeconds: 30, answerSeconds: 90, story: false },
    { prepSeconds: 30, answerSeconds: 150, story: true },
  ],
};
const CN_REPORT = buildCnPracticeReport({
  turns: normalizeCnTurns([
    { who: 'them', text: CN_QUESTIONS[0]!.q },
    { who: 'you', text: '嗯，我是一名应届毕业生，学的是计算机。' },
    { who: 'them', text: CN_QUESTIONS[1]!.q },
    { who: 'you', text: '当时我们小组要在两周内完成课程项目，我负责后端接口。我首先拆分了任务，然后每天同步进度，结果提前两天完成。' },
  ]),
  breakdown: [
    { key: 'Structure', value: 78 },
    { key: 'Communication', value: 70 },
  ],
  basis: 'text_checks',
  language: 'zh',
  formatId: 'cn_ai_interview',
  now: '2026-10-10T12:00:00.000Z',
});

function renderCnRoom(brand: 'goapply' | 'roboapply' = 'goapply') {
  renderWithProviders(
    <BrandProvider brand={clientBrandFor(brand)}>
      <TextPracticeRoom role="产品经理" interviewerId="maya" typeId="cn_ai_interview" language="zh" durationMinutes={25} onExit={vi.fn()} />
    </BrandProvider>,
  );
}

describe('TextPracticeRoom: the GoApply AI-interview format', () => {
  beforeEach(() => {
    m.start.mockResolvedValue({ sessionId: 't1', questions: CN_QUESTIONS, jobId: null, cnFormat: CN_FORMAT });
    m.nextTurn.mockReset();
    m.nextTurn
      .mockResolvedValueOnce({ nextIndex: 1, turns: [{ who: 'them', text: '好的，下一题。' }], coachTip: null })
      .mockResolvedValueOnce({ nextIndex: null, turns: [], coachTip: null });
    m.score.mockResolvedValue({
      overall: 71, delta: null, breakdown: [], strengths: ['Clear story'], gaps: [], durationMinutes: 6,
      practiceCounted: true, jobId: null, cn: CN_REPORT,
    });
  });

  it('shows each question’s thinking and answer time from the plan, under that question', async () => {
    renderCnRoom();
    expect(await screen.findByText(CN_QUESTIONS[0]!.q)).toBeTruthy();
    expect(screen.getByTestId('cn-question-timing').textContent).toBe('30 seconds to think, then up to 90 seconds to answer.');
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: '我是一名应届毕业生。' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByText(CN_QUESTIONS[1]!.q)).toBeTruthy();
    expect(screen.getByTestId('cn-question-timing').textContent).toBe('30 seconds to think, then up to 150 seconds to answer.');
    expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ typeId: 'cn_ai_interview', durationMinutes: 25 }));
  });

  it('every AI block carries the AI label on GoApply: the question, the interviewer’s replies and the result', async () => {
    const labels = () => document.querySelectorAll('[data-ai-label]').length;
    renderCnRoom();
    const question = await screen.findByText(CN_QUESTIONS[0]!.q);
    // The question card.
    expect(question.closest('[data-question-card]')!.querySelector('[data-ai-label]')).not.toBeNull();
    expect(labels()).toBe(1);
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: '我是一名应届毕业生。' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await screen.findByText('好的，下一题。');
    // The thread of interviewer replies has its own label; the next question keeps one.
    expect(labels()).toBe(2);
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: '当时我们小组要完成课程项目。' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'See my results' }));
    // The result card.
    const result = await screen.findByRole('heading', { name: 'Your results' });
    expect(result.parentElement!.querySelector('[data-ai-label]')).not.toBeNull();
    // The report's STAR block shows the AI-written questions, so it is labelled too.
    expect(document.querySelector('[data-ai-block="cn-star-questions"] [data-ai-label]')).not.toBeNull();
    // Its areas came from text checks, not from a model: no AI label there.
    expect(document.querySelector('[data-ai-block="cn-areas"]')).toBeNull();
  });

  it('follows the result with the practice report: three areas, the STAR check and filler words', async () => {
    renderCnRoom();
    await answerAllCn();
    expect(await screen.findByText('71')).toBeTruthy();
    const report = await screen.findByTestId('cn-report');
    expect(report).toHaveTextContent('AI interview practice: your results');
    // Three areas with their source lines; unknown stays "—", never 0.
    expect(screen.getByTestId('cn-area-communication').textContent).toBe('70 out of 100');
    expect(screen.getByTestId('cn-area-logic').textContent).toBe('78 out of 100');
    expect(report).toHaveTextContent('Source: quick text checks on your answers');
    expect(report).toHaveTextContent('Source: the STAR check below');
    // The STAR check on the story answer, and the filler count.
    expect(screen.getByTestId('cn-star-summary').textContent).toMatch(/1 of 1 story answer had all four parts\./);
    expect(screen.getByTestId('cn-fillers-total').textContent).toMatch(/^1 filler word/);
    // The report says what it is and is not.
    expect(report).toHaveTextContent('say nothing about the result of a real interview');
    expect(report.textContent).not.toMatch(/\b0 out of 100/);
    // FIX-6: the answers were typed, so nothing mentions a transcript or speech-to-text.
    expect(screen.getByTestId('cn-fillers-note').textContent).toBe('Counted from the answers you typed.');
    expect(report.textContent).not.toMatch(/speech-to-text|transcript/i);
  });

  it('a plan that does not match the questions shows no timing (never under the wrong question)', async () => {
    m.start.mockResolvedValue({ sessionId: 't1', questions: CN_QUESTIONS, jobId: null, cnFormat: { ...CN_FORMAT, questions: CN_FORMAT.questions.slice(0, 1) } });
    renderCnRoom();
    await screen.findByText(CN_QUESTIONS[0]!.q);
    expect(screen.queryByTestId('cn-question-timing')).toBeNull();
  });

  it('a result with no report block, or a malformed one, renders the plain result only', async () => {
    m.score.mockResolvedValue({ overall: 71, delta: null, breakdown: [], strengths: [], gaps: [], durationMinutes: 6, practiceCounted: true, jobId: null, cn: { version: 2 } });
    renderCnRoom();
    await answerAllCn();
    expect(await screen.findByText('71')).toBeTruthy();
    expect(screen.queryByTestId('cn-report')).toBeNull();
  });
});

describe('TextPracticeRoom: RoboApply is unchanged', () => {
  it('no timing line, no practice report and no AI label', async () => {
    renderWithProviders(
      <BrandProvider brand={clientBrandFor('roboapply')}>
        <TextPracticeRoom role="Backend Engineer" interviewerId="maya" typeId="behavioral" onExit={vi.fn()} />
      </BrandProvider>,
    );
    expect(await screen.findByText('Tell me about yourself.')).toBeTruthy();
    expect(screen.queryByTestId('cn-question-timing')).toBeNull();
    await answerAll();
    expect(await screen.findByText('64')).toBeTruthy();
    expect(screen.queryByTestId('cn-report')).toBeNull();
    expect(screen.queryByTestId('cn-question-timing')).toBeNull();
    expect(document.querySelector('[data-ai-label]')).toBeNull();
  });

  it('a RoboApply result carries no report block, so there is nothing more to render', async () => {
    m.score.mockResolvedValue({ overall: 64, delta: null, breakdown: [], strengths: [], gaps: [], durationMinutes: 5, practiceCounted: true, jobId: null });
    renderWithProviders(
      <BrandProvider brand={clientBrandFor('roboapply')}>
        <TextPracticeRoom role="Backend Engineer" interviewerId="maya" typeId="behavioral" onExit={vi.fn()} />
      </BrandProvider>,
    );
    await answerAll();
    expect(await screen.findByText('64')).toBeTruthy();
    // The server sends `cn` on GoApply only; with none there is nothing to render.
    expect(screen.queryByTestId('cn-report')).toBeNull();
  });
});

async function answerAllCn() {
  fireEvent.change(await screen.findByLabelText('Your answer'), { target: { value: '嗯，我是一名应届毕业生，学的是计算机。' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  await screen.findByText(CN_QUESTIONS[1]!.q);
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: '当时我们小组要在两周内完成课程项目。' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'See my results' }));
}
