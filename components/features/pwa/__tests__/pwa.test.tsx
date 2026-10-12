// WP-61: "Get alerts on this device" (permission only after a click, on both
// brands), the install prompt (once, after the second session, through
// the popup gate) and "What's new" (one announcement, through the popup gate,
// marked seen when shown). Network is a fetch double; data is fictional.

import { StrictMode, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const authState = vi.hoisted(() => ({ status: 'authenticated' as 'authenticated' | 'loading' | 'unauthenticated', user: { id: 'u1', role: 'seeker' } as { id: string; role: string } | null }));
vi.mock('../../../../lib/auth/useAuth', () => ({ useAuth: () => authState }));
const toastCalls = vi.hoisted(() => [] as Array<{ message: string }>);
vi.mock('../../../v3/primitives/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../v3/primitives/Toast')>();
  return {
    ...actual,
    toast: (input: Parameters<typeof actual.toast>[0]) => {
      toastCalls.push({ message: String(input.message) });
      return actual.toast(input);
    },
  };
});

import { BrandProvider, clientBrandFor, type BrandId } from '../../../../lib/brand';
import { IntlWrapper } from '../../../../__tests__/utils/mockTranslations';
import { capsFor } from '../../../../__tests__/shell/helpers';
import type { ResolvedFlags } from '../../../../server/src/platform/flags';
import { __setPopupGate, createPopupGate } from '../../../../lib/ui/popupGate';
import { fail, installFetch, ok } from '../../filters/filters.testkit';
import { AnnouncementModal } from '../../notifications/AnnouncementModal';
import { PushOptIn } from '../PushOptIn';
import { PwaInstallPrompt } from '../InstallPrompt';
import { WhatsNew, isInternalHref } from '../WhatsNew';
import { PWA_SESSION_COUNT_KEY, PWA_SESSION_MARK_KEY, PWA_INSTALL_SHOWN_KEY, boundToAnotherKey, forgetPushDeviceOnSignOut, urlBase64ToUint8Array } from '../../../../hooks/pwa';
import { pushChannelPatch } from '../PushOptIn';

const P = '/api/v1/roboapply/push';
const N = '/api/v1/roboapply/notifications/preferences';
const UI = '/api/v1/roboapply/ui-state';
const AN = '/api/v1/roboapply/announcements';

function renderUi(ui: ReactElement, opts: { brand?: BrandId; flags?: Partial<ResolvedFlags> } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const brand = opts.brand ?? 'roboapply';
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <IntlWrapper>
          <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={capsFor(brand, opts.flags ?? {})}>
            {children}
          </BrandProvider>
        </IntlWrapper>
      </QueryClientProvider>
    );
  }
  return { client, ...render(ui, { wrapper: Wrapper }) };
}

function syncGate() {
  const gate = createPopupGate({ now: () => Date.now(), loadLocal: () => null, saveLocal: () => undefined, persist: () => undefined, schedule: (fn) => fn() });
  __setPopupGate(gate);
  return gate;
}

const uiState = (dismissals: Record<string, { count: number; at: string }> = {}) => ({
  state: { tours: {}, dismissals, popupLastShownAt: null, announcementsSeen: [], values: {} },
  lastFeedVisitAt: null,
  updatedAt: null,
});

function prefsView() {
  return {
    tipsReminders: true,
    channels: { alert: ['in_app', 'email'], reminder: ['in_app'], billing: ['in_app'], system: ['in_app'], invitation: ['in_app'], tips: ['in_app'], announcement: ['in_app'] },
    quietHours: { start: '21:00', end: '08:00' },
    tipsRemindersDefault: true,
    tipsRemindersSource: 'default',
    tipsRemindersConsent: { text: 'x', locale: 'en', version: 'v' },
    availableChannels: ['in_app', 'email', 'push'],
    emailUnavailableReason: null,
    configurableCategories: ['alert', 'reminder', 'tips', 'invitation'],
    lockedCategories: ['billing', 'system'],
    productNewsEmail: null,
  };
}

beforeEach(() => {
  toastCalls.length = 0;
  authState.status = 'authenticated';
  authState.user = { id: 'u1', role: 'seeker' };
  window.localStorage.clear();
  window.sessionStorage.clear();
  syncGate();
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setPopupGate(null);
});

// ── Push opt-in ──────────────────────────────────────────────────────────

describe('PushOptIn', () => {
  /**
   * `existingKey`: the VAPID public key the browser's existing subscription was
   * made with (a real browser reports it as `options.applicationServerKey`).
   * With it the double behaves like a browser: `subscribe()` with another key
   * throws while that subscription exists, and after `unsubscribe()` it hands
   * out a NEW subscription (another endpoint) bound to the key it was given.
   */
  function installBrowserPush(opts: { permission?: NotificationPermission; answer?: NotificationPermission; existing?: boolean; existingKey?: string } = {}) {
    type Sub = {
      endpoint: string;
      toJSON: () => { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
      unsubscribe: ReturnType<typeof vi.fn>;
      options?: { applicationServerKey: ArrayBuffer };
    };
    let current: Sub | null = null;
    const make = (id: string, key?: Uint8Array<ArrayBuffer>): Sub => {
      const sub: Sub = {
        endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
        toJSON: () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, expirationTime: null, keys: { p256dh: 'pk', auth: 'ak' } }),
        unsubscribe: vi.fn(async () => {
          if (current === sub) current = null;
          return true;
        }),
        ...(key ? { options: { applicationServerKey: key.buffer } } : {}),
      };
      return sub;
    };
    const subscription = make('dev1', opts.existingKey ? urlBase64ToUint8Array(opts.existingKey) : undefined);
    current = opts.existing ? subscription : null;
    const pushManager = {
      getSubscription: vi.fn(async () => current),
      subscribe: vi.fn(async (init: { applicationServerKey: Uint8Array<ArrayBuffer> }) => {
        if (!opts.existingKey) {
          current = subscription;
          return subscription;
        }
        if (current) throw new DOMException('A subscription with a different applicationServerKey already exists', 'InvalidStateError');
        current = make('dev2', init.applicationServerKey);
        return current;
      }),
    };
    const registration = { pushManager };
    let registered = Boolean(opts.existing);
    const serviceWorker = {
      getRegistration: vi.fn(async () => (registered ? registration : undefined)),
      register: vi.fn(async () => {
        registered = true;
        return registration;
      }),
      ready: Promise.resolve(registration),
    };
    const requestPermission = vi.fn(async () => opts.answer ?? 'granted');
    const Notification = Object.assign(function Notification() {}, { permission: opts.permission ?? 'default', requestPermission });
    vi.stubGlobal('Notification', Notification);
    vi.stubGlobal('PushManager', function PushManager() {});
    Object.defineProperty(window.navigator, 'serviceWorker', { value: serviceWorker, configurable: true });
    return { serviceWorker, pushManager, requestPermission, subscription };
  }
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, 'serviceWorker');
  });

  it('never asks for permission on load; asks, registers and subscribes only on click; adds "This device" to alerts', async () => {
    const browser = installBrowserPush();
    const net = installFetch({
      [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' }),
      [`POST ${P}/subscriptions`]: () => ok({ id: 'sub_1', userAgent: 'Chrome on macOS', createdAt: '2026-10-10T00:00:00Z', lastSuccessAt: null }, 201),
      [`GET ${N}`]: () => ok(prefsView()),
      [`PATCH ${N}`]: (c) => ok({ ...prefsView(), channels: { ...prefsView().channels, ...(c.body as { channels: object }).channels } }),
    });
    renderUi(<PushOptIn />, { flags: { webPush: true } });
    const button = await screen.findByRole('button', { name: 'Get alerts on this device' });
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(browser.serviceWorker.register).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(net.to('POST', `${P}/subscriptions`)).toHaveLength(1), { timeout: 4000 });
    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    expect(browser.serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(browser.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(net.to('POST', `${P}/subscriptions`)[0]!.body).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/dev1',
      expirationTime: null,
      keys: { p256dh: 'pk', auth: 'ak' },
      userAgent: expect.any(String),
    });
    await waitFor(() => expect(net.to('PATCH', N)).toHaveLength(1));
    expect(net.to('PATCH', N)[0]!.body).toEqual({ channels: { alert: ['in_app', 'email', 'push'], reminder: ['in_app', 'push'] } });
    expect(await screen.findByRole('button', { name: 'Stop alerts on this device' })).toBeTruthy();
    expect(window.localStorage.getItem('ra_push_subscription_id')).toBe('sub_1');
  });

  const VIEW = { id: 'sub_1', userAgent: 'Chrome on macOS', createdAt: '2026-10-10T00:00:00Z', lastSuccessAt: null };
  const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

  it('turning it off deletes this device and unsubscribes', async () => {
    const browser = installBrowserPush({ permission: 'granted', existing: true });
    window.localStorage.setItem('ra_push_subscription_id', 'sub_1');
    const net = installFetch({
      [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: 'BEl6' }),
      [`POST ${P}/subscriptions/lookup`]: () => ok({ subscription: VIEW }),
      [`DELETE ${P}/subscriptions/sub_1`]: () => ok(null),
      [`GET ${N}`]: () => ok(prefsView()),
    });
    renderUi(<PushOptIn />, { flags: { webPush: true } });
    const button = await screen.findByRole('button', { name: 'Stop alerts on this device' });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(net.to('DELETE', `${P}/subscriptions/sub_1`)).toHaveLength(1));
    await waitFor(() => expect(browser.subscription.unsubscribe).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Get alerts on this device' })).toBeTruthy();
  });

  it('shows "on" only when the server row is this account’s: another account’s subscription (shared device) reads as off and a click re-claims it', async () => {
    const browser = installBrowserPush({ permission: 'granted', existing: true });
    window.localStorage.setItem('ra_push_subscription_id', 'sub_of_previous_account');
    const net = installFetch({
      [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: KEY }),
      [`POST ${P}/subscriptions/lookup`]: () => ok({ subscription: null }),
      [`POST ${P}/subscriptions`]: () => ok({ ...VIEW, id: 'sub_2' }, 201),
      [`GET ${N}`]: () => ok(prefsView()),
      [`PATCH ${N}`]: () => ok(prefsView()),
    });
    renderUi(<PushOptIn />, { flags: { webPush: true } });
    const button = await screen.findByRole('button', { name: 'Get alerts on this device' });
    expect(net.to('POST', `${P}/subscriptions/lookup`)[0]!.body).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/dev1' });
    expect(screen.queryByRole('button', { name: 'Stop alerts on this device' })).toBeNull();
    expect(window.localStorage.getItem('ra_push_subscription_id')).toBeNull();
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(net.to('POST', `${P}/subscriptions`)).toHaveLength(1));
    // The browser's existing subscription is reused and claimed for this account.
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(net.to('POST', `${P}/subscriptions`)[0]!.body).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/dev1' });
    expect(await screen.findByRole('button', { name: 'Stop alerts on this device' })).toBeTruthy();
  });

  it('a pruned device (browser still subscribed, no server row) reads as off; a failed lookup also reads as off', async () => {
    installBrowserPush({ permission: 'granted', existing: true });
    installFetch({
      [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: KEY }),
      [`POST ${P}/subscriptions/lookup`]: () => fail(500, 'internal'),
      [`GET ${N}`]: () => ok(prefsView()),
    });
    renderUi(<PushOptIn />, { flags: { webPush: true } });
    expect(await screen.findByRole('button', { name: 'Get alerts on this device' })).toBeTruthy();
  });

  // The server now signs with another VAPID pair than the one this device
  // subscribed with (GoApply moved from the shared pair to CN_VAPID_*).
  const OLD_KEY = KEY.replace('BEl62', 'BEl63');
  const DEV2 = 'https://fcm.googleapis.com/fcm/send/dev2';

  it('boundToAnotherKey: true only when the browser reports a different key; the same key and an unknown key keep the subscription', () => {
    const made = (key?: string) => ({ options: key ? { applicationServerKey: urlBase64ToUint8Array(key).buffer } : undefined }) as unknown as PushSubscription;
    expect(urlBase64ToUint8Array(OLD_KEY)).not.toEqual(urlBase64ToUint8Array(KEY));
    expect(boundToAnotherKey(made(OLD_KEY), KEY)).toBe(true);
    expect(boundToAnotherKey(made(KEY), KEY)).toBe(false);
    expect(boundToAnotherKey(made(), KEY)).toBe(false);
    expect(boundToAnotherKey({} as PushSubscription, KEY)).toBe(false);
    expect(boundToAnotherKey(made(OLD_KEY), 'not base64 !')).toBe(false);
  });

  it('a device that is on but subscribed with the old key is renewed on load without asking: old subscription dropped here and on the server, new one stored', async () => {
    const browser = installBrowserPush({ permission: 'granted', existing: true, existingKey: OLD_KEY });
    window.localStorage.setItem('ra_push_subscription_id', 'sub_1');
    const net = installFetch({
      [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: KEY }),
      [`POST ${P}/subscriptions/lookup`]: () => ok({ subscription: VIEW }),
      [`DELETE ${P}/subscriptions/sub_1`]: () => ok(null),
      [`POST ${P}/subscriptions`]: () => ok({ ...VIEW, id: 'sub_2' }, 201),
      [`GET ${N}`]: () => ok(prefsView()),
    });
    renderUi(<PushOptIn />, { brand: 'goapply', flags: { webPush: true } });
    await waitFor(() => expect(net.to('POST', `${P}/subscriptions`)).toHaveLength(1), { timeout: 4000 });
    expect(browser.subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(net.to('DELETE', `${P}/subscriptions/sub_1`)).toHaveLength(1);
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(browser.pushManager.subscribe.mock.calls[0]![0].applicationServerKey).toEqual(urlBase64ToUint8Array(KEY));
    expect(net.to('POST', `${P}/subscriptions`)[0]!.body).toMatchObject({ endpoint: DEV2 });
    // Nothing is asked and nothing is registered: the permission and the worker were already there.
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(browser.serviceWorker.register).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Stop alerts on this device' })).toBeTruthy();
    await waitFor(() => expect(window.localStorage.getItem('ra_push_subscription_id')).toBe('sub_2'));
  });

  it('the renewal runs once and leaves the button usable when React runs effects twice (strict mode)', async () => {
    const browser = installBrowserPush({ permission: 'granted', existing: true, existingKey: OLD_KEY });
    const net = installFetch({
      [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: KEY }),
      [`POST ${P}/subscriptions/lookup`]: () => ok({ subscription: VIEW }),
      [`DELETE ${P}/subscriptions/sub_1`]: () => ok(null),
      [`POST ${P}/subscriptions`]: () => ok({ ...VIEW, id: 'sub_2' }, 201),
      [`GET ${N}`]: () => ok(prefsView()),
    });
    renderUi(
      <StrictMode>
        <PushOptIn />
      </StrictMode>,
      { flags: { webPush: true } },
    );
    await waitFor(() => expect(net.to('POST', `${P}/subscriptions`)).toHaveLength(1), { timeout: 4000 });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Stop alerts on this device' }) as HTMLButtonElement).disabled).toBe(false));
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(net.to('POST', `${P}/subscriptions`)).toHaveLength(1);
  });

  it('when that renewal fails the device reads as off, and a click subscribes with the served key', async () => {
    const browser = installBrowserPush({ permission: 'granted', existing: true, existingKey: OLD_KEY });
    let stored = 0;
    const net = installFetch({
      [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: KEY }),
      [`POST ${P}/subscriptions/lookup`]: () => ok({ subscription: VIEW }),
      [`DELETE ${P}/subscriptions/sub_1`]: () => ok(null),
      [`POST ${P}/subscriptions`]: () => {
        stored += 1;
        return stored === 1 ? fail(500, 'internal') : ok({ ...VIEW, id: 'sub_2' }, 201);
      },
      [`GET ${N}`]: () => ok(prefsView()),
      [`PATCH ${N}`]: () => ok(prefsView()),
    });
    renderUi(<PushOptIn />, { flags: { webPush: true } });
    const button = await screen.findByRole('button', { name: 'Get alerts on this device' }, { timeout: 4000 });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(net.to('POST', `${P}/subscriptions`)).toHaveLength(2), { timeout: 4000 });
    // The subscription made during the failed renewal already uses the served key: it is reused, not replaced again.
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(net.to('POST', `${P}/subscriptions`)[1]!.body).toMatchObject({ endpoint: DEV2 });
    expect(await screen.findByRole('button', { name: 'Stop alerts on this device' })).toBeTruthy();
  });

  it('a pruned device still holding a subscription made with the old key: a click replaces it instead of registering it again', async () => {
    const browser = installBrowserPush({ permission: 'granted', existing: true, existingKey: OLD_KEY });
    const net = installFetch({
      [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: KEY }),
      [`POST ${P}/subscriptions/lookup`]: () => ok({ subscription: null }),
      [`POST ${P}/subscriptions`]: () => ok({ ...VIEW, id: 'sub_2' }, 201),
      [`GET ${N}`]: () => ok(prefsView()),
      [`PATCH ${N}`]: () => ok(prefsView()),
    });
    renderUi(<PushOptIn />, { brand: 'goapply', flags: { webPush: true } });
    const button = await screen.findByRole('button', { name: 'Get alerts on this device' });
    // Not this account's row (pruned): nothing is renewed on load.
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(net.to('POST', `${P}/subscriptions`)).toHaveLength(1), { timeout: 4000 });
    expect(browser.subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(browser.pushManager.subscribe.mock.calls[0]![0].applicationServerKey).toEqual(urlBase64ToUint8Array(KEY));
    expect(net.to('POST', `${P}/subscriptions`)[0]!.body).toMatchObject({ endpoint: DEV2 });
    expect(net.to('DELETE', `${P}/subscriptions/sub_1`)).toHaveLength(0);
    expect(await screen.findByRole('button', { name: 'Stop alerts on this device' })).toBeTruthy();
  });

  it('a device subscribed with the key the server still serves is left alone', async () => {
    const browser = installBrowserPush({ permission: 'granted', existing: true, existingKey: KEY });
    const net = installFetch({
      [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: KEY }),
      [`POST ${P}/subscriptions/lookup`]: () => ok({ subscription: VIEW }),
      [`GET ${N}`]: () => ok(prefsView()),
    });
    renderUi(<PushOptIn />, { flags: { webPush: true } });
    expect(await screen.findByRole('button', { name: 'Stop alerts on this device' })).toBeTruthy();
    await waitFor(() => expect(net.to('GET', `${P}/vapid-public-key`)).toHaveLength(1));
    expect(browser.subscription.unsubscribe).not.toHaveBeenCalled();
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(net.to('POST', `${P}/subscriptions`)).toHaveLength(0);
  });

  it('when saving "This device" to the channels fails: no "Alerts are on", the error shows and the new subscription is removed', async () => {
    const browser = installBrowserPush();
    const net = installFetch({
      [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: KEY }),
      [`POST ${P}/subscriptions`]: () => ok(VIEW, 201),
      [`DELETE ${P}/subscriptions/sub_1`]: () => ok(null),
      [`GET ${N}`]: () => ok(prefsView()),
      [`PATCH ${N}`]: () => fail(500, 'internal'),
    });
    renderUi(<PushOptIn />, { flags: { webPush: true } });
    const button = await screen.findByRole('button', { name: 'Get alerts on this device' });
    await waitFor(() => expect(net.to('GET', N)).toHaveLength(1));
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(net.to('PATCH', N)).toHaveLength(1));
    await waitFor(() => expect(net.to('DELETE', `${P}/subscriptions/sub_1`)).toHaveLength(1));
    await waitFor(() => expect(browser.subscription.unsubscribe).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', "That didn't work. Try again.");
    expect(screen.getByRole('button', { name: 'Get alerts on this device' })).toBeTruthy();
    expect(toastCalls.map((c) => c.message)).not.toContain('Alerts are on for this device.');
  });

  it('when the settings cannot carry push, it says so and never asks the browser', async () => {
    const browser = installBrowserPush();
    const net = installFetch({
      [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: KEY }),
      [`GET ${N}`]: () => ok({ ...prefsView(), availableChannels: ['in_app', 'email'] }),
    });
    renderUi(<PushOptIn />, { flags: { webPush: true } });
    const button = await screen.findByRole('button', { name: 'Get alerts on this device' });
    await waitFor(() => expect(net.to('GET', N)).toHaveLength(1));
    await act(async () => {
      fireEvent.click(button);
    });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', "Alerts on this device can't be turned on for your account right now.");
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(net.to('POST', `${P}/subscriptions`)).toHaveLength(0);
    expect(toastCalls).toHaveLength(0);
  });

  it('pushChannelPatch: null when push is unavailable or no alert/reminder category is configurable; {} when already chosen', () => {
    const v = prefsView() as unknown as Parameters<typeof pushChannelPatch>[0] & object;
    expect(pushChannelPatch(null)).toBeNull();
    expect(pushChannelPatch({ ...v, availableChannels: ['in_app'] })).toBeNull();
    expect(pushChannelPatch({ ...v, configurableCategories: ['tips'] })).toBeNull();
    expect(pushChannelPatch({ ...v, channels: { ...v.channels, alert: ['in_app', 'push'], reminder: ['push'] } })).toEqual({});
    expect(pushChannelPatch(v)).toEqual({ alert: ['in_app', 'email', 'push'], reminder: ['in_app', 'push'] });
  });

  it('forgetPushDeviceOnSignOut deletes this account’s row and unsubscribes the browser', async () => {
    const browser = installBrowserPush({ permission: 'granted', existing: true });
    const net = installFetch({
      [`POST ${P}/subscriptions/lookup`]: () => ok({ subscription: VIEW }),
      [`DELETE ${P}/subscriptions/sub_1`]: () => ok(null),
    });
    await forgetPushDeviceOnSignOut();
    expect(net.to('DELETE', `${P}/subscriptions/sub_1`)).toHaveLength(1);
    expect(browser.subscription.unsubscribe).toHaveBeenCalled();
    expect(browser.requestPermission).not.toHaveBeenCalled();
  });

  it('forgetPushDeviceOnSignOut still unsubscribes when the row is not this account’s or the server fails, and is a no-op without a subscription', async () => {
    const browser = installBrowserPush({ permission: 'granted', existing: true });
    const net = installFetch({ [`POST ${P}/subscriptions/lookup`]: () => fail(500, 'internal') });
    await forgetPushDeviceOnSignOut();
    expect(browser.subscription.unsubscribe).toHaveBeenCalled();
    expect(net.to('DELETE', `${P}/subscriptions/sub_1`)).toHaveLength(0);

    const none = installBrowserPush();
    const net2 = installFetch({});
    await forgetPushDeviceOnSignOut();
    expect(net2.calls).toHaveLength(0);
    expect(none.subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it('explains a blocked permission instead of offering the button', async () => {
    installBrowserPush({ permission: 'denied' });
    installFetch({ [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: 'BEl6' }), [`GET ${N}`]: () => ok(prefsView()) });
    renderUi(<PushOptIn />, { flags: { webPush: true } });
    expect(await screen.findByText(/Notifications are blocked for this site/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('GoApply with web push on (the shared VAPID pair): the same opt-in; a click asks the browser and subscribes', async () => {
    const browser = installBrowserPush();
    const net = installFetch({
      [`GET ${P}/vapid-public-key`]: () => ok({ publicKey: KEY }),
      [`POST ${P}/subscriptions`]: () => ok(VIEW, 201),
      [`GET ${N}`]: () => ok(prefsView()),
      [`PATCH ${N}`]: (c) => ok({ ...prefsView(), channels: { ...prefsView().channels, ...(c.body as { channels: object }).channels } }),
    });
    renderUi(<PushOptIn />, { brand: 'goapply', flags: { webPush: true } });
    const button = await screen.findByRole('button', { name: 'Get alerts on this device' });
    expect(browser.requestPermission).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(net.to('POST', `${P}/subscriptions`)).toHaveLength(1), { timeout: 4000 });
    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Stop alerts on this device' })).toBeTruthy();
  });

  it('renders nothing while the webPush flag is off (either brand: FLAG_<BRAND>_WEB_PUSH=false or no keys), without VAPID keys, or without browser support', async () => {
    const browser = installBrowserPush();
    const net = installFetch({ [`GET ${P}/vapid-public-key`]: () => fail(501, 'provider_not_configured', { reason: 'push_not_configured' }) });
    const cn = renderUi(<PushOptIn />, { brand: 'goapply', flags: { webPush: false } });
    expect(cn.container.innerHTML).toBe('');
    expect(net.to('GET', `${P}/vapid-public-key`)).toHaveLength(0);
    cn.unmount();

    const noKeys = renderUi(<PushOptIn />, { flags: { webPush: true } });
    await waitFor(() => expect(net.to('GET', `${P}/vapid-public-key`)).toHaveLength(1));
    expect(noKeys.container.innerHTML).toBe('');
    noKeys.unmount();

    Reflect.deleteProperty(window.navigator, 'serviceWorker');
    const old = renderUi(<PushOptIn />, { flags: { webPush: true } });
    expect(old.container.innerHTML).toBe('');
    expect(browser.requestPermission).not.toHaveBeenCalled();
  });
});

// ── Install prompt ───────────────────────────────────────────────────────

describe('PwaInstallPrompt', () => {
  function fireInstallEvent() {
    const prompt = vi.fn(async () => undefined);
    const ev = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    act(() => {
      window.dispatchEvent(ev);
    });
    return { prompt, ev };
  }

  it('waits for the second session', async () => {
    installFetch({ [`GET ${UI}`]: () => ok(uiState()) });
    renderUi(<PwaInstallPrompt />);
    fireInstallEvent();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('pwa-install-prompt')).toBeNull();
    expect(window.localStorage.getItem(PWA_SESSION_COUNT_KEY)).toBe('1');
  });

  it('shows once from the second session, through the popup gate, and installs on click', async () => {
    window.localStorage.setItem(PWA_SESSION_COUNT_KEY, '1'); // one earlier session
    const net = installFetch({ [`GET ${UI}`]: () => ok(uiState()), [`PATCH ${UI}`]: () => ok(uiState({ 'pwa.installPrompt': { count: 1, at: '2026-10-10T00:00:00Z' } })) });
    renderUi(<PwaInstallPrompt />);
    const { prompt, ev } = fireInstallEvent();
    expect(ev.defaultPrevented).toBe(true);
    expect(await screen.findByTestId('pwa-install-prompt')).toBeTruthy();
    expect(screen.getByText('Add RoboApply to your home screen')).toBeTruthy();
    await waitFor(() => expect(net.to('PATCH', UI)).toHaveLength(1));
    expect(net.to('PATCH', UI)[0]!.body).toEqual({ dismiss: ['pwa.installPrompt'] });
    expect(window.localStorage.getItem(PWA_INSTALL_SHOWN_KEY)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('asks the gate as install_prompt, the lowest priority: news asking in the same moment is shown and the install prompt is not used up', async () => {
    window.localStorage.setItem(PWA_SESSION_COUNT_KEY, '1');
    const queue: Array<() => void> = [];
    const gate = createPopupGate({ now: () => Date.now(), loadLocal: () => null, saveLocal: () => undefined, persist: () => undefined, schedule: (fn) => void queue.push(fn) });
    __setPopupGate(gate);
    gate.notePageView('/jobs');
    const asked = vi.spyOn(gate, 'request');
    const net = installFetch({ [`GET ${UI}`]: () => ok(uiState()), [`PATCH ${UI}`]: () => ok(uiState()) });
    renderUi(<PwaInstallPrompt />);
    fireInstallEvent();
    await waitFor(() => expect(asked).toHaveBeenCalledWith('pwa:install', 'install_prompt', { essential: false }));
    // "What's new" mounts in the same moment, after the install prompt asked.
    const news = gate.request('announcement:a1', 'announcement');
    await act(async () => {
      queue.splice(0).forEach((fn) => fn());
      await Promise.resolve();
    });
    expect(await news).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('pwa-install-prompt')).toBeNull();
    // Not shown, so not marked as shown: it can be offered on a later visit.
    expect(net.to('PATCH', UI)).toHaveLength(0);
    expect(window.localStorage.getItem(PWA_INSTALL_SHOWN_KEY)).toBeNull();
  });

  it('stays hidden when the account already saw it or another popup holds the page view', async () => {
    window.localStorage.setItem(PWA_SESSION_COUNT_KEY, '3');
    window.sessionStorage.setItem(PWA_SESSION_MARK_KEY, '1');
    installFetch({ [`GET ${UI}`]: () => ok(uiState({ 'pwa.installPrompt': { count: 1, at: '2026-10-01T00:00:00Z' } })) });
    const seen = renderUi(<PwaInstallPrompt />);
    fireInstallEvent();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('pwa-install-prompt')).toBeNull();
    seen.unmount();

    const gate = syncGate();
    gate.notePageView('/jobs');
    await gate.request('other:popup', 'offer');
    installFetch({ [`GET ${UI}`]: () => ok(uiState()) });
    renderUi(<PwaInstallPrompt />);
    fireInstallEvent();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('pwa-install-prompt')).toBeNull();
  });
});

// ── What's new ───────────────────────────────────────────────────────────

describe("What's new (AnnouncementModal slot)", () => {
  const announcement = { id: 'a1', key: 'launch.assistant', title: 'Ask about any job', body: 'Open a job and press Ask.\nAnswers cite the posting.', ctaLabel: 'Try it', ctaHref: '/jobs' };

  it('shows one announcement through the popup gate and marks it seen when shown', async () => {
    const net = installFetch({
      [`GET ${AN}/next`]: () => ok({ announcement }),
      [`POST ${AN}/a1/seen`]: () => ok(null),
      [`GET ${UI}`]: () => ok(uiState()),
    });
    renderUi(<AnnouncementModal />);
    expect(await screen.findByText('Ask about any job')).toBeTruthy();
    expect(screen.getByText(/Answers cite the posting/)).toBeTruthy();
    expect(net.to('GET', `${AN}/next`)[0]!.search).toBe('?locale=en');
    await waitFor(() => expect(net.to('POST', `${AN}/a1/seen`)).toHaveLength(1));
    expect(screen.getByRole('link', { name: 'Try it' }).getAttribute('href')).toBe('/jobs');
    fireEvent.click(screen.getByText('Close', { selector: 'button' }));
    await waitFor(() => expect(screen.queryByText('Ask about any job')).toBeNull());
    expect(net.to('POST', `${AN}/a1/seen`)).toHaveLength(1);
  });

  it('treats only a plain same-site path as an internal link', () => {
    expect(isInternalHref('/jobs')).toBe(true);
    expect(isInternalHref('/jobs?x=1')).toBe(true);
    expect(isInternalHref('/\\evil.example')).toBe(false);
    expect(isInternalHref('//evil.example')).toBe(false);
    expect(isInternalHref('https://example.com')).toBe(false);
    expect(isInternalHref(null)).toBe(false);
  });

  it('never renders a backslash path as a same-site link', async () => {
    syncGate();
    installFetch({
      [`GET ${AN}/next`]: () => ok({ announcement: { ...announcement, ctaHref: '/\\evil.example' } }),
      [`POST ${AN}/a1/seen`]: () => ok(null),
      [`GET ${UI}`]: () => ok(uiState()),
    });
    renderUi(<WhatsNew />);
    expect(await screen.findByText('Ask about any job')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Try it' })).toBeNull();
  });

  it('shows nothing when the gate denies the slot, when there is none, or signed out', async () => {
    const gate = syncGate();
    gate.notePageView('/jobs');
    await gate.request('other:popup', 'offer');
    const net = installFetch({ [`GET ${AN}/next`]: () => ok({ announcement }), [`GET ${UI}`]: () => ok(uiState()) });
    const denied = renderUi(<WhatsNew />);
    await waitFor(() => expect(net.to('GET', `${AN}/next`)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Ask about any job')).toBeNull();
    expect(net.to('POST', `${AN}/a1/seen`)).toHaveLength(0);
    denied.unmount();

    syncGate();
    const none = installFetch({ [`GET ${AN}/next`]: () => ok({ announcement: null }) });
    const empty = renderUi(<WhatsNew />);
    await waitFor(() => expect(none.to('GET', `${AN}/next`)).toHaveLength(1));
    expect(empty.container.innerHTML).toBe('');
    empty.unmount();

    authState.status = 'unauthenticated';
    const out = installFetch({});
    renderUi(<WhatsNew />);
    await new Promise((r) => setTimeout(r, 20));
    expect(out.calls).toHaveLength(0);
  });
});
