// FND-6a — the per-brand nav registry and the surfaces that render it
// (components/v3/shell/destinations.ts; PRODUCT_PLAN.md §3.3).
//
// Acceptance covered here:
//   • nav differs per brand;
//   • a flagged-off entry is absent (and a not-ready entry is absent unless
//     NEXT_PUBLIC_SHOW_ALL_NAV=true);
//   • a badge renders the hook's value and nothing for null;
//   • mobile shows 5 slots: 4 destinations + More (我的 on GoApply), and More
//     opens a sheet with the registry's `mobile: 'more'` entries.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';

import { mockAuthState, buildAuthValue, buildFakeUser } from '../utils/mockAuth';
import { renderWithBrand, flagsWith } from './helpers';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const pathnameRef = { current: '/jobs' };
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// Badge hooks: controllable per test (null = no badge).
const badgeValues = vi.hoisted(() => ({
  jobs: null as unknown,
  ready: null as unknown,
  applications: null as unknown,
  profile: null as unknown,
}));
vi.mock('../../hooks/feed/useJobsBadge', () => ({ useJobsBadge: () => badgeValues.jobs }));
vi.mock('../../hooks/agent/useReadyBadge', () => ({ useReadyBadge: () => badgeValues.ready }));
vi.mock('../../hooks/tracker/useApplicationsBadge', async (orig) => ({
  ...(await orig<typeof import('../../hooks/tracker/useApplicationsBadge')>()),
  useApplicationsBadge: () => badgeValues.applications,
}));
vi.mock('../../hooks/profile/useProfileBadge', () => ({ useProfileBadge: () => badgeValues.profile }));

import { Sidebar } from '../../components/v3/shell/Sidebar';
import { MobileNav } from '../../components/v3/shell/MobileNav';
import {
  NAV_ENTRIES,
  buildNav,
  crumbKeyFor,
  entriesForBrand,
  homeHref,
  jobHref,
  type NavVisibilityContext,
} from '../../components/v3/shell/destinations';
import { normalizeBadge } from '../../hooks/shared/navBadges';

const railHrefs = () =>
  within(screen.getByRole('navigation')).getAllByRole('link').map((l) => l.getAttribute('href'));

const ctx = (over: Partial<NavVisibilityContext> = {}): NavVisibilityContext => ({
  brandId: 'roboapply',
  flags: flagsWith(),
  isAdmin: false,
  showAll: false,
  coachRoster: false,
  ...over,
});

beforeEach(() => {
  pathnameRef.current = '/jobs';
  mockAuthState.value = buildAuthValue();
  badgeValues.jobs = null;
  badgeValues.ready = null;
  badgeValues.applications = null;
  badgeValues.profile = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registry (pure)', () => {
  it('every entry has a unique id per brand and a key in the nav namespace', () => {
    const ids = NAV_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const brand of ['roboapply', 'goapply'] as const) {
      const slots = entriesForBrand(brand)
        .map((e) => e.mobile)
        .filter((m): m is 1 | 2 | 3 | 4 => typeof m === 'number');
      expect(new Set(slots).size, `${brand} mobile slots are unique`).toBe(slots.length);
    }
  });

  it('RoboApply full IA follows PRODUCT §3.3 order when everything is on', () => {
    const nav = buildNav(ctx({ showAll: true, isAdmin: true, coachRoster: true, flags: flagsWith({ agent: true, coaching: true, invites: true, extension: true }) }));
    expect(nav.top.map((e) => e.href)).toEqual(['/jobs', '/ready', '/applications', '/resume', '/practice', '/profile']);
    expect(nav.lower.map((e) => e.href)).toEqual(['/coaching', '/invite', '/extension', '/settings', '/admin']);
    expect(nav.mobile.map((e) => e.href)).toEqual(['/jobs', '/applications', '/resume', '/practice']);
    expect(nav.more.map((e) => e.href)).toEqual(['/ready', '/profile', '/coaching', '/invite', '/settings']);
  });

  it('GoApply full IA: 职位 · 校招日历 · 待投递 · 投递记录 · 简历 · 面试练习 · 我的资料', () => {
    const nav = buildNav(
      ctx({
        brandId: 'goapply',
        showAll: true,
        flags: flagsWith({ 'jobs.feed': true, 'jobs.campusCalendar': true, agent: true, 'cn.referralCodes': true, invites: true }),
      }),
    );
    expect(nav.top.map((e) => e.href)).toEqual(['/jobs', '/campus', '/ready', '/applications', '/resume', '/practice', '/profile']);
    expect(nav.lower.map((e) => e.href)).toEqual(['/referrals', '/invite', '/settings']);
    // 职位 · 校招 · 投递 · 面试 (+ 我的)
    expect(nav.mobile.map((e) => e.href)).toEqual(['/jobs', '/campus', '/applications', '/practice']);
    // 简历, 资料, 待投递, 设置 live under 我的.
    expect(nav.more.map((e) => e.href)).toEqual(['/ready', '/resume', '/profile', '/referrals', '/invite', '/settings']);
  });

  it('the nav differs per brand', () => {
    const ra = buildNav(ctx({ flags: flagsWith({ 'jobs.feed': true }) })).all.map((e) => e.id);
    const ga = buildNav(ctx({ brandId: 'goapply', flags: flagsWith({ 'jobs.feed': true }) })).all.map((e) => e.id);
    expect(ra).toEqual(['jobs', 'applications', 'resume', 'practice', 'settings']);
    expect(ga).toEqual(['cn.jobs', 'cn.applications', 'cn.resume', 'cn.practice', 'cn.settings']);
    expect(ga.some((id) => ra.includes(id))).toBe(false);
  });

  it('a flagged-off entry is absent (GoApply 职位 without jobs.feed; 校招日历 without the calendar)', () => {
    const off = buildNav(ctx({ brandId: 'goapply', showAll: true, flags: flagsWith() }));
    expect(off.all.map((e) => e.href)).not.toContain('/jobs');
    expect(off.all.map((e) => e.href)).not.toContain('/campus');
    const on = buildNav(ctx({ brandId: 'goapply', showAll: true, flags: flagsWith({ 'jobs.campusCalendar': true }) }));
    expect(on.top[0].href).toBe('/campus');
  });

  it('flags fail closed: nothing flagged shows before the flags arrive', () => {
    const nav = buildNav(ctx({ flags: null, showAll: true }));
    expect(nav.all.every((e) => e.flag === null)).toBe(true);
  });

  it('not-ready entries need the dev override; gates need admin / a coach roster', () => {
    const flags = flagsWith({ agent: true, coaching: true });
    expect(buildNav(ctx({ flags })).all.map((e) => e.id)).not.toContain('ready');
    expect(buildNav(ctx({ flags, showAll: true })).all.map((e) => e.id)).toContain('ready');
    expect(buildNav(ctx({ flags, showAll: true })).all.map((e) => e.id)).not.toContain('coaching');
    expect(buildNav(ctx({ flags, showAll: true, coachRoster: true })).all.map((e) => e.id)).toContain('coaching');
    expect(buildNav(ctx({ flags })).all.map((e) => e.id)).not.toContain('admin');
    expect(buildNav(ctx({ flags, isAdmin: true })).all.map((e) => e.id)).toContain('admin');
  });

  it('crumbs come from the registry, most specific first; unknown paths get none', () => {
    expect(crumbKeyFor('/settings/billing/history', 'roboapply')).toBe('billing');
    expect(crumbKeyFor('/settings', 'roboapply')).toBe('settings');
    expect(crumbKeyFor('/job-search/developers', 'roboapply')).toBe('jobs');
    expect(crumbKeyFor('/practice/cm1/report', 'goapply')).toBe('cn_practice');
    expect(crumbKeyFor('/campus/acme', 'goapply')).toBe('campus');
    expect(crumbKeyFor('/assistant', 'roboapply')).toBe('assistant');
    expect(crumbKeyFor('/nowhere', 'roboapply')).toBeNull();
  });

  it('home is the first visible top entry (GoApply falls back to the calendar when the feed is off)', () => {
    expect(homeHref(buildNav(ctx()))).toBe('/jobs');
    const cnOff = buildNav(ctx({ brandId: 'goapply', showAll: true, flags: flagsWith({ 'jobs.campusCalendar': true }) }));
    expect(homeHref(cnOff)).toBe('/campus');
    expect(homeHref(buildNav(ctx({ brandId: 'goapply', flags: flagsWith() })))).toBe('/applications');
  });

  it('palette job hits go to the feed until the detail page ships, /jobs/[id] after', () => {
    expect(jobHref('cm_1', false)).toBe('/jobs');
    expect(jobHref('cm 1', true)).toBe('/jobs/cm%201');
  });

  it('badge values: zero and negative are no badge', () => {
    expect(normalizeBadge({ kind: 'count', count: 0 })).toBeNull();
    expect(normalizeBadge({ kind: 'count', count: -2 })).toBeNull();
    expect(normalizeBadge({ kind: 'count', count: 3.7 })).toEqual({ kind: 'count', count: 3 });
    expect(normalizeBadge({ kind: 'dot' })).toEqual({ kind: 'dot' });
    expect(normalizeBadge(null)).toBeNull();
  });
});

describe('Sidebar per brand', () => {
  it('RoboApply and GoApply render different rails', () => {
    const { unmount } = renderWithBrand(<Sidebar />, { brand: 'roboapply', flags: { 'jobs.feed': true } });
    expect(railHrefs()).toEqual(['/jobs', '/applications', '/resume', '/practice', '/settings']);
    expect(screen.getByRole('link', { name: 'Interview prep' })).toBeInTheDocument();
    unmount();

    renderWithBrand(<Sidebar />, { brand: 'goapply', flags: { 'jobs.feed': true } });
    expect(railHrefs()).toEqual(['/jobs', '/applications', '/resume', '/practice', '/settings']);
    // GoApply's own label (面试练习 in zh; English until INT translates).
    expect(screen.getByRole('link', { name: 'Interview practice' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Interview prep' })).not.toBeInTheDocument();
  });

  it('GoApply hides 职位 when the job feed is off', () => {
    renderWithBrand(<Sidebar />, { brand: 'goapply', flags: {} });
    expect(railHrefs()).toEqual(['/applications', '/resume', '/practice', '/settings']);
  });

  it('shows not-ready entries only with NEXT_PUBLIC_SHOW_ALL_NAV, and still only when flagged on', () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    renderWithBrand(<Sidebar />, { flags: { agent: true, invites: true } });
    const hrefs = railHrefs();
    expect(hrefs).toContain('/ready');
    expect(hrefs).toContain('/profile');
    expect(hrefs).toContain('/invite');
    // extension and coaching flags are off → absent.
    expect(hrefs).not.toContain('/extension');
    expect(hrefs).not.toContain('/coaching');
  });

  it('a badge renders the hook value; null renders nothing', () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    badgeValues.jobs = { kind: 'count', count: 7 };
    badgeValues.ready = null;
    badgeValues.applications = { kind: 'count', count: 2 };
    badgeValues.profile = { kind: 'dot' };
    renderWithBrand(<Sidebar />, { flags: { agent: true } });

    const jobs = screen.getByRole('link', { name: /^Jobs/ });
    expect(within(jobs).getByText('7')).toHaveClass('count');
    expect(within(jobs).getByText('7 new jobs that fit since your last visit')).toBeInTheDocument();

    const ready = screen.getByRole('link', { name: /^Ready to apply/ });
    expect(ready.querySelector('.count')).toBeNull();
    expect(ready.textContent).toBe('Ready to apply');

    expect(within(screen.getByRole('link', { name: /^Applications/ })).getByText('2 with no reply in 10 days')).toBeInTheDocument();
    expect(within(screen.getByRole('link', { name: /^Profile/ })).getByText('Your profile is missing details')).toBeInTheDocument();

    for (const label of ['Resume', 'Interview prep', 'Settings']) {
      expect(screen.getByRole('link', { name: label }).querySelector('.count')).toBeNull();
    }
  });
});

describe('MobileNav per brand', () => {
  it('RoboApply: 5 slots — Jobs · Applications · Resume · Interview prep · More', () => {
    renderWithBrand(<MobileNav />, { flags: {} });
    const bar = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(bar).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Jobs',
      'Applications',
      'Resume',
      'Interview prep',
    ]);
    expect(within(bar).getByRole('button', { name: 'More' })).toBeInTheDocument();
    expect(bar).toHaveAttribute('data-slots', '5');
  });

  it('GoApply: 5 slots — 职位 · 校招 · 投递 · 面试 · 我的', () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    renderWithBrand(<MobileNav />, { brand: 'goapply', flags: { 'jobs.feed': true, 'jobs.campusCalendar': true } });
    const bar = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(bar).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      '/jobs',
      '/campus',
      '/applications',
      '/practice',
    ]);
    expect(within(bar).getAllByRole('link').map((l) => l.textContent)).toEqual(['Jobs', 'Campus', 'Applied', 'Interview']);
    expect(within(bar).getByRole('button', { name: 'Me' })).toBeInTheDocument();
    expect(bar).toHaveAttribute('data-slots', '5');
  });

  it('More opens a sheet with the brand’s More entries; a link closes it', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    renderWithBrand(<MobileNav />, { brand: 'goapply', flags: { agent: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Me' }));
    const sheet = await screen.findByRole('dialog', { name: 'Me' });
    expect(within(sheet).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      '/ready',
      '/resume',
      '/profile',
      '/settings',
    ]);
    act(() => {
      fireEvent.click(within(sheet).getByRole('link', { name: 'Resume' }));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a slot badge renders the hook value with a sentence; null renders nothing', () => {
    badgeValues.applications = { kind: 'count', count: 4 };
    renderWithBrand(<MobileNav />, { flags: {} });
    const apps = screen.getByRole('link', { name: /Applications/ });
    expect(within(apps).getByText('4')).toBeInTheDocument();
    expect(within(apps).getByText('4 with no reply in 10 days')).toHaveClass('sr-only');
    expect(within(screen.getByRole('link', { name: /^Jobs/ })).queryByText(/\d/)).toBeNull();
  });

  it('admins never get Admin on the bottom bar', () => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
    renderWithBrand(<MobileNav />, { flags: {} });
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
  });
});
