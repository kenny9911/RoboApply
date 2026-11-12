// The resume editor's tabs (resume.io's editor layout): Edit · Customize ·
// Review · Tailor (New) over the left pane, the preview beside every tab, the
// open tab in `?tab=` (router.replace, no scroll). The page is real; its data
// hooks and the Tailor sheet are stand-ins, so the test reads what each tab
// shows and what the page asks the router and the sheet to do. Renders
// through the real en.json; a missing key fails the test.

import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import { capsFor } from '../../../../__tests__/shell/helpers';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import type { GradeIssue, GradeView, LatestGradeResponse } from '../../../../lib/api/contracts/resume';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/resume/rv_1',
  useSearchParams: () => nav.params,
}));

const state = vi.hoisted(() => ({
  latest: null as unknown,
  latestLoading: false,
  running: false,
  error: null as string | null,
  creditsLeft: 3 as number | null,
  run: vi.fn(),
  cancel: vi.fn(),
  tailor: true,
  targets: [] as Array<{ jobId: string; title: string; company: string | null }>,
  resumes: [] as unknown[],
  builder: undefined as unknown,
  layoutMutate: vi.fn(),
}));

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
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => RESUME), isPending: false, isError: false });
  return {
    resumeKeys: { all: ['v2', 'resumes'] },
    useResume: () => ({ data: RESUME, isLoading: false, isError: false }),
    useResumeList: () => ({ data: { resumes: state.resumes }, isLoading: false, isError: false }),
    usePatchResumeMutation: mutation,
    useResumeRewrite: mutation,
    useResumeCoachTips: () => ({ data: { tips: [] } }),
    useDeleteResumeMutation: mutation,
    usePatchResumeLayoutMutation: () => ({ mutate: state.layoutMutate, isPending: false, isError: false }),
  };
});
vi.mock('../../../../hooks/resume/useResumeCheck', () => ({
  useLatestResumeCheck: () => ({ data: state.latest, isLoading: state.latestLoading, isError: false }),
  useResumeCheck: () => ({
    latest: { data: state.latest, isLoading: state.latestLoading, isError: false, refetch: vi.fn() },
    running: state.running,
    error: state.error,
    run: state.run,
    cancel: state.cancel,
    creditsLeft: state.creditsLeft,
  }),
}));
vi.mock('../../../../hooks/resume/useResumeBuilder', () => ({ useBuilderConfig: () => ({ data: state.builder }) }));
vi.mock('../../../../hooks/resume/useResumePhoto', () => ({ useResumePhoto: () => ({ photo: null, save: vi.fn(), remove: vi.fn() }) }));
vi.mock('../../../../hooks/tailor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../hooks/tailor')>()),
  useTailorAvailability: () => ({ available: state.tailor, loading: false, capability: true }),
  useTailorTargets: () => ({ data: state.targets, isLoading: false, isError: false }),
}));

interface SheetProps {
  open: boolean;
  resumeId?: string | null;
  jobId?: string | null;
  jobTitle?: string | null;
  onClose: () => void;
}
const tailor = vi.hoisted(() => ({ sheets: [] as unknown[], hosts: [] as unknown[] }));
vi.mock('../../tailor', () => ({
  TailorLaunchHost: (props: { resumeId?: string | null }) => {
    tailor.hosts.push(props);
    return null;
  },
  TailorSheet: (props: SheetProps) => {
    tailor.sheets.push(props);
    return (
      <div data-testid="tailor-sheet" data-resume={String(props.resumeId)} data-job={String(props.jobId ?? null)} data-title={String(props.jobTitle ?? null)}>
        <button type="button" onClick={props.onClose}>
          close sheet
        </button>
      </div>
    );
  },
}));

import ResumeEditorPage from '../../../../app/(auth)/resume/[id]/page';

const issue = (over: Partial<GradeIssue> & Pick<GradeIssue, 'id' | 'type'>): GradeIssue => ({
  severity: 'critical',
  section: 'experience',
  anchor: 'section-experience',
  why: 'English why',
  how: 'English how',
  ...over,
});

const GRADE: GradeView = {
  id: 'g1',
  resumeVariantId: 'rv_1',
  status: 'done',
  label: 'good',
  score: 72,
  counts: { urgent: 1, critical: 1, optional: 1 },
  issues: [
    issue({ id: 'i1', type: 'no_numbers', severity: 'critical', evidence: 'Built weekly sales reports in SQL.', params: { withNumbers: 0, total: 1 } }),
    issue({ id: 'i2', type: 'summary_too_short', severity: 'urgent', section: 'summary', anchor: 'section-summary' }),
    issue({ id: 'i3', type: 'layout_columns', severity: 'optional', section: 'layout', anchor: null, params: { template: 'two_column' } }),
  ],
  profile: 'intl',
  method: 'rules_ai',
  aiSkipped: null,
  rulesChecked: 24,
  targetTitle: 'Data analyst',
  contentHash: 'h1',
  createdAt: '2026-11-01T10:00:00.000Z',
  completedAt: '2026-11-01T10:00:30.000Z',
};
const latest = (over: Partial<LatestGradeResponse> = {}): LatestGradeResponse => ({ grade: GRADE, previous: null, stale: false, aiAvailable: true, ...over });

const scrolled: Element[] = [];
const originalScroll = Element.prototype.scrollIntoView;

beforeEach(() => {
  nav.push.mockReset();
  nav.replace.mockReset();
  nav.params = new URLSearchParams();
  state.latest = latest();
  state.latestLoading = false;
  state.running = false;
  state.error = null;
  state.creditsLeft = 3;
  state.run.mockReset();
  state.cancel.mockReset();
  state.tailor = true;
  state.targets = [
    { jobId: 'job_1', title: 'Data analyst', company: 'Acme' },
    { jobId: 'job_2', title: 'BI developer', company: 'Beta' },
  ];
  state.resumes = [
    { id: 'rv_1', name: 'Main resume', kind: 'base', isPrimary: true, targetJobId: null, lastEditedAt: '2026-11-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z' },
    // job_2 already has a tailored version: it is not offered again.
    { id: 'rv_t2', name: 'For Beta', kind: 'tailored_for_jd', targetJobId: 'job_2', basedOnVariantId: 'rv_1', lastEditedAt: '2026-11-02T00:00:00.000Z', createdAt: '2026-11-02T00:00:00.000Z' },
  ];
  state.builder = undefined;
  state.layoutMutate.mockReset();
  tailor.sheets = [];
  tailor.hosts = [];
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this);
  };
  window.history.replaceState(null, '', '/resume/rv_1');
});

afterEach(() => {
  // jsdom has no scrollIntoView: put back exactly what was there.
  if (originalScroll) Element.prototype.scrollIntoView = originalScroll;
  else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

async function renderEditor() {
  const errors: unknown[] = [];
  const params = Promise.resolve({ id: 'rv_1' });
  const ui = (): ReactElement => (
    <BrandProvider brand={clientBrandFor('roboapply')} initialCapabilities={capsFor('roboapply', {})}>
      <ResumeEditorPage params={params} />
    </BrandProvider>
  );
  let result!: ReturnType<typeof renderWithProviders>;
  await act(async () => {
    result = renderWithProviders(ui(), { onIntlError: (e) => errors.push(e) });
    await params;
  });
  await screen.findByRole('tablist', { name: 'Resume editor' });
  return { ...result, errors, rerenderPage: () => result.rerender(ui()) };
}

/** Message errors (a missing key, a bad argument). The test provider sets no time zone, which next-intl reports too. */
const messageErrors = (errors: unknown[]) => errors.filter((e) => (e as { code?: string }).code !== 'ENVIRONMENT_FALLBACK');

const tabNamed = (name: string | RegExp) => within(screen.getByRole('tablist', { name: 'Resume editor' })).getByRole('tab', { name });

describe('resume editor tabs', () => {
  it('opens on Edit with the strip Edit · Customize · Review · Tailor, Tailor tagged New, the preview beside it', async () => {
    const { errors } = await renderEditor();
    const tabs = within(screen.getByRole('tablist', { name: 'Resume editor' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Edit', 'Customize', 'Review', 'Tailor New']);
    expect(tabNamed('Edit')).toHaveAttribute('aria-selected', 'true');
    expect(within(tabNamed(/Tailor/)).getByText('New')).toHaveClass('tag');

    // The form shows; nothing of another tab is mounted, and nothing is written to the URL.
    const edit = screen.getByRole('tabpanel', { name: 'Edit' });
    expect(within(edit).getByText('You')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Template and layout' })).toBeNull();
    expect(screen.queryByText('Checked for the role: Data analyst')).toBeNull();
    expect(screen.getByText('Live preview')).toBeVisible();
    expect(nav.replace).not.toHaveBeenCalled();
    // The tailor links (`?tailor=` / `?tailorSession=`) still run here.
    expect(tailor.hosts).toContainEqual({ resumeId: 'rv_1' });
    expect(messageErrors(errors)).toEqual([]);
  });

  it('a tab click switches the left pane at once and writes `?tab=` with replace and no scroll; Edit clears it', async () => {
    await renderEditor();
    fireEvent.click(tabNamed('Customize'));
    expect(nav.replace).toHaveBeenLastCalledWith('/resume/rv_1?tab=customize', { scroll: false });
    expect(tabNamed('Customize')).toHaveAttribute('aria-selected', 'true');
    const customize = screen.getByRole('tabpanel', { name: 'Customize' });
    expect(within(customize).getByRole('heading', { name: 'Template and layout' })).toBeInTheDocument();
    expect(within(customize).getByRole('heading', { name: 'Section order' })).toBeInTheDocument();
    // The form is hidden, not thrown away; the preview stays beside the tab.
    expect(screen.queryByRole('tabpanel', { name: 'Edit' })).toBeNull();
    expect(document.getElementById('identity')).not.toBeVisible();
    expect(screen.getByText('Live preview')).toBeVisible();

    fireEvent.click(tabNamed('Edit'));
    expect(nav.replace).toHaveBeenLastCalledWith('/resume/rv_1', { scroll: false });
    expect(document.getElementById('identity')).toBeVisible();
    // The open tab again changes nothing.
    nav.replace.mockClear();
    fireEvent.click(tabNamed('Edit'));
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('keeps the other query parameters when the tab changes', async () => {
    nav.params = new URLSearchParams('from=dashboard');
    await renderEditor();
    fireEvent.click(tabNamed('Review'));
    expect(nav.replace).toHaveBeenLastCalledWith('/resume/rv_1?from=dashboard&tab=review', { scroll: false });
  });

  it('a link opens a tab, and when the URL moves (Back) the tab follows it', async () => {
    nav.params = new URLSearchParams('tab=review');
    const { rerenderPage } = await renderEditor();
    expect(tabNamed('Review')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Review' })).toBeVisible();

    nav.params = new URLSearchParams('tab=customize');
    act(() => rerenderPage());
    expect(tabNamed('Customize')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Template and layout' })).toBeInTheDocument();

    nav.params = new URLSearchParams();
    act(() => rerenderPage());
    expect(tabNamed('Edit')).toHaveAttribute('aria-selected', 'true');
    // Following the URL never writes it back.
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('Customize: a layout change saves through the layout call, as before', async () => {
    nav.params = new URLSearchParams('tab=customize');
    await renderEditor();
    const customize = screen.getByRole('tabpanel', { name: 'Customize' });
    fireEvent.click(within(customize).getByRole('radio', { name: /^Compact/ }));
    expect(state.layoutMutate).toHaveBeenCalledWith({ template: 'compact' });
    // Photo and personal details are GoApply's; RoboApply has none.
    expect(within(customize).queryByRole('heading', { name: 'Photo and personal details' })).toBeNull();
  });

  it('Customize shows the photo and personal details where the brand offers them (GoApply)', async () => {
    state.builder = { personalFields: ['nativePlace', 'politicalStatus'], photo: { offered: true }, maxPages: 2 };
    nav.params = new URLSearchParams('tab=customize');
    await renderEditor();
    const customize = screen.getByRole('tabpanel', { name: 'Customize' });
    expect(within(customize).getByRole('heading', { name: 'Photo and personal details' })).toBeInTheDocument();
  });

  it('Review: the latest check in short — rating, score, counts, how it was checked, issues by section — and a link to the full check', async () => {
    nav.params = new URLSearchParams('tab=review');
    const { errors } = await renderEditor();
    const review = screen.getByRole('tabpanel', { name: 'Review' });
    expect(within(review).getByRole('heading', { level: 2, name: 'Good' })).toBeInTheDocument();
    expect(within(review).getByText('72 of 100 on the checklist')).toBeInTheDocument();
    const counts = within(review).getByRole('list', { name: 'Issues by priority' });
    expect(within(counts).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['1Fix first', '1Important', '1Nice to have']);
    expect(within(review).getByText('Checked against 24 rules, plus an AI read for spelling and a vague summary.')).toBeInTheDocument();
    expect(within(review).getByText('Checked for the role: Data analyst')).toBeInTheDocument();
    expect(within(review).getByText(/It does not predict whether you will hear back/)).toBeInTheDocument();
    expect(within(review).getByRole('link', { name: 'Open the full check' })).toHaveAttribute('href', '/resume/rv_1/check');

    // Grouped as the check page groups them: section order, most pressing first.
    expect(within(review).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Layout', 'Summary', 'Experience']);
    expect(within(review).getByText('Very short summary')).toBeInTheDocument();
    expect(within(review).getByText('Few results with numbers (0 of 1 bullets)')).toBeInTheDocument();
    expect(within(review).getByText('Built weekly sales reports in SQL.')).toBeInTheDocument();
    // Only what the check returned (D3): it has no strengths list, so none is shown.
    expect(review.textContent).not.toMatch(/strength/i);
    expect(messageErrors(errors)).toEqual([]);
  });

  it('Review: says there is nothing to fix only when the counts agree, never over counted issues it was not sent', async () => {
    nav.params = new URLSearchParams('tab=review');
    state.latest = latest({ grade: { ...GRADE, issues: [] } });
    const first = await renderEditor();
    const review = screen.getByRole('tabpanel', { name: 'Review' });
    expect(within(review).queryByText('Nothing to fix on this checklist.')).toBeNull();
    expect(within(review).getByRole('link', { name: 'Open the full check' })).toBeInTheDocument();
    first.unmount();

    state.latest = latest({ grade: { ...GRADE, counts: { urgent: 0, critical: 0, optional: 0 }, issues: [] } });
    await renderEditor();
    expect(within(screen.getByRole('tabpanel', { name: 'Review' })).getByText('Nothing to fix on this checklist.')).toBeInTheDocument();
  });

  it('Review: Check again is the check call with the same role, and its cost shows before the click', async () => {
    nav.params = new URLSearchParams('tab=review');
    await renderEditor();
    const review = screen.getByRole('tabpanel', { name: 'Review' });
    expect(within(review).getByText('Uses 1 resume check credit (3 left).')).toBeInTheDocument();
    fireEvent.click(within(review).getByRole('button', { name: 'Check again' }));
    expect(state.run).toHaveBeenCalledWith('Data analyst');
  });

  it('Review: with AI off it says the checklist runs alone and no credit is used; a changed resume is flagged', async () => {
    state.latest = latest({ aiAvailable: false, stale: true, grade: { ...GRADE, method: 'rules', aiSkipped: 'ai_unavailable' } });
    nav.params = new URLSearchParams('tab=review');
    await renderEditor();
    const review = screen.getByRole('tabpanel', { name: 'Review' });
    expect(within(review).getByText('Checklist only: AI checks are off for your account. No credit is used.')).toBeInTheDocument();
    expect(within(review).getByText(/spelling was not checked/)).toBeInTheDocument();
    expect(within(review).getByText('You changed this resume after the check.')).toBeInTheDocument();
  });

  it('Review: no check yet shows the check page start card; running shows the running card with Cancel', async () => {
    state.latest = latest({ grade: null });
    nav.params = new URLSearchParams('tab=review');
    const { rerenderPage } = await renderEditor();
    const review = screen.getByRole('tabpanel', { name: 'Review' });
    expect(within(review).getByRole('heading', { name: 'Check this resume' })).toBeInTheDocument();
    fireEvent.click(within(review).getByRole('button', { name: 'Run the check' }));
    expect(state.run).toHaveBeenCalledWith(undefined);

    state.running = true;
    act(() => rerenderPage());
    expect(within(review).getByRole('heading', { name: 'Checking your resume' })).toBeInTheDocument();
    fireEvent.click(within(review).getByRole('button', { name: 'Cancel the check' }));
    expect(state.cancel).toHaveBeenCalled();
  });

  it('Review: an issue leads to its section in Edit (the tab opens, then the section scrolls into view)', async () => {
    nav.params = new URLSearchParams('tab=review');
    await renderEditor();
    const review = screen.getByRole('tabpanel', { name: 'Review' });
    // A layout issue has no section in the form: no jump there.
    const layout = within(review).getByRole('heading', { name: 'Layout' }).closest('section')!;
    expect(within(layout as HTMLElement).queryByRole('button', { name: /Edit the/ })).toBeNull();

    fireEvent.click(within(review).getByRole('button', { name: 'Edit the Experience section' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/resume/rv_1', { scroll: false });
    expect(tabNamed('Edit')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(scrolled).toContain(document.getElementById('experience')));
  });

  it('Review: a two-column layout issue opens Customize, where the template is picked', async () => {
    nav.params = new URLSearchParams('tab=review');
    await renderEditor();
    fireEvent.click(within(screen.getByRole('tabpanel', { name: 'Review' })).getByRole('button', { name: 'Change the template' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/resume/rv_1?tab=customize', { scroll: false });
    expect(screen.getByRole('tabpanel', { name: 'Customize' })).toBeVisible();
  });

  it('a check report link (`?focus=`) still opens the form on its section, from any tab', async () => {
    window.history.replaceState(null, '', '/resume/rv_1?tab=review&focus=section-summary');
    nav.params = new URLSearchParams('tab=review&focus=section-summary');
    await renderEditor();
    await waitFor(() => expect(scrolled).toContain(document.getElementById('summary')));
    expect(nav.replace).toHaveBeenLastCalledWith('/resume/rv_1?focus=section-summary', { scroll: false });
    expect(tabNamed('Edit')).toHaveAttribute('aria-selected', 'true');
  });

  it('Tailor: explains the copy, offers the saved jobs without a tailored version, and opens the Tailor sheet', async () => {
    nav.params = new URLSearchParams('tab=tailor');
    const { errors } = await renderEditor();
    const panel = screen.getByRole('tabpanel', { name: /Tailor/ });
    expect(within(panel).getByText(/AI rewrites a copy of your resume to fit it; your original stays as it is\./)).toBeInTheDocument();
    expect(within(panel).getByText('Main resume')).toBeInTheDocument();

    // job_2 already has a tailored version.
    const chips = within(panel).getAllByRole('button', { name: /^Tailor a version for/ });
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual(['Tailor a version for Data analyst at Acme']);
    fireEvent.click(chips[0]!);
    let sheet = await screen.findByTestId('tailor-sheet');
    expect(sheet).toHaveAttribute('data-resume', 'rv_1');
    expect(sheet).toHaveAttribute('data-job', 'job_1');
    expect(sheet).toHaveAttribute('data-title', 'Data analyst');
    fireEvent.click(screen.getByRole('button', { name: 'close sheet' }));
    expect(screen.queryByTestId('tailor-sheet')).toBeNull();

    // Pick another saved job or paste a posting: the sheet starts at its own target step.
    const start = within(panel).getByRole('button', { name: 'Tailor for a job' });
    // One primary per screen: the toolbar's Tailor button is it.
    expect(start).not.toHaveClass('primary');
    fireEvent.click(start);
    sheet = await screen.findByTestId('tailor-sheet');
    expect(sheet).toHaveAttribute('data-resume', 'rv_1');
    expect(sheet).toHaveAttribute('data-job', 'null');
    expect(messageErrors(errors)).toEqual([]);
  });

  it('Tailor is not offered when AI tailoring may not run; a link to it opens Edit', async () => {
    state.tailor = false;
    nav.params = new URLSearchParams('tab=tailor');
    await renderEditor();
    const tablist = screen.getByRole('tablist', { name: 'Resume editor' });
    expect(within(tablist).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Edit', 'Customize', 'Review']);
    expect(tabNamed('Edit')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tabpanel', { name: /Tailor/ })).toBeNull();
  });

  it('a tab keeps what was on it while another is open (its content mounts once)', async () => {
    nav.params = new URLSearchParams('tab=review');
    await renderEditor();
    fireEvent.click(tabNamed('Edit'));
    // Review stays mounted, hidden.
    expect(document.getElementById('resume-editor-panel-review')).not.toBeVisible();
    expect(document.getElementById('resume-editor-panel-review')?.textContent).toContain('72 of 100 on the checklist');
    fireEvent.click(tabNamed('Review'));
    expect(screen.getByRole('tabpanel', { name: 'Review' })).toBeVisible();
  });
});
