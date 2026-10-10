// __tests__/pages/settings.test.tsx
//
// Smoke test for /settings — ONE page; its sections, their order and the
// brand rules come from components/features/settings/registry.ts (FND-6a,
// PRODUCT_PLAN.md §3.4): Account · Sign-in and security · Notifications ·
// Plan and billing · Credits · Privacy and data · Appearance · Your search ·
// Danger zone on RoboApply today. The registry itself (per brand, flags,
// readiness) is covered in __tests__/shell/settings.test.tsx.
//
// This replaces __tests__/pages/preferences.test.tsx. What changed and why:
//   • Route: /preferences → /settings, and it absorbed /plans, /account and
//     /account/billing. Four routes became seven sections on one page.
//   • Section names are the C21/C6 vocabulary: "Your search" (not "Job
//     target"), "Plan and billing" (not "Plans"), "Danger zone" survives.
//   • The first section's H1 is the setup sentence, and it has exactly ONE
//     name in the whole product: "Tell us what you're looking for" (C21 —
//     "Tune my matches" and "Redo setup chat" are deleted).
//   • The plain-language block no longer mentions an agent reading anything
//     (D4/C9 — zero speakers).
//
// INT-12 (WP-93) wiring, covered at the bottom of this file:
//   • each section renders its owner on both brands — the area component from
//     sectionComponents.ts (Notifications and Your search included) or the
//     route's renderer — and no section is an empty panel, even with every
//     request failing;
//   • #security carries two-step sign-in on both brands and the phone number
//     block on GoApply only; #account carries the finish-setup line;
//   • Your search = the saved searches (search area) with the draft-backed
//     notes, main resume and company blocklist under them;
//   • a preferences refetch never wipes unsaved edits, and Save sends only
//     what the user changed (never a search-backed key);
//   • the dead controls are gone (photo upload, typing into name/email,
//     "Manage the list", "Reset settings").
//
// The billing assertion is the one that matters most: styles/v3.css hides the
// sidebar below 760px, so before this page existed a phone user could not
// reach billing at all — they could not change a plan or cancel a
// subscription. The section list here is what gives them that, and the test
// proves the section exists and renders rather than being a rail entry that
// leads nowhere.

import type { ReactNode } from 'react';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState, buildAuthValue, buildFakeUser } from '../utils/mockAuth';
import { renderWithBrand, flagsWith } from '../shell/helpers';

// The three area blocks the frame mounts inside a section, as markers: their
// own behaviour (hidden while unavailable, the phone flows, the count of steps
// left) is tested by their areas. Here: are they mounted, and on which brand.
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

// "Sign out everywhere" and "Delete account": the account profile and the two
// mutations are controllable (no account API here), and the device cleanup
// steps are recorded (components/v3/shell/signOutCleanup.ts).
const signOut = vi.hoisted(() => ({
  steps: [] as string[],
  profile: null as null | { hasPassword: boolean; provider: string },
  /** The next sign-out-all / delete-account request fails. */
  fail: false,
  /** When set, the push step waits for this before it finishes. */
  pushGate: null as null | Promise<void>,
}));
vi.mock('../../hooks/useAccount', async (orig) => {
  const real = await orig<typeof import('../../hooks/useAccount')>();
  type Opts = { onSuccess?: () => void; onError?: (err: unknown) => void };
  const settle = (opts?: Opts) => (signOut.fail ? opts?.onError?.(new Error('request failed')) : opts?.onSuccess?.());
  return {
    ...real,
    useAccountProfile: () => (signOut.profile ? { data: signOut.profile, isError: false, refetch: () => undefined } : real.useAccountProfile()),
    useSignOutAll: () => ({
      isPending: false,
      mutate: (_v: unknown, opts?: Opts) => {
        signOut.steps.push('sign-out-all');
        settle(opts);
      },
    }),
    useDeleteAccount: () => ({
      isPending: false,
      mutate: (confirmEmail: string, opts?: Opts) => {
        signOut.steps.push(`delete-account:${confirmEmail}`);
        settle(opts);
      },
    }),
  };
});
vi.mock('../../components/v3/shell/signOutCleanup', () => {
  const forgetPushOnSignOut = async () => {
    // Resolves later, like the real one (it talks to the push service).
    await (signOut.pushGate ?? new Promise((r) => setTimeout(r, 5)));
    signOut.steps.push('forget-push');
  };
  const clearDraftsOnSignOut = () => {
    signOut.steps.push('clear-drafts');
  };
  return {
    forgetPushOnSignOut,
    clearDraftsOnSignOut,
    cleanUpDeviceOnSignOut: async () => {
      await forgetPushOnSignOut();
      clearDraftsOnSignOut();
    },
    leaveSignedOut: () => {
      signOut.steps.push('leave');
    },
    useSessionCleanupRegistration: () => undefined,
  };
});

import SettingsPage from '../../app/(auth)/settings/page';
import { __toastStore } from '../../components/v3/primitives/Toast';
import { visibleSettingsSections } from '../../components/features/settings';
import { EMPTY_SECTION_DELAY_MS } from '../../components/features/settings/SettingsPage';
import { changedPreferenceKeys, preferenceKeys, rebasePreferencesDraft, settlePreferencesSave } from '../../hooks/usePreferences';
import { SEARCH_BACKED_PREFERENCE_KEYS } from '../../hooks/search/keys';
import { raV2Api } from '../../lib/api/v2';

beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

// The real AuthProvider fires GET /me on mount; page tests mock the module and
// point useAuth() at the shared fixture (per __tests__/utils/mockAuth.tsx).
vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockAuthState.value,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings',
}));

beforeEach(() => {
  mockAuthState.value = buildAuthValue();
  signOut.steps.length = 0;
  signOut.fail = false;
  signOut.pushGate = null;
  __toastStore.set(() => []);
  signOut.profile = null;
});

describe('/settings', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/settings');
  });

  it('renders the sections in registry order and lands on Account', async () => {
    renderWithProviders(<SettingsPage />);

    // The section list lands once the preferences query resolves.
    await waitFor(
      () => {
        expect(
          screen.getByRole('link', { name: 'Your search' }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    // All of them, in order. Each is a section on this page, not a route — a
    // fragment anchor, because the open section is the URL hash.
    const ids = ['account', 'security', 'notifications', 'billing', 'credits', 'privacy', 'appearance', 'search', 'sensitive', 'danger'];
    const names = [
      'Account',
      'Sign-in and security',
      'Notifications',
      'Plan and billing',
      'Credits',
      'Privacy and data',
      'Appearance',
      'Your search',
      'Sensitive answers',
      'Danger zone',
    ];
    const row = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(row).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(ids.map((id) => `#${id}`));
    names.forEach((name, i) => {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', `#${ids[i]}`);
    });
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens Your search from its hash, with the one setup sentence as its H1', async () => {
    window.history.replaceState(null, '', '/settings#search');
    renderWithProviders(<SettingsPage />);
    await waitFor(
      () => {
        expect(screen.getByRole('link', { name: 'Your search' })).toHaveAttribute('aria-current', 'page');
      },
      { timeout: 4000 },
    );

    // Your search's H1 is the one setup sentence
    // (C21). The heading is assembled from three keys, so match on the
    // distinctive middle rather than the whole string.
    expect(
      screen.getByRole('heading', { level: 1, name: /you're looking for/i }),
    ).toBeInTheDocument();

    // C21 deletes the competing names for the same panel.
    expect(screen.queryByText(/Tune my matches/i)).toBeNull();
    expect(screen.queryByText(/Redo setup chat/i)).toBeNull();
  });

  it('reaches Plan and billing — the section a phone user could not open before', async () => {
    renderWithProviders(<SettingsPage />);

    await waitFor(
      () => {
        expect(
          screen.getByRole('link', { name: 'Plan and billing' }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    fireEvent.click(screen.getByRole('link', { name: 'Plan and billing' }));
    // A fragment anchor: the browser moves the URL, then fires hashchange.
    await waitFor(() => expect(window.location.hash).toBe('#billing'));

    // The section swaps once the browser fires hashchange (a task later). Since
    // the Wave 2 gate the body is WP-21b's billing view (registered in
    // sectionComponents.ts), not the page's legacy renderer: that one checked
    // out with `{ tier }`, which WP-21a refuses with 409 plan_not_sellable.
    expect(await screen.findByTestId('billing-view')).toBeInTheDocument();
    expect(
      screen.queryByText(/What you are on now, what else you can move to, and where your receipts are\./i),
    ).toBeNull();

    // The plan sheet is served by the billing API, which has no stub and no
    // network in JSDOM — so this test asserts the branch that a phone user on
    // a bad connection actually hits. It must say what happened and offer a
    // retry, never a blank panel (voice rule: errors are factual). The
    // populated sheet is covered by components/features/credits/__tests__.
    await waitFor(
      () => {
        expect(screen.getByText("We couldn't load the plans.")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
  });

  it('opens the section the URL hash names — the deep link every "Billing" entry points at', async () => {
    // The avatar menu, the practice launcher's "Get credits" and the invoice
    // page's back link all point at /settings#billing. Before the hash drove
    // the section, every one of them landed on "Your search".
    window.history.replaceState(null, '', '/settings#billing');
    renderWithProviders(<SettingsPage />);

    await waitFor(
      () => {
        expect(screen.getByTestId('billing-view')).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.getByRole('link', { name: 'Plan and billing' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Your search' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('shows the save bar on edit and clears it after saving', async () => {
    window.history.replaceState(null, '', '/settings#search');
    renderWithProviders(<SettingsPage />);

    await waitFor(
      () => {
        expect(
          screen.getByRole('link', { name: 'Your search' }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    // Clean against the server baseline → no save bar.
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument();

    // Edit the free-text intent field → the draft diverges from the baseline.
    // (The notes sit under the saved searches and arrive with the preferences.)
    const intent = (await screen.findByLabelText('What you want next', {}, { timeout: 4000 })) as HTMLTextAreaElement;
    fireEvent.change(intent, { target: { value: 'Remote staff PM, climate.' } });

    await waitFor(() => {
      expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
    });

    // Save → the stub persists, the page re-baselines, the bar goes away.
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(
      () => {
        expect(
          screen.queryByText('You have unsaved changes'),
        ).not.toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    // The edited value survives the re-baseline.
    expect(
      (screen.getByLabelText('What you want next') as HTMLTextAreaElement).value,
    ).toBe('Remote staff PM, climate.');
  });

  it('Danger zone: the data-wipe row opens a real type-to-confirm modal', async () => {
    renderWithProviders(<SettingsPage />);

    await waitFor(
      () => {
        expect(
          screen.getByRole('link', { name: 'Danger zone' }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    fireEvent.click(screen.getByRole('link', { name: 'Danger zone' }));

    // Before the modal opens, the row title is the only match. The copy names
    // what is destroyed and what survives, in the user's nouns — "job data",
    // not "application records" (C4: the product nouns are job, application,
    // resume, practice interview).
    expect(await screen.findByText('Delete your job data')).toBeInTheDocument();
    expect(
      screen.getByText(/Your account and resumes stay\./i),
    ).toBeInTheDocument();

    // Its button opens the REAL confirm modal — a type-to-confirm gate.
    fireEvent.click(screen.getByRole('button', { name: 'Delete job data' }));
    expect(screen.getByText(/Type DELETE to confirm\./i)).toBeInTheDocument();

    // A wrong keyword is rejected locally — nothing is cleared, no request
    // fires, and the error says exactly what to do next.
    fireEvent.change(screen.getByPlaceholderText('DELETE'), {
      target: { value: 'nope' },
    });
    // The confirm CTA repeats the row's verb, so scope to the dialog.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Delete job data' }),
    );
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Type DELETE exactly to confirm\./i,
      );
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// INT-12 (WP-93) wiring
// ───────────────────────────────────────────────────────────────────────────

/** Capture the page's QueryClient so a test can refetch like the app does. */
function ClientProbe({ onClient }: { onClient: (c: QueryClient) => void }) {
  onClient(useQueryClient());
  return null;
}

const ALL_ON = { copilot: true, extension: true, invites: true, hiringContacts: 'on', totp: true, 'auth.phoneOtp': true } as const;

const body = () => document.querySelector<HTMLElement>('.pref-body [data-settings-body]');

describe('/settings — each section renders its owner (both brands), and none is an empty panel', () => {
  beforeEach(() => {
    // #devices shows once the brand's extension is published.
    vi.stubEnv('NEXT_PUBLIC_EXT_ID', 'ext-store-id');
    vi.stubEnv('NEXT_PUBLIC_CN_EXT_ID', 'cn-ext-store-id');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    window.history.replaceState(null, '', '/settings');
  });

  /** What must be on screen for a section: a string from its owner, or a test id. */
  const OWNER: Record<string, { text?: RegExp; testId?: string }> = {
    account: { text: /Who\s+you are/ }, // route: IdentitySection
    security: { testId: 'two-factor' }, // route: SecurityCard (+ the mounted blocks)
    notifications: { text: /How we reach you/ }, // notifications area
    billing: { testId: 'billing-view' }, // credits area
    credits: { text: /Your credits/ }, // credits area
    privacy: { text: /Download your data/ }, // compliance area
    appearance: { text: /How this app looks/ }, // brand area
    consents: { text: /consents/i }, // compliance area (GoApply)
    search: { text: /Saved searches/ }, // search area
    assistant: { testId: 'assistant-settings' }, // copilot area
    devices: { text: /Browsers with the extension/ }, // extension area
    connections: { testId: 'connections-import' }, // network area
    referrals: {}, // growth area: see the fallback test below
    sensitive: { text: /profile|Sensitive/i }, // profile area
    danger: { text: /Delete your job data/ }, // route: DangerSection
  };

  it.each(['roboapply', 'goapply'] as const)('%s: every visible section has content from its owner', async (brand) => {
    const ids = visibleSettingsSections({ brandId: brand, flags: flagsWith(ALL_ON as never), showAll: false }).map((s) => s.id);
    // GoApply has #consents; #referrals only where the invite programme runs.
    expect(ids.includes('consents')).toBe(brand === 'goapply');
    for (const flipped of ['assistant', 'devices', 'connections']) expect(ids, flipped).toContain(flipped);
    for (const id of ids) {
      window.history.replaceState(null, '', `/settings#${id}`);
      const view = renderWithBrand(<SettingsPage />, { brand, flags: ALL_ON as never });
      await waitFor(() => expect(document.querySelector('.pref')).toHaveAttribute('data-settings-section', id));
      const owner = OWNER[id];
      expect(owner, `#${id} has no owner expectation`).toBeDefined();
      if (owner.testId) await waitFor(() => expect(screen.getByTestId(owner.testId!), `#${id}`).toBeInTheDocument(), { timeout: 4000 });
      if (owner.text) await waitFor(() => expect(body()?.textContent ?? '', `#${id}`).toMatch(owner.text!), { timeout: 4000 });
      // Never a blank panel: either the owner rendered, or the frame says the section did not load.
      await waitFor(
        () => {
          const el = body()!;
          const blank = el.childElementCount === 0 && !(el.textContent ?? '').trim();
          expect(!blank || !!screen.queryByTestId('settings-section-empty'), `#${id} is an empty panel`).toBe(true);
        },
        { timeout: EMPTY_SECTION_DELAY_MS + 2500 },
      );
      view.unmount();
    }
  }, 60_000);

  it('a section whose area renders nothing (its data failed to load) says so instead of staying blank', async () => {
    // #referrals: the growth section renders nothing until its data arrives, and there is no network here.
    window.history.replaceState(null, '', '/settings#referrals');
    renderWithBrand(<SettingsPage />, { flags: { invites: true } });
    await waitFor(() => expect(document.querySelector('.pref')).toHaveAttribute('data-settings-section', 'referrals'));
    expect(screen.queryByTestId('settings-section-empty')).toBeNull(); // not during a normal loading flash
    expect(await screen.findByTestId('settings-section-empty', {}, { timeout: EMPTY_SECTION_DELAY_MS + 2500 })).toHaveTextContent(
      'This section did not load. Reload the page to try again.',
    );
  });

  it('#security: two-step sign-in on both brands; the phone number block on GoApply only', async () => {
    window.history.replaceState(null, '', '/settings#security');
    const ra = renderWithBrand(<SettingsPage />, { brand: 'roboapply', flags: {} });
    expect(await screen.findByTestId('two-factor')).toBeInTheDocument();
    expect(screen.queryByTestId('change-phone')).toBeNull();
    ra.unmount();

    renderWithBrand(<SettingsPage />, { brand: 'goapply', flags: {} });
    expect(await screen.findByTestId('two-factor')).toBeInTheDocument();
    expect(screen.getByTestId('change-phone')).toBeInTheDocument();
    // After the security card (or its load state), in this order.
    const order = [...body()!.children].map((el) => el.getAttribute('data-testid'));
    expect(order.slice(-2)).toEqual(['two-factor', 'change-phone']);
  });

  it('"Sign out everywhere" forgets the push device first, signs out, then clears the drafts and the client and leaves', async () => {
    signOut.profile = { hasPassword: true, provider: 'email' };
    const clear = vi.fn(() => signOut.steps.push('clear'));
    mockAuthState.value = buildAuthValue({ clear });
    window.history.replaceState(null, '', '/settings#security');
    renderWithProviders(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    // The push subscription goes while the session can still authorise it; the
    // drafts go only once the sign-out worked; the leave is a hard navigation.
    expect(signOut.steps).toEqual(['forget-push', 'sign-out-all', 'clear-drafts', 'clear', 'leave']);
  });

  it('"Sign out everywhere" is disabled while the device cleanup runs, so a second click does nothing', async () => {
    signOut.profile = { hasPassword: true, provider: 'email' };
    let release!: () => void;
    signOut.pushGate = new Promise<void>((r) => (release = r));
    window.history.replaceState(null, '', '/settings#security');
    renderWithProviders(<SettingsPage />);
    const button = await screen.findByRole('button', { name: 'Sign out everywhere' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(signOut.steps).toEqual([]);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(signOut.steps).toContain('leave'));
    expect(signOut.steps.filter((s) => s === 'sign-out-all')).toHaveLength(1);
    expect(signOut.steps.filter((s) => s === 'forget-push')).toHaveLength(1);
  });

  it('"Sign out everywhere" that fails keeps the drafts and the session, says so, and can be tried again', async () => {
    signOut.profile = { hasPassword: true, provider: 'email' };
    signOut.fail = true;
    const clear = vi.fn();
    mockAuthState.value = buildAuthValue({ clear });
    window.history.replaceState(null, '', '/settings#security');
    renderWithProviders(<SettingsPage />);
    const button = await screen.findByRole('button', { name: 'Sign out everywhere' });
    fireEvent.click(button);
    await waitFor(() => expect(__toastStore.get().map((x) => x.message)).toEqual(['You are still signed in. Try again.']));
    expect(__toastStore.get()[0].tone).toBe('danger');
    expect(signOut.steps).toEqual(['forget-push', 'sign-out-all']);
    expect(clear).not.toHaveBeenCalled();
    await waitFor(() => expect(button).not.toBeDisabled());

    signOut.fail = false;
    fireEvent.click(button);
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(signOut.steps.slice(2)).toEqual(['forget-push', 'sign-out-all', 'clear-drafts', 'leave']);
  });

  /** Open the delete-account modal from the Danger zone and fill it in. */
  const fillDeleteAccount = async () => {
    window.history.replaceState(null, '', '/settings#danger');
    renderWithProviders(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete account$/ }, { timeout: 4000 }));
    const modal = await screen.findByRole('dialog');
    fireEvent.change(within(modal).getByPlaceholderText('jane@example.com'), { target: { value: 'Jane@Example.com ' } });
    fireEvent.change(within(modal).getByPlaceholderText('Tell us why you are leaving (required)'), { target: { value: 'Found a job.' } });
    return modal;
  };

  it('deleting the account forgets this device: push first, the deletion, then the drafts, the client and a hard leave', async () => {
    const clear = vi.fn(() => signOut.steps.push('clear'));
    mockAuthState.value = buildAuthValue({ clear });
    const modal = await fillDeleteAccount();
    const confirm = within(modal).getByRole('button', { name: 'Delete my account' });
    fireEvent.click(confirm);
    // Disabled at once (the push step runs before the request), so no second deletion.
    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(signOut.steps).toEqual(['forget-push', 'delete-account:Jane@Example.com', 'clear-drafts', 'clear', 'leave']);
  });

  it('a deletion that fails keeps the drafts and the session and says so', async () => {
    signOut.fail = true;
    const clear = vi.fn();
    mockAuthState.value = buildAuthValue({ clear });
    const modal = await fillDeleteAccount();
    const confirm = within(modal).getByRole('button', { name: 'Delete my account' });
    fireEvent.click(confirm);
    expect(await within(modal).findByRole('alert')).toHaveTextContent('Your account was not deleted. Try again.');
    expect(signOut.steps).toEqual(['forget-push', 'delete-account:Jane@Example.com']);
    expect(clear).not.toHaveBeenCalled();
    expect(confirm).not.toBeDisabled();
  });

  it('an account without an email (GoApply phone sign-up): the generated address is never shown or asked for', async () => {
    const generated = 'u-0123456789abcdef01234567@users.goapply.invalid';
    const clear = vi.fn(() => signOut.steps.push('clear'));
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ email: generated, name: '' }), clear });

    // #account: no Email row, and the address does not stand in for the name.
    window.history.replaceState(null, '', '/settings#account');
    const account = renderWithBrand(<SettingsPage />, { brand: 'goapply', flags: {} });
    await screen.findByLabelText('Phone', {}, { timeout: 4000 });
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByDisplayValue(generated)).toBeNull();
    expect(document.body.textContent).not.toContain('goapply.invalid');
    account.unmount();

    // Danger zone: confirm with the fixed word; the modal sends the stored address itself.
    window.history.replaceState(null, '', '/settings#danger');
    renderWithBrand(<SettingsPage />, { brand: 'goapply', flags: {} });
    fireEvent.click(await screen.findByRole('button', { name: /Delete account$/ }, { timeout: 4000 }));
    const modal = await screen.findByRole('dialog');
    expect(modal.textContent).not.toContain('goapply.invalid');
    expect(within(modal).getByText('Type DELETE to confirm.')).toBeInTheDocument();
    expect(within(modal).queryByText(/confirmation email/i)).toBeNull();
    fireEvent.change(within(modal).getByPlaceholderText('Tell us why you are leaving (required)'), { target: { value: 'Done.' } });
    const confirm = within(modal).getByRole('button', { name: 'Delete my account' });

    fireEvent.change(within(modal).getByPlaceholderText('DELETE'), { target: { value: 'nope' } });
    fireEvent.click(confirm);
    expect(await within(modal).findByRole('alert')).toHaveTextContent('Type DELETE exactly to confirm.');
    expect(signOut.steps).toEqual([]);

    fireEvent.change(within(modal).getByPlaceholderText('DELETE'), { target: { value: 'delete' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(signOut.steps).toEqual(['forget-push', `delete-account:${generated}`, 'clear-drafts', 'clear', 'leave']);
  });

  it('a wrong email never starts the device cleanup or the deletion', async () => {
    const modal = await fillDeleteAccount();
    fireEvent.change(within(modal).getByPlaceholderText('jane@example.com'), { target: { value: 'someone@else.com' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Delete my account' }));
    expect(await within(modal).findByRole('alert')).toHaveTextContent('That is not the email on this account.');
    await new Promise((r) => setTimeout(r, 20));
    expect(signOut.steps).toEqual([]);
  });

  it('#account: the finish-setup line sits above the account form, on both brands', async () => {
    for (const brand of ['roboapply', 'goapply'] as const) {
      window.history.replaceState(null, '', '/settings#account');
      const view = renderWithBrand(<SettingsPage />, { brand, flags: {} });
      await screen.findByRole('heading', { level: 1, name: /you are/i }, { timeout: 4000 });
      expect(body()!.firstElementChild).toHaveAttribute('data-testid', 'finish-setup');
      view.unmount();
    }
  });

  it('#notifications is the notifications area’s section and never raises the save bar', async () => {
    window.history.replaceState(null, '', '/settings#notifications');
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText('How we reach you')).toBeInTheDocument();
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument();
  });

  it('Your search: the saved searches (search area) with the notes, main resume and company blocklist under them', async () => {
    window.history.replaceState(null, '', '/settings#search');
    renderWithProviders(<SettingsPage />);
    const saved = await screen.findByRole('heading', { level: 2, name: 'Saved searches' });
    const intent = await screen.findByLabelText('What you want next', {}, { timeout: 4000 });
    const blocklist = screen.getByText("Companies you don't want to see jobs from");
    const mainResume = screen.getAllByText('Main resume')[0];
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    // One H1 for the whole section: the setup sentence (C21).
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(follows(screen.getByRole('heading', { level: 1, name: /you're looking for/i }), saved)).toBe(true);
    expect(follows(saved, intent)).toBe(true);
    expect(follows(intent, mainResume)).toBe(true);
    expect(follows(mainResume, blocklist)).toBe(true);
    // The notes are notes: the copy does not claim they hide jobs.
    expect(screen.getByText('Your own lists')).toBeInTheDocument();
    expect(screen.queryByText('Hard rules')).toBeNull();
    expect(screen.queryByText(/Jobs without these are hidden/)).toBeNull();
    expect(screen.getAllByText('Notes for you. To hide jobs, change the filters in a saved search.').length).toBe(2);
  });

  it('the dead controls are gone', async () => {
    window.history.replaceState(null, '', '/settings#account');
    const account = renderWithProviders(<SettingsPage />);
    const name = (await screen.findByLabelText('Full name', {}, { timeout: 4000 })) as HTMLInputElement;
    // Name and email are shown, not editable here: no input that swallows typing.
    expect(name).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Email')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Upload a photo' })).toBeNull();
    account.unmount();

    window.history.replaceState(null, '', '/settings#search');
    const search = renderWithProviders(<SettingsPage />);
    await screen.findByText("Companies you don't want to see jobs from", {}, { timeout: 4000 });
    expect(screen.queryByRole('button', { name: 'Manage the list' })).toBeNull();
    expect(screen.queryByText(/recruiters cannot contact you/)).toBeNull();
    expect(screen.queryByText('Your current employer')).toBeNull();
    search.unmount();

    window.history.replaceState(null, '', '/settings#danger');
    renderWithProviders(<SettingsPage />);
    await screen.findByText('Delete your job data');
    expect(screen.queryByRole('button', { name: 'Reset settings' })).toBeNull();
    expect(screen.getAllByRole('button').filter((b) => /Delete/.test(b.textContent ?? '')).length).toBe(2);
  });
});

describe('/settings — the draft survives a preferences refetch', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/settings');
    vi.restoreAllMocks();
  });

  it('a refetch keeps unsaved edits, takes the server’s other keys, and Save sends only what changed', async () => {
    let client!: QueryClient;
    window.history.replaceState(null, '', '/settings#search');
    renderWithProviders(
      <>
        <ClientProbe onClient={(c) => (client = c)} />
        <SettingsPage />
      </>,
    );

    const intent = (await screen.findByLabelText('What you want next', {}, { timeout: 4000 })) as HTMLTextAreaElement;
    fireEvent.change(intent, { target: { value: 'Hybrid data roles, not finance.' } });
    await screen.findByText('You have unsaved changes');

    // Meanwhile the server copy moves: a saved search changed the projected
    // job titles (search-backed) and another device changed the location.
    await raV2Api.preferences.update({ roleTitles: ['Staff Product Manager'], location: 'Lisbon' } as never);
    const update = vi.spyOn(raV2Api.preferences, 'update');
    await act(async () => {
      await client.invalidateQueries({ queryKey: preferenceKeys.all });
    });
    await waitFor(() =>
      expect((client.getQueryData(preferenceKeys.get()) as { preferences: { location: string } }).preferences.location).toBe('Lisbon'),
    );

    // The unsaved edit is still there and still unsaved.
    expect((screen.getByLabelText('What you want next') as HTMLTextAreaElement).value).toBe('Hybrid data roles, not finance.');
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();

    // Save: only the edited key goes out. The refetched title and location are
    // not echoed back (a stale draft can never undo a saved search).
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toEqual({ intentMarkdown: 'Hybrid data roles, not finance.' });
    await waitFor(() => expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument(), { timeout: 4000 });
    expect((screen.getByLabelText('What you want next') as HTMLTextAreaElement).value).toBe('Hybrid data roles, not finance.');

    // The key the user did not touch took the server's value.
    act(() => {
      window.history.replaceState(null, '', '/settings#account');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(((await screen.findByLabelText('Location')) as HTMLInputElement).value).toBe('Lisbon');
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument();
  });

  it('Discard returns to the latest server copy, not the one the page first loaded', async () => {
    let client!: QueryClient;
    window.history.replaceState(null, '', '/settings#account');
    renderWithProviders(
      <>
        <ClientProbe onClient={(c) => (client = c)} />
        <SettingsPage />
      </>,
    );
    const phone = (await screen.findByLabelText('Phone', {}, { timeout: 4000 })) as HTMLInputElement;
    fireEvent.change(phone, { target: { value: '+1 555 0100' } });
    await screen.findByText('You have unsaved changes');

    await raV2Api.preferences.update({ location: 'Porto' } as never);
    await act(async () => {
      await client.invalidateQueries({ queryKey: preferenceKeys.all });
    });
    await waitFor(() => expect((screen.getByLabelText('Location') as HTMLInputElement).value).toBe('Porto'));
    expect((screen.getByLabelText('Phone') as HTMLInputElement).value).toBe('+1 555 0100');

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument());
    expect((screen.getByLabelText('Location') as HTMLInputElement).value).toBe('Porto');
    expect((screen.getByLabelText('Phone') as HTMLInputElement).value).not.toBe('+1 555 0100');
  });
});

describe('rebasePreferencesDraft / settlePreferencesSave / changedPreferenceKeys (pure)', () => {
  type Blob = Record<string, unknown>;
  const server = (over: Blob = {}): Blob => ({
    intentMarkdown: 'a',
    phone: '',
    links: { linkedin: '', github: '' },
    blockedCompanies: ['Acme'],
    roleTitles: ['Analyst'],
    salaryMinK: 100,
    workModes: { remote: true, hybrid: false, onsite: false },
    updatedAt: 't1',
    ...over,
  });

  it('with no draft, or nothing edited, the server copy replaces both', () => {
    const first = rebasePreferencesDraft<Blob>(null, server());
    expect(first.draft).toEqual(server());
    expect(first.baseline).toEqual(server());
    expect(first.draft).not.toBe(first.baseline); // independent copies
    const next = rebasePreferencesDraft(first, server({ phone: '123', updatedAt: 't2' }));
    expect(next.draft).toEqual(server({ phone: '123', updatedAt: 't2' }));
    expect(changedPreferenceKeys(next.draft, next.baseline)).toEqual({});
  });

  it('an edited draft keeps the user’s keys and takes the server’s for everything else', () => {
    const state = { draft: server({ intentMarkdown: 'mine', links: { linkedin: 'in/me', github: '' } }), baseline: server() };
    const fresh = server({ phone: '999', blockedCompanies: ['Acme', 'Globex'], updatedAt: 't2' });
    const next = rebasePreferencesDraft(state, fresh);
    expect(next.baseline).toEqual(fresh);
    expect(next.draft).toEqual({ ...fresh, intentMarkdown: 'mine', links: { linkedin: 'in/me', github: '' } });
    expect(changedPreferenceKeys(next.draft, next.baseline)).toEqual({ intentMarkdown: 'mine', links: { linkedin: 'in/me', github: '' } });
  });

  it('the search-backed keys always take the server’s value, even when the draft differs', () => {
    const edited = server({ intentMarkdown: 'mine', roleTitles: ['Stale title'], salaryMinK: 1, workModes: { remote: false, hybrid: true, onsite: false } });
    const fresh = server({ roleTitles: ['Staff PM'], salaryMinK: 180 });
    const next = rebasePreferencesDraft({ draft: edited, baseline: server() }, fresh);
    expect(next.draft.roleTitles).toEqual(['Staff PM']);
    expect(next.draft.salaryMinK).toBe(180);
    expect(next.draft.workModes).toEqual({ remote: true, hybrid: false, onsite: false });
    expect(next.draft.intentMarkdown).toBe('mine');
  });

  it('never sends a search-backed key, whatever the draft holds', () => {
    const draft = server({ phone: '1' });
    for (const key of SEARCH_BACKED_PREFERENCE_KEYS) draft[key] = 'changed';
    expect(changedPreferenceKeys(draft, server())).toEqual({ phone: '1' });
    expect([...SEARCH_BACKED_PREFERENCE_KEYS]).toEqual([
      'roleTitles',
      'workModes',
      'cities',
      'salaryMinK',
      'salaryPeriod',
      'employmentTypes',
      'companyStages',
      'companySizes',
      'industriesTarget',
      'industriesAvoid',
      'targetCompanies',
    ]);
  });

  it('the server’s timestamp is never an edit and is never sent', () => {
    const next = rebasePreferencesDraft({ draft: server({ updatedAt: 't0' }), baseline: server({ updatedAt: 't0' }) }, server({ updatedAt: 't9' }));
    expect(next.draft.updatedAt).toBe('t9');
    expect(changedPreferenceKeys(server({ updatedAt: 'mine', phone: '1' }), server())).toEqual({ phone: '1' });
    // Even a draft that somehow holds an old timestamp is not "dirty".
    expect(changedPreferenceKeys(server({ updatedAt: 't0' }), server({ updatedAt: 't9' }))).toEqual({});
  });

  it('after a save: the sent keys are saved, the answer is the baseline, nothing is left unsaved', () => {
    const state = { draft: server({ intentMarkdown: 'mine' }), baseline: server() };
    const answer = server({ intentMarkdown: 'mine', updatedAt: 't2' });
    const next = settlePreferencesSave(state, { intentMarkdown: 'mine' }, answer);
    expect(next.draft).toEqual(answer);
    expect(next.baseline).toEqual(answer);
    expect(changedPreferenceKeys(next.draft, next.baseline)).toEqual({});
    expect(settlePreferencesSave<Blob>(null, {}, answer)).toEqual({ draft: answer, baseline: answer });
  });

  it('after a save: what was typed while the request was in flight stays unsaved', () => {
    const typing = { draft: server({ intentMarkdown: 'mine, and more', phone: '7' }), baseline: server() };
    const answer = server({ intentMarkdown: 'mine', updatedAt: 't2' });
    const next = settlePreferencesSave(typing, { intentMarkdown: 'mine' }, answer);
    expect(changedPreferenceKeys(next.draft, next.baseline)).toEqual({ intentMarkdown: 'mine, and more', phone: '7' });
  });

  it('after a save that raced a refetch: the server’s newer values are not mistaken for edits (the bar clears)', () => {
    // Save was clicked on a draft loaded at t1; before the answer arrived a
    // refetch moved the draft and the baseline to t2 (another device changed
    // the phone). Then the save answers at t3.
    const afterRefetch = rebasePreferencesDraft(
      { draft: server({ intentMarkdown: 'mine' }), baseline: server() },
      server({ phone: '999', updatedAt: 't2' }),
    );
    expect(changedPreferenceKeys(afterRefetch.draft, afterRefetch.baseline)).toEqual({ intentMarkdown: 'mine' });
    const answer = server({ intentMarkdown: 'mine', phone: '999', updatedAt: 't3' });
    const next = settlePreferencesSave(afterRefetch, { intentMarkdown: 'mine' }, answer);
    expect(next.draft).toEqual(answer);
    expect(changedPreferenceKeys(next.draft, next.baseline)).toEqual({});
    // And every later refetch keeps it clean.
    const later = rebasePreferencesDraft(next, server({ intentMarkdown: 'mine', phone: '999', updatedAt: 't4' }));
    expect(changedPreferenceKeys(later.draft, later.baseline)).toEqual({});
  });
});
