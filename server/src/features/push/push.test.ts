// @vitest-environment node
// WP-61: web push — VAPID config, endpoint allowlist, subscribe/unsubscribe
// routes, sends with pruning, the `web_push` delivery channel (job alerts
// mirror to push when subscribed), and the `push.send` worker. No network:
// the push sender is a fake; Prisma is the in-memory fake.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { getBrand } from '../../platform/brand/registry.js';
import { isEnabledForBrand } from '../../platform/flags.js';
import { deliverMessage, deliveryChannels, resetDeliveryChannelsForTests, type DeliverDeps } from '../alerts/index.js';
import type { NotificationPreferencesView } from '../notifications/index.js';
import {
  PUSH_POLICY,
  PushService,
  createPushRouter,
  createWebPushChannel,
  handlePushSend,
  isAllowedPushEndpoint,
  pushChosen,
  registerWebPushChannel,
  safeHref,
  serializePayload,
  vapidConfig,
  webPushServesBrand,
  type PushSender,
  type PushSendResult,
} from './index.js';
import { createPrismaPushRepo } from './repo.js';

const VAPID = { VAPID_PUBLIC_KEY: 'BPublicKeyForTests', VAPID_PRIVATE_KEY: 'privateKeyForTests', VAPID_SUBJECT: 'mailto:support@example.test' };
const FCM = (n: number | string) => `https://fcm.googleapis.com/fcm/send/device-${n}`;
const CN_VAPID = { CN_VAPID_PUBLIC_KEY: 'BCnPublicKey', CN_VAPID_PRIVATE_KEY: 'cnPrivateKey', CN_VAPID_SUBJECT: 'mailto:support@example.test' };
const T0 = new Date('2026-10-10T08:00:00.000Z');

type Fake = ReturnType<typeof createFakePrisma>;

function makeService(db: Fake, sender: PushSender, env: Record<string, string | undefined> = VAPID) {
  const repo = createPrismaPushRepo(async () => db as never);
  return new PushService({ repo, sender, env, now: () => T0 });
}

function fakeDb(seed: Record<string, Record<string, unknown>[]> = {}): Fake {
  return createFakePrisma({
    seed,
    defaults: { rAPushSubscription: { failedCount: 0, lastOkAt: null, userAgent: null } },
    uniqueFields: { rAPushSubscription: ['endpoint'] },
  });
}

function recordingSender(outcome: (endpoint: string) => PushSendResult = () => ({ ok: true, statusCode: 201 })) {
  const calls: Array<{ endpoint: string; payload: string }> = [];
  const sender: PushSender = async (target, payload) => {
    calls.push({ endpoint: target.endpoint, payload });
    return outcome(target.endpoint);
  };
  return { sender, calls };
}

function prefs(channels: Record<string, string[]>): NotificationPreferencesView {
  return { channels } as unknown as NotificationPreferencesView;
}

// ── Pure parts ───────────────────────────────────────────────────────────

describe('config and payload helpers', () => {
  it('needs all three VAPID values and a mailto:/https: subject', () => {
    expect(vapidConfig('roboapply', VAPID)).toEqual({ publicKey: VAPID.VAPID_PUBLIC_KEY, privateKey: VAPID.VAPID_PRIVATE_KEY, subject: VAPID.VAPID_SUBJECT });
    expect(vapidConfig('roboapply', { ...VAPID, VAPID_PRIVATE_KEY: '' })).toBeNull();
    expect(vapidConfig('roboapply', { ...VAPID, VAPID_SUBJECT: 'support@example.test' })).toBeNull();
    // GoApply reads CN_-prefixed names only (no fallback to RoboApply's keys).
    expect(vapidConfig('goapply', VAPID)).toBeNull();
  });

  it('accepts only https endpoints on known browser push services', () => {
    expect(isAllowedPushEndpoint(FCM(1))).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://web.push.apple.com/QGx')).toBe(true);
    expect(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://evil.example.test/fcm.googleapis.com')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.test/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://user:pw@fcm.googleapis.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('not a url')).toBe(false);
  });

  it('keeps click targets same-site and clips the payload', () => {
    expect(safeHref('/jobs/abc?src=alert')).toBe('/jobs/abc?src=alert');
    expect(safeHref('//evil.test/x')).toBe('/inbox');
    expect(safeHref('https://evil.test')).toBe('/inbox');
    expect(safeHref(null)).toBe('/inbox');
    const json = JSON.parse(serializePayload({ title: 'x'.repeat(500), body: 'y'.repeat(900), href: 'javascript:alert(1)', tag: 't'.repeat(100) }));
    expect(json.title).toHaveLength(120);
    expect(json.body).toHaveLength(300);
    expect(json.href).toBe('/inbox');
    expect(json.tag).toHaveLength(64);
  });

  it('push counts only when the person chose it for the category (unknown categories fail closed)', () => {
    expect(pushChosen(prefs({ alert: ['in_app', 'push'] }), 'alert')).toBe(true);
    expect(pushChosen(prefs({ alert: ['in_app', 'email'] }), 'alert')).toBe(false);
    expect(pushChosen(prefs({ alert: ['push'] }), 'mystery')).toBe(false);
    expect(pushChosen(null, 'alert')).toBe(false);
  });
});

// ── Routes ───────────────────────────────────────────────────────────────

describe('/push routes', () => {
  let h: RouteHarness;
  let hNoKeys: RouteHarness;
  let db: Fake;
  const sender = recordingSender();
  const auth = [fakeAuth((req) => (req.headers['x-test-user'] ? { id: String(req.headers['x-test-user']) } : null))];
  const as = (user: string, host = 'localhost:3621') => ({ host, headers: { 'x-test-user': user } });
  const sub = (n: number | string, extra: Record<string, unknown> = {}) => ({ endpoint: FCM(n), keys: { p256dh: `p${n}`, auth: `a${n}` }, ...extra });

  beforeAll(async () => {
    db = fakeDb();
    const service = makeService(db, sender.sender);
    h = await startRouteHarness({ env: VAPID, mounts: [['/api/v1/roboapply/push', createPushRouter({ seekerAuth: auth, env: VAPID, service })]] });
    const bare = makeService(db, sender.sender, {});
    hNoKeys = await startRouteHarness({ env: {}, mounts: [['/api/v1/roboapply/push', createPushRouter({ seekerAuth: auth, env: {}, service: bare })]] });
  });
  afterAll(async () => {
    await h.close();
    await hNoKeys.close();
  });
  beforeEach(() => {
    db.$rows('rAPushSubscription').length = 0;
  });

  it('requires a session', async () => {
    expect((await h.request('GET', '/api/v1/roboapply/push/vapid-public-key')).status).toBe(401);
    expect((await h.request('POST', '/api/v1/roboapply/push/subscriptions', { body: sub(1) })).status).toBe(401);
  });

  it('GoApply has no web push: every route answers 404 feature_disabled', async () => {
    for (const [method, path, body] of [
      ['GET', '/vapid-public-key', undefined],
      ['POST', '/subscriptions', sub(1)],
      ['DELETE', '/subscriptions/x', undefined],
    ] as const) {
      const res = await h.request<{ code: string }>(method, `/api/v1/roboapply/push${path}`, { ...as('u1', 'goapply.localhost:3621'), body });
      expect(res.status, path).toBe(404);
      expect(res.body.code).toBe('feature_disabled');
    }
  });

  it('GoApply stays off in the push area itself, even with a FLAG override and CN_VAPID_* keys', async () => {
    const env = { ...VAPID, ...CN_VAPID, FLAG_GOAPPLY_WEB_PUSH: 'true' };
    // The override really turns the flag on, so the 404 below comes from the service.
    expect(isEnabledForBrand('webPush', getBrand('goapply'), env)).toBe(true);
    expect(webPushServesBrand('goapply')).toBe(false);
    expect(webPushServesBrand('roboapply')).toBe(true);
    const cnDb = fakeDb();
    const service = makeService(cnDb, sender.sender, env);
    const hCn = await startRouteHarness({ env, mounts: [['/api/v1/roboapply/push', createPushRouter({ seekerAuth: auth, env, service })]] });
    try {
      for (const [method, path, body] of [
        ['GET', '/vapid-public-key', undefined],
        ['POST', '/subscriptions', sub(1)],
        ['POST', '/subscriptions/lookup', { endpoint: FCM(1) }],
      ] as const) {
        const res = await hCn.request<{ code: string }>(method, `/api/v1/roboapply/push${path}`, { ...as('u1', 'goapply.localhost:3621'), body });
        expect(res.status, path).toBe(404);
        expect(res.body.code).toBe('feature_disabled');
      }
      expect(cnDb.$rows('rAPushSubscription')).toHaveLength(0);
      // Nothing is sent to a goapply row either, whatever the flag says.
      cnDb.$rows('rAPushSubscription').push({ id: 'g1', userId: 'u1', brand: 'goapply', endpoint: FCM('g1'), p256dh: 'p', auth: 'a', userAgent: null, failedCount: 0, lastOkAt: null, createdAt: T0 });
      const calls = sender.calls.length;
      expect(await service.sendToUser('u1', 'goapply', { title: 't', body: null, href: '/inbox', tag: 't' })).toMatchObject({ subscriptions: 0, sent: 0 });
      expect(await service.devicesFor('u1', 'goapply')).toEqual([]);
      expect(sender.calls.length).toBe(calls);
      // RoboApply on the same router still works.
      expect((await hCn.request('GET', '/api/v1/roboapply/push/vapid-public-key', as('u1'))).status).toBe(200);
    } finally {
      await hCn.close();
    }
  });

  it('lookup says "on" only for the caller’s own row (shared device, pruned device)', async () => {
    const L = '/api/v1/roboapply/push/subscriptions/lookup';
    const none = await h.request<{ data: { subscription: unknown } }>('POST', L, { ...as('u1'), body: { endpoint: FCM(1) } });
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual({ subscription: null });

    const created = await h.request<{ data: { id: string } }>('POST', '/api/v1/roboapply/push/subscriptions', { ...as('u1'), body: sub(1) });
    const mine = await h.request<{ data: { subscription: { id: string } | null } }>('POST', L, { ...as('u1'), body: { endpoint: FCM(1) } });
    expect(mine.body.data.subscription?.id).toBe(created.body.data.id);
    // Another account signed in on the same browser: the row is not theirs.
    const theirs = await h.request<{ data: { subscription: unknown } }>('POST', L, { ...as('u2'), body: { endpoint: FCM(1) } });
    expect(theirs.body.data).toEqual({ subscription: null });
    // The server pruned the device: the browser's subscription reads as off.
    db.$rows('rAPushSubscription').length = 0;
    const pruned = await h.request<{ data: { subscription: unknown } }>('POST', L, { ...as('u1'), body: { endpoint: FCM(1) } });
    expect(pruned.body.data).toEqual({ subscription: null });
    expect((await h.request('POST', L, { ...as('u1'), body: { endpoint: 'not a url' } })).status).toBe(422);
    expect((await h.request('POST', L, { body: { endpoint: FCM(1) } })).status).toBe(401);
  });

  it('answers 501 push_not_configured without VAPID keys, and the key when set', async () => {
    const off = await hNoKeys.request<{ code: string; details: { reason: string } }>('GET', '/api/v1/roboapply/push/vapid-public-key', as('u1'));
    expect(off.status).toBe(501);
    expect(off.body.code).toBe('provider_not_configured');
    expect(off.body.details.reason).toBe('push_not_configured');
    const noSub = await hNoKeys.request('POST', '/api/v1/roboapply/push/subscriptions', { ...as('u1'), body: sub(1) });
    expect(noSub.status).toBe(501);

    const on = await h.request<{ data: { publicKey: string } }>('GET', '/api/v1/roboapply/push/vapid-public-key', as('u1'));
    expect(on.status).toBe(200);
    expect(on.body.data).toEqual({ publicKey: VAPID.VAPID_PUBLIC_KEY });
  });

  it('stores a subscription, refuses unknown push services and validates the body', async () => {
    const res = await h.request<{ data: { id: string; userAgent: string | null; lastSuccessAt: null } }>('POST', '/api/v1/roboapply/push/subscriptions', {
      ...as('u1'),
      body: sub(1, { userAgent: 'Chrome on Mac', expirationTime: null }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ userAgent: 'Chrome on Mac', lastSuccessAt: null });
    expect(db.$rows('rAPushSubscription')).toEqual([expect.objectContaining({ userId: 'u1', brand: 'roboapply', endpoint: FCM(1), p256dh: 'p1', auth: 'a1' })]);

    const bad = await h.request<{ details: { reason: string } }>('POST', '/api/v1/roboapply/push/subscriptions', {
      ...as('u1'),
      body: { endpoint: 'https://collector.example.test/x', keys: { p256dh: 'p', auth: 'a' } },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.details.reason).toBe('push_endpoint_not_allowed');
    expect((await h.request('POST', '/api/v1/roboapply/push/subscriptions', { ...as('u1'), body: { endpoint: FCM(2) } })).status).toBe(422);
    expect(db.$rows('rAPushSubscription')).toHaveLength(1);
  });

  it('the account signed in last owns an endpoint; keys refresh and failures reset', async () => {
    await h.request('POST', '/api/v1/roboapply/push/subscriptions', { ...as('u1'), body: sub(1) });
    db.$rows('rAPushSubscription')[0]!.failedCount = 3;
    await h.request('POST', '/api/v1/roboapply/push/subscriptions', { ...as('u2'), body: { ...sub(1), keys: { p256dh: 'new', auth: 'new' } } });
    expect(db.$rows('rAPushSubscription')).toEqual([expect.objectContaining({ userId: 'u2', p256dh: 'new', failedCount: 0 })]);
  });

  it(`keeps at most ${PUSH_POLICY.maxSubscriptionsPerUser} devices, dropping the oldest`, async () => {
    const rows = db.$rows('rAPushSubscription');
    for (let i = 0; i < PUSH_POLICY.maxSubscriptionsPerUser; i += 1) {
      rows.push({ id: `old${i}`, userId: 'u1', brand: 'roboapply', endpoint: FCM(`old${i}`), p256dh: 'p', auth: 'a', userAgent: null, failedCount: 0, lastOkAt: null, createdAt: new Date(T0.getTime() + i) });
    }
    const res = await h.request('POST', '/api/v1/roboapply/push/subscriptions', { ...as('u1'), body: sub('new') });
    expect(res.status).toBe(201);
    const left = db.$rows('rAPushSubscription').map((r) => r.id);
    expect(left).toHaveLength(PUSH_POLICY.maxSubscriptionsPerUser);
    expect(left).not.toContain('old0');
    expect(left).toContain('old1');
  });

  it('deletes only the caller’s own device', async () => {
    const created = await h.request<{ data: { id: string } }>('POST', '/api/v1/roboapply/push/subscriptions', { ...as('u1'), body: sub(1) });
    const id = created.body.data.id;
    const other = await h.request<{ code: string }>('DELETE', `/api/v1/roboapply/push/subscriptions/${id}`, as('u2'));
    expect(other.status).toBe(404);
    expect(db.$rows('rAPushSubscription')).toHaveLength(1);
    const own = await h.request('DELETE', `/api/v1/roboapply/push/subscriptions/${id}`, as('u1'));
    expect(own.status).toBe(200);
    expect(db.$rows('rAPushSubscription')).toHaveLength(0);
  });
});

// ── Sending and pruning ──────────────────────────────────────────────────

describe('PushService.sendToUser', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    userId: 'u1',
    brand: 'roboapply',
    endpoint: FCM(id),
    p256dh: 'p',
    auth: 'a',
    userAgent: null,
    failedCount: 0,
    lastOkAt: null,
    createdAt: T0,
    ...extra,
  });
  const payload = { title: '2 new jobs for “Data analyst”', body: 'Acme · Remote', href: '/jobs?src=alert', tag: 'n1' };

  it('sends to every device and marks success', async () => {
    const db = fakeDb({ rAPushSubscription: [row('a'), row('b', { failedCount: 2 }), row('c', { userId: 'u2' })] });
    const s = recordingSender();
    const res = await makeService(db, s.sender).sendToUser('u1', 'roboapply', payload);
    expect(res).toEqual({ subscriptions: 2, sent: 2, failed: 0, pruned: 0 });
    expect(s.calls.map((c) => c.endpoint).sort()).toEqual([FCM('a'), FCM('b')]);
    expect(JSON.parse(s.calls[0]!.payload)).toEqual(payload);
    expect(db.$rows('rAPushSubscription').find((r) => r.id === 'b')).toMatchObject({ failedCount: 0, lastOkAt: T0 });
  });

  it('prunes gone endpoints at once and others after repeated failures', async () => {
    const db = fakeDb({ rAPushSubscription: [row('gone'), row('flaky', { failedCount: PUSH_POLICY.maxFailures - 1 }), row('once')] });
    const s = recordingSender((endpoint) =>
      endpoint === FCM('gone') ? { ok: false, statusCode: 410, gone: true, message: 'gone' } : { ok: false, statusCode: 503, gone: false, message: 'busy' },
    );
    const res = await makeService(db, s.sender).sendToUser('u1', 'roboapply', payload);
    expect(res).toEqual({ subscriptions: 3, sent: 0, failed: 3, pruned: 2 });
    expect(db.$rows('rAPushSubscription')).toEqual([expect.objectContaining({ id: 'once', failedCount: 1 })]);
  });

  it('sends nothing without VAPID keys or devices', async () => {
    const s = recordingSender();
    const db = fakeDb({ rAPushSubscription: [row('a')] });
    expect(await makeService(db, s.sender, {}).sendToUser('u1', 'roboapply', payload)).toEqual({ subscriptions: 0, sent: 0, failed: 0, pruned: 0 });
    expect(await makeService(db, s.sender).sendToUser('nobody', 'roboapply', payload)).toMatchObject({ subscriptions: 0, sent: 0 });
    expect(s.calls).toHaveLength(0);
  });
});

// ── The delivery channel ─────────────────────────────────────────────────

describe('web_push delivery channel', () => {
  const ENV = { ...VAPID };
  const message = {
    userId: 'u1',
    brand: 'roboapply' as const,
    locale: 'en',
    kind: 'instant' as const,
    category: 'alert',
    templateKey: 'notify.alertInstant',
    params: { count: 2 },
    href: '/jobs?src=alert',
    notificationId: 'n1',
  };

  function setup(opts: { prefsView?: NotificationPreferencesView | null; devices?: number; outcome?: PushSendResult } = {}) {
    const db = fakeDb({
      rAPushSubscription: Array.from({ length: opts.devices ?? 1 }, (_, i) => ({
        id: `s${i}`,
        userId: 'u1',
        brand: 'roboapply',
        endpoint: FCM(i),
        p256dh: 'p',
        auth: 'a',
        userAgent: null,
        failedCount: 0,
        lastOkAt: null,
        createdAt: T0,
      })),
      seekerNotification: [{ id: 'n1', pushSentAt: null }],
    });
    const s = recordingSender(() => opts.outcome ?? { ok: true, statusCode: 201 });
    const service = makeService(db, s.sender, ENV);
    const preferences = vi.fn(async () => (opts.prefsView === undefined ? prefs({ alert: ['in_app', 'email', 'push'] }) : opts.prefsView));
    const copy = vi.fn(() => ({ title: '2 new jobs for “Data analyst”', body: 'Acme · Remote' }));
    const channel = createWebPushChannel({ service: () => service, preferences, copy, env: ENV });
    return { db, s, channel, preferences, copy };
  }

  it('serves RoboApply only and is unconfigured without VAPID keys', () => {
    expect(setup().channel.brands).toEqual(['roboapply']);
    expect(setup().channel.isConfigured()).toBe(true);
    expect(createWebPushChannel({ env: {} }).isConfigured()).toBe(false);
    expect(createWebPushChannel({ env: { ...VAPID, FLAG_ROBOAPPLY_WEB_PUSH: 'false' } }).isConfigured()).toBe(false);
  });

  it('sends the in-app message’s own text and stamps pushSentAt', async () => {
    const { db, s, channel, copy } = setup();
    expect(await channel.deliver(message)).toEqual({ delivered: true });
    expect(copy).toHaveBeenCalledWith(getBrand('roboapply'), 'en', 'notify.alertInstant', { count: 2 });
    expect(JSON.parse(s.calls[0]!.payload)).toEqual({ title: '2 new jobs for “Data analyst”', body: 'Acme · Remote', href: '/jobs?src=alert', tag: 'n1' });
    expect(db.$rows('seekerNotification')[0]!.pushSentAt).toEqual(T0);
  });

  it('skips when push is not chosen for the category, with no device, or on GoApply', async () => {
    const off = setup({ prefsView: prefs({ alert: ['in_app', 'email'] }) });
    expect(await off.channel.deliver(message)).toEqual({ delivered: false, skippedReason: 'preference_off' });
    expect(off.s.calls).toHaveLength(0);
    expect(await setup({ prefsView: null }).channel.deliver(message)).toMatchObject({ skippedReason: 'preference_off' });
    const noDevice = setup({ devices: 0 });
    expect(await noDevice.channel.deliver(message)).toEqual({ delivered: false, skippedReason: 'no_subscription' });
    // No device → the preferences view is never loaded.
    expect(noDevice.preferences).not.toHaveBeenCalled();
    const cn = setup();
    expect(await cn.channel.deliver({ ...message, brand: 'goapply' })).toEqual({ delivered: false, skippedReason: 'feature_disabled' });
    expect(cn.preferences).not.toHaveBeenCalled();
    // A GoApply flag override does not open the channel either.
    const cnOverride = createWebPushChannel({ env: { ...VAPID, ...CN_VAPID, FLAG_GOAPPLY_WEB_PUSH: 'true' }, preferences: cn.preferences });
    expect(await cnOverride.deliver({ ...message, brand: 'goapply' })).toEqual({ delivered: false, skippedReason: 'feature_disabled' });
    const failed = setup({ outcome: { ok: false, statusCode: 500, gone: false, message: 'x' } });
    expect(await failed.channel.deliver(message)).toEqual({ delivered: false, skippedReason: 'send_failed' });
    expect(failed.db.$rows('seekerNotification')[0]!.pushSentAt).toBeNull();
  });

  it('job alerts mirror to push when subscribed (alerts.deliverMessage → web_push)', async () => {
    const { s, channel, db } = setup();
    const deps: DeliverDeps = {
      createInApp: async () => ({ id: 'n1' }),
      markEmailed: async () => undefined,
      sendEmail: async () => ({ status: 'sent' }) as never,
      channels: () => [channel],
      emailEnabled: () => false,
      now: () => T0,
    };
    const outcome = await deliverMessage(
      {
        recipient: { userId: 'u1', seekerProfileId: 'sp1', brand: 'roboapply', locale: 'en', email: null } as never,
        kind: 'instant',
        category: 'alert',
        templateKey: 'notify.alertInstant',
        params: { count: 2 },
        href: '/jobs?src=alert',
      },
      deps,
    );
    expect(outcome.notificationId).toBe('n1');
    expect(outcome.channels.web_push).toEqual({ delivered: true });
    expect(s.calls).toHaveLength(1);
    expect(db.$rows('seekerNotification')[0]!.pushSentAt).toEqual(T0);
  });

  it('registers itself with alerts for RoboApply only (idempotent)', () => {
    resetDeliveryChannelsForTests();
    const a = registerWebPushChannel();
    const b = registerWebPushChannel();
    expect(a).toBe(b);
    expect(deliveryChannels('roboapply').map((c) => c.id)).toEqual(['web_push']);
    expect(deliveryChannels('goapply')).toEqual([]);
    resetDeliveryChannelsForTests();
  });
});

// ── push.send worker ─────────────────────────────────────────────────────

describe('push.send worker', () => {
  const base = {
    userId: 'u1',
    brand: 'roboapply',
    category: 'alert',
    payload: { title: 'Reminder', body: null, href: '/applications', tag: 'r1' },
    notificationId: 'n9',
  };
  const pushOn = async () => prefs({ alert: ['in_app', 'push'] });

  it('sends, stamps the inbox row, and treats bad items as permanent', async () => {
    const db = fakeDb({
      rAPushSubscription: [{ id: 's1', userId: 'u1', brand: 'roboapply', endpoint: FCM(1), p256dh: 'p', auth: 'a', userAgent: null, failedCount: 0, lastOkAt: null, createdAt: T0 }],
      seekerNotification: [{ id: 'n9', pushSentAt: null }],
    });
    const s = recordingSender();
    const service = makeService(db, s.sender);
    expect(await handlePushSend(base, service, pushOn)).toEqual({ sent: 1, pruned: 0 });
    expect(db.$rows('seekerNotification')[0]!.pushSentAt).toEqual(T0);
    await expect(handlePushSend({ ...base, brand: 'goapply' }, service, pushOn)).rejects.toMatchObject({ name: 'PermanentWorkError' });
    await expect(handlePushSend({ userId: 'u1' }, service, pushOn)).rejects.toMatchObject({ name: 'PermanentWorkError' });
    await expect(handlePushSend({ ...base, category: undefined }, service, pushOn)).rejects.toMatchObject({ name: 'PermanentWorkError' });
    await expect(handlePushSend(base, makeService(db, s.sender, {}), pushOn)).rejects.toMatchObject({ name: 'PermanentWorkError' });
  });

  it('sends nothing when the person did not choose push for the category', async () => {
    const db = fakeDb({
      rAPushSubscription: [{ id: 's1', userId: 'u1', brand: 'roboapply', endpoint: FCM(1), p256dh: 'p', auth: 'a', userAgent: null, failedCount: 0, lastOkAt: null, createdAt: T0 }],
      seekerNotification: [{ id: 'n9', pushSentAt: null }],
    });
    const s = recordingSender();
    const service = makeService(db, s.sender);
    const off = vi.fn(async () => prefs({ alert: ['in_app', 'email'] }));
    expect(await handlePushSend(base, service, off)).toEqual({ sent: 0, pruned: 0, skippedReason: 'preference_off' });
    expect(off).toHaveBeenCalledWith('u1', expect.objectContaining({ id: 'roboapply' }));
    expect(await handlePushSend({ ...base, category: 'mystery' }, service, pushOn)).toMatchObject({ sent: 0, skippedReason: 'preference_off' });
    expect(await handlePushSend(base, service, async () => null)).toMatchObject({ sent: 0, skippedReason: 'preference_off' });
    expect(s.calls).toHaveLength(0);
    expect(db.$rows('seekerNotification')[0]!.pushSentAt).toBeNull();
  });

  it('honours the webPush kill switch like the channel (FLAG_ROBOAPPLY_WEB_PUSH=false → dead at once)', async () => {
    const db = fakeDb({
      rAPushSubscription: [{ id: 's1', userId: 'u1', brand: 'roboapply', endpoint: FCM(1), p256dh: 'p', auth: 'a', userAgent: null, failedCount: 0, lastOkAt: null, createdAt: T0 }],
    });
    const s = recordingSender();
    const preferences = vi.fn(pushOn);
    await expect(handlePushSend(base, makeService(db, s.sender), preferences, { ...VAPID, FLAG_ROBOAPPLY_WEB_PUSH: 'false' })).rejects.toMatchObject({
      name: 'PermanentWorkError',
      message: expect.stringMatching(/disabled/),
    });
    expect(s.calls).toHaveLength(0);
    // A GoApply item stays dead even with a GoApply override.
    await expect(
      handlePushSend({ ...base, brand: 'goapply' }, makeService(db, s.sender, { ...VAPID, ...CN_VAPID }), preferences, { ...CN_VAPID, FLAG_GOAPPLY_WEB_PUSH: 'true' }),
    ).rejects.toMatchObject({ name: 'PermanentWorkError' });
    expect(preferences).not.toHaveBeenCalled();
  });

  it('completes without loading preferences when the person has no device', async () => {
    const s = recordingSender();
    const preferences = vi.fn(pushOn);
    expect(await handlePushSend(base, makeService(fakeDb(), s.sender), preferences)).toEqual({ sent: 0, pruned: 0 });
    expect(preferences).not.toHaveBeenCalled();
  });

  it('retries when no device accepted the message', async () => {
    const db = fakeDb({
      rAPushSubscription: [{ id: 's1', userId: 'u1', brand: 'roboapply', endpoint: FCM(1), p256dh: 'p', auth: 'a', userAgent: null, failedCount: 0, lastOkAt: null, createdAt: T0 }],
    });
    const s = recordingSender(() => ({ ok: false, statusCode: 503, gone: false, message: 'busy' }));
    await expect(handlePushSend(base, makeService(db, s.sender), pushOn)).rejects.toThrow(/no device/);
  });
});
