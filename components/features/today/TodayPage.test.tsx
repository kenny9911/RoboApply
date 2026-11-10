// /today — the route and its container. TodayPage gathers the reads
// (hooks/today) and asks for the main resume's latest check, as the /resume hub
// does; TodayDesk draws them (today.test.tsx). Here the two hooks are doubles.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/today',
}));

const h = vi.hoisted(() => ({ sources: vi.fn(), check: vi.fn() }));
vi.mock('../../../hooks/today', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useTodaySources: () => h.sources() }));
vi.mock('../../../hooks/resume/useResumeCheck', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLatestResumeCheck: (id: string | null | undefined) => h.check(id),
}));

import TodayRoute from '../../../app/(auth)/today/page';
import { daysAgo, loading, ready, renderToday, resume, sourcesWith } from './today.testkit';

const NO_AGENT = { flags: { ready: true, agent: false, copilot: false, feed: true }, queue: { status: 'off' } as const, picksFrom: 'feed' as const };
const grade = { id: 'g1', resumeVariantId: 'rv_main', status: 'done', label: 'fair', score: 61, counts: { urgent: 2, critical: 0, optional: 1 }, issues: [], createdAt: daysAgo(2), completedAt: daysAgo(2) };

beforeEach(() => {
  vi.clearAllMocks();
  h.check.mockReturnValue({ data: undefined, isLoading: false, isError: false });
});

describe('/today route', () => {
  it('renders the desk and reads the latest check of the main resume: the primary one', () => {
    h.sources.mockReturnValue(
      sourcesWith({ ...NO_AGENT, resumes: ready([resume({ id: 'rv_newer', name: 'Newer', isPrimary: false, lastEditedAt: daysAgo(0) }), resume({ id: 'rv_main', name: 'Main one', lastEditedAt: daysAgo(9) })]) }),
    );
    h.check.mockReturnValue({ data: { grade, previous: null, stale: false, aiAvailable: true }, isLoading: false, isError: false });
    renderToday(<TodayRoute />, { flags: { 'jobs.feed': true } });

    expect(h.check).toHaveBeenLastCalledWith('rv_main');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Nothing is waiting for you');
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
    renderToday(<TodayRoute />, { flags: { 'jobs.feed': true } });
    expect(h.check).toHaveBeenLastCalledWith('rv_new');
  });

  it('asks for no check while the resumes load, and none when there is no resume', () => {
    h.sources.mockReturnValue(sourcesWith({ ...NO_AGENT, resumes: loading }));
    const first = renderToday(<TodayRoute />, { flags: { 'jobs.feed': true } });
    expect(h.check).toHaveBeenLastCalledWith(undefined);
    expect(within(screen.getByTestId('today-resume')).getByRole('status')).toHaveTextContent('Loading your resume…');
    first.unmount();

    h.sources.mockReturnValue(sourcesWith({ ...NO_AGENT, resumes: ready([]) }));
    renderToday(<TodayRoute />, { flags: { 'jobs.feed': true } });
    expect(h.check).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByTestId('today-resume-none')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('1 thing is waiting for you');
  });

  it('a check that could not be read shows no made-up result, only the way to the check', () => {
    h.sources.mockReturnValue(sourcesWith({ ...NO_AGENT, resumes: ready([resume({ id: 'rv_main', name: 'Main one' })]) }));
    h.check.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderToday(<TodayRoute />, { flags: { 'jobs.feed': true } });
    const lane = screen.getByTestId('today-resume');
    expect(lane).not.toHaveTextContent(/of 100|Not checked yet/);
    expect(within(lane).getByRole('link', { name: 'Resume check for Main one' })).toHaveAttribute('href', '/resume/rv_main/check');
  });
});
