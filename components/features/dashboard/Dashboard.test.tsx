// Dashboard — the signed-in home: the resume.io layout around the agent desk
// (docs/agent-driven/REDESIGN.md §5). The desk's reads (hooks/today), the main
// resume's latest check and the goal meters' facts are doubles here; the desk's
// own behaviour is covered in components/features/today (today.test.tsx) and
// the meters in model.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';

const h = vi.hoisted(() => ({
  sources: vi.fn(),
  check: vi.fn(),
  replace: vi.fn(),
  params: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: h.replace, refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => h.params,
  usePathname: () => '/dashboard',
}));
vi.mock('../../../lib/auth/AuthProvider', async () => {
  const { mockAuthState } = await import('../../../__tests__/utils/mockAuth');
  return { AuthProvider: ({ children }: { children: unknown }) => children, useAuth: () => mockAuthState.value };
});
vi.mock('../../../hooks/today', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useTodaySources: () => h.sources() }));
vi.mock('../../../hooks/resume/useResumeCheck', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLatestResumeCheck: (id: string | null | undefined) => h.check(id),
}));
vi.mock('./useDashboardFacts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useDashboardFacts: () => ({
    hasResume: true,
    primaryResumeId: 'rv_main',
    resumeScore: 61,
    tailoredCount: 1,
    letterCount: 0,
    profileCompleteness: 68,
    statusCounts: { applied: 2 },
    preparingCount: 0,
    practiceCompleted: 0,
  }),
}));
// The hero's resume picture renders the document; not under test here.
vi.mock('../resume/hub/ResumeThumb', () => ({ ResumeThumb: () => <div data-testid="resume-thumb" /> }));

import { mockAuthState, buildAuthValue, buildFakeUser } from '../../../__tests__/utils/mockAuth';
import { daysAgo, loading, pick, ready, renderToday, resume, sourcesWith } from '../today/today.testkit';
import { Dashboard } from './Dashboard';

const NO_AGENT = { flags: { ready: true, agent: false, copilot: false, feed: true }, queue: { status: 'off' } as const, picksFrom: 'feed' as const };
const grade = { id: 'g1', resumeVariantId: 'rv_main', status: 'done', label: 'fair', score: 61, counts: { urgent: 2, critical: 0, optional: 1 }, issues: [], createdAt: daysAgo(2), completedAt: daysAgo(2) };

function renderDashboard(ui: ReactElement = <Dashboard />) {
  return renderToday(ui, { flags: { 'jobs.feed': true } });
}

/** a is before b in the document. */
function before(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.params = new URLSearchParams();
  mockAuthState.value = buildAuthValue({ user: buildFakeUser({ name: 'Ada Lovelace' }) });
  h.check.mockReturnValue({ data: undefined, isLoading: false, isError: false });
});

describe('Dashboard', () => {
  it('greets by first name, says what waits, and lays out the desk around the goals', () => {
    h.sources.mockReturnValue(sourcesWith({ ...NO_AGENT, profileMissing: ready(1), picks: ready([pick('p1', 'Analytics Engineer')]) }));
    renderDashboard();

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Hi Ada!');
    expect(screen.getByTestId('today-status')).toHaveTextContent('1 thing is waiting for you');
    expect(screen.getByTestId('today-goal')).toBeInTheDocument();

    // resume.io order: what waits, the goals (tabs, progress, hero), the picks, then the Applications and Resume lanes.
    const waiting = screen.getByTestId('today-waiting');
    const goals = screen.getByTestId('dashboard-goals');
    const picks = screen.getByTestId('today-job-search');
    const resumeLane = screen.getByTestId('today-resume');
    expect(before(waiting, goals) && before(goals, picks) && before(picks, resumeLane)).toBe(true);

    expect(within(goals).getByRole('heading', { level: 2, name: 'What do you want to move forward today?' })).toBeInTheDocument();
    expect(within(goals).getAllByRole('button', { pressed: true }).map((b) => b.textContent)).toContain('Resume');
  });

  it('keeps one primary button: the waiting card holds it while something waits', () => {
    h.sources.mockReturnValue(sourcesWith({ ...NO_AGENT, profileMissing: ready(1), picks: ready([pick('p1', 'Analytics Engineer')]) }));
    const { container } = renderDashboard();
    expect(within(screen.getByTestId('today-waiting')).getByTestId('waiting-action')).toHaveClass('primary');
    expect(container.querySelector('[data-primary="true"]')).toBeNull();
    expect(within(screen.getByTestId('today-job-search')).queryByText('View job', { selector: '.primary' })).toBeNull();
  });

  it('when nothing waits, the hero card carries the one primary button and no pick does', () => {
    h.sources.mockReturnValue(sourcesWith({ ...NO_AGENT, picks: ready([pick('p1', 'Analytics Engineer')]) }));
    const { container } = renderDashboard();
    expect(screen.getByTestId('today-status')).toHaveTextContent('Nothing is waiting for you');
    const primaries = container.querySelectorAll('[data-primary="true"], .btn.primary');
    expect(primaries).toHaveLength(1);
    expect(within(screen.getByTestId('dashboard-goals')).getByRole('link', { name: /Run a resume check|Check|resume/i })).toHaveAttribute('data-primary', 'true');
  });

  it('a goal tab moves the selection into the address, so Back restores it', () => {
    h.sources.mockReturnValue(sourcesWith(NO_AGENT));
    renderDashboard();
    fireEvent.click(within(screen.getByTestId('dashboard-goals')).getByRole('button', { name: 'Job search' }));
    expect(h.replace).toHaveBeenLastCalledWith('/dashboard?goal=jobs', { scroll: false });
  });

  it('reads the latest check of the main resume: the primary one', () => {
    h.sources.mockReturnValue(
      sourcesWith({ ...NO_AGENT, resumes: ready([resume({ id: 'rv_newer', name: 'Newer', isPrimary: false, lastEditedAt: daysAgo(0) }), resume({ id: 'rv_main', name: 'Main one', lastEditedAt: daysAgo(9) })]) }),
    );
    h.check.mockReturnValue({ data: { grade, previous: null, stale: false, aiAvailable: true }, isLoading: false, isError: false });
    renderDashboard();

    expect(h.check).toHaveBeenCalledWith('rv_main');
    const lane = screen.getByTestId('today-resume');
    expect(within(lane).getByTestId('today-resume-name')).toHaveTextContent('Main one');
    expect(lane).toHaveTextContent('Fair');
    expect(lane).toHaveTextContent('61 of 100 on the checklist');
    expect(within(lane).getByRole('link', { name: 'See the check for Main one' })).toHaveAttribute('href', '/resume/rv_main/check');
  });

  it('with no primary, the main resume is the newest base resume; a tailored version is never it', () => {
    h.sources.mockReturnValue(
      sourcesWith({
        ...NO_AGENT,
        resumes: ready([
          resume({ id: 'rv_old', isPrimary: false, lastEditedAt: daysAgo(9) }),
          resume({ id: 'rv_new', isPrimary: false, lastEditedAt: daysAgo(1) }),
          resume({ id: 'rv_tailored', kind: 'tailored_for_jd', isPrimary: false, lastEditedAt: daysAgo(0) }),
        ]),
      }),
    );
    renderDashboard();
    expect(h.check).toHaveBeenCalledWith('rv_new');
    expect(h.check).not.toHaveBeenCalledWith('rv_tailored');
  });

  it('asks for no check while the resumes load, and none when there is no resume', () => {
    h.sources.mockReturnValue(sourcesWith({ ...NO_AGENT, resumes: loading }));
    const first = renderDashboard();
    expect(h.check).toHaveBeenLastCalledWith(undefined);
    expect(within(screen.getByTestId('today-resume')).getByRole('status')).toHaveTextContent('Loading your resume…');
    first.unmount();

    h.sources.mockReturnValue(sourcesWith({ ...NO_AGENT, resumes: ready([]) }));
    renderDashboard();
    expect(h.check).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByTestId('today-resume-none')).toBeInTheDocument();
    expect(screen.getByTestId('today-status')).toHaveTextContent('1 thing is waiting for you');
  });

  it('a check that could not be read shows no made-up result, only the way to the check', () => {
    h.sources.mockReturnValue(sourcesWith({ ...NO_AGENT, resumes: ready([resume({ id: 'rv_main', name: 'Main one' })]) }));
    h.check.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderDashboard();
    const lane = screen.getByTestId('today-resume');
    expect(lane).not.toHaveTextContent(/of 100|Not checked yet/);
    expect(within(lane).getByRole('link', { name: 'Resume check for Main one' })).toHaveAttribute('href', '/resume/rv_main/check');
  });
});
