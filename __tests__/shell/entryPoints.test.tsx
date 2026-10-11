// INT-12 — the WP-93 entry-point checklist (TASK_PLAN.md §9; wave-5 carry-over
// WP-93 #28).
//
// Each shipped surface must be reachable from where the plan says, its target
// page must exist and be real, and the link must disappear when its flag is
// off (R-04: a disabled feature has no UI entry):
//
//   1. /jobs header                → /jobs/report            flag `competitiveness` (+ the feed)
//   2. Assistant competitiveness card → /jobs/report         flag `competitiveness`
//   3. /practice                   → /practice/questions     flag `interviewBank`
//   4. job checklist               → /practice/questions/[company]   flag `interviewBank`
//   5. resume hub                  → /resume/letters         (no flag)
//   6. marketing footer "Popular job lists" → /browse/*      flag `seo.browse`
//   7. browse pages render VisitorFeed
//
// Rendered where the component is small enough to stand alone (2, 4, 5, 6);
// checked in the source where it is a whole workspace (1, 3) or a server route
// (7). A missing entry point is a fix request to the owning bundle, not an
// edit here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';

import { mockAuthState, buildAuthValue } from '../utils/mockAuth';
import { auditPage, isStubSource, readSource, renderWithBrand, rendersNullByDesign, routeFor } from './helpers';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/jobs',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// The footer's "Popular job lists" come from the public index stats.
const support = vi.hoisted(() => ({ getIndexStats: vi.fn() }));
vi.mock('../../lib/api/support', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/support')>()),
  getIndexStats: support.getIndexStats,
}));

import { CompetitivenessCard } from '../../components/features/copilot/cards/CompetitivenessCard';
import { CARD_COMPONENTS } from '../../components/features/copilot/cards';
import { GetReadyChecklist, practiceQuestionsHref } from '../../components/features/job/GetReadyChecklist';
import { ResumeHubTabs } from '../../components/features/resume/ResumeHub';
import { MarketingFooter, popularListHref } from '../../components/features/marketing';

/** The target exists and is a real page; returns its file. */
function expectLivePage(href: string): string {
  const route = routeFor(href);
  expect(route, `no page for ${href}`).not.toBeNull();
  expect(auditPage(route!.file).problems, `${href} → ${route!.file}`).toEqual([]);
  return route!.file;
}

/**
 * The condition of the nearest `{cond ? (` that opens before `needle`
 * (identifiers joined by `&&`), or null. Enough to tell which flag guards a link.
 */
function guardedBy(source: string, needle: string): string | null {
  const at = source.indexOf(needle);
  if (at < 0) return null;
  const guards = [...source.slice(0, at).matchAll(/\{\s*([A-Za-z_$][\w$.]*(?:\s*&&\s*[A-Za-z_$][\w$.]*)*)\s*\?\s*\(?/g)];
  const last = guards.pop();
  return last ? last[1]!.replace(/\s+/g, ' ') : null;
}

beforeEach(() => {
  mockAuthState.value = buildAuthValue();
  support.getIndexStats.mockReset();
});

describe('1. /jobs header → /jobs/report (flag competitiveness)', () => {
  const file = 'components/features/feed/JobsWorkspace.tsx';
  const source = readSource(file);

  it('the header links to the report, only with the competitiveness flag on (and the feed)', () => {
    expect(source).toMatch(/const reportOn = useFlag\('competitiveness'\);/);
    expect(source).toMatch(/const feedOn = useFlag\('jobs\.feed'\);/);
    expect(source).toMatch(/<Link href="\/jobs\/report"/);
    expect(guardedBy(source, '<Link href="/jobs/report"')).toBe('reportOn && feedOn');
    // Exactly one such link, inside the page header.
    expect(source.match(/href="\/jobs\/report"/g)).toHaveLength(1);
    const header = source.slice(source.indexOf('<header'), source.indexOf('</header>'));
    expect(header).toContain('href="/jobs/report"');
  });

  it('/jobs renders that workspace and /jobs/report is a real page', () => {
    expect(auditPage('app/(auth)/jobs/page.tsx').components.map((c) => c.name)).toContain('JobsWorkspace');
    expect(expectLivePage('/jobs/report')).toBe('app/(auth)/jobs/report/page.tsx');
    expect(auditPage('app/(auth)/jobs/report/page.tsx').components.map((c) => c.name)).toEqual(['CompetitivenessReport']);
  });
});

describe('2. Assistant competitiveness card → /jobs/report (flag competitiveness)', () => {
  const card = { type: 'competitiveness', id: 'c1', data: { jobId: 'cm_job1' } } as never;

  it('is the registered card for its type', () => {
    expect(CARD_COMPONENTS.competitiveness).toBe(CompetitivenessCard);
  });

  it.each(['roboapply', 'goapply'] as const)('%s: links to the report with the flag on; nothing with it off', (brand) => {
    const on = renderWithBrand(<CompetitivenessCard card={card} ctx={{}} />, { brand, flags: { competitiveness: true } });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/jobs/report?job=cm_job1');
    expectLivePage(link.getAttribute('href')!);
    on.unmount();

    const off = renderWithBrand(<CompetitivenessCard card={card} ctx={{}} />, { brand, flags: {} });
    expect(off.container).toBeEmptyDOMElement();
    off.unmount();

    const loading = renderWithBrand(<CompetitivenessCard card={card} ctx={{}} />, { brand, flags: null });
    expect(loading.container).toBeEmptyDOMElement();
  });

  it('never follows a link the server did not mean: only /jobs/report targets render', () => {
    const { container } = renderWithBrand(
      <CompetitivenessCard card={{ type: 'competitiveness', id: 'c2', data: { href: 'https://evil.example/x' } } as never} ctx={{}} />,
      { flags: { competitiveness: true } },
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('3. /practice → /practice/questions (flag interviewBank)', () => {
  const source = readSource('app/(auth)/practice/page.tsx');

  it('the practice page links to the question bank, only with interviewBank on', () => {
    expect(source).toMatch(/const showQuestionsLink = useFlag\('interviewBank'\);/);
    expect(source).toMatch(/showQuestionsLink \? <Link href="\/practice\/questions">[^<]*<\/Link> : null/);
    expect(source.match(/href="\/practice\/questions"/g)).toHaveLength(1);
  });

  it('/practice/questions is a real page that keeps the app shell (not the full-screen room)', async () => {
    expect(expectLivePage('/practice/questions')).toBe('app/(auth)/practice/questions/page.tsx');
    const { isPracticeLivePath } = await import('../../components/v3/shell/HybridShell');
    expect(isPracticeLivePath('/practice/questions')).toBe(false);
    expect(isPracticeLivePath('/practice/questions/acme')).toBe(false);
  });
});

describe('4. job checklist → /practice/questions/[company] (flag interviewBank)', () => {
  const detail = {
    job: { id: 'cm_job1', title: 'Backend Engineer', companyName: 'Acme', status: 'open', applyUrl: 'https://boards.example.com/acme/1' },
    company: { id: 'co1', name: 'Acme Inc', slug: 'acme-inc' },
    checklist: { saved: true, tailoredResumeId: null, coverLetterId: null, practiced: false, applied: false, appliedAt: null, trackerEntryId: null },
  } as never;
  const noop = () => {};
  const render = (interviewBank: boolean, brand: 'roboapply' | 'goapply' = 'roboapply') =>
    renderWithBrand(
      <GetReadyChecklist
        detail={detail}
        flags={{ interviewBank, extension: false, agent: false, people: false, ai: false }}
        pending={null}
        onSave={noop}
        onTailor={noop}
        onPractice={noop}
        onApply={noop}
        onIApplied={noop}
        onPeople={noop}
      />,
      { brand, flags: {} },
    );

  it.each(['roboapply', 'goapply'] as const)('%s: the checklist links to the company’s questions with the flag on; no link with it off', (brand) => {
    const on = render(true, brand);
    const list = screen.getByTestId('job-checklist');
    const link = within(list).getByRole('link', { name: /Acme Inc/ });
    expect(link).toHaveAttribute('href', '/practice/questions/acme-inc?job=cm_job1');
    expect(expectLivePage(link.getAttribute('href')!)).toBe('app/(auth)/practice/questions/[company]/page.tsx');
    on.unmount();

    render(false, brand);
    expect(within(screen.getByTestId('job-checklist')).queryAllByRole('link').map((a) => a.getAttribute('href'))).not.toContain(
      '/practice/questions/acme-inc?job=cm_job1',
    );
    expect(document.querySelector('a[href^="/practice/questions"]')).toBeNull();
  });

  it('the flag comes from the capability, not a constant', () => {
    const panel = readSource('components/features/job/JobDetailPanel.tsx');
    expect(panel).toMatch(/const interviewBank = useFlag\('interviewBank'\);/);
    expect(panel).toMatch(/flags=\{\{ interviewBank,/);
  });

  it('practiceQuestionsHref: the company slug, else its name, encoded; the job travels as ?job=', () => {
    expect(practiceQuestionsHref({ slug: 'acme', name: 'Acme' })).toBe('/practice/questions/acme');
    expect(practiceQuestionsHref({ slug: null, name: '字节 跳动' }, 'cm 1')).toBe(`/practice/questions/${encodeURIComponent('字节 跳动')}?job=cm%201`);
  });
});

describe('5. resume hub → /resume/letters', () => {
  it.each(['roboapply', 'goapply'] as const)('%s: the hub tabs link to cover letters, a real page', (brand) => {
    renderWithBrand(<ResumeHubTabs active="resumes" />, { brand, flags: {} });
    const tabs = screen.getByRole('navigation');
    const hrefs = within(tabs).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/resume', '/resume/letters']);
    expect(expectLivePage('/resume/letters')).toBe('app/(auth)/resume/letters/page.tsx');
    expectLivePage('/resume/letters/cm_l1');
  });

  it('the resume hub page renders the tabs, and the cover-letter hub links back to it', () => {
    expect(readSource('app/(auth)/resume/page.tsx')).toMatch(/<ResumeHubTabs active="resumes" \/>/);
    const letters = auditPage('app/(auth)/resume/letters/page.tsx').components.find((c) => c.name === 'CoverLetterHub')!;
    expect(readSource(letters.file)).toMatch(/href="\/resume"/);
  });
});

describe('6. marketing footer "Popular job lists" → /browse/* (flag seo.browse)', () => {
  const stats = {
    openRoles: null,
    addedThisWeek: null,
    popularLists: [
      { taxonomyId: 'data_analyst', label: 'Data analyst', labelZh: '数据分析师' },
      { taxonomyId: 'software_engineer', label: 'Software engineer', labelZh: '软件工程师' },
    ],
    asOf: '2026-10-10T00:00:00.000Z',
    partial: false,
  };

  it('with seo.browse on: one link per list, each to a real browse page', async () => {
    support.getIndexStats.mockResolvedValue(stats);
    renderWithBrand(<MarketingFooter />, { flags: { 'seo.browse': true } });
    const title = await screen.findByText('Popular job lists');
    const links = within(title.parentElement as HTMLElement).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Data analyst', '/browse/data-analyst'],
      ['Software engineer', '/browse/software-engineer'],
    ]);
    for (const a of links) expect(expectLivePage(a.getAttribute('href')!)).toBe('app/browse/[...path]/page.tsx');
    expect(popularListHref('data_analyst')).toBe('/browse/data-analyst');
  });

  it('with seo.browse off: no "Popular job lists" and no /browse link, whatever the stats say', async () => {
    support.getIndexStats.mockResolvedValue(stats);
    renderWithBrand(<MarketingFooter />, { flags: {} });
    await waitFor(() => expect(support.getIndexStats).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('Popular job lists')).toBeNull();
    expect(document.querySelector('a[href^="/browse"]')).toBeNull();
  });

  it('with the flag on but no list to show (unknown counts): nothing, never an empty heading', async () => {
    support.getIndexStats.mockResolvedValue({ ...stats, popularLists: [] });
    renderWithBrand(<MarketingFooter />, { flags: { 'seo.browse': true } });
    await waitFor(() => expect(support.getIndexStats).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('Popular job lists')).toBeNull();
  });

  it('the footer is mounted on the public pages that use the marketing chrome', () => {
    for (const page of ['app/pricing/page.tsx', 'app/about/page.tsx', 'app/help/page.tsx', 'app/tools/page.tsx', 'app/features/[slug]/page.tsx']) {
      expect(auditPage(page).components.map((c) => c.name), page).toContain('MarketingFooter');
    }
  });
});

describe('7. browse pages render VisitorFeed', () => {
  const route = 'app/browse/[...path]/page.tsx';
  const source = readSource(route);

  it('the browse route renders the public feed under the page, attributed to browse', () => {
    expect(source).toMatch(/import \{ VisitorFeed \} from '[^']*components\/features\/visitor'/);
    // Under a known page and under the "we do not have that list" page.
    expect(source.match(/<VisitorFeed\b/g)).toHaveLength(2);
    expect(source.match(/<VisitorFeed\s+from="browse"/g)).toHaveLength(2);
    const known = source.slice(source.indexOf('<BrowsePage '));
    expect(known.indexOf('<VisitorFeed')).toBeGreaterThan(0);
    const audit = auditPage(route);
    expect(audit.components.map((c) => c.name)).toEqual(expect.arrayContaining(['BrowsePage', 'BrowseUnknown', 'VisitorFeed', 'HybridShell']));
    expect(audit.problems).toEqual([]);
  });

  it('VisitorFeed and BrowsePage are real components (the FND stubs are filled)', () => {
    for (const [file, name] of [
      ['components/features/visitor/VisitorFeed.tsx', 'VisitorFeed'],
      ['components/features/seo/BrowsePage.tsx', 'BrowsePage'],
    ] as const) {
      expect(isStubSource(file), file).toBe(false);
      expect(rendersNullByDesign(file, name), file).toBe(false);
    }
    // BrowsePage itself leaves the feed to the route (it says so), so the route is where it must be.
    expect(readSource('components/features/seo/BrowsePage.tsx')).toMatch(/VisitorFeed below \(rendered by the route/);
  });

  // Parity wave (PAR-9 item 1, plan §3.11): browse pages follow the same gates on both
  // brands (`seo.browse`, the display providers), so the route has no market guard.
  it('browse has no market guard (both brands, behind seo.browse) and its hub is a real page', () => {
    expect(source).not.toMatch(/brand\.market === 'cn'/);
    expect(readSource('app/browse/page.tsx')).not.toMatch(/brand\.market === 'cn'/);
    expect(expectLivePage('/browse')).toBe('app/browse/page.tsx');
    expect(expectLivePage('/browse/remote/data-analyst')).toBe(route);
  });
});

describe('every checklist target is a real page', () => {
  it.each(['/jobs/report', '/practice/questions', '/practice/questions/acme', '/resume/letters', '/browse/data-analyst', '/browse'])('%s', (href) => {
    expectLivePage(href);
  });
});
