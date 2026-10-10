// WP-22 — resume check UI: report, fix panel, re-check comparison, keyword
// check, entry points, and the AI gate (AI actions hidden when the server
// says AI is unavailable). Renders through the real en.json + staged English,
// so a missing key fails here instead of showing a dotted path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithProviders } from '../../../__tests__/utils/renderWithProviders';
import type { GradeIssue, GradeView, KeywordReportResponse, LatestGradeResponse } from '../../../lib/api/contracts/resume';

const api = vi.hoisted(() => ({
  getLatestGrade: vi.fn(),
  markResumeCheckOpened: vi.fn(),
  startGrade: vi.fn(),
  cancelGrade: vi.fn(),
  fixIssue: vi.fn(),
  applyIssueFix: vi.fn(),
  getKeywordReport: vi.fn(),
}));
vi.mock('../../../lib/api/resumes', () => api);

const gate = vi.hoisted(() => ({ left: 3 as number | null, runs: 0 }));
vi.mock('../../../hooks/shared/useCreditGate', () => ({
  useCreditGate: () => ({
    left: gate.left,
    run: async (fn: (key: string) => Promise<unknown>) => {
      gate.runs += 1;
      return { ok: true, value: await fn('idem-key') };
    },
  }),
}));

vi.mock('../../../hooks/useResumes', () => ({ useResume: () => ({ data: { name: 'Product resume' } }) }));

// The GoApply label is WP-13's; render a marker so the test sees where it goes.
vi.mock('../market', () => ({ AiGeneratedBadge: () => <span data-testid="ai-badge">AI generated</span> }));

import { ResumeCheckReport } from './ResumeCheckReport';
import { RUNNING_POLL_MS } from '../../../hooks/resume/useResumeCheck';
import { KeywordReportView } from './KeywordReport';
import { ResumeCheckEntry, resumeCheckHref } from './ResumeCheckEntry';
import { AnalyzerPanel } from '../../v3/resume-editor/AnalyzerPanel';
import { analyzeResume } from '../../../lib/resumeAnalyzer';
import { parseResumeMarkdown } from '../../../lib/resumeStructure';

const NOW = '2026-10-10T12:00:00.000Z';

const issue = (over: Partial<GradeIssue> & Pick<GradeIssue, 'id' | 'type' | 'severity' | 'section'>): GradeIssue => ({
  anchor: `section-${over.section}`,
  why: 'English fallback why',
  how: 'English fallback how',
  ...over,
});

const ISSUES: GradeIssue[] = [
  issue({ id: 'spelling-1', type: 'spelling', severity: 'urgent', section: 'other', anchor: null, evidence: 'recieve', params: { word: 'recieve', suggestion: 'receive' }, source: 'ai' }),
  issue({ id: 'weak_verb-1', type: 'weak_verb', severity: 'critical', section: 'experience', target: 'Responsible for opening the store.', fixable: true, params: { opener: 'responsible for' } }),
  issue({ id: 'layout_table-1', type: 'layout_table', severity: 'critical', section: 'layout', anchor: null }),
  issue({ id: 'cn_photo_optional-1', type: 'cn_photo_optional', severity: 'optional', section: 'contact' }),
];

function gradeView(over: Partial<GradeView> = {}): GradeView {
  return {
    id: 'g2',
    resumeVariantId: 'rv_1',
    status: 'done',
    label: 'fair',
    score: 62,
    counts: { urgent: 1, critical: 2, optional: 1 },
    issues: ISSUES,
    profile: 'intl',
    method: 'rules_ai',
    aiSkipped: null,
    rulesChecked: 21,
    targetTitle: null,
    contentHash: 'h',
    createdAt: NOW,
    completedAt: NOW,
    ...over,
  };
}

function latest(over: Partial<LatestGradeResponse> = {}): LatestGradeResponse {
  return { grade: gradeView(), previous: null, stale: false, aiAvailable: true, ...over };
}

/** Intl errors other than the test environment's missing default time zone. */
const realIntlErrors = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter(([e]) => !String((e as Error)?.message ?? e).includes('ENVIRONMENT_FALLBACK'));

function renderReport(focusIssueId?: string) {
  const onIntlError = vi.fn();
  renderWithProviders(<ResumeCheckReport resumeId="rv_1" focusIssueId={focusIssueId} />, { onIntlError });
  return { onIntlError };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.markResumeCheckOpened.mockResolvedValue(undefined);
  gate.left = 3;
  gate.runs = 0;
});
afterEach(() => vi.clearAllMocks());

describe('ResumeCheckReport', () => {
  it('renders the grade, counts, honesty line and translated issues', async () => {
    api.getLatestGrade.mockResolvedValue(latest());
    const { onIntlError } = renderReport();
    expect(await screen.findByRole('heading', { name: 'Fair' })).toBeInTheDocument();
    expect(screen.getByText('62 of 100 on the checklist')).toBeInTheDocument();
    expect(screen.getByText(/does not predict whether you will hear back/)).toBeInTheDocument();
    expect(screen.getByText('Checked against 21 rules, plus an AI read for spelling and a vague summary.')).toBeInTheDocument();
    expect(screen.getByText('Possible spelling mistake: "recieve"')).toBeInTheDocument();
    expect(screen.getByText('Weak opener: "responsible for"')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Layout' })).toBeInTheDocument();
    for (const b of screen.getAllByRole('button', { name: 'Show details' })) fireEvent.click(b);
    expect(screen.getAllByText(/Company software may not read this/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /1\s*Fix first/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/resumeCheck\.|\bATS\b/);
    expect(realIntlErrors(onIntlError)).toEqual([]);
  });

  describe('?issue=<id> (the Assistant links to /resume/<id>/check?issue=<id>)', () => {
    it('opens on that issue: scrolled into view, focused, details shown, and marked', async () => {
      const scrolled = vi.fn();
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrolled;
      try {
        api.getLatestGrade.mockResolvedValue(latest());
        const { onIntlError } = renderReport('layout_table-1');
        await screen.findByRole('heading', { name: 'Fair' });
        const card = document.getElementById('issue-layout_table-1')!;
        expect(card).toHaveAttribute('data-focused', 'true');
        await waitFor(() => expect(document.activeElement).toBe(card));
        expect(scrolled).toHaveBeenCalledTimes(1);
        expect(scrolled.mock.instances[0]).toBe(card);
        // Its details are open without a click (a non-urgent issue starts closed otherwise).
        expect(card.querySelector('button[aria-expanded="true"]')).not.toBeNull();
        expect(card).toHaveTextContent('Why it matters');
        // No other card is marked or opened by the link.
        const other = document.getElementById('issue-weak_verb-1')!;
        expect(other).not.toHaveAttribute('data-focused');
        expect(other.querySelector('button[aria-expanded="true"]')).toBeNull();
        expect(document.querySelector('[data-focus-missing]')).toBeNull();
        expect(realIntlErrors(onIntlError)).toEqual([]);
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });

    it('says so when the linked issue is not in the latest check, and focuses nothing', async () => {
      api.getLatestGrade.mockResolvedValue(latest());
      const { onIntlError } = renderReport('gone-9');
      expect(await screen.findByText('The issue you opened is not in the latest check. It may already be fixed.')).toBeInTheDocument();
      expect(document.querySelector('[data-focused="true"]')).toBeNull();
      expect(realIntlErrors(onIntlError)).toEqual([]);
    });

    it('the page passes ?issue= to the report (first value, trimmed; junk ignored)', async () => {
      const { default: Page } = await import('../../../app/(auth)/resume/[id]/check/page');
      const props = async (query?: Record<string, string | string[]>) =>
        ((await Page({ params: Promise.resolve({ id: 'rv_1' }), searchParams: query ? Promise.resolve(query) : undefined })) as { props: Record<string, unknown> }).props;
      expect(await props({ issue: ' weak_verb-1 ' })).toEqual({ resumeId: 'rv_1', focusIssueId: 'weak_verb-1' });
      expect(await props({ issue: ['a-1', 'b-2'] })).toEqual({ resumeId: 'rv_1', focusIssueId: 'a-1' });
      expect(await props({ issue: 'x'.repeat(121) })).toEqual({ resumeId: 'rv_1', focusIssueId: null });
      expect(await props()).toEqual({ resumeId: 'rv_1', focusIssueId: null });
    });

    it('without ?issue= nothing is focused and no note shows', async () => {
      api.getLatestGrade.mockResolvedValue(latest());
      renderReport();
      await screen.findByRole('heading', { name: 'Fair' });
      expect(document.querySelector('[data-focused="true"]')).toBeNull();
      expect(document.querySelector('[data-focus-missing]')).toBeNull();
    });
  });

  it('filters by priority', async () => {
    api.getLatestGrade.mockResolvedValue(latest());
    renderReport();
    fireEvent.click(await screen.findByRole('button', { name: /1\s*Nice to have/ }));
    expect(screen.queryByText('Weak opener: "responsible for"')).toBeNull();
    expect(screen.getByText('Photo (optional)')).toBeInTheDocument();
  });

  it('writes an AI version (labelled), then Use writes it into the resume', async () => {
    api.getLatestGrade.mockResolvedValue(latest());
    api.fixIssue.mockResolvedValue({ suggestions: [{ text: 'Opened the store every morning.', aiWritten: true }], blocked: 0 });
    api.applyIssueFix.mockResolvedValue({ applied: true, resumeContentHash: 'h2' });
    renderReport();
    fireEvent.click(await screen.findByRole('button', { name: 'Write an AI version' }));
    expect(await screen.findByText('Opened the store every morning.')).toBeInTheDocument();
    expect(api.fixIssue).toHaveBeenCalledWith('rv_1', 'weak_verb-1', { variant: 'ai' }, { idempotencyKey: 'idem-key' });
    expect(screen.getByText('AI version')).toBeInTheDocument();
    expect(screen.getByTestId('ai-badge')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shorter' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use this' }));
    await waitFor(() => expect(api.applyIssueFix).toHaveBeenCalledWith('rv_1', 'weak_verb-1', { text: 'Opened the store every morning.' }));
    expect(await screen.findByText('Updated in your resume.')).toBeInTheDocument();
  });

  it('Edit lets the user change the AI version before saving', async () => {
    api.getLatestGrade.mockResolvedValue(latest());
    api.fixIssue.mockResolvedValue({ suggestions: [{ text: 'Opened the store.', aiWritten: true }], blocked: 0 });
    api.applyIssueFix.mockResolvedValue({ applied: true, resumeContentHash: 'h2' });
    renderReport();
    fireEvent.click(await screen.findByRole('button', { name: 'Write an AI version' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit the AI version' }), { target: { value: 'Opened the store at 7.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to resume' }));
    await waitFor(() => expect(api.applyIssueFix).toHaveBeenCalledWith('rv_1', 'weak_verb-1', { text: 'Opened the store at 7.' }));
  });

  it('explains a CitationGuard refusal', async () => {
    api.getLatestGrade.mockResolvedValue(latest());
    const { RoboApiError } = await import('../../../lib/api/client');
    const err = Object.assign(Object.create(RoboApiError.prototype), { payload: { code: 'conflict', details: { reason: 'citation_guard' } } });
    api.fixIssue.mockRejectedValue(err);
    renderReport();
    fireEvent.click(await screen.findByRole('button', { name: 'Write an AI version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('added numbers that are not in your resume');
  });

  it('hides every AI action when AI is unavailable', async () => {
    api.getLatestGrade.mockResolvedValue(latest({ aiAvailable: false, grade: gradeView({ method: 'rules', rulesChecked: 19, issues: ISSUES.filter((i) => i.source !== 'ai') }) }));
    renderReport();
    expect(await screen.findByText('Weak opener: "responsible for"')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write an AI version' })).toBeNull();
    expect(screen.getByText(/AI checks are off for your account, so spelling was not checked/)).toBeInTheDocument();
  });

  it('shows the stale banner and the comparison with the previous check', async () => {
    api.getLatestGrade.mockResolvedValue(
      latest({
        stale: true,
        previous: { id: 'g1', label: 'needs_work', score: 40, counts: { urgent: 2, critical: 3, optional: 1 }, issueTypes: ['weak_verb', 'contact_email_missing'], createdAt: NOW },
      }),
    );
    renderReport();
    expect(await screen.findByText('You changed this resume after the check.')).toBeInTheDocument();
    expect(screen.getByText('Since your last check')).toBeInTheDocument();
    expect(screen.getByText('Last time: Needs work, 40 of 100')).toBeInTheDocument();
    expect(screen.getByText('2 → 1')).toBeInTheDocument();
    expect(screen.getByText('Email address')).toBeInTheDocument(); // fixed since last time
  });

  it('starts a check (credit line shown) and re-renders the result', async () => {
    api.getLatestGrade.mockResolvedValueOnce(latest({ grade: null }));
    api.startGrade.mockResolvedValue({ gradeId: 'g2', grade: gradeView() });
    api.getLatestGrade.mockResolvedValue(latest());
    renderReport();
    expect(await screen.findByText('Uses 1 resume check credit (3 left).')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Role you are aiming for (optional)'), { target: { value: 'Store lead' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run the check' }));
    await waitFor(() => expect(api.startGrade).toHaveBeenCalledWith('rv_1', { targetTitle: 'Store lead' }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    // Never blocked on credits: the checklist is free, only the AI pass is metered.
    expect(gate.runs).toBe(0);
    expect(await screen.findByRole('heading', { name: 'Fair' })).toBeInTheDocument();
  });

  it('with no resume check credit left the check still runs and says spelling was not checked', async () => {
    gate.left = 0;
    api.getLatestGrade.mockResolvedValueOnce(latest({ grade: null }));
    const checklistOnly = gradeView({ method: 'rules', aiSkipped: 'credits_exhausted', rulesChecked: 19, issues: ISSUES.filter((i) => i.source !== 'ai') });
    api.startGrade.mockResolvedValue({ gradeId: 'g2', grade: checklistOnly });
    api.getLatestGrade.mockResolvedValue(latest({ grade: checklistOnly }));
    const { onIntlError } = renderReport();
    expect(await screen.findByText(/No resume check credits left: the checklist still runs/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run the check' }));
    await waitFor(() => expect(api.startGrade).toHaveBeenCalled());
    expect(await screen.findByText(/Spelling was not checked: you have no resume check credits left/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    // AI fixes stay available: they use the separate rewrite credit.
    expect(screen.getByRole('button', { name: 'Write an AI version' })).toBeInTheDocument();
    expect(realIntlErrors(onIntlError)).toEqual([]);
  });

  it('says so when the AI read failed', async () => {
    api.getLatestGrade.mockResolvedValue(latest({ grade: gradeView({ method: 'rules', aiSkipped: 'ai_failed', issues: ISSUES.filter((i) => i.source !== 'ai') }) }));
    renderReport();
    expect(await screen.findByText(/the AI read did not finish. No credit was used/)).toBeInTheDocument();
  });

  it('a running check turns into the report when the server finishes it (polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.getLatestGrade
        .mockResolvedValueOnce(latest({ grade: gradeView({ status: 'running', label: null, score: null, counts: null, issues: [] }) }))
        .mockResolvedValue(latest());
      renderReport();
      expect(await screen.findByRole('button', { name: 'Cancel the check' })).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS + 50);
      });
      expect(await screen.findByRole('heading', { name: 'Fair' })).toBeInTheDocument();
      expect(api.getLatestGrade.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without AI the check runs without the credit gate', async () => {
    gate.left = 0;
    api.getLatestGrade.mockResolvedValue(latest({ grade: null, aiAvailable: false }));
    api.startGrade.mockResolvedValue({ gradeId: 'g3' });
    renderReport();
    expect(await screen.findByText(/No credit is used/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run the check' }));
    await waitFor(() => expect(api.startGrade).toHaveBeenCalled());
    expect(gate.runs).toBe(0);
  });

  describe('telling the server the check was opened (RAResumeGrade.viewedAt)', () => {
    it('the finished report says so once, however often the page re-renders or refetches', async () => {
      api.getLatestGrade.mockResolvedValue(latest());
      renderReport();
      expect(await screen.findByRole('heading', { name: 'Fair' })).toBeInTheDocument();
      await waitFor(() => expect(api.markResumeCheckOpened).toHaveBeenCalledTimes(1));
      expect(api.markResumeCheckOpened).toHaveBeenCalledWith('rv_1');
      // Filtering re-renders the report; the same check is not reported twice.
      fireEvent.click(screen.getByRole('button', { name: /1\s*Fix first/ }));
      fireEvent.click(screen.getByRole('button', { name: /^All/ }));
      expect(api.markResumeCheckOpened).toHaveBeenCalledTimes(1);
    });

    it('a failed call changes nothing on the page', async () => {
      api.getLatestGrade.mockResolvedValue(latest());
      api.markResumeCheckOpened.mockRejectedValue(new Error('offline'));
      renderReport();
      expect(await screen.findByRole('heading', { name: 'Fair' })).toBeInTheDocument();
      await waitFor(() => expect(api.markResumeCheckOpened).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('nothing is sent before there is a finished check on screen', async () => {
      api.getLatestGrade.mockResolvedValue(latest({ grade: null }));
      renderReport();
      expect(await screen.findByRole('button', { name: 'Run the check' })).toBeInTheDocument();
      expect(api.markResumeCheckOpened).not.toHaveBeenCalled();
    });

    it('a running check is not opened; the report it turns into is', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        api.getLatestGrade
          .mockResolvedValueOnce(latest({ grade: gradeView({ status: 'running', label: null, score: null, counts: null, issues: [] }) }))
          .mockResolvedValue(latest());
        renderReport();
        expect(await screen.findByRole('button', { name: 'Cancel the check' })).toBeInTheDocument();
        expect(api.markResumeCheckOpened).not.toHaveBeenCalled();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS + 50);
        });
        expect(await screen.findByRole('heading', { name: 'Fair' })).toBeInTheDocument();
        await waitFor(() => expect(api.markResumeCheckOpened).toHaveBeenCalledTimes(1));
      } finally {
        vi.useRealTimers();
      }
    });

    it('a new check after a re-check is reported as opened too', async () => {
      api.getLatestGrade.mockResolvedValueOnce(latest());
      api.startGrade.mockResolvedValue({ gradeId: 'g3', grade: gradeView({ id: 'g3' }) });
      api.getLatestGrade.mockResolvedValue(latest({ grade: gradeView({ id: 'g3' }) }));
      renderReport();
      expect(await screen.findByRole('heading', { name: 'Fair' })).toBeInTheDocument();
      await waitFor(() => expect(api.markResumeCheckOpened).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getAllByRole('button', { name: 'Check again' })[0]!);
      await waitFor(() => expect(api.markResumeCheckOpened).toHaveBeenCalledTimes(2));
    });

    it('other readers of the latest check (the editor popover) never say it was opened', async () => {
      api.getLatestGrade.mockResolvedValue(latest());
      const report = analyzeResume(parseResumeMarkdown(''));
      renderWithProviders(<AnalyzerPanel report={report} resumeId="rv_1" onJump={() => {}} onClose={() => {}} />);
      expect(await screen.findByText('Last check: Fair · 1 to fix first')).toBeInTheDocument();
      expect(api.markResumeCheckOpened).not.toHaveBeenCalled();
    });
  });

  it('a running check can be cancelled', async () => {
    api.getLatestGrade.mockResolvedValue(latest({ grade: gradeView({ status: 'running', label: null, score: null, counts: null, issues: [] }) }));
    api.cancelGrade.mockResolvedValue({ gradeId: 'g2', status: 'cancelled', released: true });
    renderReport();
    const cancel = await screen.findByRole('button', { name: 'Cancel the check' });
    await act(async () => {
      fireEvent.click(cancel);
    });
    await waitFor(() => expect(api.cancelGrade).toHaveBeenCalledWith('g2'));
  });
});

describe('KeywordReportView', () => {
  const report: KeywordReportResponse = {
    fit: { value: 72, source: 'ai', asOf: NOW, method: 'fit_score' },
    fitTier: 'good',
    rows: [
      { key: 'title', status: 'pass', params: { title: 'Analyst' }, label: 'Job title', detail: '' },
      { key: 'years', status: 'unknown', params: {}, label: 'Years', detail: '' },
      { key: 'education', status: 'fail', params: { required: 'master', found: 'bachelor' }, label: 'Education', detail: '' },
      { key: 'skills', status: 'warn', params: { met: 2, total: 4 }, label: 'Hard skills', detail: '' },
      { key: 'keywords', status: 'pass', params: { met: 5, total: 6 }, label: 'Keywords', detail: '' },
    ],
    keywords: { matched: ['SQL'], missing: ['dbt'] },
    hardSkills: { matched: ['python'], missing: ['tableau'] },
    keywordSource: 'extraction',
  };

  it('renders rows, statuses, terms and the fit honesty line', () => {
    const onIntlError = vi.fn();
    renderWithProviders(<KeywordReportView report={report} />, { onIntlError });
    expect(screen.getByText('Keyword check')).toBeInTheDocument();
    expect(screen.getByText('Not listed')).toBeInTheDocument();
    expect(screen.getByText('Your degree is below the listed level.')).toBeInTheDocument();
    expect(screen.getByText('Hard skills · 2 of 4')).toBeInTheDocument();
    expect(screen.getByText('tableau')).toBeInTheDocument();
    expect(screen.getByText('This is not your chance of getting hired.')).toBeInTheDocument();
    expect(realIntlErrors(onIntlError)).toEqual([]);
  });

  it('says so when there is no fit score', () => {
    renderWithProviders(<KeywordReportView report={{ ...report, fit: null, fitTier: null }} />);
    expect(screen.getByText('No fit score for this version of your resume yet.')).toBeInTheDocument();
  });
});

describe('entry points', () => {
  it('links the hub card and the editor to the check page', () => {
    renderWithProviders(<ResumeCheckEntry resumeId="rv 1" name="Product resume" />);
    const link = screen.getByRole('link', { name: 'Resume check for Product resume' });
    expect(link).toHaveAttribute('href', resumeCheckHref('rv 1'));
    expect(resumeCheckHref('rv 1')).toBe('/resume/rv%201/check');
  });

  it('the analyzer popover leads with the server check and keeps the heuristic list', async () => {
    api.getLatestGrade.mockResolvedValue(latest());
    const report = analyzeResume(parseResumeMarkdown(''));
    renderWithProviders(<AnalyzerPanel report={report} resumeId="rv_1" onJump={() => {}} onClose={() => {}} />);
    expect(await screen.findByText('Last check: Fair · 1 to fix first')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the full check' })).toHaveAttribute('href', '/resume/rv_1/check');
    expect(screen.getByText('Quick checks while you edit')).toBeInTheDocument();
  });
});

describe('editor AI gate (aiEnabled=false hides AI actions)', () => {
  it('SummaryEditor and BulletRow hide their AI controls', async () => {
    const { SummaryEditor } = await import('../../v3/resume-editor/SummaryEditor');
    const { BulletRow } = await import('../../v3/resume-editor/BulletRow');
    const runRewrite = vi.fn();
    const { unmount } = renderWithProviders(
      <>
        <SummaryEditor value="Engineer." onChange={() => {}} runRewrite={runRewrite} aiEnabled={false} />
        <BulletRow text="Built things." onAccept={() => {}} onChange={() => {}} onAddBelow={() => {}} onRemove={() => {}} runRewrite={runRewrite} aiEnabled={false} />
      </>,
    );
    expect(screen.queryByText('Show 3 rewrites')).toBeNull();
    expect(screen.queryByText('Improve the writing')).toBeNull();
    unmount();
    renderWithProviders(
      <>
        <SummaryEditor value="Engineer." onChange={() => {}} runRewrite={runRewrite} />
        <BulletRow text="Built things." onAccept={() => {}} onChange={() => {}} onAddBelow={() => {}} onRemove={() => {}} runRewrite={runRewrite} />
      </>,
    );
    expect(screen.getByText('Show 3 rewrites')).toBeInTheDocument();
    expect(screen.getByText('Improve the writing')).toBeInTheDocument();
    expect(runRewrite).not.toHaveBeenCalled();
  });
});
