// FND-6a — the /settings section registry and frame
// (components/features/settings; PRODUCT_PLAN.md §3.4, F-ACCT-05).
//
// Acceptance: the settings page renders sections from the registry in
// PRODUCT §3.4 order — #account #security #notifications #billing #credits
// #privacy #appearance (+ #consents on GoApply) … #danger — plus #search
// #assistant #devices #connections #referrals #sensitive. The Danger zone
// stays last (PRODUCT's eight keep their relative order; additions sit before
// the destructive section).
//
// INT-12 (WP-93):
//   • assistant, devices, connections and referrals are flipped to ready and
//     show with their flag, per brand, with no dev override; connections shows
//     whenever hiringContacts is not 'off';
//   • every section has an owner: the area component in SECTION_COMPONENTS
//     (notifications and search included) or one of the three route renderers;
//   • the frame mounts the area blocks that sit inside a section
//     (SECTION_EXTRAS): the finish-setup line in #account, two-step sign-in in
//     #security and, on GoApply only, the phone number block.

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

// The three area blocks the frame mounts inside a section, as markers: their
// own behaviour (hide while unavailable, phone flows) is tested by their areas.
vi.mock('../../components/features/account-v2', async (orig) => ({
  ...(await orig<typeof import('../../components/features/account-v2')>()),
  TwoFactorSettings: () => <i data-testid="two-factor" />,
}));
vi.mock('../../components/features/auth-cn', async (orig) => ({
  ...(await orig<typeof import('../../components/features/auth-cn')>()),
  ChangePhoneSection: () => <i data-testid="change-phone" />,
}));
vi.mock('../../components/features/onboarding', async (orig) => ({
  ...(await orig<typeof import('../../components/features/onboarding')>()),
  FinishSetupSettingsLine: () => <i data-testid="finish-setup" />,
}));

import {
  SETTINGS_REGISTRY,
  SECTION_COMPONENTS,
  SECTION_EXTRAS,
  SettingsPage,
  activeSectionFor,
  sectionExtrasFor,
  sectionIdFromHash,
  settingsHref,
  visibleSettingsSections,
  type SettingsSectionEntry,
} from '../../components/features/settings';
import { INVITE_REWARD_BRANDS } from '../../hooks/growth/useInvites';
import { TwoFactorSettings } from '../../components/features/account-v2';
import { ChangePhoneSection } from '../../components/features/auth-cn';
import { BrandSettingsSection } from '../../components/features/brand';
import { ComplianceSettingsSection } from '../../components/features/compliance';
import { CopilotSettingsSection } from '../../components/features/copilot';
import { CreditsSettingsSection } from '../../components/features/credits';
import { ExtensionSettingsSection } from '../../components/features/extension';
import { GrowthSettingsSection } from '../../components/features/growth';
import { NetworkSettingsSection } from '../../components/features/network';
import { NotificationsSettingsSection } from '../../components/features/notifications';
import { FinishSetupSettingsLine } from '../../components/features/onboarding';
import { ProfileSettingsSection } from '../../components/features/profile';
import { SearchSettingsSection } from '../../components/features/search';

/** The registered components as shipped (some tests swap one in and out). */
const SHIPPED_COMPONENTS = { ...SECTION_COMPONENTS };

/** Sections the settings route renders itself (the pre-clone account pieces). */
const ROUTE_RENDERED = ['account', 'security', 'danger'];

/** #referrals shows on a brand only once its every sign-up path carries the invite. */
const withoutUnwiredReferrals = (brand: 'roboapply' | 'goapply', ids: string[]) =>
  INVITE_REWARD_BRANDS.includes(brand) ? ids : ids.filter((id) => id !== 'referrals');

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
  // Both brands' extensions are published (a store id is configured), unless a test says otherwise.
  vi.stubEnv('NEXT_PUBLIC_EXT_ID', 'ext-store-id');
  vi.stubEnv('NEXT_PUBLIC_CN_EXT_ID', 'cn-ext-store-id');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of Object.keys(SECTION_COMPONENTS)) delete (SECTION_COMPONENTS as Record<string, unknown>)[k];
  Object.assign(SECTION_COMPONENTS, SHIPPED_COMPONENTS);
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
    expect(ra).toEqual(withoutUnwiredReferrals('roboapply', ALL_ORDER.filter((id) => id !== 'consents')));
    expect(ga).toEqual(withoutUnwiredReferrals('goapply', ALL_ORDER));
    expect(ra).not.toContain('consents');
    expect(ga).toContain('consents');
  });

  it('flags gate assistant, devices, connections and referrals (fail closed)', () => {
    const ids = (flags: ReturnType<typeof flagsWith> | null) =>
      visibleSettingsSections({ brandId: 'roboapply', flags, showAll: false }).map((s) => s.id);
    const gated = ['assistant', 'devices', 'connections', 'referrals'];
    expect(ids(flagsWith()).filter((id) => gated.includes(id))).toEqual([]);
    expect(ids(null).filter((id) => gated.includes(id))).toEqual([]);
    expect(ids(flagsWith({ copilot: true })).filter((id) => gated.includes(id))).toEqual(['assistant']);
    expect(ids(flagsWith({ extension: true })).filter((id) => gated.includes(id))).toEqual(['devices']);
    expect(ids(flagsWith({ invites: true })).filter((id) => gated.includes(id))).toEqual(['referrals']);
  });

  it('connections shows whenever hiringContacts is not off, so "Delete all imported connections" stays reachable', () => {
    for (const brandId of ['roboapply', 'goapply'] as const) {
      const ids = (mode: 'off' | 'deeplinks_only' | 'on') =>
        visibleSettingsSections({ brandId, flags: flagsWith({ hiringContacts: mode }), showAll: false }).map((s) => s.id);
      expect(ids('off'), brandId).not.toContain('connections');
      expect(ids('deeplinks_only'), brandId).toContain('connections');
      expect(ids('on'), brandId).toContain('connections');
    }
  });

  it('devices needs the extension flag AND a published extension (before that no browser can be connected)', () => {
    const flags = flagsWith({ extension: true });
    const has = (brandId: 'roboapply' | 'goapply') => visibleSettingsSections({ brandId, flags, showAll: true }).some((s) => s.id === 'devices');
    expect([has('roboapply'), has('goapply')]).toEqual([true, true]);
    vi.stubEnv('NEXT_PUBLIC_EXT_ID', '');
    expect([has('roboapply'), has('goapply')]).toEqual([false, true]);
    vi.stubEnv('NEXT_PUBLIC_CN_EXT_ID', '');
    expect([has('roboapply'), has('goapply')]).toEqual([false, false]);
  });

  it('referrals needs the invites flag AND a brand that runs the programme', () => {
    const flags = flagsWith({ invites: true });
    for (const brandId of ['roboapply', 'goapply'] as const) {
      const ids = visibleSettingsSections({ brandId, flags, showAll: true }).map((s) => s.id);
      expect(ids.includes('referrals'), brandId).toBe(INVITE_REWARD_BRANDS.includes(brandId));
    }
    expect(INVITE_REWARD_BRANDS).toContain('roboapply');
  });

  it('every section is ready (INT-12 flipped assistant, devices, connections, referrals); with no flag on, the base sections show per brand', () => {
    expect(SETTINGS_REGISTRY.filter((s) => !s.ready).map((s) => s.id)).toEqual([]);
    const base = ['account', 'security', 'notifications', 'billing', 'credits', 'privacy', 'appearance', 'search', 'sensitive', 'danger'];
    expect(visibleSettingsSections({ brandId: 'roboapply', flags: flagsWith(), showAll: false }).map((s) => s.id)).toEqual(base);
    expect(visibleSettingsSections({ brandId: 'goapply', flags: flagsWith(), showAll: false }).map((s) => s.id)).toEqual([
      ...base.slice(0, 7),
      'consents',
      ...base.slice(7),
    ]);
  });

  it('one section can be taken back out with `ready: false` (the revert); the dev override shows it again', () => {
    const reverted: SettingsSectionEntry[] = SETTINGS_REGISTRY.map((s) => (s.id === 'assistant' ? { ...s, ready: false } : s));
    const flags = flagsWith({ copilot: true });
    expect(visibleSettingsSections({ brandId: 'roboapply', flags, showAll: false }, reverted).map((s) => s.id)).not.toContain('assistant');
    expect(visibleSettingsSections({ brandId: 'roboapply', flags, showAll: true }, reverted).map((s) => s.id)).toContain('assistant');
    expect(visibleSettingsSections({ brandId: 'roboapply', flags, showAll: false }).map((s) => s.id)).toContain('assistant');
  });

  it('every section has an owner: its area component, or one of the three route renderers', () => {
    expect(SECTION_COMPONENTS).toEqual({
      notifications: NotificationsSettingsSection,
      billing: CreditsSettingsSection,
      credits: CreditsSettingsSection,
      privacy: ComplianceSettingsSection,
      consents: ComplianceSettingsSection,
      appearance: BrandSettingsSection,
      search: SearchSettingsSection,
      assistant: CopilotSettingsSection,
      devices: ExtensionSettingsSection,
      connections: NetworkSettingsSection,
      referrals: GrowthSettingsSection,
      sensitive: ProfileSettingsSection,
    });
    for (const s of SETTINGS_REGISTRY) {
      const owned = !!SECTION_COMPONENTS[s.id] || ROUTE_RENDERED.includes(s.id);
      expect(owned, `#${s.id} has no content`).toBe(true);
    }
    // No section is both: a route renderer would hide the area component.
    expect(ROUTE_RENDERED.filter((id) => id in SECTION_COMPONENTS)).toEqual([]);
  });

  it('area blocks inside a section: finish-setup in #account; two-step sign-in in #security; the phone number on GoApply only', () => {
    expect(SECTION_EXTRAS.account?.map((e) => [e.id, e.component, e.position, e.brands])).toEqual([['finish-setup', FinishSetupSettingsLine, 'before', undefined]]);
    expect(SECTION_EXTRAS.security?.map((e) => [e.id, e.component, e.position, e.brands])).toEqual([
      ['two-factor', TwoFactorSettings, 'after', undefined],
      ['change-phone', ChangePhoneSection, 'after', ['goapply']],
    ]);
    expect(sectionExtrasFor('security', 'roboapply', 'after').map((e) => e.id)).toEqual(['two-factor']);
    expect(sectionExtrasFor('security', 'goapply', 'after').map((e) => e.id)).toEqual(['two-factor', 'change-phone']);
    expect(sectionExtrasFor('security', 'goapply', 'before')).toEqual([]);
    expect(sectionExtrasFor('account', 'goapply', 'before').map((e) => e.id)).toEqual(['finish-setup']);
    expect(sectionExtrasFor('billing', 'roboapply', 'after')).toEqual([]);
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
    expect(sectionHrefs()).toEqual(withoutUnwiredReferrals('roboapply', ALL_ORDER.filter((id) => id !== 'consents')).map((id) => `#${id}`));
    expect(screen.getByRole('link', { name: 'Danger zone' })).toHaveClass('danger');
  });

  it('adds #consents on GoApply', () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    renderWithBrand(<SettingsPage />, {
      brand: 'goapply',
      flags: { copilot: true, extension: true, invites: true, hiringContacts: 'on' },
    });
    expect(sectionHrefs()).toEqual(withoutUnwiredReferrals('goapply', ALL_ORDER).map((id) => `#${id}`));
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

  it('lists the flipped sections with their flags on and no dev override (both brands)', () => {
    const { unmount } = renderWithBrand(<SettingsPage />, { flags: { copilot: true, extension: true, invites: true, hiringContacts: 'deeplinks_only' } });
    for (const name of ['Assistant', 'Devices', 'Connections', 'Invite friends']) {
      expect(screen.getByRole('link', { name }), name).toBeInTheDocument();
    }
    unmount();
    renderWithBrand(<SettingsPage />, { brand: 'goapply', flags: { copilot: true, extension: true, hiringContacts: 'deeplinks_only' } });
    for (const name of ['Assistant', 'Devices', 'Connections', 'Consents']) {
      expect(screen.getByRole('link', { name }), name).toBeInTheDocument();
    }
    expect(screen.queryByRole('link', { name: 'Invite friends' })).not.toBeInTheDocument();
  });

  it('mounts the area blocks around a section’s content, per brand, whatever the route passes', () => {
    const bodyOrder = () => [...document.querySelectorAll('.pref-body > [data-settings-body] > *')].map((el) => el.getAttribute('data-testid') ?? el.textContent);

    window.history.replaceState(null, '', '/settings#security');
    let view = renderWithBrand(<SettingsPage renderers={{ security: () => <p>security body</p> }} />);
    expect(bodyOrder()).toEqual(['security body', 'two-factor']);
    view.unmount();

    view = renderWithBrand(<SettingsPage renderers={{ security: () => <p>security body</p> }} />, { brand: 'goapply' });
    expect(bodyOrder()).toEqual(['security body', 'two-factor', 'change-phone']);
    view.unmount();

    window.history.replaceState(null, '', '/settings#account');
    view = renderWithBrand(<SettingsPage renderers={{ account: () => <p>account body</p> }} />);
    expect(bodyOrder()).toEqual(['finish-setup', 'account body']);
    view.unmount();

    // A section with no registered block gets none; the route's own extras wrap the area component.
    (SECTION_COMPONENTS as Record<string, unknown>).search = () => <p>saved searches</p>;
    window.history.replaceState(null, '', '/settings#search');
    renderWithBrand(<SettingsPage extras={{ search: { before: () => <p>intro</p>, after: () => <p>notes</p> } }} />);
    expect(bodyOrder()).toEqual(['intro', 'saved searches', 'notes']);
  });

  it('shows the loading line instead of a body while the route loads', () => {
    renderWithBrand(<SettingsPage loading renderers={{ account: () => <p>account body</p> }} />);
    expect(screen.getByText('Loading your settings…')).toBeInTheDocument();
    expect(screen.queryByText('account body')).not.toBeInTheDocument();
  });
});
