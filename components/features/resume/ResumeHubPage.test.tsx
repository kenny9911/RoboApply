// /resume hub page (WP-36b, AI first): base resumes vs tailored versions, the
// 5-slot limit, primary first, no LinkedIn door on GoApply, the first-visit
// start panel, AI tailoring only when AI may run (R-04), "Up next", a file
// dropped on the page opening the upload with it, and a refused delete.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import { renderWithProviders } from '../../../__tests__/utils/renderWithProviders';
import type { LatestGradeResponse } from '../../../lib/api/contracts/resume';
import type { ResumeSummary } from '../../../lib/api/resumes';
import { RoboApiError } from '../../../lib/api/client';

const state = vi.hoisted(() => ({
  resumes: [] as unknown[],
  market: 'intl' as 'intl' | 'cn',
  setPrimary: vi.fn(),
  flags: {} as Record<string, boolean>,
  checks: {} as Record<string, unknown>,
  targets: [] as Array<{ jobId: string; title: string; company: string | null }>,
  ask: vi.fn(),
  deleteResume: vi.fn(),
}));

// The hub mounts TailorLaunchHost (Wave 3 gate), which reads the query string.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/resume',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../../../lib/brand', () => ({ useBrand: () => ({ id: state.market === 'cn' ? 'goapply' : 'roboapply', market: state.market }) }));
vi.mock('../../../lib/flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/flags')>()),
  useFlag: (key: string) => state.flags[key] === true,
}));
vi.mock('../../../hooks/useResumes', () => {
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useResumeList: () => ({ data: { resumes: state.resumes }, isLoading: false, isError: false, refetch: vi.fn() }),
    useResume: () => ({ data: undefined, isLoading: true, isError: false }),
    useCreateResumeMutation: mut,
    useUploadResumeMutation: mut,
    useImportLinkedInMutation: mut,
    useDeleteResumeMutation: () => ({ mutate: vi.fn(), mutateAsync: state.deleteResume, isPending: false }),
    useSetPrimaryResumeMutation: () => ({ mutate: state.setPrimary, isPending: false }),
  };
});
vi.mock('../../../hooks/resume/useResumeCheck', () => ({
  useLatestResumeCheck: (id: string | null | undefined) =>
    id && state.checks[id] ? { data: state.checks[id], isLoading: false, isError: false } : { data: undefined, isLoading: false, isError: true },
}));
vi.mock('../../../hooks/resume/useResumeBuilder', () => ({ useBuilderConfig: () => ({ data: { aiAvailable: true } }) }));
vi.mock('../../../hooks/tailor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/tailor')>()),
  useTailorTargets: (enabled = true) => ({ data: enabled ? state.targets : undefined, isLoading: false }),
}));
vi.mock('../../../hooks/shared/useOpenAssistant', () => ({ useOpenAssistant: () => state.ask }));
// The tailor flow itself is WP-36a's; here only who starts it, and with what.
vi.mock('../tailor', () => ({
  TailorLaunchHost: () => null,
  TailorSheet: ({ resumeId, jobId }: { resumeId: string | null; jobId: string | null }) => (
    <div data-testid="tailor-sheet" data-resume={resumeId ?? ''} data-job={jobId ?? ''} />
  ),
}));

import ResumesPage from '../../../app/(auth)/resume/page';

const row = (over: Partial<ResumeSummary>): ResumeSummary => ({
  id: 'r',
  name: 'Resume',
  kind: 'base',
  targetJobId: null,
  targetJobTitle: null,
  targetJobCompany: null,
  matchScoreCached: null,
  isPrimary: false,
  sourceKind: 'upload',
  lastEditedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const latest = (over: Partial<LatestGradeResponse> = {}): LatestGradeResponse => ({ grade: null, previous: null, stale: false, aiAvailable: true, ...over });

beforeEach(() => {
  state.market = 'intl';
  state.setPrimary.mockReset();
  state.ask.mockReset();
  state.deleteResume.mockReset();
  state.deleteResume.mockResolvedValue(undefined);
  state.flags = {};
  state.checks = {};
  state.targets = [];
  state.resumes = [
    row({ id: 'b1', name: 'Older base', lastEditedAt: '2026-10-03T00:00:00.000Z' }),
    row({ id: 'b2', name: 'Primary base', isPrimary: true, targetTitle: 'Analyst' }),
    row({ id: 't1', name: 'For Acme', kind: 'tailored_for_jd', targetJobId: 'j1', targetJobCompany: 'Acme', targetJobTitle: 'Engineer', basedOnVariantId: 'b2' }),
  ];
});

const cardTitles = () => screen.getAllByRole('article').map((a) => within(a).getByRole('heading', { level: 3 }).textContent);

describe('/resume hub', () => {
  it('shows tabs, counts only base resumes, puts the primary first and lists tailored versions per job', () => {
    renderWithProviders(<ResumesPage />);
    expect(screen.getByRole('link', { name: 'Cover letters' })).toHaveAttribute('href', '/resume/letters');
    expect(screen.getByText('2 of 5 resumes')).toBeInTheDocument();
    expect(cardTitles()).toEqual(['Primary base', 'Older base']);
    expect(screen.getByText('Aimed at Analyst')).toBeInTheDocument();
    // The primary card counts the version made from it.
    expect(screen.getByText('1 version for a specific job')).toBeInTheDocument();
    const tailored = screen.getByRole('region', { name: 'Versions for specific jobs' });
    expect(within(tailored).getByRole('link', { name: 'For Acme' })).toBeInTheDocument();
    expect(within(tailored).getByText(/From Primary base/)).toBeInTheDocument();
  });

  it('makes another resume primary', () => {
    renderWithProviders(<ResumesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Make Older base your primary resume' }));
    expect(state.setPrimary).toHaveBeenCalledWith('b1');
  });

  it('with 5 base resumes, the new-resume tile explains the limit and its ways are disabled', () => {
    state.resumes = Array.from({ length: 5 }, (_, i) => row({ id: `b${i}`, name: `Base ${i}` }));
    renderWithProviders(<ResumesPage />);
    expect(screen.getByText(/All slots used/)).toBeInTheDocument();
    expect(screen.getByText(/You can keep up to 5 resumes\. Delete one to add another\./)).toBeInTheDocument();
    const upload = screen.getByRole('button', { name: /Upload a file/ });
    expect(upload).toBeDisabled();
    fireEvent.click(upload);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers the LinkedIn PDF way on RoboApply only', () => {
    const { unmount } = renderWithProviders(<ResumesPage />);
    expect(screen.getByRole('button', { name: /LinkedIn PDF/ })).toBeInTheDocument();
    unmount();
    state.market = 'cn';
    renderWithProviders(<ResumesPage />);
    expect(screen.queryByRole('button', { name: /LinkedIn PDF/ })).toBeNull();
  });

  it('first visit: no library yet, a start panel with upload, the guided builder and a template', () => {
    state.resumes = [];
    renderWithProviders(<ResumesPage />);
    expect(screen.getByRole('heading', { name: 'Start with the resume you have' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload your resume/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Guided builder/ })).toHaveAttribute('href', '/resume/new');
    // The builder says its AI writing help is on.
    expect(screen.getByText('AI writing help')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Your resumes' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Versions for specific jobs' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Start from a template/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('a resume file dropped on the new-resume tile opens the upload with that file', () => {
    renderWithProviders(<ResumesPage />);
    const tile = screen.getByRole('region', { name: 'New resume' });
    const file = new File(['%PDF-1.4'], 'my-resume.pdf', { type: 'application/pdf' });
    const dataTransfer = { files: [file], types: ['Files'], dropEffect: 'none' };
    fireEvent.dragEnter(tile, { dataTransfer });
    fireEvent.drop(tile, { dataTransfer });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('my-resume.pdf')).toBeInTheDocument();
  });

  it('says why a delete was refused and keeps the dialog open', async () => {
    // RAResumeService.delete: the only base resume while saved jobs exist → 409 in_use.
    state.deleteResume.mockRejectedValueOnce(new RoboApiError('Resume still in use', { status: 409, payload: { error: 'in_use', code: 'has_dependents' } }));
    renderWithProviders(<ResumesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Older base' }));
    fireEvent.change(screen.getByLabelText('Type the resume name to confirm'), { target: { value: 'Older base' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete resume' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("You can't delete your only resume while you have saved jobs.");
    expect(state.deleteResume).toHaveBeenCalledWith('b1');
    expect(screen.getByRole('button', { name: 'Delete resume' })).toBeInTheDocument();
  });

  describe('AI tailoring (R-04: no entry unless AI may run)', () => {
    it('is absent without the ai.text flag, and absent without the user\'s consent', () => {
      state.checks = { b2: latest({ aiAvailable: true }) };
      const { unmount } = renderWithProviders(<ResumesPage />);
      expect(screen.queryByRole('region', { name: 'Make a version for the next job you want' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Tailor Primary base for a job' })).toBeNull();
      unmount();
      state.flags = { 'ai.text': true };
      state.checks = { b2: latest({ aiAvailable: false }) };
      renderWithProviders(<ResumesPage />);
      expect(screen.queryByRole('region', { name: 'Make a version for the next job you want' })).toBeNull();
    });

    it('offers saved jobs without a tailored version, and starts tailoring the main resume for one', () => {
      state.flags = { 'ai.text': true };
      state.checks = { b2: latest() };
      state.targets = [
        { jobId: 'j1', title: 'Engineer', company: 'Acme' },
        { jobId: 'j2', title: 'Analyst', company: 'Globex' },
      ];
      renderWithProviders(<ResumesPage />);
      const panel = screen.getByRole('region', { name: 'Make a version for the next job you want' });
      // j1 already has a tailored version ("For Acme"): only Globex is offered.
      expect(within(panel).queryByRole('button', { name: 'Tailor a version for Engineer at Acme' })).toBeNull();
      fireEvent.click(within(panel).getByRole('button', { name: 'Tailor a version for Analyst at Globex' }));
      const sheet = screen.getByTestId('tailor-sheet');
      expect(sheet).toHaveAttribute('data-resume', 'b2');
      expect(sheet).toHaveAttribute('data-job', 'j2');
    });

    it('a card tailors its own resume, picking the job in the flow', () => {
      state.flags = { 'ai.text': true };
      state.checks = { b2: latest() };
      renderWithProviders(<ResumesPage />);
      fireEvent.click(screen.getByRole('button', { name: 'Tailor Older base for a job' }));
      const sheet = screen.getByTestId('tailor-sheet');
      expect(sheet).toHaveAttribute('data-resume', 'b1');
      expect(sheet).toHaveAttribute('data-job', '');
    });

    it('puts an Assistant question in its box, scoped to the main resume, when the Assistant is on', () => {
      state.flags = { 'ai.text': true, copilot: true };
      state.checks = { b2: latest() };
      renderWithProviders(<ResumesPage />);
      fireEvent.click(screen.getByRole('button', { name: 'What should I fix first in my resume?' }));
      expect(state.ask).toHaveBeenCalledWith({ source: 'resume', resumeId: 'b2', scope: 'resume', prompt: 'What should I fix first in my resume?' });
    });
  });

  describe('Up next', () => {
    it('lists details to verify first, then the main resume\'s check', () => {
      state.resumes = [...state.resumes, row({ id: 't2', name: 'For Globex', kind: 'tailored_for_jd', targetJobId: 'j2', unverifiedClaims: 3, tailorSessionId: 'ts_9' })];
      state.checks = { b2: latest() };
      renderWithProviders(<ResumesPage />);
      const next = screen.getByRole('region', { name: 'Up next' });
      const links = within(next).getAllByRole('link');
      expect(links[0]).toHaveTextContent('3 details to check');
      expect(links[0]).toHaveAttribute('href', '/resume?tailorSession=ts_9');
      expect(links[1]).toHaveTextContent('Check your main resume');
      expect(links[1]).toHaveAttribute('href', '/resume/b2/check');
    });

    it('names issues to fix first from the last check, with the checklist score on the card', () => {
      state.checks = {
        b2: latest({
          grade: {
            id: 'g',
            resumeVariantId: 'b2',
            status: 'done',
            label: 'fair',
            score: 61,
            counts: { urgent: 2, critical: 1, optional: 4 },
            issues: [],
            profile: 'intl',
            method: 'rules',
            aiSkipped: null,
            rulesChecked: 24,
            targetTitle: null,
            contentHash: 'h',
            createdAt: '2026-10-02T00:00:00.000Z',
            completedAt: '2026-10-02T00:00:30.000Z',
          },
        }),
      };
      renderWithProviders(<ResumesPage />);
      expect(within(screen.getByRole('region', { name: 'Up next' })).getByText('2 issues to fix first')).toBeInTheDocument();
      const card = screen.getAllByRole('article')[0]!;
      expect(within(card).getByText('Fair')).toBeInTheDocument();
      expect(within(card).getByText('61 of 100 on the checklist')).toBeInTheDocument();
      expect(within(card).getByText('Fix first')).toBeInTheDocument();
    });
  });
});
