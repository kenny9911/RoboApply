// INT-12 — WP-93 "no dead ends" (TASK_PLAN.md §9), web side.
//
// Nothing a signed-in or signed-out user can click may lead to a stub. For
// every entry point the shell and the marketing chrome offer, on both brands:
//   1. a page file exists under app/ for its href;
//   2. that page is not an FND-6b route shell (`data-route-stub`);
//   3. no component the page renders is an FND stub (`STUB (FND…)` header) or
//      a component whose whole body is `return null`.
//
// Entry points audited:
//   • components/v3/shell/destinations.ts — every nav entry of both brands
//     (the Sidebar, the bottom bar, the More sheet and the ⌘K palette render
//     this one list), the palette's job target and the Topbar crumbs;
//   • the Topbar buttons: Ask (the Assistant rail) and the message center;
//   • the AvatarMenu;
//   • components/features/settings/registry.ts — every section has content;
//   • components/v3/admin/AdminNav.tsx — every admin area;
//   • components/features/marketing/SiteChrome.tsx — the marketing nav and
//     footer links (read-only here; a finding is a fix request to its owner).
// Then the same thing from the DOM: every link the shell actually renders,
// with every flag on, resolves to a real page.
//
// The server half is server/src/features/noStubRoutes.test.ts; the login gate
// half is __tests__/lib/proxyPaths.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import { mockAuthState, buildAuthValue, buildFakeUser } from '../utils/mockAuth';
import {
  appRoutes,
  auditPage,
  definingFile,
  isStubSource,
  readSource,
  rendersNullByDesign,
  renderWithBrand,
  routeFor,
  sourceExists,
} from './helpers';

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

// The roster gate asks the coaching API; give it one coach so Coaching renders.
vi.mock('../../lib/api/coaching', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/coaching')>()),
  listCoaches: async () => ({ items: [{ id: 'c1' }] }),
}));

import { NAV_ENTRIES, SURFACES_READY, crumbKeyFor, entriesForBrand, jobHref } from '../../components/v3/shell/destinations';
import { Sidebar } from '../../components/v3/shell/Sidebar';
import { MobileNav } from '../../components/v3/shell/MobileNav';
import { Topbar } from '../../components/v3/shell/Topbar';
import { CommandPaletteProvider } from '../../components/v3/shell/CommandPalette';
import { SETTINGS_REGISTRY, SECTION_COMPONENTS, SECTION_EXTRAS, settingsHref } from '../../components/features/settings';
import { ADMIN_AREAS, adminAreasFor } from '../../components/v3/admin/AdminNav';
import { FEATURES, popularListHref } from '../../components/features/marketing';
import { isProtectedPath } from '../../lib/proxyPaths';
import { FLAG_KEYS } from '../../server/src/platform/flags';

const BRANDS = ['roboapply', 'goapply'] as const;

/** Every boolean capability on. */
const EVERYTHING = { ...Object.fromEntries(FLAG_KEYS.map((k) => [k, true])), hiringContacts: 'on' } as never;

/** A page for `href` exists and is not a dead end; returns the page file. */
function expectLivePage(href: string, where: string): string {
  const route = routeFor(href);
  expect(route, `${where}: no page for ${href}`).not.toBeNull();
  const audit = auditPage(route!.file);
  expect(audit.problems, `${where}: ${href} → ${route!.file}`).toEqual([]);
  return route!.file;
}

beforeEach(() => {
  pathnameRef.current = '/jobs';
  mockAuthState.value = buildAuthValue();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the audit itself can see a dead end (guards against passing vacuously)', () => {
  it('resolves hrefs like the App Router: static beats dynamic, groups are invisible, unknown is null', () => {
    expect(appRoutes().length).toBeGreaterThan(60);
    expect(routeFor('/jobs')?.file).toBe('app/(auth)/jobs/page.tsx');
    expect(routeFor('/jobs/report')?.file).toBe('app/(auth)/jobs/report/page.tsx');
    expect(routeFor('/jobs/cm_1')?.file).toBe('app/(auth)/jobs/[id]/page.tsx');
    expect(routeFor('/practice/questions')?.file).toBe('app/(auth)/practice/questions/page.tsx');
    expect(routeFor('/practice/questions/acme?job=cm1')?.file).toBe('app/(auth)/practice/questions/[company]/page.tsx');
    expect(routeFor('/settings#billing')?.file).toBe('app/(auth)/settings/page.tsx');
    expect(routeFor('/browse/data-analyst/taipei')?.file).toBe('app/browse/[...path]/page.tsx');
    expect(routeFor('/browse')?.file).toBe('app/browse/page.tsx');
    expect(routeFor('/')?.file).toBe('app/page.tsx');
    expect(routeFor('/#features')?.file).toBe('app/page.tsx');
    expect(routeFor('/zh-TW')?.file).toBe('app/[locale]/page.tsx');
    expect(routeFor('/nowhere')).toBeNull();
    expect(routeFor('/coaching/bookings')).toBeNull();
    expect(routeFor('/job-search')).toBeNull(); // the old search page is gone (next.config redirects the bare path)
  });

  it('recognises a stub header, a route-stub marker and a component that renders nothing by design', () => {
    expect(/\bSTUB(?: SEAM)? \(FND/.test('// x.ts — STUB (FND-6b). Owner: WP-1.')).toBe(true);
    // The one remaining FND stub header in the repo is server-side (no route: an empty worker list).
    expect(isStubSource('server/src/features/extension/workers.ts')).toBe(true);
    expect(isStubSource('components/v3/shell/Sidebar.tsx')).toBe(false);
    // rendersNullByDesign reads real source: a component with a real body is not flagged.
    expect(rendersNullByDesign('components/v3/shell/Sidebar.tsx', 'Sidebar')).toBe(false);
    const audit = auditPage('app/(auth)/ready/page.tsx');
    expect(audit.components).toEqual([{ name: 'ReadyPage', file: definingFile('components/features/agent/index.ts', 'ReadyPage') }]);
    expect(audit.components[0].file).not.toBe('components/features/agent/index.ts'); // followed the re-export
  });
});

describe('nav entries (destinations.ts → Sidebar, bottom bar, More sheet, ⌘K)', () => {
  it.each(NAV_ENTRIES.map((e) => [e.id, e] as const))('%s → a real page', (_id, entry) => {
    expectLivePage(entry.href, `nav ${entry.id}`);
    expect(entry.ready, `${entry.id} is flipped`).toBe(true);
  });

  it('every signed-in destination is behind the login gate; the hybrid ones are public pages', () => {
    for (const e of NAV_ENTRIES) {
      const route = routeFor(e.href)!;
      expect(isProtectedPath(e.href), e.id).toBe(route.signedIn);
    }
    // /campus (GoApply) and /extension (RoboApply) are public pages signed-in users also use (R-23).
    expect(NAV_ENTRIES.filter((e) => !isProtectedPath(e.href)).map((e) => e.href).sort()).toEqual(['/campus', '/extension']);
  });

  it('both brands have a full IA and no entry of one brand leaks into the other', () => {
    for (const brand of BRANDS) {
      const entries = entriesForBrand(brand);
      expect(entries.length).toBeGreaterThanOrEqual(10);
      expect(entries.every((e) => e.brands.includes(brand))).toBe(true);
      for (const e of entries) expectLivePage(e.href, `${brand} nav ${e.id}`);
    }
  });

  it('the surfaces beside the nav: the palette’s job page and the crumb pages', () => {
    expect(SURFACES_READY).toEqual({ assistant: true, jobDetail: true });
    expectLivePage(jobHref('cm_job1', false), 'palette job hit');
    for (const [path, key] of [
      ['/assistant', 'assistant'],
      ['/inbox', 'inbox'],
      ['/settings/billing/history', 'billing'],
    ] as const) {
      expect(crumbKeyFor(path, 'roboapply')).toBe(key);
      expectLivePage(path, `crumb ${key}`);
    }
  });
});

describe('Topbar buttons: Ask and the message center', () => {
  it('Ask opens the Assistant rail, which is mounted by both layouts and is not a stub', () => {
    const rail = 'components/features/copilot/CopilotRail.tsx';
    expect(isStubSource(rail)).toBe(false);
    expect(rendersNullByDesign(rail, 'CopilotRail')).toBe(false);
    expect(readSource('app/(auth)/layout.tsx')).toMatch(/<CopilotRail \/>/);
    expect(readSource('components/v3/shell/HybridShell.tsx')).toMatch(/<CopilotRail \/>/);
    expect(readSource('components/v3/shell/Topbar.tsx')).toMatch(/openAssistant\(\{ source: 'topbar' \}\)/);
    // "Open in full page" from the rail.
    expectLivePage('/assistant', 'Assistant full page');
  });

  it('the message center button is real and its "Open inbox" goes to a real page', () => {
    const button = 'components/features/notifications/MessageCenterButton.tsx';
    expect(isStubSource(button)).toBe(false);
    expect(rendersNullByDesign(button, 'MessageCenterButton')).toBe(false);
    expect(readSource(button)).toMatch(/href="\/inbox"/);
    expectLivePage('/inbox', 'message center');
  });
});

describe('AvatarMenu', () => {
  it('every link in the menu is a real page; Sign out is a button with a handler', () => {
    const source = readSource('components/v3/shell/AvatarMenu.tsx');
    const hrefs = [...source.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]!);
    expect(hrefs).toEqual(['/settings', '/settings#billing']);
    for (const href of hrefs) expectLivePage(href, 'avatar menu');
    expect(source).toMatch(/onClick=\{\(\) => void signOut\(\)\}/);
    // Billing is a settings section that exists on both brands.
    expect(SETTINGS_REGISTRY.find((s) => s.id === 'billing')).toMatchObject({ brands: ['roboapply', 'goapply'], ready: true });
  });
});

describe('settings sections (registry.ts)', () => {
  const ROUTE_RENDERED: Record<string, string> = {
    account: 'components/v3/preferences/sections/IdentitySection.tsx',
    security: 'components/v3/account/security.tsx',
    danger: 'components/v3/preferences/sections/DangerSection.tsx',
  };

  it.each(SETTINGS_REGISTRY.map((s) => [s.id, s] as const))('#%s has content that is not a stub', (id, section) => {
    expectLivePage(settingsHref(section.id), `settings #${id}`);
    expect(section.ready, `#${id} is flipped`).toBe(true);
    const component = SECTION_COMPONENTS[section.id];
    if (component) {
      const file = `components/features/${section.owner}/SettingsSection.tsx`;
      expect(sourceExists(file), `#${id}: ${file}`).toBe(true);
      expect(isStubSource(file), `#${id}: ${file} is an FND stub`).toBe(false);
      expect(rendersNullByDesign(file, 'SettingsSection'), `#${id}: ${file} renders nothing by design`).toBe(false);
    } else {
      const file = ROUTE_RENDERED[id];
      expect(file, `#${id} has neither an area component nor a route renderer`).toBeDefined();
      expect(isStubSource(file!)).toBe(false);
      expect(readSource('app/(auth)/settings/page.tsx')).toMatch(new RegExp(`\\b${id}: `));
    }
  });

  it('the blocks mounted inside a section are real components', () => {
    const files: Record<string, [string, string]> = {
      'finish-setup': ['components/features/onboarding/FirstVisitPrompts.tsx', 'FinishSetupSettingsLine'],
      'two-factor': ['components/features/account-v2/TwoFactorSettings.tsx', 'TwoFactorSettings'],
      'change-phone': ['components/features/auth-cn/ChangePhoneSection.tsx', 'ChangePhoneSection'],
    };
    const extras = Object.values(SECTION_EXTRAS).flatMap((list) => list ?? []);
    expect(extras.map((e) => e.id).sort()).toEqual(Object.keys(files).sort());
    for (const extra of extras) {
      const [file, name] = files[extra.id]!;
      expect(isStubSource(file), extra.id).toBe(false);
      expect(rendersNullByDesign(file, name), extra.id).toBe(false);
      expect(typeof extra.component).toBe('function');
    }
  });

  it('the links the settings sections point at exist (invoices, the invite page, the return page)', () => {
    for (const href of ['/settings/billing/history', '/settings/billing/return', '/settings/billing', '/invite', '/cancel', '/onboarding']) {
      expectLivePage(href, 'settings link');
    }
  });
});

describe('admin areas (AdminNav.tsx)', () => {
  it.each(ADMIN_AREAS.map((a) => [a.id, a] as const))('%s → a real page behind the gate', (_id, area) => {
    expectLivePage(area.href, `admin ${area.id}`);
    expect(isProtectedPath(area.href)).toBe(true);
  });

  it('each brand’s admin sees only its own areas, and every admin page has an area (none is orphaned)', () => {
    // `inviteRewards` (held invite rewards, /admin/reports/invites) joined on both brands at the INT gate (INT-08).
    expect(adminAreasFor('roboapply').map((a) => a.id)).toEqual(['overview', 'system', 'reports', 'inviteRewards', 'credits', 'announcements', 'questions', 'coaches', 'sources']);
    expect(adminAreasFor('goapply').map((a) => a.id)).toEqual(['overview', 'system', 'reports', 'inviteRewards', 'credits', 'announcements', 'questions', 'coaches', 'campus', 'fraud', 'invites']);
    const listed = new Set(ADMIN_AREAS.map((a) => a.href));
    const topLevelAdminPages = appRoutes()
      .filter((r) => r.segments[0] === 'admin' && r.segments.length <= 2 && !r.segments.some((s) => s.startsWith('[')))
      .map((r) => `/${r.segments.join('/')}`);
    expect(topLevelAdminPages.filter((p) => !listed.has(p))).toEqual([]);
  });
});

describe('marketing nav and footer (SiteChrome.tsx, read-only)', () => {
  const source = readSource('components/features/marketing/SiteChrome.tsx');

  it('every literal link is a real, public page', () => {
    const hrefs = [...new Set([...source.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]!))];
    expect(hrefs.sort()).toEqual(['/#features', '/about', '/help', '/help/ranking', '/login', '/pricing', '/security', '/tools']);
    for (const href of hrefs) {
      expectLivePage(href, 'marketing chrome');
      expect(isProtectedPath(href.split('#')[0] || '/'), href).toBe(false);
    }
  });

  it('every feature link in the footer has its page, and "Popular job lists" go to browse pages', () => {
    expect(FEATURES.length).toBeGreaterThan(0);
    for (const def of FEATURES) expectLivePage(`/features/${def.slug}`, `footer feature ${def.key}`);
    expect(routeFor(popularListHref('data_analyst'))?.file).toBe('app/browse/[...path]/page.tsx');
    expectLivePage(popularListHref('data_analyst'), 'footer popular list');
    // Sign-up and sign-in targets of the chrome.
    for (const href of ['/signup', '/login', '/legal/privacy', '/legal/terms', '/tools', '/browse']) expectLivePage(href, 'marketing target');
  });
});

describe('what the shell actually renders (every flag on, admin, both brands)', () => {
  /** Every in-app link currently in the document. */
  const hrefsIn = (root: ParentNode = document) =>
    [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].map((a) => a.getAttribute('href')!).filter((h) => h.startsWith('/'));

  it.each(BRANDS)('%s: the rail, the bottom bar, the More sheet, the avatar menu and the palette only link to real pages', async (brand) => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
    vi.stubEnv('NEXT_PUBLIC_EXT_ID', 'ext-store-id'); // the extension is published
    renderWithBrand(
      <CommandPaletteProvider>
        <Sidebar />
        <Topbar />
        <MobileNav />
      </CommandPaletteProvider>,
      { brand, flags: EVERYTHING },
    );

    // The roster arrives → Coaching joins the RoboApply rail.
    if (brand === 'roboapply') expect(await screen.findByRole('link', { name: 'Coaching' })).toHaveAttribute('href', '/coaching');

    const seen = new Set(hrefsIn());

    fireEvent.click(screen.getByRole('button', { name: brand === 'goapply' ? 'Me' : 'More' }));
    const sheet = await screen.findByRole('dialog');
    for (const h of hrefsIn(sheet)) seen.add(h);
    fireEvent.keyDown(sheet, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Your account' }));
    for (const h of hrefsIn(screen.getByRole('menu'))) seen.add(h);

    // Every nav destination of the brand is in what rendered (nothing ready is missing from the UI)…
    const expected = entriesForBrand(brand)
      .filter((e) => e.gate !== 'invitesLive' || brand === 'roboapply')
      .map((e) => e.href);
    for (const href of expected) expect([...seen], `${brand}: ${href} is not rendered anywhere`).toContain(href);

    // …and every rendered link leads to a real page.
    expect(seen.size).toBeGreaterThanOrEqual(expected.length);
    for (const href of seen) expectLivePage(href, `${brand} rendered link`);

    // The palette offers the same destinations, as buttons that route to them.
    fireEvent.click(screen.getAllByRole('button', { name: 'Search jobs and companies' })[0]);
    const palette = screen.getByRole('dialog', { name: 'Search and jump to' });
    expect(within(palette).getAllByRole('button').length).toBeGreaterThanOrEqual(expected.length);
  });

  it('no button in the Topbar is without a handler or a label', () => {
    renderWithBrand(
      <CommandPaletteProvider>
        <Topbar />
      </CommandPaletteProvider>,
      { flags: EVERYTHING },
    );
    const buttons = within(document.querySelector('.topbar') as HTMLElement).getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const b of buttons) expect((b.getAttribute('aria-label') ?? b.textContent ?? '').trim(), b.outerHTML.slice(0, 80)).not.toBe('');
    expect(screen.getByRole('button', { name: 'Ask the assistant' })).toBeInTheDocument();
  });
});

describe('every page under app/ is a real page', () => {
  it.each(appRoutes().map((r) => [r.file, r] as const))('%s', (_file, route) => {
    expect(auditPage(route.file).problems).toEqual([]);
  });
});
