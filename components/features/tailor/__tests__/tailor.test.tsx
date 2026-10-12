// WP-36a — tailor flow UI: entry hidden when AI is off (zero API calls),
// setup (sections, instruction ≤ 1000, only confirmed skills), the result
// (before/after fit score with source or "—", change cards, Verify details:
// Yes keep · Remove · I did something similar → edit), finalize blocked while
// a claim is pending, checklist refresh, AI badge, error copy, launch host.
// INT-10: the target step ("Which job is this for?") when the flow starts
// without a job (the editor's Tailor button): pick a saved job or paste the
// posting, which becomes `jobId` or `jd: { title, company, text }`.
// Renders through the real en.json + staged English, so a missing key fails.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import { RoboApiError } from '../../../../lib/api/client';
import type { KeywordReportResponse, LatestGradeResponse, TailorClaim, TailorSessionView } from '../../../../lib/api/contracts/resume';

const api = vi.hoisted(() => ({
  createTailorSession: vi.fn(),
  getTailorSession: vi.fn(),
  updateTailorClaim: vi.fn(),
  finalizeTailorSession: vi.fn(),
  getKeywordReport: vi.fn(),
  getLatestGrade: vi.fn(),
}));
vi.mock('../../../../lib/api/resumes', () => api);

const flags = vi.hoisted(() => ({ aiText: true }));
vi.mock('../../../../lib/flags', () => ({ useFlag: (key: string) => (key === 'ai.text' ? flags.aiText : false) }));

const gate = vi.hoisted(() => ({ runs: 0, keys: [] as string[] }));
vi.mock('../../../../hooks/shared/useCreditGate', () => ({
  useCreditGate: () => ({
    summary: null,
    left: 2,
    run: async (fn: (key: string) => Promise<unknown>) => {
      gate.runs += 1;
      const key = `idem-${gate.runs}`;
      gate.keys.push(key);
      return { ok: true, value: await fn(key) };
    },
  }),
}));

const resumes = vi.hoisted(() => ({
  list: [
    { id: 'rv_other', name: 'Old resume', kind: 'base', isPrimary: false },
    { id: 'rv_1', name: 'Main resume', kind: 'base', isPrimary: true },
    { id: 'rv_t', name: 'Tailored', kind: 'tailored_for_jd', isPrimary: false },
  ],
}));
vi.mock('../../../../hooks/useResumes', () => ({
  resumeKeys: { all: ['v2', 'resumes'] },
  useResumeList: () => ({ data: { resumes: resumes.list }, isLoading: false, isError: false, refetch: vi.fn() }),
  useResume: (id: string | null) => ({
    data: id ? { id, resumeMarkdown: id === 'rv_1' ? '## Skills\nSQL' : '## Skills\nSQL, Tableau' } : undefined,
    isLoading: false,
    isError: false,
  }),
}));

const tracker = vi.hoisted(() => ({ listTracker: vi.fn() }));
vi.mock('../../../../lib/api/tracker', () => tracker);

const growth = vi.hoisted(() => ({ refreshChecklist: vi.fn(async () => undefined) }));
vi.mock('../../../../hooks/growth', () => growth);

vi.mock('../../market', () => ({ AiGeneratedBadge: () => <span data-testid="ai-badge">AI generated</span> }));

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/resume',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { ClaimCard, TailorButton, TailorFlow, TailorLaunchHost, TailorResult, TailorSheet, TailorTarget, postingOf } from '..';
import { readTailorPrefs, tailorErrorKind, targetJobsOf, writeTailorPrefs } from '../../../../hooks/tailor';

const NOW = '2026-10-10T12:00:00.000Z';

function latest(aiAvailable: boolean): LatestGradeResponse {
  return { grade: null, previous: null, stale: false, aiAvailable };
}

const KEYWORDS: KeywordReportResponse = {
  fit: null,
  fitTier: null,
  rows: [],
  keywords: { matched: ['sql'], missing: ['forecasting'] },
  hardSkills: { matched: [], missing: ['Tableau', 'Python'] },
  keywordSource: 'extraction',
};

const claim = (over: Partial<TailorClaim> & Pick<TailorClaim, 'id' | 'text'>): TailorClaim => ({ kind: 'keyword', status: 'pending', reasons: ['new_keyword'], ...over });

function sessionView(over: Partial<TailorSessionView> = {}): TailorSessionView {
  const claims = over.claims ?? [
    claim({ id: 'c1', text: 'SQL, Tableau', terms: ['Tableau'], original: 'SQL', section: 'Skills' }),
    claim({ id: 'c2', text: 'Cut report time by 40%.', kind: 'number', reasons: ['new_number'], terms: ['40'], original: null, section: 'Experience' }),
  ];
  return {
    id: 'ts_1',
    status: 'review',
    baseVariantId: 'rv_1',
    jobId: 'job_1',
    scoreBefore: 61,
    scoreAfter: 74,
    changes: [
      { section: 'Skills', before: 'SQL', after: 'SQL, Tableau', kind: 'rewrite' },
      { section: 'Experience', before: '', after: 'Cut report time by 40%.', kind: 'add' },
    ],
    claims,
    resultVariantId: 'rv_t',
    mode: 'guided',
    sections: ['experience', 'skills'],
    experienceDepth: 'quick',
    target: { title: 'Data Analyst', company: 'Acme' },
    pendingClaims: claims.filter((c) => c.status === 'pending').length,
    fit: {
      before: { value: 61, source: 'ai', asOf: NOW, method: 'fit_score' },
      after: { value: 74, source: 'ai', asOf: NOW, method: 'fit_score' },
    },
    aiWritten: true,
    failure: null,
    createdAt: NOW,
    ...over,
  };
}

/** Tracker rows as GET /v2/tracker sends them (only the fields the target step reads). */
const TRACKED = [
  { id: 'te_1', jobId: 'job_9', job: { title: 'Data Analyst', companyName: 'Acme' } },
  { id: 'te_2', jobId: null, job: null, externalSnapshot: { title: 'Typed by hand', companyName: 'No posting' } },
  { id: 'te_3', jobId: 'job_7', job: { title: 'BI Engineer', companyName: '' } },
  { id: 'te_4', jobId: 'job_9', job: { title: 'Data Analyst', companyName: 'Acme' } },
];

const POSTING_TEXT = 'We need an analyst who builds SQL reports and Tableau dashboards for the sales team every week.';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getLatestGrade.mockResolvedValue(latest(true));
  api.getKeywordReport.mockResolvedValue(KEYWORDS);
  tracker.listTracker.mockReset();
  tracker.listTracker.mockResolvedValue({ entries: TRACKED, statusCounts: {}, total: TRACKED.length });
  flags.aiText = true;
  gate.runs = 0;
  gate.keys = [];
  nav.push.mockReset();
  nav.replace.mockReset();
  nav.search = '';
  growth.refreshChecklist.mockClear();
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom without storage */
  }
});

describe('TailorButton', () => {
  it('is hidden when the brand has no AI text model (no consent read either)', async () => {
    flags.aiText = false;
    renderWithProviders(<TailorButton jobId="job_1" />);
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: /tailor/i })).toBeNull();
    expect(api.getLatestGrade).not.toHaveBeenCalled();
  });

  it('is hidden when the user has not allowed AI (GoApply consent off)', async () => {
    api.getLatestGrade.mockResolvedValue(latest(false));
    renderWithProviders(<TailorButton jobId="job_1" />);
    await waitFor(() => expect(api.getLatestGrade).toHaveBeenCalledWith('rv_1', expect.anything()));
    expect(screen.queryByRole('button', { name: /tailor/i })).toBeNull();
  });

  it('launches the shared route contract with the main resume checked for consent', async () => {
    renderWithProviders(<TailorButton jobId="job_1" from="job_detail" />);
    const btn = await screen.findByRole('button', { name: 'Tailor resume' });
    fireEvent.click(btn);
    expect(nav.push).toHaveBeenCalledWith('/resume?tailor=job_1&from=job_detail');
  });
});

describe('TailorFlow', () => {
  it('AI off: one plain line, no session is created', async () => {
    api.getLatestGrade.mockResolvedValue(latest(false));
    renderWithProviders(<TailorFlow resumeId="rv_1" jobId="job_1" />);
    expect(await screen.findByTestId('tailor-ai-off')).toHaveTextContent('AI tailoring is not available');
    expect(api.createTailorSession).not.toHaveBeenCalled();
  });

  it('setup: sections, instruction counter, only confirmed skills are sent; then the result', async () => {
    api.createTailorSession.mockResolvedValue(sessionView());
    renderWithProviders(<TailorFlow resumeId="rv_1" jobId="job_1" />);
    expect(await screen.findByText('What should change?')).toBeInTheDocument();

    // defaults: summary, experience, skills; turn summary off, projects on
    fireEvent.click(screen.getByRole('checkbox', { name: 'Summary' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Projects' }));

    expect(screen.getByRole('radio', { name: 'Quick: reword and reorder what is there' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Full: bullets may be rewritten, merged or dropped' }));

    const box = screen.getByLabelText('Anything to keep in mind? (optional)');
    fireEvent.change(box, { target: { value: 'Lead with reporting.' } });
    expect(screen.getByText('20 of 1000 characters')).toBeInTheDocument();
    expect(box).toHaveAttribute('maxLength', '1000');

    const tableau = await screen.findByRole('checkbox', { name: 'Tableau' });
    expect(screen.getByRole('checkbox', { name: 'forecasting' })).toBeInTheDocument();
    fireEvent.click(tableau);

    fireEvent.click(screen.getByRole('button', { name: 'Tailor my resume' }));
    await waitFor(() => expect(api.createTailorSession).toHaveBeenCalledTimes(1));
    expect(api.createTailorSession).toHaveBeenCalledWith(
      {
        baseVariantId: 'rv_1',
        jobId: 'job_1',
        mode: 'guided',
        sections: ['experience', 'skills', 'projects'],
        experienceDepth: 'full',
        customPrompt: 'Lead with reporting.',
        keywords: ['Tableau'],
      },
      { idempotencyKey: 'idem-1' },
    );
    expect(await screen.findByText('Tailored for Data Analyst · Acme')).toBeInTheDocument();
    expect(readTailorPrefs()?.sections).toEqual(['experience', 'skills', 'projects']);
  });

  it('a repeat user gets Fast tailor with the last sections', async () => {
    writeTailorPrefs({ sections: ['skills'], experienceDepth: 'quick', runs: 2 });
    api.createTailorSession.mockResolvedValue(sessionView());
    renderWithProviders(<TailorFlow resumeId="rv_1" jobId="job_1" />);
    expect(await screen.findByText('Uses your last settings: Skills.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fast tailor' }));
    await waitFor(() =>
      expect(api.createTailorSession).toHaveBeenCalledWith({ baseVariantId: 'rv_1', jobId: 'job_1', mode: 'fast', sections: ['skills'], keywords: [] }, { idempotencyKey: 'idem-1' }),
    );
  });

  it('phone binding and content-safety errors get their own copy', async () => {
    api.createTailorSession.mockRejectedValueOnce(new RoboApiError('x', { status: 403, payload: { code: 'phone_binding_required' } }));
    renderWithProviders(<TailorFlow resumeId="rv_1" jobId="job_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tailor my resume' }));
    expect(await screen.findByRole('link', { name: /phone/i })).toBeInTheDocument();

    api.createTailorSession.mockRejectedValueOnce(new RoboApiError('x', { status: 422, payload: { code: 'content_blocked', details: { stage: 'input' } } }));
    fireEvent.click(screen.getByRole('button', { name: 'Tailor my resume' }));
    expect(await screen.findByText('This request could not be processed. Change the instruction and try again.')).toBeInTheDocument();
  });

  it('a stopped session offers a fresh start', async () => {
    api.getTailorSession.mockResolvedValue(sessionView({ status: 'failed', failure: 'stopped', claims: [], resultVariantId: null }));
    renderWithProviders(<TailorFlow resumeId="rv_1" jobId="job_1" sessionId="ts_1" />);
    expect(await screen.findByText(/stopped before it finished/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('What should change?')).toBeInTheDocument();
  });
});

describe('TailorResult', () => {
  it('finalized: shows the two measures as numbers and meters with sources, each named for what it is', () => {
    renderWithProviders(<TailorResult session={sessionView({ status: 'finalized', claims: [], pendingClaims: 0 })} />);
    // MKT-2F: two measures, not one number that moved. No "Before" / "After" pair.
    expect(screen.getByText('Your fit')).toBeInTheDocument();
    expect(screen.getByText('With this version')).toBeInTheDocument();
    expect(screen.queryByText('Before')).toBeNull();
    expect(screen.queryByText('After')).toBeNull();
    expect(screen.getByTestId('tailor-score-before')).toHaveTextContent('61 / 100');
    expect(screen.getByTestId('tailor-score-after')).toHaveTextContent('74 / 100');
    expect(screen.getAllByRole('meter')).toHaveLength(2);
    expect(screen.getByTestId('tailor-fit-note')).toHaveTextContent('Your fit on the job page stays the one for your main resume until you make this version your main resume.');
    // The honesty line stays with the numbers.
    expect(screen.getAllByText('This is not your chance of getting hired.').length).toBeGreaterThan(0);
  });

  it('MKT-2F: the measures the server names (canonical, variant) are what is shown, each with its own date', () => {
    const canonical = { value: 63, kind: 'ai' as const, tier: 'possible' as const, scoredAt: '2026-10-08T09:00:00.000Z', version: { rubric: 'fit_v3', estimator: 'est_v2', model: 'm' } };
    const variant = { value: 79, kind: 'ai' as const, tier: 'good' as const, scoredAt: '2026-10-10T10:00:00.000Z', version: { rubric: 'fit_v3', estimator: 'est_v2', model: 'm' } };
    renderWithProviders(
      <TailorResult
        session={sessionView({
          status: 'finalized',
          claims: [],
          pendingClaims: 0,
          scoreBefore: 63,
          scoreAfter: 79,
          // The aliases of an older shape are ignored once the named measures are there.
          fit: { canonical, variant, before: { value: 1, source: 'ai', asOf: NOW, method: 'fit_score' }, after: { value: 2, source: 'ai', asOf: NOW, method: 'fit_score' } },
        })}
      />,
    );
    expect(screen.getByTestId('tailor-score-before')).toHaveTextContent('63 / 100');
    expect(screen.getByTestId('tailor-score-after')).toHaveTextContent('79 / 100');
    expect(screen.getByText('Your fit').parentElement).toContainElement(screen.getByTestId('tailor-score-before'));
    expect(screen.getByText('With this version').parentElement).toContainElement(screen.getByTestId('tailor-score-after'));
  });

  it('MKT-2F: "With this version" waits until the copy is finalized; a version with no AI fit shows "—", never an estimate', () => {
    const canonical = { value: 63, kind: 'ai' as const, tier: 'possible' as const, scoredAt: '2026-10-08T09:00:00.000Z', version: null };
    const { unmount } = renderWithProviders(<TailorResult session={sessionView({ scoreAfter: null, fit: { canonical, variant: null, before: null, after: null } })} />);
    expect(screen.getByText('Your fit')).toBeInTheDocument();
    expect(screen.getByText('With this version')).toBeInTheDocument();
    expect(screen.getByTestId('tailor-score-before')).toHaveTextContent('63 / 100');
    expect(screen.queryByTestId('tailor-score-after')).toBeNull();
    expect(screen.getByTestId('tailor-score-after-pending')).toHaveTextContent("You'll see this after you check every detail");
    unmount();
    renderWithProviders(<TailorResult session={sessionView({ status: 'finalized', claims: [], pendingClaims: 0, scoreAfter: null, fit: { canonical, variant: null, before: null, after: null } })} />);
    expect(screen.getByTestId('tailor-score-after-pending')).toHaveTextContent('Fit score not available for this version.');
    expect(screen.getAllByRole('meter')).toHaveLength(1);
  });

  it('in review: the before score shows; the after score waits until every detail is checked', () => {
    renderWithProviders(<TailorResult session={sessionView({ scoreAfter: null, fit: { before: { value: 61, source: 'ai', asOf: NOW, method: 'fit_score' }, after: null } })} />);
    expect(screen.getByTestId('tailor-score-before')).toHaveTextContent('61 / 100');
    expect(screen.queryByTestId('tailor-score-after')).toBeNull();
    expect(screen.getByTestId('tailor-score-after-pending')).toHaveTextContent("You'll see this after you check every detail");
    expect(screen.getAllByRole('meter')).toHaveLength(1);
  });

  it('change rows: a default section title follows the interface language, the resume\u2019s own title stays, marks are not shown', () => {
    renderWithProviders(
      <TailorResult
        session={sessionView({
          changes: [
            { section: 'Summary', before: 'Old summary.', after: 'New summary.', kind: 'rewrite' },
            { section: '实习经历', before: '', after: '**框架：** pandas', kind: 'add' },
          ],
        })}
      />,
    );
    const rows = document.querySelectorAll('[data-kind]');
    expect(rows[0]!.textContent).toContain('Summary');
    expect(rows[1]!.textContent).toContain('实习经历');
    expect(rows[1]!.textContent).toContain('框架： pandas');
    expect(rows[1]!.textContent).not.toContain('**');
  });

  it('the result shows the keyword check of the tailored text, for a job and for a pasted posting', async () => {
    api.getKeywordReport.mockResolvedValue({ ...KEYWORDS, rows: [{ key: 'skills', status: 'warn', params: { met: 1, total: 2 }, label: 'Hard skills', detail: '' }] });
    renderWithProviders(<TailorResult session={sessionView({ jobId: null, resultVariantId: 'rv_2' })} />);
    await waitFor(() => expect(api.getKeywordReport).toHaveBeenCalledWith('rv_2', { tailorSessionId: 'ts_1' }, expect.anything()));
    expect(await screen.findByText('Keyword check')).toBeInTheDocument();
    // The result has its own before / after scores: the grid does not repeat a fit score.
    expect(screen.queryByText('Fit score for this resume')).toBeNull();
  });

  it('shows AI labels and change cards', async () => {
    renderWithProviders(<TailorResult session={sessionView()} />);
    expect(screen.getByTestId('ai-badge')).toBeInTheDocument();
    expect(screen.getByText('Written with AI. Check every line before you use it.')).toBeInTheDocument();
    expect(screen.getByText('Changes (2)')).toBeInTheDocument();
    expect(screen.getByText('Rewritten')).toBeInTheDocument();
    expect(screen.getByText('Added')).toBeInTheDocument();
  });

  it('no score → "—", never a made-up number', () => {
    renderWithProviders(<TailorResult session={sessionView({ scoreBefore: null, scoreAfter: null, fit: { before: null, after: null } })} />);
    expect(screen.getByTestId('tailor-score-none')).toHaveTextContent('—');
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    expect(screen.getByText('This is not your chance of getting hired.')).toBeInTheDocument();
  });

  it('Use this resume stays disabled while a detail is pending; keep → finalize → checklist refresh', async () => {
    const first = sessionView();
    api.updateTailorClaim.mockImplementation(async (_id: string, claimId: string, body: { status: string }) => {
      const claims = first.claims.map((c) => (c.id === claimId ? { ...c, status: body.status as TailorClaim['status'] } : c));
      return sessionView({ claims });
    });
    const onFinalized = vi.fn();
    const { rerender } = renderWithProviders(<TailorResult session={first} onFinalized={onFinalized} />);
    const use = screen.getByRole('button', { name: 'Use this resume' });
    expect(use).toBeDisabled();
    expect(screen.getByText('Check 2 details before you use this resume.')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Yes, keep' })[0]!);
    await waitFor(() => expect(api.updateTailorClaim).toHaveBeenCalledWith('ts_1', 'c1', { status: 'kept' }));

    const allKept = sessionView({ claims: first.claims.map((c) => ({ ...c, status: 'kept' as const })) });
    api.finalizeTailorSession.mockResolvedValue({ ...allKept, status: 'finalized' });
    rerender(<TailorResult session={allKept} onFinalized={onFinalized} />);
    const enabled = screen.getByRole('button', { name: 'Use this resume' });
    expect(enabled).not.toBeDisabled();
    fireEvent.click(enabled);
    await waitFor(() => expect(api.finalizeTailorSession).toHaveBeenCalledWith('ts_1'));
    await waitFor(() => expect(growth.refreshChecklist).toHaveBeenCalledTimes(1));
    expect(onFinalized).toHaveBeenCalledWith(expect.objectContaining({ status: 'finalized' }));
  });

  it('finalized: open the tailored resume', () => {
    const onOpenResume = vi.fn();
    renderWithProviders(<TailorResult session={sessionView({ status: 'finalized', claims: [], pendingClaims: 0 })} onOpenResume={onOpenResume} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open this resume' }));
    expect(onOpenResume).toHaveBeenCalledWith('rv_t');
  });

  it('compare shows both versions', async () => {
    renderWithProviders(<TailorResult session={sessionView()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
    expect(await screen.findByText('Your resume')).toBeInTheDocument();
    expect(screen.getByText('Tailored version')).toBeInTheDocument();
  });
});

describe('ClaimCard', () => {
  it('Yes, keep · Remove · I did something similar → the user text', async () => {
    const onDecide = vi.fn(async () => undefined);
    renderWithProviders(
      <ul>
        <ClaimCard claim={claim({ id: 'c2', text: 'Cut report time by 40%.', reasons: ['new_number'], terms: ['40'] })} onDecide={onDecide} />
      </ul>,
    );
    expect(screen.getByText('A number your resume did not have')).toBeInTheDocument();
    expect(screen.getByText('New here: 40')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onDecide).toHaveBeenLastCalledWith({ status: 'removed' });

    fireEvent.click(screen.getByRole('button', { name: 'I did something similar' }));
    const box = screen.getByLabelText('Write what you actually did');
    fireEvent.change(box, { target: { value: 'Automated two weekly reports.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onDecide).toHaveBeenLastCalledWith({ status: 'edited', text: 'Automated two weekly reports.' }));
  });

  it('markdown marks of a resume line are not shown as text (QA: raw "**框架：**")', () => {
    const onDecide = vi.fn();
    renderWithProviders(<ul><ClaimCard claim={claim({ id: 'c7', text: '**框架：** pandas · PyTorch', original: '**Frameworks:** pandas' })} onDecide={onDecide} /></ul>);
    expect(screen.getByText('框架： pandas · PyTorch')).toBeInTheDocument();
    expect(screen.getByText('Your resume said: Frameworks: pandas')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('**');
  });

  it('a line the AI wrote in several places says the choice applies to each copy', () => {
    renderWithProviders(
      <ul>
        <ClaimCard
          claim={claim({ id: 'c3', text: 'Managed a team of 12 engineers.', copies: [{ section: 'Experience', original: null }, { section: 'Experience', original: null }] })}
          onDecide={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByTestId('claim-copies')).toHaveTextContent('This line appears 2 times. Your choice applies to each one.');
  });

  it('a removed detail has no actions', () => {
    renderWithProviders(
      <ul>
        <ClaimCard claim={claim({ id: 'c1', text: 'SQL, Tableau', status: 'removed' })} onDecide={vi.fn()} />
      </ul>,
    );
    expect(screen.getByText('Removed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yes, keep' })).toBeNull();
  });
});

describe('TailorLaunchHost', () => {
  it('renders nothing without ?tailor=', () => {
    const { container } = renderWithProviders(<TailorLaunchHost />);
    expect(container).toBeEmptyDOMElement();
  });

  it('re-opening a session on the hub skips the picker and uses the session base', async () => {
    nav.search = 'tailor=job_1&tailorSession=ts_1';
    api.getTailorSession.mockResolvedValue(sessionView({ baseVariantId: 'rv_other' }));
    renderWithProviders(<TailorLaunchHost />);
    expect(await screen.findByText('Verify details')).toBeInTheDocument();
    expect(screen.queryByText('Which resume should we start from?')).toBeNull();
    expect(api.getTailorSession).toHaveBeenCalledWith('ts_1', expect.anything());
  });

  it('?tailorSession=<id> alone (pasted posting, no job) re-opens the session', async () => {
    nav.search = 'tailorSession=ts_1';
    api.getTailorSession.mockResolvedValue(sessionView({ jobId: null }));
    renderWithProviders(<TailorLaunchHost />);
    expect(await screen.findByText('Verify details')).toBeInTheDocument();
    expect(screen.queryByText('Which resume should we start from?')).toBeNull();
  });

  it('?tailor=<jobId> on the hub: pick a base resume (main first, no tailored copies)', async () => {
    nav.search = 'tailor=job_1&from=job_card';
    renderWithProviders(<TailorLaunchHost />);
    expect(await screen.findByText('Which resume should we start from?')).toBeInTheDocument();
    const picks = screen.getAllByRole('button').filter((b) => /resume/i.test(b.textContent ?? '') && !/close/i.test(b.getAttribute('aria-label') ?? ''));
    expect(picks[0]).toHaveTextContent('Main resume');
    expect(screen.queryByText('Tailored')).toBeNull();
  });
});

describe('target step: which job is this for? (INT-10)', () => {
  const openSheet = (props: Partial<React.ComponentProps<typeof TailorSheet>> = {}) =>
    renderWithProviders(<TailorSheet open onClose={vi.fn()} resumeId="rv_1" {...props} />);

  it('with no job, the sheet asks for one before any setup or credit', async () => {
    openSheet();
    expect(await screen.findByText('Which job is this for?')).toBeInTheDocument();
    expect(screen.getByText('Your saved jobs')).toBeInTheDocument();
    expect(screen.getByText('Or paste the job post')).toBeInTheDocument();
    // The setup (and its credit line) is not on screen yet, and nothing was created.
    expect(screen.queryByText('What should change?')).toBeNull();
    expect(api.createTailorSession).not.toHaveBeenCalled();
    expect(gate.runs).toBe(0);
  });

  it('lists the user\'s saved jobs that have a posting, once each; hand-typed entries are not offered', async () => {
    openSheet();
    expect(await screen.findByRole('button', { name: /Data Analyst\s*Acme/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'BI Engineer' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Data Analyst/ })).toHaveLength(1);
    expect(screen.queryByText('Typed by hand')).toBeNull();
    expect(tracker.listTracker).toHaveBeenCalledWith({ limit: 30, sortBy: 'updated', sortDir: 'desc' }, expect.anything());
  });

  it('picking a saved job → the setup for that job; Generate sends its jobId', async () => {
    api.createTailorSession.mockResolvedValue(sessionView());
    api.getTailorSession.mockResolvedValue(sessionView());
    openSheet();
    fireEvent.click(await screen.findByRole('button', { name: /Data Analyst\s*Acme/ }));
    expect(await screen.findByText('What should change?')).toBeInTheDocument();
    expect(screen.getByTestId('tailor-target')).toHaveTextContent('Tailoring for: Data Analyst at Acme');
    // The sheet heading names the job, and the skill list is read for it.
    expect(screen.getByRole('heading', { name: 'Tailor your resume for Data Analyst' })).toBeInTheDocument();
    await waitFor(() => expect(api.getKeywordReport).toHaveBeenCalledWith('rv_1', { jobId: 'job_9' }, expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: 'Tailor my resume' }));
    await waitFor(() => expect(api.createTailorSession).toHaveBeenCalledTimes(1));
    const body = api.createTailorSession.mock.calls[0]![0];
    expect(body).toMatchObject({ baseVariantId: 'rv_1', jobId: 'job_9', mode: 'guided' });
    expect(body).not.toHaveProperty('jd');
    expect(gate.runs).toBe(1);
  });

  it('pasting a posting → Generate sends jd { title, company, text } and no jobId', async () => {
    api.getKeywordReport.mockResolvedValue({ ...KEYWORDS, skillGaps: ['Snowflake', 'dbt'], keywordSource: 'posting' });
    api.createTailorSession.mockResolvedValue(sessionView({ jobId: null }));
    api.getTailorSession.mockResolvedValue(sessionView({ jobId: null }));
    openSheet();
    const go = await screen.findByRole('button', { name: 'Continue' });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: '  Sales Analyst ' } });
    fireEvent.change(screen.getByLabelText('Company (optional)'), { target: { value: 'Globex' } });
    fireEvent.change(screen.getByLabelText('Text of the job post'), { target: { value: 'Too short.' } });
    expect(go).toBeDisabled();
    expect(screen.getByText('Paste at least 50 characters (10 so far).')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Text of the job post'), { target: { value: `  ${POSTING_TEXT}  ` } });
    expect(go).toBeEnabled();
    fireEvent.click(go);

    expect(await screen.findByText('What should change?')).toBeInTheDocument();
    expect(screen.getByTestId('tailor-target')).toHaveTextContent('Tailoring for: Sales Analyst at Globex');
    // A pasted posting gets the same skills step as a job: the skills are read from the pasted text
    // (QA: a pasted post naming Snowflake, dbt and Looker had no keyword step).
    await waitFor(() =>
      expect(api.getKeywordReport).toHaveBeenCalledWith('rv_1', { jd: { title: 'Sales Analyst', company: 'Globex', text: POSTING_TEXT } }, expect.anything()),
    );
    expect(screen.getByText('Skills this job asks for that your resume does not show')).toBeInTheDocument();
    // The server's list of skill gaps is offered as is (never the raw keyword rows).
    expect(await screen.findByRole('checkbox', { name: 'Snowflake' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'forecasting' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Snowflake' }));

    fireEvent.click(screen.getByRole('button', { name: 'Tailor my resume' }));
    await waitFor(() => expect(api.createTailorSession).toHaveBeenCalledTimes(1));
    const body = api.createTailorSession.mock.calls[0]![0];
    expect(body.keywords).toEqual(['Snowflake']);
    expect(body.jd).toEqual({ title: 'Sales Analyst', company: 'Globex', text: POSTING_TEXT });
    expect(body).not.toHaveProperty('jobId');
    expect(body.baseVariantId).toBe('rv_1');
  });

  it('the company is optional; the title and at least 50 characters of text are not', () => {
    expect(postingOf('Analyst', '', POSTING_TEXT)).toEqual({ title: 'Analyst', company: '', text: POSTING_TEXT });
    expect(postingOf('', 'Globex', POSTING_TEXT)).toBeNull();
    expect(postingOf('Analyst', 'Globex', 'x'.repeat(49))).toBeNull();
    expect(postingOf('Analyst', 'Globex', 'x'.repeat(50))).not.toBeNull();
    expect(postingOf('A'.repeat(201), '', POSTING_TEXT)).toBeNull();
  });

  it('"Change job" goes back to the target step before anything is generated', async () => {
    openSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'BI Engineer' }));
    expect(await screen.findByTestId('tailor-target')).toHaveTextContent('Tailoring for: BI Engineer');
    fireEvent.click(screen.getByRole('button', { name: 'Change job' }));
    expect(await screen.findByText('Which job is this for?')).toBeInTheDocument();
    expect(api.createTailorSession).not.toHaveBeenCalled();
  });

  it('no saved jobs: says so and still offers the paste form', async () => {
    tracker.listTracker.mockResolvedValue({ entries: [], statusCounts: {}, total: 0 });
    openSheet();
    expect(await screen.findByText('You have no saved jobs yet. Paste the job post below.')).toBeInTheDocument();
    expect(screen.getByLabelText('Text of the job post')).toBeInTheDocument();
  });

  it('saved jobs fail to load: the paste form still works and a retry is offered', async () => {
    tracker.listTracker.mockRejectedValue(new Error('offline'));
    openSheet();
    expect(await screen.findByText('Your saved jobs did not load. You can still paste the job post below.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('without a resume the base picker comes first, then the target step', async () => {
    renderWithProviders(<TailorSheet open onClose={vi.fn()} />);
    expect(await screen.findByText('Which resume should we start from?')).toBeInTheDocument();
    expect(screen.queryByText('Which job is this for?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Main resume/ }));
    expect(await screen.findByText('Which job is this for?')).toBeInTheDocument();
  });

  it('a job in the URL or a session to re-open never shows the target step', async () => {
    const withJob = openSheet({ jobId: 'job_1' });
    expect(await screen.findByText('What should change?')).toBeInTheDocument();
    expect(screen.queryByText('Which job is this for?')).toBeNull();
    expect(screen.queryByTestId('tailor-target')).toBeNull();
    withJob.unmount();
    api.getTailorSession.mockResolvedValue(sessionView({ jobId: null }));
    openSheet({ sessionId: 'ts_1' });
    expect(await screen.findByText('Verify details')).toBeInTheDocument();
    expect(screen.queryByText('Which job is this for?')).toBeNull();
    expect(tracker.listTracker).not.toHaveBeenCalled();
  });

  it('AI off: the target step can be answered, then one plain line; no session, no credit', async () => {
    api.getLatestGrade.mockResolvedValue(latest(false));
    openSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'BI Engineer' }));
    expect(await screen.findByTestId('tailor-ai-off')).toBeInTheDocument();
    expect(api.createTailorSession).not.toHaveBeenCalled();
    expect(gate.runs).toBe(0);
  });

  it('TailorTarget reports the choice to its caller', async () => {
    const onPick = vi.fn();
    renderWithProviders(<TailorTarget onPick={onPick} />);
    fireEvent.click(await screen.findByRole('button', { name: /Data Analyst\s*Acme/ }));
    expect(onPick).toHaveBeenCalledWith({ kind: 'job', jobId: 'job_9', title: 'Data Analyst', company: 'Acme' });
  });

  it('targetJobsOf keeps only entries with a job, once per job, a blank company as null', () => {
    expect(targetJobsOf(TRACKED as never)).toEqual([
      { jobId: 'job_9', title: 'Data Analyst', company: 'Acme' },
      { jobId: 'job_7', title: 'BI Engineer', company: null },
    ]);
  });

  it('target step copy renders from the bundles (no dotted paths, no banned shorthand)', async () => {
    const onIntlError = vi.fn();
    renderWithProviders(<TailorSheet open onClose={vi.fn()} resumeId="rv_1" />, { onIntlError });
    await screen.findByText('Which job is this for?');
    const real = onIntlError.mock.calls.filter(([e]) => !String((e as Error)?.message ?? e).includes('ENVIRONMENT_FALLBACK'));
    expect(real).toEqual([]);
    expect(document.body.textContent).not.toMatch(/tailor\.[a-z]+\.[a-zA-Z.]+/);
    expect(document.body.textContent).not.toMatch(/\bJD\b|\bATS\b/);
  });
});

describe('helpers', () => {
  it('tailorErrorKind', () => {
    const err = (code: string, details?: unknown) => new RoboApiError('x', { payload: { code, details } });
    expect(tailorErrorKind(err('unverified_claims'))).toBe('unverified_claims');
    expect(tailorErrorKind(err('ai_unavailable', { reason: 'ai_failed' }))).toBe('ai_failed');
    expect(tailorErrorKind(err('ai_unavailable', { reason: 'content_safety_unavailable' }))).toBe('safety_unavailable');
    expect(tailorErrorKind(err('conflict', { reason: 'request_in_progress' }))).toBe('in_progress');
    expect(tailorErrorKind(err('conflict', { reason: 'tailor_session_not_reviewable' }))).toBe('not_reviewable');
    expect(tailorErrorKind(new Error('x'))).toBe('failed');
  });

  it('prefs survive a storage that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readTailorPrefs()).toBeNull();
    spy.mockRestore();
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeTailorPrefs({ sections: ['skills'], experienceDepth: 'quick', runs: 1 })).not.toThrow();
    set.mockRestore();
  });
});

describe('copy', () => {
  it('every rendered key exists in the bundles (no dotted paths)', async () => {
    const onIntlError = vi.fn();
    const reasons = ['new_number', 'new_keyword', 'new_statement', 'posting_text'] as const;
    const claims = reasons.map((r, i) =>
      claim({
        id: `c${i}`,
        text: `Line ${i}`,
        reasons: [r],
        status: (['pending', 'kept', 'edited', 'removed'] as const)[i],
        original: i === 0 ? 'Was' : null,
        ...(i === 0 ? { copies: [{ original: 'Was' }, { original: null }] } : {}),
      }),
    );
    writeTailorPrefs({ sections: ['skills', 'experience'], experienceDepth: 'full', runs: 1 });
    renderWithProviders(
      <>
        <TailorFlow resumeId="rv_1" jobId="job_1" />
        <TailorResult session={sessionView({ claims, changes: [{ section: 'S', before: 'a', after: '', kind: 'remove' }], fit: { before: { value: 61, source: 'ai', asOf: NOW, method: 'fit_score' }, after: null } })} />
        <TailorResult session={sessionView({ status: 'finalized', claims: [], pendingClaims: 0, fit: { before: null, after: null } })} onOpenResume={vi.fn()} onClose={vi.fn()} />
      </>,
      { onIntlError },
    );
    await screen.findByRole('checkbox', { name: 'Tableau' });
    fireEvent.click(screen.getAllByRole('tab', { name: 'Compare' })[0]!);
    const real = onIntlError.mock.calls.filter(([e]) => !String((e as Error)?.message ?? e).includes('ENVIRONMENT_FALLBACK'));
    expect(real).toEqual([]);
    expect(document.body.textContent).not.toMatch(/tailor\.[a-z]+\.[a-zA-Z.]+/);
  });
});
