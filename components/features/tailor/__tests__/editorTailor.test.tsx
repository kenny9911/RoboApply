// INT-10 (wave3 WP-93 #3): the resume editor's Tailor button opens the
// tailor-session sheet for this resume (no job yet → the sheet's target step),
// not the retired TailorModal. The page is real; its data hooks and the sheet
// are stand-ins so the test reads what the page mounts and with which props.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';

import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => '/resume/rv_1',
  useSearchParams: () => new URLSearchParams(''),
}));

const state = vi.hoisted(() => ({ aiAvailable: true }));
vi.mock('../../../../hooks/useResumes', () => {
  const RESUME = {
    id: 'rv_1',
    name: 'Main resume',
    kind: 'base',
    resumeMarkdown: '# Sam Lee\n\nsam@example.test\n\n## Summary\n\nAnalyst.\n\n## Experience\n\n**Acme** — Analyst · 2021 – Present\n- Built weekly sales reports in SQL.\n\n## Skills\n\nSQL\n',
    layout: null,
    unverifiedClaims: 0,
    aiAssisted: false,
    defaultPage: 'letter',
  };
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => RESUME), isPending: false });
  return {
    resumeKeys: { all: ['v2', 'resumes'] },
    useResume: () => ({ data: RESUME, isLoading: false, isError: false }),
    useResumeList: () => ({ data: { resumes: [] }, isLoading: false, isError: false }),
    usePatchResumeMutation: mutation,
    useResumeRewrite: mutation,
    useResumeCoachTips: () => ({ data: { tips: [] } }),
    useDeleteResumeMutation: mutation,
    usePatchResumeLayoutMutation: mutation,
  };
});
vi.mock('../../../../hooks/resume/useResumeCheck', () => ({
  useLatestResumeCheck: () => ({ data: { grade: null, previous: null, stale: false, aiAvailable: state.aiAvailable }, isLoading: false }),
}));
vi.mock('../../../../hooks/resume/useResumeBuilder', () => ({ useBuilderConfig: () => ({ data: undefined }) }));
vi.mock('../../../../hooks/resume/useResumePhoto', () => ({ useResumePhoto: () => ({ photo: null, set: vi.fn(), clear: vi.fn(), error: null }) }));

// The parts of the resume area the editor shows around the toolbar are not under test here.
vi.mock('../../resume', async () => {
  const layout = await vi.importActual<typeof import('../../resume/layout')>('../../resume/layout');
  const Nothing = () => null;
  return {
    AskAssistantButton: Nothing,
    FitToPageControl: Nothing,
    LayoutPanel: Nothing,
    ResumeDetailsPanel: Nothing,
    SectionOrderPanel: Nothing,
    ResumeCheckEntry: Nothing,
    docLanguageOf: () => 'en',
    personalLineFor: () => null,
    layoutPatch: layout.layoutPatch,
    resolveLayout: layout.resolveLayout,
  };
});

interface SheetProps {
  open: boolean;
  resumeId?: string | null;
  jobId?: string | null;
  sessionId?: string | null;
  onClose: () => void;
  onOpenResume?: (id: string) => void;
}
const sheet = vi.hoisted(() => ({ props: [] as unknown[] }));
vi.mock('..', () => ({
  TailorLaunchHost: () => null,
  TailorSheet: (props: SheetProps) => {
    sheet.props.push(props);
    return (
      <div data-testid="tailor-sheet" data-open={String(props.open)} data-resume={String(props.resumeId)} data-job={String(props.jobId ?? null)} data-session={String(props.sessionId ?? null)}>
        <button type="button" onClick={props.onClose}>
          close sheet
        </button>
        <button type="button" onClick={() => props.onOpenResume?.('rv_t9')}>
          open tailored
        </button>
      </div>
    );
  },
}));

import ResumeEditorPage from '../../../../app/(auth)/resume/[id]/page';
import * as editorParts from '../../../v3/resume-editor';

async function renderEditor() {
  const params = Promise.resolve({ id: 'rv_1' });
  await act(async () => {
    renderWithProviders(<ResumeEditorPage params={params} />);
    await params;
  });
  return screen.findByRole('button', { name: 'Download' });
}

beforeEach(() => {
  nav.push.mockReset();
  sheet.props = [];
  state.aiAvailable = true;
});

describe('resume editor → Tailor', () => {
  it('the toolbar Tailor button opens the tailor sheet for this resume, with no job chosen yet', async () => {
    await renderEditor();
    expect(screen.queryByTestId('tailor-sheet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Tailor/ }));
    const el = await screen.findByTestId('tailor-sheet');
    // This resume is the base; no job and no session → the sheet starts at "Which job is this for?".
    expect(el).toHaveAttribute('data-open', 'true');
    expect(el).toHaveAttribute('data-resume', 'rv_1');
    expect(el).toHaveAttribute('data-job', 'null');
    expect(el).toHaveAttribute('data-session', 'null');
  });

  it('closing the sheet removes it; reopening starts it fresh', async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Tailor/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'close sheet' }));
    expect(screen.queryByTestId('tailor-sheet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Tailor/ }));
    expect(await screen.findByTestId('tailor-sheet')).toBeInTheDocument();
  });

  it('"Open this resume" goes to the tailored version and closes the sheet', async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Tailor/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'open tailored' }));
    expect(nav.push).toHaveBeenCalledWith('/resume/rv_t9');
    expect(screen.queryByTestId('tailor-sheet')).toBeNull();
  });

  it('with AI off for the user there is no Tailor button (no entry, no sheet)', async () => {
    state.aiAvailable = false;
    await renderEditor();
    expect(screen.queryByRole('button', { name: /Tailor/ })).toBeNull();
    expect(screen.queryByTestId('tailor-sheet')).toBeNull();
  });

  it('TailorModal is gone from the editor components', () => {
    expect(Object.keys(editorParts)).not.toContain('TailorModal');
    expect(Object.keys(editorParts)).toContain('DownloadModal');
  });
});
