// WP-43 — the practice report end: "Recording off" without consent, one
// "Practice again for this job" line with the credit path, the checklist
// refresh, the honest score note (C16) and GoApply's AI label on every block
// of AI output.

import { Suspense, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import ReportPage from '../../../../app/(auth)/practice/[id]/report/page';
import { IntlWrapper } from '../../../../__tests__/utils/mockTranslations';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import { CHECKLIST_QUERY_KEY } from '../../../../hooks/growth';

const m = vi.hoisted(() => ({
  report: vi.fn(),
  info: vi.fn(),
  credits: { balance: 2 } as { balance: number } | undefined,
}));

vi.mock('../../../../lib/api/interviewEngine', () => ({
  interviewEngineApi: { report: m.report },
  practiceApi: { info: m.info },
}));
vi.mock('../../../../hooks/useAccount', () => ({ useCredits: () => ({ data: m.credits }) }));

function report(extra: Record<string, unknown> = {}) {
  return {
    session: {
      id: 's1', status: 'completed', source: 'roboapply', role: 'Backend Engineer', interviewType: 'behavioral',
      personaId: 'maya', mode: 'video', language: 'en', durationMinutes: 20, overall: 70, externalRef: null,
      createdAt: '2026-10-10T00:00:00Z', startedAt: null, endedAt: null, candidateName: null, characteristics: null,
      voice: null, questions: [], webSources: [], interviewerBrief: null, requirements: null,
      breakdown: [{ key: 'structure', value: 60, note: '' }], strengths: ['Clear'], gaps: ['Add numbers'],
      summary: 'ok', recommendations: [], questionAnalysis: [], reportPending: false, reportTooShort: false,
      recordingAvailable: false, transcriptAvailable: true, ...extra,
    },
    transcript: [{ role: 'candidate', text: 'An answer', ts: 1 }],
    recordingUrl: null,
    transcriptUrl: null,
  };
}

/** A report with every AI block: verdict, homework, both signal cards, the coaching path, notes, steps, questions. */
function richReport() {
  return report({
    breakdown: [{ key: 'structure', value: 60, note: 'Clear order' }],
    recommendations: [
      { title: 'Lead with the result', priority: 'high', detail: 'Say the outcome first.', example: 'We cut costs.' },
      { title: 'Add numbers', priority: 'medium', detail: 'Quantify.', example: '40 percent.' },
    ],
    questionAnalysis: [{
      questionIndex: 0, blueprintIndex: null, missed: false, question: 'Tell me about a project.',
      answerSummary: 'Led a migration.', keyQuote: 'I led the migration.', analysis: 'No result given.',
      correction: 'State the impact.', suggestion: 'Add the result.', modelAnswer: 'I led it and cut latency 40%.',
      rating: 'adequate', score: 55,
    }],
  });
}

function info(extra: Record<string, unknown> = {}) {
  return {
    practice: {
      sessionId: 's1', status: 'completed',
      job: { id: 'j1', title: 'Backend Engineer', companyName: 'Acme' },
      recording: { consented: false, video: false, available: false },
      completedAt: '2026-10-10T00:10:00Z',
      ...extra,
    },
  };
}

async function renderPage(brand: 'roboapply' | 'goapply' = 'roboapply') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(client, 'invalidateQueries');
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={client}>
      <BrandProvider brand={clientBrandFor(brand)}>
        <IntlWrapper>
          <Suspense fallback={null}>{node}</Suspense>
        </IntlWrapper>
      </BrandProvider>
    </QueryClientProvider>
  );
  await act(async () => {
    render(wrap(<ReportPage params={Promise.resolve({ id: 's1' })} />));
  });
  return { spy };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.credits = { balance: 2 };
  m.report.mockResolvedValue(report());
  m.info.mockResolvedValue(info());
});

describe('practice report end', () => {
  it('says recording was off, offers one "Practice again for this job" line and refreshes the checklist once', async () => {
    const { spy } = await renderPage();
    expect(await screen.findByTestId('practice-recording-off')).toHaveTextContent(
      'Recording off: no audio or video was kept from this practice.',
    );
    const end = screen.getByTestId('practice-report-end');
    const link = screen.getByRole('link', { name: 'Practice again for this job' });
    expect(link).toHaveAttribute('href', '/practice?job=j1&from=report');
    expect(end).toHaveTextContent('For Backend Engineer at Acme');
    expect(end).toHaveTextContent('Uses practice credits. You have 2 left.');
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: CHECKLIST_QUERY_KEY }));
    expect(spy.mock.calls.filter((c) => JSON.stringify(c[0]) === JSON.stringify({ queryKey: CHECKLIST_QUERY_KEY }))).toHaveLength(1);
  });

  it('with no credits left, links to packs or Pro', async () => {
    m.credits = { balance: 0 };
    await renderPage();
    expect(await screen.findByText('No practice credits left.', { exact: false })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Get a practice pack or Pro' })).toHaveAttribute('href', '/settings/billing#plans');
  });

  it('with an unknown balance claims nothing', async () => {
    m.credits = undefined;
    await renderPage();
    expect(await screen.findByTestId('practice-report-end')).toHaveTextContent('Uses practice credits.');
  });

  it('without a job: "Practice again" replays the plan; a consented recording hides "Recording off"', async () => {
    m.info.mockResolvedValue(info({ job: null, recording: { consented: true, video: false, available: true } }));
    await renderPage();
    const link = await screen.findByRole('link', { name: 'Practice again' });
    expect(link.getAttribute('href')).toMatch(/^\/practice\?role=Backend\+Engineer/);
    expect(screen.queryByTestId('practice-recording-off')).toBeNull();
  });

  it('describes scores as this practice, never a real panel (C16)', async () => {
    await renderPage();
    expect(await screen.findByRole('heading', { name: 'How your answers scored' })).toBeTruthy();
    expect(screen.getByText("Scores come from your answers in this practice. They don't predict a real interview.")).toBeTruthy();
    expect(screen.queryByText(/real panel/)).toBeNull();
  });

  it('a session from before per-session consent that kept a recording does not say "Recording off"', async () => {
    m.info.mockResolvedValue(info({ recording: { consented: false, video: false, available: true } }));
    await renderPage();
    await screen.findByTestId('practice-report-end');
    expect(screen.queryByTestId('practice-recording-off')).toBeNull();
  });

  it('labels every block of AI output on GoApply', async () => {
    m.report.mockResolvedValue(richReport());
    await renderPage('goapply');
    await screen.findByTestId('practice-report-end');
    const tabs = ['What to do next', 'Question by question', 'Transcript'];
    const seen = new Set<string>();
    const check = () => {
      document.querySelectorAll('[data-ai-block]').forEach((block) => {
        const name = block.getAttribute('data-ai-block')!;
        seen.add(name);
        expect(block.querySelector('[data-ai-label]'), name).not.toBeNull();
      });
    };
    check();
    for (const label of tabs) {
      const tab = screen.queryByRole('tab', { name: new RegExp(label) });
      if (tab) {
        fireEvent.click(tab);
        check();
      }
    }
    for (const name of ['verdict', 'homework', 'strengths', 'gaps', 'coaching', 'scores', 'steps', 'questions', 'transcript']) {
      expect(seen.has(name), name).toBe(true);
    }
  });

  it('renders no AI label on RoboApply, and the report still works when the extras fail', async () => {
    m.info.mockRejectedValue(new Error('down'));
    m.report.mockResolvedValue(richReport());
    await renderPage('roboapply');
    expect(await screen.findByRole('heading', { name: 'Interview report' })).toBeTruthy();
    expect(document.querySelectorAll('[data-ai-block]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-ai-label]')).toHaveLength(0);
    expect(screen.queryByTestId('practice-report-end')).toBeNull();
  });
});
