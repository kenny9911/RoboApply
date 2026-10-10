// Extension web side (WP-55a): the three-state setup card, connecting a
// browser (token straight to the extension, code fallback), the version
// check, the install prompt (popup after real use, inline for Ready to
// apply), "Fill this form", Settings → Devices, the sensitive-answers consent
// and the uninstall survey. lib/api is mocked; the extension is a fake bridge.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { mockAuthState, buildAuthValue } from '../../../__tests__/utils/mockAuth';
import type { ExtStatusResponse } from '../../../lib/api/contracts/extension';
import type { ProfileView } from '../../../lib/api/contracts/profile';

vi.mock('../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const nav = vi.hoisted(() => ({ pathname: '/jobs/cm_a' }));
vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return { ...real, usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }) };
});

const extApi = vi.hoisted(() => ({
  getStatus: vi.fn(),
  createDevice: vi.fn(),
  revokeDevice: vi.fn(),
  createPairCode: vi.fn(),
  listDevices: vi.fn(),
  submitUninstallSurvey: vi.fn(),
  extensionApiOrigin: vi.fn(() => 'https://www.roboapply.io'),
}));
vi.mock('../../../lib/api/extension', () => extApi);

const profileApi = vi.hoisted(() => ({ getProfile: vi.fn() }));
vi.mock('../../../lib/api/profile', () => profileApi);

const complianceApi = vi.hoisted(() => ({ getConsents: vi.fn(), recordConsent: vi.fn() }));
vi.mock('../../../lib/api/compliance', () => complianceApi);

const jobsApi = vi.hoisted(() => ({ getJob: vi.fn() }));
vi.mock('../../../lib/api/jobs', async (orig) => ({ ...(await orig<object>()), getJob: jobsApi.getJob }));

const gate = vi.hoisted(() => ({ requests: [] as Array<{ key: string; enabled: boolean }> }));
vi.mock('../../../lib/ui/popupGate', async (orig) => {
  const real = await orig<typeof import('../../../lib/ui/popupGate')>();
  return {
    ...real,
    usePopupGate: (key: string, _p: string, opts: { enabled?: boolean } = {}) => {
      gate.requests.push({ key, enabled: opts.enabled !== false });
      return { granted: opts.enabled !== false };
    },
  };
});

import { __setExtensionBridge, browserSupport, extensionStoreUrl, type ExtensionBridge } from '../../../hooks/extension';
import { ExtensionPage, ExtensionSettingsSection, ExtensionStatusCard, FillWithExtensionButton, InstallPrompt, SensitiveFillConsent, UninstallSurvey, setupStage } from './index';
import { JOB_VIEWS_KEY, PROMPT_DISMISSED_KEY, jobIdFromPath } from './InstallPrompt';

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:131.0) Gecko/20100101 Firefox/131.0';

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

/** A fake installed (or absent) extension. */
function fakeExtension(state: { installed: boolean; version?: string; paired?: boolean; acceptPair?: boolean }) {
  const sent: Array<{ id: string; message: unknown }> = [];
  const bridge: ExtensionBridge = {
    async send<T>(id: string, message: { type: string }) {
      sent.push({ id, message });
      if (!state.installed) return null;
      if (message.type === 'ping') return { ok: true, version: state.version ?? '1.4.0', paired: state.paired ?? false } as T;
      if (message.type === 'pair') {
        if (state.acceptPair === false) return null;
        state.paired = true;
        return { ok: true } as T;
      }
      return null;
    },
  };
  __setExtensionBridge(bridge);
  return { sent, state };
}

function profile(missing = 0): ProfileView {
  return {
    userId: 'u1',
    completeness: missing ? 40 : 100,
    missing: Array.from({ length: missing }, (_, i) => ({ key: `k${i}`, label: 'profile.missing.firstName', section: 'personal' as const })),
    availability: { market: 'intl', twFields: false, eeo: false, cnSensitive: false, cnPhoto: false },
  } as unknown as ProfileView;
}

const status = (over: Partial<ExtStatusResponse> = {}): ExtStatusResponse => ({ minExtVersion: '1.2.0', devices: [], ...over });
const liveDevice = { id: 'dev_live', name: 'Chrome on Mac', browser: 'chrome', extVersion: '1.4.0', tokenPrefix: 'rax_live', lastSeenAt: '2026-10-09T10:00:00.000Z', createdAt: '2026-10-01T10:00:00.000Z' };

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_EXT_ID', 'abcdefghijklmnopabcdefghijklmnop');
  setUserAgent(CHROME_UA);
  mockAuthState.value = buildAuthValue();
  nav.pathname = '/jobs/cm_a';
  gate.requests = [];
  window.localStorage.clear();
  extApi.getStatus.mockResolvedValue(status());
  profileApi.getProfile.mockResolvedValue(profile(0));
  complianceApi.getConsents.mockResolvedValue({ items: [] });
  jobsApi.getJob.mockResolvedValue({ autofill: { supported: true, atsType: 'greenhouse' } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  __setExtensionBridge(null);
});

// ── Pure pieces ──────────────────────────────────────────────────────────

describe('setupStage', () => {
  const p = (state: 'checking' | 'absent' | 'present' | 'mobile' | 'unsupported' | 'unavailable', version: string | null = null, paired = false) => ({ state, version, paired });
  it('orders profile → install → update → connect → done', () => {
    expect(setupStage({ profileMissing: 2, presence: p('present', '1.4.0', true), minExtVersion: null })).toBe('profile');
    expect(setupStage({ profileMissing: 0, presence: p('absent'), minExtVersion: null })).toBe('install');
    expect(setupStage({ profileMissing: 0, presence: p('present', '1.0.0'), minExtVersion: '1.2.0' })).toBe('update');
    expect(setupStage({ profileMissing: 0, presence: p('present', '1.4.0'), minExtVersion: '1.2.0' })).toBe('connect');
    expect(setupStage({ profileMissing: 0, presence: p('present', '1.4.0', true), minExtVersion: '1.2.0' })).toBe('done');
    expect(setupStage({ profileMissing: 0, presence: p('present', '1.4.0', true), minExtVersion: '1.2.0', liveDevices: 1 })).toBe('done');
  });
  it('a disconnected browser (token held, no live device) has to connect again', () => {
    expect(setupStage({ profileMissing: 0, presence: p('present', '1.4.0', true), minExtVersion: null, liveDevices: 0 })).toBe('connect');
    // Unknown device count (still loading or failed) does not downgrade.
    expect(setupStage({ profileMissing: 0, presence: p('present', '1.4.0', true), minExtVersion: null, liveDevices: null })).toBe('done');
  });
  it('handles loading, phones, other browsers and no published extension', () => {
    expect(setupStage({ profileMissing: null, presence: p('absent'), minExtVersion: null })).toBe('loading');
    expect(setupStage({ profileMissing: 0, presence: p('checking'), minExtVersion: null })).toBe('loading');
    expect(setupStage({ profileMissing: 0, presence: p('mobile'), minExtVersion: null })).toBe('mobile');
    expect(setupStage({ profileMissing: 0, presence: p('unsupported'), minExtVersion: null })).toBe('unsupported');
    expect(setupStage({ profileMissing: 0, presence: p('unavailable'), minExtVersion: null })).toBe('unavailable');
  });
});

describe('browser and path helpers', () => {
  it('detects Chromium, phones and other browsers', () => {
    expect(browserSupport({ userAgent: CHROME_UA })).toBe('chromium');
    expect(browserSupport({ userAgent: IPHONE_UA })).toBe('mobile');
    expect(browserSupport({ userAgent: FIREFOX_UA })).toBe('other');
    expect(browserSupport({ userAgent: CHROME_UA, userAgentData: { mobile: true } })).toBe('mobile');
  });
  it('recognises job pages only', () => {
    expect(jobIdFromPath('/jobs/cm_1')).toBe('cm_1');
    expect(jobIdFromPath('/jobs/explore')).toBeNull();
    expect(jobIdFromPath('/jobs')).toBeNull();
    expect(jobIdFromPath('/jobs/cm_1/apply')).toBeNull();
  });
});

// ── The three-state status card ──────────────────────────────────────────

describe('ExtensionStatusCard', () => {
  it('state 1 — profile incomplete → Complete profile', async () => {
    fakeExtension({ installed: true, paired: true });
    profileApi.getProfile.mockResolvedValue(profile(3));
    renderWithBrand(<ExtensionStatusCard />, { flags: { extension: true } });
    const link = await screen.findByRole('link', { name: 'Complete profile' });
    expect(link).toHaveAttribute('href', '/profile');
    expect(screen.queryByRole('link', { name: 'Explore jobs' })).toBeNull();
  });

  it('state 2 — no extension → Install', async () => {
    fakeExtension({ installed: false });
    renderWithBrand(<ExtensionStatusCard />, { flags: { extension: true } });
    const link = await screen.findByRole('link', { name: 'Get the extension' });
    expect(link).toHaveAttribute('href', 'https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('button', { name: 'I installed it' })).toBeInTheDocument();
  });

  it('state 3 — done → Explore jobs', async () => {
    extApi.getStatus.mockResolvedValue(status({ devices: [liveDevice] }));
    fakeExtension({ installed: true, paired: true, version: '1.4.0' });
    renderWithBrand(<ExtensionStatusCard />, { flags: { extension: true } });
    expect(await screen.findByRole('link', { name: 'Explore jobs' })).toHaveAttribute('href', '/jobs');
    expect(screen.getByRole('heading', { name: "You're set" })).toBeInTheDocument();
  });

  it('not "set" after the browser was disconnected in Settings → Devices', async () => {
    extApi.getStatus.mockResolvedValue(status({ devices: [] }));
    fakeExtension({ installed: true, paired: true, version: '1.4.0' });
    renderWithBrand(<ExtensionStatusCard />, { flags: { extension: true } });
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "You're set" })).toBeNull();
  });

  it('asks for an update below the minimum version', async () => {
    fakeExtension({ installed: true, paired: true, version: '1.0.0' });
    renderWithBrand(<ExtensionStatusCard />, { flags: { extension: true } });
    expect(await screen.findByRole('heading', { name: 'Update the extension' })).toBeInTheDocument();
    expect(screen.getByText(/You have version 1\.0\.0/)).toBeInTheDocument();
  });

  it('phones get a plain note, no install button', async () => {
    setUserAgent(IPHONE_UA);
    fakeExtension({ installed: false });
    renderWithBrand(<ExtensionStatusCard />, { flags: { extension: true } });
    expect(await screen.findByText(/don't run on phones/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Get the extension' })).toBeNull();
  });

  it('connects this browser: the token goes straight to the extension', async () => {
    const ext = fakeExtension({ installed: true, paired: false, version: '1.4.0' });
    extApi.createDevice.mockImplementation(async () => {
      extApi.getStatus.mockResolvedValue(status({ devices: [liveDevice] }));
      return { deviceId: 'dev_1', token: 'rax_secret_token_value_123456' };
    });
    renderWithBrand(<ExtensionStatusCard />, { flags: { extension: true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('link', { name: 'Explore jobs' })).toBeInTheDocument();
    expect(extApi.createDevice).toHaveBeenCalledWith(expect.objectContaining({ name: 'Chrome on Mac', browser: 'chrome', extVersion: '1.4.0' }));
    expect(ext.sent).toContainEqual({ id: 'abcdefghijklmnopabcdefghijklmnop', message: { type: 'pair', token: 'rax_secret_token_value_123456', apiOrigin: 'https://www.roboapply.io' } });
    expect(JSON.stringify(window.localStorage)).not.toContain('rax_secret');
    expect(extApi.revokeDevice).not.toHaveBeenCalled();
  });

  it('falls back to a code when the extension does not take the token (and drops the unused device)', async () => {
    fakeExtension({ installed: true, paired: false, acceptPair: false });
    extApi.createDevice.mockResolvedValue({ deviceId: 'dev_1', token: 'rax_x' });
    extApi.createPairCode.mockResolvedValue({ code: 'ABCD2345', expiresAt: '2026-10-10T12:10:00.000Z' });
    renderWithBrand(<ExtensionStatusCard />, { flags: { extension: true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use a code instead');
    expect(extApi.revokeDevice).toHaveBeenCalledWith('dev_1');
    fireEvent.click(screen.getByRole('button', { name: 'Show a code' }));
    expect(await screen.findByText('ABCD2345')).toBeInTheDocument();
  });

  it('renders nothing when the brand has no published extension', () => {
    vi.stubEnv('NEXT_PUBLIC_EXT_ID', '');
    fakeExtension({ installed: true });
    const { container } = renderWithBrand(<ExtensionStatusCard />, { flags: { extension: true } });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ExtensionPage', () => {
  it('explains that the user submits, and that facts are never written by AI', async () => {
    fakeExtension({ installed: false });
    renderWithBrand(<ExtensionPage />, { flags: { extension: true } });
    expect(await screen.findByRole('heading', { level: 1, name: 'RoboApply for your browser' })).toBeInTheDocument();
    expect(screen.getByText(/submit each application yourself/)).toBeInTheDocument();
    expect(screen.getByText(/never submits a form/)).toBeInTheDocument();
    expect(screen.getByText(/AI never writes them/)).toBeInTheDocument();
  });

  it('lists the sites this brand’s extension fills', async () => {
    fakeExtension({ installed: false });
    renderWithBrand(<ExtensionPage />, { flags: { extension: true } });
    // Wave 5 gate: WP-70's adapters joined the RoboApply list.
    expect(await screen.findByText(/Application forms on Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, Workable, Taleo,? and SuccessFactors\./)).toBeInTheDocument();
    expect(screen.getByText(/looks for the application form when the page opens/)).toBeInTheDocument();
  });

  it('GoApply lists its mainland portals only (WP-71), never Greenhouse / Lever / Ashby', async () => {
    vi.stubEnv('NEXT_PUBLIC_CN_EXT_ID', 'cnextensionidcnextensionidcnexten');
    fakeExtension({ installed: false });
    renderWithBrand(<ExtensionPage />, { brand: 'goapply', flags: { extension: true } });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Moka/)).toBeInTheDocument();
    expect(screen.getByText(/Dayee/)).toBeInTheDocument();
    expect(screen.queryByText(/Greenhouse/)).toBeNull();
  });

  it('signed out: install link and Sign in, no setup card', async () => {
    mockAuthState.value = { ...buildAuthValue(), status: 'unauthenticated', user: null };
    fakeExtension({ installed: false });
    renderWithBrand(<ExtensionPage />, { flags: { extension: true } });
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?next=%2Fextension');
    expect(extApi.getStatus).not.toHaveBeenCalled();
  });

  it('capability off: says it is not available, nothing to install', () => {
    renderWithBrand(<ExtensionPage />, { flags: { extension: false } });
    expect(screen.getByText('The extension is not available yet.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Get the extension' })).toBeNull();
  });

  it('GoApply installs only from its configured store (no Chrome Web Store default)', async () => {
    vi.stubEnv('NEXT_PUBLIC_EXT_ID', '');
    vi.stubEnv('NEXT_PUBLIC_CN_EXT_ID', 'cnextensionidcnextensionidcnexten');
    vi.stubEnv('NEXT_PUBLIC_CN_EXT_STORE_URL', 'https://microsoftedge.microsoft.com/addons/detail/cnextensionidcnextensionidcnexten');
    fakeExtension({ installed: false });
    renderWithBrand(<ExtensionPage />, { brand: 'goapply', flags: { extension: true } });
    // (The test bundle substitutes %BRAND% for RoboApply; the brand shows in the store link.)
    expect(await screen.findByRole('link', { name: 'Get the extension' })).toHaveAttribute('href', 'https://microsoftedge.microsoft.com/addons/detail/cnextensionidcnextensionidcnexten');
  });

  it('GoApply without NEXT_PUBLIC_CN_EXT_STORE_URL shows no install link', async () => {
    vi.stubEnv('NEXT_PUBLIC_CN_EXT_ID', 'cnextensionidcnextensionidcnexten');
    vi.stubEnv('NEXT_PUBLIC_CN_EXT_STORE_URL', '');
    expect(extensionStoreUrl('goapply')).toBeNull();
    fakeExtension({ installed: false });
    renderWithBrand(<ExtensionStatusCard />, { brand: 'goapply', flags: { extension: true } });
    expect(await screen.findByRole('button', { name: 'I installed it' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Get the extension' })).toBeNull();
  });
});

// ── Sensitive answers consent ────────────────────────────────────────────

describe('SensitiveFillConsent', () => {
  const item = {
    type: 'autofill_sensitive',
    required: false,
    stage: 'in_context',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: 'I allow the extension to fill my saved sensitive answers.',
    proseVersion: 'v3',
    proseHash: 'h',
    proseLocale: 'en',
    granted: null,
    answeredAt: null,
  };

  it('starts unticked and records the answer with the prose version', async () => {
    complianceApi.getConsents.mockResolvedValue({ items: [item] });
    complianceApi.recordConsent.mockResolvedValue({ type: item.type, granted: true, proseVersion: 'v3', proseHash: 'h', at: '2026-10-10T00:00:00Z' });
    renderWithBrand(<SensitiveFillConsent />, { flags: { extension: true } });
    const box = await screen.findByRole('checkbox', { name: 'Let the extension fill my sensitive answers' });
    expect(box).not.toBeChecked();
    expect(screen.getByText(item.prose)).toBeInTheDocument();
    fireEvent.click(box);
    await waitFor(() => expect(complianceApi.recordConsent).toHaveBeenCalledWith(expect.objectContaining({ type: 'autofill_sensitive', granted: true, proseVersion: 'v3' })));
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
  });

  it('renders nothing when the consent is not in the catalog', async () => {
    const { container } = renderWithBrand(<SensitiveFillConsent />, { flags: { extension: true } });
    await waitFor(() => expect(complianceApi.getConsents).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

// ── Install prompt ───────────────────────────────────────────────────────

describe('InstallPrompt (popup)', () => {
  it('waits for real use: nothing on the first job page, the prompt on the second', async () => {
    fakeExtension({ installed: false });
    nav.pathname = '/jobs/cm_a';
    const { rerender } = renderWithBrand(<InstallPrompt mode="popup" />, { flags: { extension: true } });
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    nav.pathname = '/jobs/cm_b';
    rerender(<InstallPrompt mode="popup" />);
    const dialog = await screen.findByRole('dialog', { name: 'Fill application forms faster' });
    expect(within(dialog).getByText(/submit the application yourself/)).toBeInTheDocument();
    expect(gate.requests.some((r) => r.key === 'extension:install' && r.enabled)).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(JOB_VIEWS_KEY)!)).toEqual(['cm_a', 'cm_b']);
  });

  it('"Not now" closes it and snoozes it', async () => {
    fakeExtension({ installed: false });
    window.localStorage.setItem(JOB_VIEWS_KEY, JSON.stringify(['cm_x']));
    renderWithBrand(<InstallPrompt />, { flags: { extension: true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(Number(window.localStorage.getItem(PROMPT_DISMISSED_KEY))).toBeGreaterThan(0);
  });

  it.each([
    ['the extension is installed', () => fakeExtension({ installed: true })],
    ['a phone', () => (setUserAgent(IPHONE_UA), fakeExtension({ installed: false }))],
    ['not a job page', () => ((nav.pathname = '/applications'), fakeExtension({ installed: false }))],
    ['snoozed', () => (window.localStorage.setItem(PROMPT_DISMISSED_KEY, String(Date.now())), fakeExtension({ installed: false }))],
  ])('never shows when %s', async (_name, arrange) => {
    window.localStorage.setItem(JOB_VIEWS_KEY, JSON.stringify(['cm_x']));
    arrange();
    renderWithBrand(<InstallPrompt />, { flags: { extension: true } });
    await act(async () => {});
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never shows with the capability off', async () => {
    fakeExtension({ installed: false });
    window.localStorage.setItem(JOB_VIEWS_KEY, JSON.stringify(['cm_x']));
    renderWithBrand(<InstallPrompt />, { flags: { extension: false } });
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('InstallPrompt (inline, Ready to apply setup)', () => {
  it('offers the install when the extension is absent', async () => {
    fakeExtension({ installed: false });
    renderWithBrand(<InstallPrompt mode="inline" />, { flags: { extension: true } });
    expect(await screen.findByRole('link', { name: 'Get the extension' })).toBeInTheDocument();
    expect(gate.requests).toEqual([]);
  });

  it('confirms an installed extension, and links to connect it when unpaired', async () => {
    fakeExtension({ installed: true, version: '1.4.0', paired: false });
    renderWithBrand(<InstallPrompt mode="inline" />, { flags: { extension: true } });
    expect(await screen.findByText('Extension installed (version 1.4.0).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect it' })).toHaveAttribute('href', '/extension');
  });

  it('asks for an update below the minimum version', async () => {
    fakeExtension({ installed: true, version: '1.0.0', paired: true });
    renderWithBrand(<InstallPrompt mode="inline" />, { flags: { extension: true } });
    expect(await screen.findByText('Update the extension to version 1.2.0 or later.')).toBeInTheDocument();
  });
});

// ── Fill this form ───────────────────────────────────────────────────────

describe('FillWithExtensionButton', () => {
  it('extension installed → opens the application page in a new tab (no fit call, no tracker move)', async () => {
    fakeExtension({ installed: true });
    renderWithBrand(<FillWithExtensionButton jobId="cm1" applyUrl="https://boards.greenhouse.io/acme/jobs/1" />, { flags: { extension: true } });
    const link = await screen.findByRole('link', { name: /Fill this form/ });
    expect(link).toHaveAttribute('href', 'https://boards.greenhouse.io/acme/jobs/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/submit the application yourself/)).toBeInTheDocument();
    expect(extApi.createDevice).not.toHaveBeenCalled();
  });

  it('extension absent → Get the extension', async () => {
    fakeExtension({ installed: false });
    renderWithBrand(<FillWithExtensionButton jobId="cm1" applyUrl="https://boards.greenhouse.io/acme/jobs/1" />, { flags: { extension: true } });
    expect(await screen.findByRole('link', { name: 'Get the extension to fill this form' })).toHaveAttribute('href', '/extension');
  });

  it('hidden on GoApply for a Greenhouse job even when job detail says supported', async () => {
    vi.stubEnv('NEXT_PUBLIC_CN_EXT_ID', 'cnextensionidcnextensionidcnexten');
    fakeExtension({ installed: true });
    jobsApi.getJob.mockResolvedValue({ autofill: { supported: true, atsType: 'greenhouse' } });
    const r = renderWithBrand(<FillWithExtensionButton jobId="cm1" applyUrl="https://boards.greenhouse.io/acme/jobs/1" />, { brand: 'goapply', flags: { extension: true } });
    await waitFor(() => expect(jobsApi.getJob).toHaveBeenCalled());
    expect(r.container).toBeEmptyDOMElement();
  });

  it('hidden for a form no adapter supports, without an apply link, or for a non-web link', async () => {
    fakeExtension({ installed: true });
    jobsApi.getJob.mockResolvedValue({ autofill: { supported: false, atsType: 'workday' } });
    const a = renderWithBrand(<FillWithExtensionButton jobId="cm1" applyUrl="https://acme.wd1.myworkdayjobs.com/x" />, { flags: { extension: true } });
    await waitFor(() => expect(jobsApi.getJob).toHaveBeenCalled());
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    expect(renderWithBrand(<FillWithExtensionButton jobId="cm1" applyUrl={null} />).container).toBeEmptyDOMElement();
    expect(renderWithBrand(<FillWithExtensionButton jobId="cm1" applyUrl="javascript:alert(1)" />).container).toBeEmptyDOMElement();
  });
});

// ── Settings → Devices ───────────────────────────────────────────────────

describe('ExtensionSettingsSection (#devices)', () => {
  const device = { id: 'dev_1', name: 'Chrome on Mac', browser: 'chrome', extVersion: '1.0.0', tokenPrefix: 'rax_abcd', lastSeenAt: '2026-10-09T10:00:00.000Z', createdAt: '2026-10-01T10:00:00.000Z' };

  it('lists devices, marks outdated ones and disconnects after confirming', async () => {
    extApi.getStatus.mockResolvedValue(status({ devices: [device] }));
    extApi.revokeDevice.mockResolvedValue(undefined);
    renderWithBrand(<ExtensionSettingsSection section="devices" />, { flags: { extension: true } });
    expect(await screen.findByText('Chrome on Mac')).toBeInTheDocument();
    expect(screen.getByText('Needs an update')).toBeInTheDocument();
    expect(screen.getByText(/Version 1\.0\.0 · Last used/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect: Chrome on Mac' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Disconnect Chrome on Mac?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(extApi.revokeDevice).toHaveBeenCalledWith('dev_1'));
  });

  it('empty state links to the setup page', async () => {
    renderWithBrand(<ExtensionSettingsSection section="devices" />, { flags: { extension: true } });
    expect(await screen.findByText('No browser is connected yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up the extension' })).toHaveAttribute('href', '/extension');
  });
});

// ── Uninstall survey ─────────────────────────────────────────────────────

describe('UninstallSurvey', () => {
  it('needs a reason, then sends reasons and the note', async () => {
    extApi.submitUninstallSurvey.mockResolvedValue(undefined);
    renderWithBrand(<UninstallSurvey />, { flags: { extension: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one reason.');
    expect(extApi.submitUninstallSurvey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I had privacy concerns' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  too many fields  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(extApi.submitUninstallSurvey).toHaveBeenCalledWith({ reasons: ['privacy'], note: 'too many fields' }));
    expect(await screen.findByText('Thanks for telling us.')).toBeInTheDocument();
  });
});
