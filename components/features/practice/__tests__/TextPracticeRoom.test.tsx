// TextPracticeRoom (WP-43): the written practice — start (with the job),
// answer, finish, score; a counted practice refreshes the checklist and the
// balance; a refused start goes back to the setup page.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';

import { TextPracticeRoom, type TextPracticeRoomProps } from '../TextPracticeRoom';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import { IntlWrapper } from '../../../../__tests__/utils/mockTranslations';
import { CHECKLIST_QUERY_KEY } from '../../../../hooks/growth';

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
    expect(await screen.findByText('0')).toBeTruthy();
    expect(spy).not.toHaveBeenCalledWith({ queryKey: CHECKLIST_QUERY_KEY });
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
