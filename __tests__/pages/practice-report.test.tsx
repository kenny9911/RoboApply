import { Suspense } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

import MockReportPage from '../../app/(auth)/practice/[id]/report/page';
import type {
  IEQuestionAnalysisItem,
  IEReport,
} from '../../lib/api/interviewEngine';
import { IntlWrapper } from '../utils/mockTranslations';

const reportMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api/interviewEngine', () => ({
  interviewEngineApi: { report: reportMock },
}));

type ReportFixture = IEReport & {
  session: IEReport['session'] & { reportTooShort: boolean };
};

const QUESTION: IEQuestionAnalysisItem = {
  questionIndex: 0,
  blueprintIndex: 0,
  missed: false,
  question: 'Tell me about a difficult technical decision.',
  intent: 'The interviewer wants to understand how you evaluate trade-offs.',
  answerSummary: 'The candidate chose Postgres because the team already knew it.',
  keyQuote: 'We just went with what we knew.',
  analysis: 'The answer sounded familiar, but not deliberate.',
  correction: 'A manager hears that convenience mattered more than the constraints.',
  suggestion: 'Name the options, the deciding constraint, and the measured result.',
  modelAnswer: 'We compared Postgres and Mongo, then chose Postgres for transaction safety.',
  tips: [],
  rating: 'weak',
  score: 42,
  tags: [],
};

function makeReport(overrides: Partial<ReportFixture> = {}): ReportFixture {
  const report: ReportFixture = {
    session: {
      id: 'practice-report-1',
      status: 'completed',
      source: 'app',
      role: 'Backend Engineer',
      interviewType: 'behavioral',
      personaId: 'maya',
      mode: 'voice',
      language: 'en',
      durationMinutes: 20,
      overall: 76,
      externalRef: null,
      createdAt: '2026-08-12T00:00:00.000Z',
      startedAt: '2026-08-12T00:00:00.000Z',
      endedAt: '2026-08-12T00:10:00.000Z',
      candidateName: null,
      characteristics: null,
      voice: null,
      questions: [],
      webSources: [],
      interviewerBrief: null,
      requirements: null,
      groundedOn: 'role',
      breakdown: [
        { key: 'specificity', value: 58, note: 'One short score takeaway.' },
      ],
      strengths: ['You stayed concise and answered directly.'],
      gaps: ['Make the decision criteria and outcome concrete.'],
      summary: 'Clear and concise, but the evidence needs to be more specific.',
      recommendations: [
        {
          title: 'Add the deciding metric',
          priority: 'high',
          detail: 'Anchor the decision in one constraint and one measured result.',
          example: 'Before: familiar tool. After: reduced failed writes by 30%.',
          drill: 'Re-answer the decision question in 90 seconds.',
          linkedDimension: 'specificity',
        },
      ],
      questionAnalysis: [QUESTION],
      reportDegraded: false,
      reportPending: false,
      reportTooShort: false,
      recordingAvailable: false,
      transcriptAvailable: true,
    },
    transcript: [
      { role: 'interviewer', text: QUESTION.question, ts: 1 },
      { role: 'candidate', text: 'We just went with what we knew.', ts: 2 },
    ],
    recordingUrl: null,
    transcriptUrl: null,
    ...overrides,
  };

  return report;
}

async function renderReport(report: ReportFixture) {
  reportMock.mockResolvedValue(report);
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(
      <IntlWrapper>
        <Suspense fallback={<p>Loading test report</p>}>
          <MockReportPage params={Promise.resolve({ id: report.session.id })} />
        </Suspense>
      </IntlWrapper>,
    );
  });
  return rendered!;
}

describe('/practice/[id]/report', () => {
  beforeEach(() => {
    reportMock.mockReset();
  });

  it('shows a scored outcome, one setup CTA, compact scores, and an explicit coaching path', async () => {
    await renderReport(makeReport());

    expect(
      (await screen.findAllByText('Add the deciding metric')).length,
    ).toBeGreaterThan(0);
    // The overall score is stated ONCE, as the verdict meter.
    const overall = screen.getByRole('progressbar', { name: 'Overall' });
    expect(overall).toHaveAttribute('aria-valuenow', '76');
    expect(screen.getAllByText('76')).toHaveLength(1);
    expect(
      screen.getAllByText('Make the decision criteria and outcome concrete.').length,
    ).toBeGreaterThan(0);

    const setupLink = screen.getByRole('link', { name: 'Run it again' });
    expect(setupLink).toHaveAttribute(
      'href',
      '/practice?role=Backend+Engineer&type=behavioral&mode=voice&language=en&duration=20&interviewer=maya',
    );

    expect(
      screen.getByRole('progressbar', { name: 'Did you give real numbers?' }),
    ).toHaveAttribute('aria-valuenow', '58');
    expect(screen.getByText('One short score takeaway.')).toBeInTheDocument();
    expect(screen.getAllByText('What you said').length).toBeGreaterThan(0);
    expect(screen.getAllByText('What happened').length).toBeGreaterThan(0);
    expect(screen.getAllByText('A stronger answer').length).toBeGreaterThan(0);
  });

  it('shows only the recovery state when the server marks the answers too short', async () => {
    const base = makeReport();
    await renderReport({
      ...base,
      session: {
        ...base.session,
        overall: 0,
        summary:
          'This session was too short to evaluate — complete a few full answers to get a graded report.',
        strengths: [],
        gaps: [],
        recommendations: [],
        questionAnalysis: [],
        reportTooShort: true,
        recordingAvailable: true,
      },
      // A short utterance alone is still below the server's substantive-answer
      // threshold; the explicit reportTooShort signal must win.
      transcript: [{ role: 'candidate', text: 'I am ready.', ts: 1 }],
      recordingUrl: 'https://example.com/short-session.mp3',
      transcriptUrl: 'https://example.com/short-session.txt',
    });

    expect(
      await screen.findByRole('heading', { name: 'No score yet.' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(
      screen.getByText(/too short to evaluate/i),
    ).toBeInTheDocument();

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName('Pick a different setup');
    expect(links[0]).toHaveAttribute('href', '/practice');

    await waitFor(() => expect(reportMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Overall')).not.toBeInTheDocument();
    expect(screen.queryByText('What to do next')).not.toBeInTheDocument();
    expect(screen.queryByText('Question by question')).not.toBeInTheDocument();
    expect(screen.queryByText('Recording')).not.toBeInTheDocument();
    expect(screen.queryByText('Show the transcript')).not.toBeInTheDocument();
  });

  it('shows a pending verdict, not 0/100, while the session is still finalizing', async () => {
    const base = makeReport();
    await renderReport({
      ...base,
      session: { ...base.session, status: 'finalizing', overall: null, recommendations: null },
    });
    expect(await screen.findByText(/Your score is being worked out/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Overall' })).toBeNull();
    expect(screen.queryByText('/100')).toBeNull();
  });

  it('shows the no-answer state (not charged) for a failed no_answer session', async () => {
    const base = makeReport();
    await renderReport({
      ...base,
      session: { ...base.session, status: 'failed', error: 'no_answer', overall: null },
      transcript: [],
    });
    expect(await screen.findByRole('heading', { name: 'No answers were recorded' })).toBeInTheDocument();
    expect(screen.getByText(/You were not charged/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start again' })).toHaveAttribute(
      'href',
      expect.stringContaining('/practice?role=Backend+Engineer'),
    );
    // A settled failed session does not keep polling.
    await new Promise((r) => setTimeout(r, 50));
    expect(reportMock).toHaveBeenCalledTimes(1);
  });

  it('shows a plain failed state for any other failed session', async () => {
    const base = makeReport();
    await renderReport({
      ...base,
      session: { ...base.session, status: 'failed', error: 'worker_error', overall: null },
    });
    expect(await screen.findByRole('heading', { name: "This interview couldn't be scored" })).toBeInTheDocument();
  });

  it('offers Retry when the report fails to load', async () => {
    reportMock.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      render(
        <IntlWrapper>
          <Suspense fallback={<p>Loading test report</p>}>
            <MockReportPage params={Promise.resolve({ id: 'practice-report-1' })} />
          </Suspense>
        </IntlWrapper>,
      );
    });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    reportMock.mockResolvedValueOnce(makeReport());
    await act(async () => { retry.click(); });
    expect(await screen.findByRole('progressbar', { name: 'Overall' })).toHaveAttribute('aria-valuenow', '76');
  });
});
