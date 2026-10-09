// FND-6a — the /settings section registry and frame
// (components/features/settings; PRODUCT_PLAN.md §3.4, F-ACCT-05).
//
// Acceptance: the settings page renders sections from the registry in
// PRODUCT §3.4 order — #account #security #notifications #billing #credits
// #privacy #appearance (+ #consents on GoApply) … #danger — plus #search
// #assistant #devices #connections #referrals #sensitive. The Danger zone
// stays last (PRODUCT's eight keep their relative order; additions sit before
// the destructive section).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';

import { mockAuthState, buildAuthValue } from '../utils/mockAuth';
import { renderWithBrand, flagsWith } from './helpers';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import {
  SETTINGS_REGISTRY,
  SECTION_COMPONENTS,
  SettingsPage,
  activeSectionFor,
  sectionIdFromHash,
  settingsHref,
  visibleSettingsSections,
} from '../../components/features/settings';

const ALL_ORDER = [
  'account',
  'security',
  'notifications',
  'billing',
  'credits',
  'privacy',
  'appearance',
  'consents',
  'search',
  'assistant',
  'devices',
  'connections',
  'referrals',
  'sensitive',
  'danger',
];

const sectionHrefs = () =>
  within(screen.getByRole('navigation', { name: 'Settings' }))
    .getAllByRole('link')
    .map((l) => l.getAttribute('href'));

beforeEach(() => {
  mockAuthState.value = buildAuthValue();
  window.history.replaceState(null, '', '/settings');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of Object.keys(SECTION_COMPONENTS)) delete (SECTION_COMPONENTS as Record<string, unknown>)[k];
});

describe('registry (pure)', () => {
  it('holds every section once, in PRODUCT §3.4 order with the additions before the Danger zone', () => {
    expect(SETTINGS_REGISTRY.map((s) => s.id)).toEqual(ALL_ORDER);
    const product = ['account', 'security', 'notifications', 'billing', 'credits', 'privacy', 'appearance', 'danger'];
    const ids = SETTINGS_REGISTRY.map((s) => s.id as string);
    expect(product.map((id) => ids.indexOf(id))).toEqual([...product.map((id) => ids.indexOf(id))].sort((a, b) => a - b));
    expect(SETTINGS_REGISTRY.at(-1)).toMatchObject({ id: 'danger', danger: true });
  });

  it('consents exist on GoApply only', () => {
    const everything = flagsWith({ copilot: true, extension: true, invites: true, hiringContacts: 'on' });
    const ra = visibleSettingsSections({ brandId: 'roboapply', flags: everything, showAll: true }).map((s) => s.id);
    const ga = visibleSettingsSections({ brandId: 'goapply', flags: everything, showAll: true }).map((s) => s.id);
    expect(ra).toEqual(ALL_ORDER.filter((id) => id !== 'consents'));
    expect(ga).toEqual(ALL_ORDER);
  });

  it('flags gate assistant, devices, connections and referrals (fail closed)', () => {
    const ids = (flags: ReturnType<typeof flagsWith> | null) =>
      visibleSettingsSections({ brandId: 'roboapply', flags, showAll: true }).map((s) => s.id);
    expect(ids(flagsWith()).filter((id) => ['assistant', 'devices', 'connections', 'referrals'].includes(id))).toEqual([]);
    expect(ids(null).filter((id) => ['assistant', 'devices', 'connections', 'referrals'].includes(id))).toEqual([]);
    expect(ids(flagsWith({ copilot: true }))).toContain('assistant');
    expect(ids(flagsWith({ hiringContacts: 'deeplinks_only' }))).not.toContain('connections');
    expect(ids(flagsWith({ hiringContacts: 'on' }))).toContain('connections');
  });

  it('sections whose owner has not shipped stay hidden without the dev override', () => {
    const ids = visibleSettingsSections({ brandId: 'goapply', flags: flagsWith({ copilot: true }), showAll: false }).map((s) => s.id);
    // consents (WP-13, GoApply only) and sensitive (WP-19) shipped in Wave 2.
    expect(ids).toEqual(['account', 'security', 'notifications', 'billing', 'credits', 'privacy', 'appearance', 'consents', 'search', 'sensitive', 'danger']);
  });

  it('old hashes still open their section; unknown or hidden ones fall back to the first', () => {
    expect(sectionIdFromHash('#notif')).toBe('notifications');
    expect(sectionIdFromHash('resume')).toBe('search');
    expect(sectionIdFromHash('#account?verified=1')).toBe('account');
    expect(sectionIdFromHash('#nope')).toBeNull();
    const visible = ['account', 'billing', 'danger'] as const;
    expect(activeSectionFor('/settings', '#danger', visible)).toBe('danger');
    expect(activeSectionFor('/settings', '#consents', visible)).toBe('account');
    expect(activeSectionFor('/settings', '', visible)).toBe('account');
    expect(activeSectionFor('/settings/billing/history', '', visible)).toBe('billing');
    expect(activeSectionFor('/settings', '', [])).toBeNull();
    expect(settingsHref('credits')).toBe('/settings#credits');
  });
});

describe('<SettingsPage>', () => {
  it('renders the section row from the registry, in order (RoboApply, everything on)', () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    renderWithBrand(<SettingsPage />, {
      flags: { copilot: true, extension: true, invites: true, hiringContacts: 'on' },
    });
    expect(sectionHrefs()).toEqual(ALL_ORDER.filter((id) => id !== 'consents').map((id) => `#${id}`));
    expect(screen.getByRole('link', { name: 'Danger zone' })).toHaveClass('danger');
  });

  it('adds #consents on GoApply', () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    renderWithBrand(<SettingsPage />, {
      brand: 'goapply',
      flags: { copilot: true, extension: true, invites: true, hiringContacts: 'on' },
    });
    expect(sectionHrefs()).toEqual(ALL_ORDER.map((id) => `#${id}`));
    expect(screen.getByRole('link', { name: 'Consents' })).toHaveAttribute('href', '#consents');
  });

  it('renders the route’s content for the open section, else the area component', async () => {
    window.history.replaceState(null, '', '/settings#billing');
    const { unmount } = renderWithBrand(
      <SettingsPage renderers={{ billing: () => <p>billing body</p>, account: () => <p>account body</p> }} />,
    );
    expect(screen.getByText('billing body')).toBeInTheDocument();
    expect(screen.queryByText('account body')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Plan and billing' })).toHaveAttribute('aria-current', 'page');
    unmount();

    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    (SECTION_COMPONENTS as Record<string, unknown>).sensitive = ({ section }: { section: string }) => <p>area says {section}</p>;
    window.history.replaceState(null, '', '/settings#sensitive');
    renderWithBrand(<SettingsPage />);
    expect(screen.getByText('area says sensitive')).toBeInTheDocument();
  });

  it('shows the loading line instead of a body while the route loads', () => {
    renderWithBrand(<SettingsPage loading renderers={{ account: () => <p>account body</p> }} />);
    expect(screen.getByText('Loading your settings…')).toBeInTheDocument();
    expect(screen.queryByText('account body')).not.toBeInTheDocument();
  });
});
