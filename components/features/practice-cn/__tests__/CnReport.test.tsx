// WP-66 — the GoApply practice report blocks: areas ("—" when unknown), the
// STAR check, filler counts, the AI label on AI output (GoApply only), the
// stored block preferred over the client build, re-reads while the review is
// pending, and the zh copy (format line, no vendor names).

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';

import { IntlWrapper } from '../../../../__tests__/utils/mockTranslations';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import zhMessages from '../../../../i18n/messages/zh.json';
import enMessages from '../../../../i18n/messages/en.json';

// The `practiceCn` strings as the zh and en bundles carry them (WP-91 merged them out of i18n/staging).
const zhBundle = { practiceCn: zhMessages.practiceCn };
const enBundle = { practiceCn: enMessages.practiceCn };
import { ZH_BREAKDOWN, ZH_ENGINE_TRANSCRIPT, ZH_EXPECTED } from '../../../../server/src/features/cn/interview/__tests__/fixtures';

const m = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock('../../../../lib/api/interviewEngine', () => ({ interviewEngineApi: { report: m.report } }));

import { CnQuestionTiming, CnReport, CnReportView, buildCnPracticeReport, cnReportFromEngine, normalizeCnTurns } from '..';
import { CN_REPORT_MAX_POLLS, CN_REPORT_POLL_MS } from '../CnReport';

function engineReport(session: Record<string, unknown> = {}, transcript: unknown[] = ZH_ENGINE_TRANSCRIPT) {
  return {
    session: {
      id: 's1', status: 'completed', source: 'roboapply', role: '产品经理', interviewType: 'behavioral',
      personaId: 'priya', mode: 'voice', language: 'zh', durationMinutes: 25, overall: 64, externalRef: null,
      createdAt: '2026-10-10T00:00:00Z', startedAt: null, endedAt: '2026-10-10T00:25:00Z', candidateName: null,
      characteristics: null, voice: null, questions: [], webSources: [], interviewerBrief: null, requirements: null,
      breakdown: ZH_BREAKDOWN, strengths: [], gaps: [], summary: null, recommendations: [], questionAnalysis: [],
      reportPending: false, reportDegraded: false, recordingAvailable: false, transcriptAvailable: true,
      ...session,
    },
    transcript,
    recordingUrl: null,
    transcriptUrl: null,
  };
}

function wrap(node: ReactNode, brand: 'goapply' | 'roboapply' = 'goapply', messages?: Record<string, unknown>) {
  return (
    <BrandProvider brand={clientBrandFor(brand)}>
      {messages ? <IntlWrapper locale="zh" messages={messages as never}>{node}</IntlWrapper> : <IntlWrapper>{node}</IntlWrapper>}
    </BrandProvider>
  );
}

async function renderReport(brand: 'goapply' | 'roboapply' = 'goapply') {
  await act(async () => {
    render(wrap(<CnReport sessionId="s1" />, brand));
  });
}

beforeEach(() => {
  m.report.mockResolvedValue(engineReport());
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('CnReport (GoApply)', () => {
  it('shows the three areas, the STAR check and filler counts from the session', async () => {
    await renderReport();
    expect(await screen.findByTestId('cn-report')).toBeInTheDocument();
    expect(m.report).toHaveBeenCalledWith('s1');
    expect(screen.getByTestId('cn-area-communication')).toHaveTextContent(`${ZH_EXPECTED.communication} out of 100`);
    expect(screen.getByTestId('cn-area-logic')).toHaveTextContent(`${ZH_EXPECTED.logic} out of 100`);
    expect(screen.getByTestId('cn-area-behaviour')).toHaveTextContent(`${ZH_EXPECTED.behaviour} out of 100`);
    expect(screen.getAllByText('Source: AI review of this practice')).toHaveLength(2);
    expect(screen.getByText('Source: the STAR check below')).toBeInTheDocument();
    expect(screen.getByTestId('cn-star-summary')).toHaveTextContent('1 of 2 story answers had all four parts.');
    expect(screen.getByTestId('cn-star-missing')).toHaveTextContent('Most often missing: Task.');
    expect(screen.getByTestId('cn-fillers-total')).toHaveTextContent(`${ZH_EXPECTED.fillerTotal} filler words`);
    expect(screen.getByTestId('cn-fillers-total')).toHaveTextContent('per 100 characters');
    expect(document.querySelector('[data-filler="那个"]')).toHaveTextContent('那个 ×3');
    expect(screen.getByText('Task: missing')).toBeInTheDocument();
    expect(screen.getByText(/AI interview format many employers use/)).toBeInTheDocument();
  });

  it('labels the AI review areas and the AI-asked question lines on GoApply; the filler keyword checks are not AI output', async () => {
    await renderReport();
    await screen.findByTestId('cn-report');
    const blocks = document.querySelectorAll('[data-ai-block]');
    expect([...blocks].map((b) => b.getAttribute('data-ai-block'))).toEqual(['cn-areas', 'cn-star-questions']);
    blocks.forEach((b) => expect(b.querySelector('[data-ai-label]')).not.toBeNull());
    expect(document.querySelectorAll('[data-ai-label]')).toHaveLength(2);
    const star = screen.getByTestId('cn-star-summary').parentElement!;
    expect(star.querySelector('[data-ai-label]')).not.toBeNull();
    expect(star.querySelectorAll('[data-star-part]').length).toBeGreaterThan(0);
    expect(screen.getByTestId('cn-star-question-source')).toHaveTextContent('The questions were asked by the AI interviewer.');
    const fillers = screen.getByTestId('cn-fillers-total').parentElement!;
    expect(fillers.querySelector('[data-ai-label]')).toBeNull();
    expect(screen.getByText(/Communication and logic come from the AI review of this practice/)).toBeInTheDocument();
  });

  it('marks the areas as text checks (no AI label) while the review is pending, then re-reads', async () => {
    vi.useFakeTimers();
    m.report.mockResolvedValueOnce(engineReport({ status: 'completed', reportPending: true, breakdown: [{ key: 'Communication', value: 50 }, { key: 'Structure', value: 40 }] }));
    m.report.mockResolvedValue(engineReport());
    await renderReport();
    expect(screen.getByTestId('cn-area-communication')).toHaveTextContent('50 out of 100');
    expect(screen.getAllByText('Source: quick text checks on your answers')).toHaveLength(2);
    expect(screen.queryByText(/AI review yet/)).toBeNull();
    expect(screen.getByText(/Communication and logic come from quick text checks on your answers, not from an AI review/)).toBeInTheDocument();
    expect(document.querySelector('[data-ai-block="cn-areas"]')).toBeNull();
    // Only the AI-asked question lines keep their label while the review is pending.
    expect([...document.querySelectorAll('[data-ai-block]')].map((b) => b.getAttribute('data-ai-block'))).toEqual(['cn-star-questions']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CN_REPORT_POLL_MS);
    });
    expect(m.report).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('cn-area-communication')).toHaveTextContent(`${ZH_EXPECTED.communication} out of 100`);
    expect(document.querySelector('[data-ai-block="cn-areas"] [data-ai-label]')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CN_REPORT_POLL_MS * 3);
    });
    expect(m.report).toHaveBeenCalledTimes(2);
  });

  it('stops re-reading after the cap', async () => {
    vi.useFakeTimers();
    m.report.mockResolvedValue(engineReport({ status: 'finalizing' }));
    await renderReport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CN_REPORT_POLL_MS * (CN_REPORT_MAX_POLLS + 5));
    });
    expect(m.report).toHaveBeenCalledTimes(CN_REPORT_MAX_POLLS + 1);
  });

  it('a degraded review says part of it did not finish', async () => {
    m.report.mockResolvedValue(engineReport({ reportDegraded: true }));
    await renderReport();
    expect(await screen.findAllByText(/part of the AI review did not finish/)).toHaveLength(2);
  });

  it('shows unknowns as "—", never 0, when there are no answers', async () => {
    m.report.mockResolvedValue(engineReport({ breakdown: [{ key: 'communication', value: 0 }] }, [{ role: 'interviewer', text: '请做一个自我介绍。', ts: 1 }]));
    await renderReport();
    expect(await screen.findByTestId('cn-report-empty')).toBeInTheDocument();
    for (const key of ['communication', 'logic', 'behaviour']) expect(screen.getByTestId(`cn-area-${key}`)).toHaveTextContent('—');
    expect(screen.getByTestId('cn-star-none')).toBeInTheDocument();
    expect(screen.getByTestId('cn-fillers-total')).toHaveTextContent('No filler words found.');
  });

  it('prefers the block the server stored', async () => {
    const stored = buildCnPracticeReport({
      turns: normalizeCnTurns(ZH_ENGINE_TRANSCRIPT),
      breakdown: [{ key: 'communication', value: 90 }, { key: 'structure', value: 10 }],
      basis: 'ai_review',
      language: 'zh',
      now: '2026-10-10T00:00:00Z',
    });
    m.report.mockResolvedValue(engineReport({ cnReport: stored }));
    await renderReport();
    expect(await screen.findByTestId('cn-area-communication')).toHaveTextContent('90 out of 100');
    expect(screen.getByTestId('cn-area-logic')).toHaveTextContent('10 out of 100');
  });

  it('renders nothing when the report cannot be read', async () => {
    m.report.mockRejectedValue(new Error('down'));
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(wrap(<CnReport sessionId="s1" />)));
    });
    expect(container!).toBeEmptyDOMElement();
  });

  it('shows a loading line first', () => {
    m.report.mockReturnValue(new Promise(() => {}));
    render(wrap(<CnReport sessionId="s1" />));
    expect(screen.getByTestId('cn-report-loading')).toHaveTextContent('Checking your answers…');
  });
});

describe('CnReportView', () => {
  const report = cnReportFromEngine(engineReport() as never);

  it('renders no AI label on RoboApply', () => {
    render(wrap(<CnReportView report={report} />, 'roboapply'));
    expect(document.querySelectorAll('[data-ai-label]')).toHaveLength(0);
  });

  it('shows no AI label on the STAR block when no question line was recorded', () => {
    const noQuestions = { ...report, answers: report.answers.map((a) => ({ ...a, question: null })) };
    render(wrap(<CnReportView report={noQuestions as typeof report} />));
    expect(document.querySelector('[data-ai-block="cn-star-questions"]')).toBeNull();
    expect(screen.queryByTestId('cn-star-question-source')).toBeNull();
    expect([...document.querySelectorAll('[data-ai-block]')].map((b) => b.getAttribute('data-ai-block'))).toEqual(['cn-areas']);
  });

  it('marks each STAR part found or missing per story answer', () => {
    render(wrap(<CnReportView report={report} />));
    const answers = screen.getAllByText(/^Answer \d+$/).map((el) => el.closest('li')!);
    expect(answers).toHaveLength(2);
    const second = within(answers[1]!);
    expect(second.getByText('Situation: found')).toBeInTheDocument();
    expect(second.getByText('Action: missing')).toBeInTheDocument();
    expect(second.getByText('Result: found')).toBeInTheDocument();
  });

  // FIX-6: a typed session never mentions a transcript or speech-to-text.
  it('says where the filler counts come from: the transcript for a voice session, the typed answers for a written one', () => {
    const { unmount } = render(wrap(<CnReportView report={report} />));
    expect(screen.getByTestId('cn-fillers-note').textContent).toBe('Counted from the transcript. Speech-to-text can miss or add words.');
    unmount();
    render(wrap(<CnReportView report={report} typed />));
    expect(screen.getByTestId('cn-fillers-note').textContent).toBe('Counted from the answers you typed.');
    expect(screen.getByTestId('cn-report').textContent).not.toMatch(/speech-to-text/i);
  });

  it('renders in Chinese with the zh bundle', () => {
    const messages = { practiceCn: zhBundle.practiceCn, legal: { aiBadge: { text: 'AI 辅助生成', title: 'AI', document: 'd', audio: 'a' } } };
    render(wrap(<CnReportView report={report} />, 'goapply', messages));
    expect(screen.getByText('本练习模拟企业常用的 AI 面试形式。以下结果只反映本次练习，不代表真实面试的结果。')).toBeInTheDocument();
    expect(screen.getByTestId('cn-area-logic')).toHaveTextContent(`${ZH_EXPECTED.logic} / 100`);
    expect(screen.getByTestId('cn-star-summary')).toHaveTextContent('2 个经历类回答中，1 个四项齐全。');
    expect(screen.getByTestId('cn-fillers-total')).toHaveTextContent(`共 ${ZH_EXPECTED.fillerTotal} 次口头禅`);
  });
});

describe('CnQuestionTiming', () => {
  it('renders the timing from the plan numbers, in both languages', () => {
    const { unmount } = render(wrap(<CnQuestionTiming prepSeconds={30} answerSeconds={120} />));
    expect(screen.getByTestId('cn-question-timing')).toHaveTextContent('30 seconds to think, then up to 120 seconds to answer.');
    unmount();
    render(wrap(<CnQuestionTiming prepSeconds={30} answerSeconds={120} />, 'goapply', { practiceCn: zhBundle.practiceCn }));
    expect(screen.getByTestId('cn-question-timing')).toHaveTextContent('思考时间 30 秒，作答不超过 120 秒。');
  });

  it('renders nothing when a number is missing', () => {
    render(wrap(<CnQuestionTiming prepSeconds={null} answerSeconds={120} />));
    expect(screen.queryByTestId('cn-question-timing')).toBeNull();
  });
});

describe('practiceCn bundles', () => {
  type Tree = { [k: string]: string | Tree };
  const keys = (t: Tree, p = ''): string[] =>
    Object.entries(t).flatMap(([k, v]) => (typeof v === 'string' ? [`${p}${k}`] : keys(v, `${p}${k}.`)));

  it('zh has exactly the en keys', () => {
    expect(keys(zhBundle as unknown as Tree).sort()).toEqual(keys(enBundle as unknown as Tree).sort());
  });

  it('names no vendor, claims no outcome, and says the format line in zh', () => {
    const all = JSON.stringify(zhBundle) + JSON.stringify(enBundle);
    for (const name of ['北森', '牛客', 'HireVue', 'Beisen']) expect(all.includes(name), name).toBe(false);
    expect(JSON.stringify(zhBundle)).toContain('模拟企业常用的 AI 面试形式');
    for (const claim of ['通过率', '保证', 'guarantee']) expect(all.includes(claim), claim).toBe(false);
  });
});
