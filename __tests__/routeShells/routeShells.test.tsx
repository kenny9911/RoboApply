// FND-6b — route shells (TASK_PLAN.md §4.1.b).
//
// Acceptance: every route shell renders, one smoke test per group:
//   auth     app/(auth)/…          inside the (auth) app shell
//   onboard  app/(onboarding)/…    stage pages per brand, /onboarding index
//   public   app/(public)/…        the sign-in layout's pages
//   bare     app/auth/callback/…   no shell
//   hybrid   public pages          HybridShell: app shell signed in,
//                                  marketing chrome + legal footer signed out
// Plus: each shell names its owner, public stubs are not indexed, authenticated
// shells are behind the proxy's login gate and public ones are not, and
// /jobs/explore serves the job search that /job-search used to.
//
// Owners replace these pages without touching this file: the render, marker,
// owner and noindex checks run only while the page still carries its
// `data-route-stub` marker; the page-exists and proxy-gate checks always run
// (proxyPaths is a hot file, so its answers do not move under a WP).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { screen, within } from '@testing-library/react';

import { mockAuthState, buildAuthValue } from '../utils/mockAuth';
import { renderWithBrand } from '../shell/helpers';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const nav = vi.hoisted(() => ({ pathname: '/jobs', replace: [] as string[] }));
vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return {
    ...real,
    usePathname: () => nav.pathname,
    useRouter: () => ({
      push: vi.fn(),
      replace: (href: string) => nav.replace.push(href),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({}),
  };
});

vi.mock('../../lib/ui/popupGate', async (orig) => {
  const real = await orig<typeof import('../../lib/ui/popupGate')>();
  return { ...real, usePopupGateSync: () => undefined };
});

const serverBrand = vi.hoisted(() => ({ id: 'roboapply' as 'roboapply' | 'goapply' }));
vi.mock('../../lib/server/brand', () => ({ getServerBrandId: async () => serverBrand.id }));

// Seams the shells hand data to: replaced with visible markers so the test
// sees what each page passes.
vi.mock('../../components/features/job', () => ({
  JobDetailPanel: (p: { jobId: string; mode: string }) => <i data-testid="job-panel" data-job={p.jobId} data-mode={p.mode} />,
}));
vi.mock('../../components/features/visitor', () => ({
  VisitorFeed: (p: { from: string }) => <i data-testid="visitor-feed" data-from={p.from} />,
}));
vi.mock('../../components/features/market', () => ({
  LegalFooter: () => <footer data-testid="legal-footer" />,
}));
vi.mock('../../components/job-search/JobSearchWorkspace', () => ({
  JobSearchWorkspace: () => <i data-testid="job-search-workspace" />,
}));

import AuthLayout from '../../app/(auth)/layout';
import OnboardingLayout from '../../app/(onboarding)/layout';
import { isProtectedPath } from '../../lib/proxyPaths';
import { ONBOARDING_STAGE_ROUTES } from '../../server/src/features/onboarding/contract';
import { ONBOARDING_SCREEN_STAGES } from '../../app/(onboarding)/onboarding/steps';

const ROOT = process.cwd();

interface Shell {
  /** Directory under app/. */
  dir: string;
  /** The route as §4.1.b writes it. */
  route: string;
  owner: string;
  /** A concrete URL for the route (proxy check, pathname). */
  url: string;
  params?: Record<string, string | string[]>;
  /** Signup attribution slug (hybrid pages). */
  from?: string;
}

const AUTH: Shell[] = [
  { dir: '(auth)/jobs/added', route: '/jobs/added', owner: 'WP-35', url: '/jobs/added' },
  { dir: '(auth)/jobs/report', route: '/jobs/report', owner: 'WP-77', url: '/jobs/report' },
  { dir: '(auth)/ready', route: '/ready', owner: 'WP-53', url: '/ready' },
  { dir: '(auth)/ready/setup', route: '/ready/setup', owner: 'WP-53', url: '/ready/setup' },
  { dir: '(auth)/ready/[jobId]', route: '/ready/[jobId]', owner: 'WP-53', url: '/ready/cm_job1', params: { jobId: 'cm_job1' } },
  { dir: '(auth)/resume/[id]/check', route: '/resume/[id]/check', owner: 'WP-22', url: '/resume/cm_r1/check', params: { id: 'cm_r1' } },
  { dir: '(auth)/resume/letters', route: '/resume/letters', owner: 'WP-37', url: '/resume/letters' },
  { dir: '(auth)/resume/letters/[id]', route: '/resume/letters/[id]', owner: 'WP-37', url: '/resume/letters/cm_l1', params: { id: 'cm_l1' } },
  { dir: '(auth)/resume/new', route: '/resume/new', owner: 'WP-65', url: '/resume/new' },
  { dir: '(auth)/practice/questions/[company]', route: '/practice/questions/[company]', owner: 'WP-59', url: '/practice/questions/acme', params: { company: 'acme' } },
  { dir: '(auth)/profile', route: '/profile', owner: 'WP-19', url: '/profile' },
  { dir: '(auth)/assistant', route: '/assistant', owner: 'WP-51', url: '/assistant' },
  { dir: '(auth)/inbox', route: '/inbox', owner: 'WP-39b', url: '/inbox' },
  { dir: '(auth)/coaching', route: '/coaching', owner: 'WP-72', url: '/coaching' },
  { dir: '(auth)/referrals', route: '/referrals', owner: 'WP-54', url: '/referrals' },
  { dir: '(auth)/invite', route: '/invite', owner: 'WP-60', url: '/invite' },
  { dir: '(auth)/settings/billing/return', route: '/settings/billing/return', owner: 'WP-21b', url: '/settings/billing/return' },
  ...(
    [
      ['credits', 'WP-21b'],
      ['campus', 'WP-58'],
      ['fraud', 'WP-41'],
      ['sources', 'WP-42'],
      ['invites', 'WP-11'],
      ['questions', 'WP-59'],
      ['announcements', 'WP-61'],
      ['coaches', 'WP-72'],
      ['system', 'WP-74'],
      ['reports', 'WP-74'],
    ] as const
  ).map(([name, owner]) => ({ dir: `(auth)/admin/${name}`, route: `/admin/${name}`, owner, url: `/admin/${name}` })),
];

/** /practice/questions: see the it.fails case below. */
const PRACTICE_QUESTIONS: Shell = { dir: '(auth)/practice/questions', route: '/practice/questions', owner: 'WP-59', url: '/practice/questions' };

const PUBLIC_GROUP: Shell[] = [
  { dir: '(public)/forgot-password', route: '/forgot-password', owner: 'WP-10', url: '/forgot-password' },
  { dir: '(public)/reset-password/[token]', route: '/reset-password/[token]', owner: 'WP-10', url: '/reset-password/tok', params: { token: 'tok' } },
  { dir: '(public)/verify-email/[token]', route: '/verify-email/[token]', owner: 'WP-10', url: '/verify-email/tok', params: { token: 'tok' } },
  { dir: '(public)/bind-phone', route: '/bind-phone', owner: 'WP-11', url: '/bind-phone' },
];

const BARE: Shell[] = [
  { dir: 'auth/callback/google', route: '/auth/callback/google', owner: 'WP-10', url: '/auth/callback/google' },
  { dir: 'auth/callback/line', route: '/auth/callback/line', owner: 'WP-10', url: '/auth/callback/line' },
  { dir: 'auth/callback/wechat', route: '/auth/callback/wechat', owner: 'WP-11', url: '/auth/callback/wechat' },
];

const HYBRID: Shell[] = [
  { dir: 'unsubscribe/[token]', route: '/unsubscribe/[token]', owner: 'WP-39b', url: '/unsubscribe/tok', params: { token: 'tok' }, from: 'unsubscribe' },
  { dir: 'cancel', route: '/cancel', owner: 'WP-21b', url: '/cancel', from: 'cancel' },
  { dir: 'r/[code]', route: '/r/[code]', owner: 'WP-60', url: '/r/ABC123', params: { code: 'ABC123' }, from: 'invite' },
  { dir: 'alerts/confirm/[token]', route: '/alerts/confirm/[token]', owner: 'WP-78', url: '/alerts/confirm/tok', params: { token: 'tok' }, from: 'alerts' },
  { dir: 'extension', route: '/extension', owner: 'WP-55a', url: '/extension', from: 'extension' },
  { dir: 'extension/uninstalled', route: '/extension/uninstalled', owner: 'WP-55a', url: '/extension/uninstalled', from: 'extension' },
  { dir: 'campus', route: '/campus', owner: 'WP-58', url: '/campus', from: 'campus' },
  { dir: 'campus/[company]', route: '/campus/[company]', owner: 'WP-58', url: '/campus/acme', params: { company: 'acme' }, from: 'campus' },
  { dir: 'job/[idSlug]', route: '/job/[idSlug]', owner: 'WP-56', url: '/job/cm_job1-data-analyst', params: { idSlug: 'cm_job1-data-analyst' }, from: 'job' },
  { dir: 'browse/[...path]', route: '/browse/[...path]', owner: 'WP-56', url: '/browse/data-analyst/taipei', params: { path: ['data-analyst', 'taipei'] }, from: 'browse' },
  { dir: 'features/[slug]', route: '/features/[slug]', owner: 'WP-40', url: '/features/job-matches', params: { slug: 'job-matches' }, from: 'features' },
  { dir: 'pricing', route: '/pricing', owner: 'WP-40', url: '/pricing', from: 'pricing' },
  { dir: 'tools', route: '/tools', owner: 'WP-57', url: '/tools', from: 'tools' },
  { dir: 'tools/[tool]', route: '/tools/[tool]', owner: 'WP-57', url: '/tools/resume-check', params: { tool: 'resume-check' }, from: 'tools' },
  { dir: 'legal/[doc]', route: '/legal/[doc]', owner: 'WP-13', url: '/legal/privacy', params: { doc: 'privacy' }, from: 'legal' },
  { dir: 'about', route: '/about', owner: 'WP-40', url: '/about', from: 'about' },
  { dir: 'security', route: '/security', owner: 'WP-40', url: '/security', from: 'security' },
  { dir: 'help', route: '/help', owner: 'WP-40', url: '/help', from: 'help' },
  { dir: 'help/ranking', route: '/help/ranking', owner: 'WP-40', url: '/help/ranking', from: 'help' },
];

interface PageModule {
  default: (props: { params: Promise<Record<string, string | string[]>> }) => ReactElement | Promise<ReactElement>;
  metadata?: { robots?: unknown };
}

/** True while app/<dir>/page.tsx is still the FND route shell. */
const isStubPage = (dir: string) => readFileSync(join(ROOT, 'app', dir, 'page.tsx'), 'utf8').includes('data-route-stub=');

const loadPage = (dir: string) => import(/* @vite-ignore */ join(ROOT, 'app', dir, 'page.tsx')) as Promise<PageModule>;

/** The page's element, with its params resolved the way Next.js passes them (a Promise). */
async function pageElement(shell: Pick<Shell, 'dir' | 'params'>): Promise<ReactElement> {
  const mod = await loadPage(shell.dir);
  return mod.default({ params: Promise.resolve(shell.params ?? {}) });
}

function stubMarker(route: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-route-stub="${route}"]`);
  if (!el) throw new Error(`no route-stub marker for ${route}`);
  return el;
}

function expectParam(shell: Shell) {
  if (!shell.params) return;
  const values = Object.values(shell.params);
  const last = values[values.length - 1];
  expect(stubMarker(shell.route)).toHaveAttribute('data-param', Array.isArray(last) ? last.join('/') : last);
}

beforeEach(() => {
  nav.pathname = '/jobs';
  nav.replace = [];
  serverBrand.id = 'roboapply';
  mockAuthState.value = buildAuthValue();
});

describe('every §4.1.b route has a page', () => {
  const all = [...AUTH, PRACTICE_QUESTIONS, ...PUBLIC_GROUP, ...BARE, ...HYBRID];
  it.each([
    ...all.map((s) => s.dir),
    '(auth)/jobs/[id]',
    '(auth)/jobs/explore',
    '(onboarding)/onboarding',
    '(onboarding)/onboarding/[step]',
  ])('app/%s/page.tsx', (dir) => {
    expect(existsSync(join(ROOT, 'app', dir, 'page.tsx'))).toBe(true);
  });

  it('no coaching/bookings shell (V2 has no bookings data; WP-72 asserts the 404)', () => {
    expect(existsSync(join(ROOT, 'app/(auth)/coaching/bookings'))).toBe(false);
  });
});

describe('authenticated shells render inside the app shell', () => {
  it.each(AUTH.map((s) => [s.route, s] as const))('%s', async (_route, shell) => {
    // Behind the proxy's login gate.
    expect(isProtectedPath(shell.url)).toBe(true);
    if (!isStubPage(shell.dir)) return;
    nav.pathname = shell.url;
    const el = await pageElement(shell);
    renderWithBrand(<AuthLayout>{el}</AuthLayout>, { flags: {} });
    const marker = stubMarker(shell.route);
    expect(marker).toHaveAttribute('data-owner', shell.owner);
    expect(marker.closest('.main-inner')).not.toBeNull();
    expect(document.querySelector('aside.side')).not.toBeNull();
    expectParam(shell);
  });

  // /practice/questions is a static sibling of the live room /practice/[id];
  // isPracticeLivePath() keeps the shell for it (fixed at G2).
  it('/practice/questions keeps the app shell', async () => {
    if (!isStubPage(PRACTICE_QUESTIONS.dir)) return;
    nav.pathname = PRACTICE_QUESTIONS.url;
    renderWithBrand(<AuthLayout>{await pageElement(PRACTICE_QUESTIONS)}</AuthLayout>, { flags: {} });
    expect(stubMarker(PRACTICE_QUESTIONS.route).closest('.main-inner')).not.toBeNull();
  });

  it('/practice/questions still renders its stub and is gated', async () => {
    expect(isProtectedPath('/practice/questions')).toBe(true);
    if (!isStubPage(PRACTICE_QUESTIONS.dir)) return;
    renderWithBrand(await pageElement(PRACTICE_QUESTIONS), { flags: {} });
    expect(stubMarker('/practice/questions')).toHaveAttribute('data-owner', 'WP-59');
    expect(isProtectedPath('/practice/questions')).toBe(true);
  });

  it('/jobs/[id] hands the id to JobDetailPanel in page mode', async () => {
    if (!isStubPage('(auth)/jobs/[id]')) return;
    nav.pathname = '/jobs/cm_job9';
    renderWithBrand(<AuthLayout>{await pageElement({ dir: '(auth)/jobs/[id]', params: { id: 'cm_job9' } })}</AuthLayout>, { flags: {} });
    expect(stubMarker('/jobs/[id]')).toHaveAttribute('data-owner', 'WP-34');
    const panel = screen.getByTestId('job-panel');
    expect(panel).toHaveAttribute('data-job', 'cm_job9');
    expect(panel).toHaveAttribute('data-mode', 'page');
    expect(panel.closest('.main-inner')).not.toBeNull();
  });

  it('/jobs/explore serves the job search that /job-search used to', async () => {
    expect(isProtectedPath('/jobs/explore')).toBe(true);
    if (!readFileSync(join(ROOT, 'app/(auth)/jobs/explore/page.tsx'), 'utf8').includes('JobSearchWorkspace')) return;
    nav.pathname = '/jobs/explore';
    renderWithBrand(<AuthLayout>{await pageElement({ dir: '(auth)/jobs/explore' })}</AuthLayout>, { flags: {} });
    expect(screen.getByTestId('job-search-workspace').closest('.main-inner')).not.toBeNull();
    const layout = await import('../../app/(auth)/jobs/explore/layout');
    expect(typeof layout.generateMetadata).toBe('function');
    expect(isProtectedPath('/jobs/explore')).toBe(true);
  });
});

describe('onboarding shells', () => {
  it('the web stage list equals the server stage → route map', () => {
    for (const brand of ['roboapply', 'goapply'] as const) {
      const fromServer = Object.entries(ONBOARDING_STAGE_ROUTES[brand])
        .filter(([, route]) => route?.startsWith('/onboarding/'))
        .map(([stage, route]) => {
          expect(route).toBe(`/onboarding/${stage}`);
          return stage;
        });
      expect([...ONBOARDING_SCREEN_STAGES[brand]]).toEqual(fromServer);
    }
  });

  it.each([
    ['roboapply', 'situation'],
    ['roboapply', 'goal'],
    ['goapply', 'consent'],
    ['goapply', 'tags'],
    ['goapply', 'confirm'],
  ] as const)('%s /onboarding/%s renders inside the onboarding layout', async (brand, step) => {
    expect(isProtectedPath(`/onboarding/${step}`)).toBe(true);
    if (!isStubPage('(onboarding)/onboarding/[step]')) return;
    serverBrand.id = brand;
    nav.pathname = `/onboarding/${step}`;
    const el = await pageElement({ dir: '(onboarding)/onboarding/[step]', params: { step } });
    renderWithBrand(<OnboardingLayout>{el}</OnboardingLayout>, { brand, flags: {} });
    const marker = stubMarker('/onboarding/[step]');
    expect(marker).toHaveAttribute('data-owner', 'WP-30');
    expect(marker).toHaveAttribute('data-param', step);
    expect(marker.closest('[data-shell="onboarding"]')).not.toBeNull();
    expect(isProtectedPath(`/onboarding/${step}`)).toBe(true);
  });

  it.each([
    ['roboapply', 'consent'],
    ['roboapply', 'tour'],
    ['goapply', 'situation'],
    ['goapply', 'goal'],
    ['roboapply', 'account'],
    ['roboapply', 'nope'],
  ] as const)('%s /onboarding/%s is a 404', async (brand, step) => {
    if (!isStubPage('(onboarding)/onboarding/[step]')) return;
    serverBrand.id = brand;
    await expect(pageElement({ dir: '(onboarding)/onboarding/[step]', params: { step } })).rejects.toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
    });
  });

  it('/onboarding waits for the flags, then goes to the home destination', async () => {
    if (!isStubPage('(onboarding)/onboarding')) return;
    const Page = (await loadPage('(onboarding)/onboarding')).default as () => ReactElement;
    nav.pathname = '/onboarding';
    renderWithBrand(<Page />, { flags: null });
    expect(stubMarker('/onboarding')).toHaveAttribute('data-owner', 'WP-30');
    expect(nav.replace).toEqual([]);

    nav.replace = [];
    renderWithBrand(<Page />, { flags: { 'jobs.feed': true } });
    expect(nav.replace).toEqual(['/jobs']);
  });
});

describe('(public) sign-in group shells', () => {
  it.each(PUBLIC_GROUP.map((s) => [s.route, s] as const))('%s', async (_route, shell) => {
    expect(isProtectedPath(shell.url)).toBe(false);
    if (!isStubPage(shell.dir)) return;
    const mod = await loadPage(shell.dir);
    renderWithBrand(await pageElement(shell), { flags: {} });
    expect(stubMarker(shell.route)).toHaveAttribute('data-owner', shell.owner);
    expectParam(shell);
    expect(mod.metadata?.robots).toEqual({ index: false, follow: false });
    expect(isProtectedPath(shell.url)).toBe(false);
  });
});

describe('OAuth callback shells (no shell)', () => {
  it.each(BARE.map((s) => [s.route, s] as const))('%s', async (_route, shell) => {
    expect(isProtectedPath(shell.url)).toBe(false);
    if (!isStubPage(shell.dir)) return;
    const mod = await loadPage(shell.dir);
    renderWithBrand(await pageElement(shell), { flags: {} });
    expect(stubMarker(shell.route)).toHaveAttribute('data-owner', shell.owner);
    expect(document.querySelector('[data-shell]')).toBeNull();
    expect(mod.metadata?.robots).toEqual({ index: false, follow: false });
    expect(isProtectedPath(shell.url)).toBe(false);
  });
});

describe('public pages render in HybridShell', () => {
  it.each(HYBRID.map((s) => [s.route, s] as const))('%s', async (_route, shell) => {
    expect(isProtectedPath(shell.url)).toBe(false);
    if (!isStubPage(shell.dir)) return;
    const mod = await loadPage(shell.dir);
    expect(mod.metadata?.robots).toEqual({ index: false, follow: false });
    expect(isProtectedPath(shell.url)).toBe(false);
    nav.pathname = shell.url;

    // Signed out: marketing chrome, attributed signup link, legal footer.
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    const out = renderWithBrand(await pageElement(shell), { brand: 'goapply', flags: {} });
    const chrome = document.querySelector('[data-shell="marketing"]') as HTMLElement;
    expect(chrome).not.toBeNull();
    expect(chrome.contains(stubMarker(shell.route))).toBe(true);
    expect(stubMarker(shell.route)).toHaveAttribute('data-owner', shell.owner);
    expectParam(shell);
    expect(within(chrome).getByRole('link', { name: 'Get started' })).toHaveAttribute('href', `/signup?from=${shell.from}`);
    expect(within(chrome).getByTestId('legal-footer')).toBeInTheDocument();
    out.unmount();

    // Signed in: the app shell, no marketing chrome.
    mockAuthState.value = buildAuthValue();
    renderWithBrand(await pageElement(shell), { flags: {} });
    expect(stubMarker(shell.route).closest('.main-inner')).not.toBeNull();
    expect(document.querySelector('[data-shell="marketing"]')).toBeNull();
  });

  it('browse pages render the VisitorFeed seam', async () => {
    if (!isStubPage('browse/[...path]')) return;
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
    renderWithBrand(await pageElement(HYBRID.find((s) => s.dir === 'browse/[...path]')!), { flags: {} });
    expect(screen.getByTestId('visitor-feed')).toHaveAttribute('data-from', 'browse');
  });
});
