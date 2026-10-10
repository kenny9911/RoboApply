// @vitest-environment node
//
// WP-39b: message center, notification settings, email preference gate and
// one-click unsubscribe. In-memory Prisma (no database, no network).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));

import type { RequestHandler } from 'express';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import { getBrand } from '../../../platform/brand/registry.js';
import { createUnsubscribeToken, hashEmail } from '../../../platform/email/unsubscribe.js';
import { CONSENT_PROSE_VERSION, consentProseHash } from '../../compliance/index.js';
import {
  NotificationCenterService,
  UnsubscribeService,
  categoryOf,
  createEmailPublicRouter,
  createNotificationsRouter,
  effectiveChannels,
  safeHref,
  tipsRemindersDefault,
  type ChannelCapabilities,
  type NotificationPreferencesView,
  type NotificationsDb,
  type NotificationsResponse,
  type UnsubscribePreview,
} from '../index.js';
import { decodeCursor, encodeCursor, readCenter, tipsConsentProse } from '../service.js';

const ROBO = getBrand('roboapply');
const GO = getBrand('goapply');
const SECRET_ENV = { EMAIL_UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret-0123456789' };
const T0 = new Date('2026-10-10T08:00:00.000Z');

const ALL_CAPS: ChannelCapabilities = { email: true, push: false, wechat: false, invitations: true, alerts: true };
const TIPS_PROSE_EN = 'Send me tips and reminders about jobs I saved and practice I started.';

type Fake = ReturnType<typeof createFakePrisma>;

function seed(db: Fake, opts: { userId?: string; profileId?: string; brand?: 'roboapply' | 'goapply'; market?: string | null; country?: string | null; email?: string; placeholder?: boolean; prefs?: unknown } = {}) {
  const userId = opts.userId ?? 'u1';
  const profileId = opts.profileId ?? 'sp1';
  db.$rows('user').push({ id: userId, email: opts.email ?? `${userId}@example.test`, emailIsPlaceholder: opts.placeholder ?? false, brand: opts.brand ?? 'roboapply' });
  db.$rows('seekerProfile').push({
    id: profileId,
    userId,
    market: opts.market ?? null,
    notificationPreferences: opts.prefs ?? null,
    weeklyNudgeOptOut: false,
  });
  if (opts.country !== undefined) db.$rows('rAProfile').push({ userId, country: opts.country });
}

function note(db: Fake, row: Record<string, unknown>) {
  db.$rows('seekerNotification').push({
    seekerProfileId: 'sp1',
    userId: 'u1',
    brand: 'roboapply',
    type: 'system',
    category: 'system',
    templateKey: null,
    params: null,
    title: 'Fallback title',
    body: null,
    deepLink: null,
    readAt: null,
    createdAt: T0,
    ...row,
  });
}

function service(db: Fake, caps: Partial<ChannelCapabilities> = {}) {
  return new NotificationCenterService({
    db: db as unknown as NotificationsDb,
    env: SECRET_ENV,
    now: () => T0,
    capabilities: async () => ({ ...ALL_CAPS, ...caps }),
  });
}

// ── Pure helpers ─────────────────────────────────────────────────────────

describe('pure helpers', () => {
  it('tipsRemindersDefault: off for GoApply, EEA/UK/CH/CA and unknown; on elsewhere', () => {
    expect(tipsRemindersDefault({ market: 'cn', country: 'CN' })).toBe(false);
    expect(tipsRemindersDefault({ market: 'cn', country: 'US' })).toBe(false);
    for (const c of ['DE', 'FR', 'NO', 'IS', 'GB', 'UK', 'CH', 'CA', 'ca']) expect(tipsRemindersDefault({ market: 'intl', country: c }), c).toBe(false);
    expect(tipsRemindersDefault({ market: 'intl', country: null })).toBe(false);
    expect(tipsRemindersDefault({ market: 'intl', country: 'nowhere' })).toBe(false);
    for (const c of ['US', 'TW', 'JP', 'SG', 'AU']) expect(tipsRemindersDefault({ market: 'intl', country: c }), c).toBe(true);
  });

  it('categoryOf maps both stored vocabularies and legacy types', () => {
    expect(categoryOf({ category: 'job_alert', type: 'x' })).toBe('alert');
    expect(categoryOf({ category: 'alert', type: 'x' })).toBe('alert');
    expect(categoryOf({ category: 'application', type: 'x' })).toBe('reminder');
    expect(categoryOf({ category: 'referral', type: 'x' })).toBe('system');
    expect(categoryOf({ category: null, type: 'interview_scheduled' })).toBe('reminder');
    expect(categoryOf({ category: null, type: 'cap_warning' })).toBe('billing');
    expect(categoryOf({ category: null, type: 'mystery' })).toBe('system');
  });

  it('cursors round-trip and junk decodes to null', () => {
    const c = encodeCursor({ createdAt: T0, id: 'n_1' });
    expect(decodeCursor(c)).toEqual({ createdAt: T0, id: 'n_1' });
    expect(decodeCursor('%%%')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('safeHref keeps same-site paths only', () => {
    expect(safeHref('/jobs/1?src=alert')).toBe('/jobs/1?src=alert');
    expect(safeHref('https://evil.example')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('/\\evil')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });

  it('effectiveChannels: in-app always, locked categories get every channel, announcements in-app only, legacy matchAlerts=false honoured', () => {
    const ch = effectiveChannels(readCenter({ center: { channels: { reminder: ['email', 'push', 'bogus'] } } }), ['in_app', 'email'], { matchAlerts: false });
    expect(ch.alert).toEqual(['in_app']);
    expect(ch.reminder).toEqual(['in_app', 'email']);
    expect(ch.billing).toEqual(['in_app', 'email']);
    expect(ch.announcement).toEqual(['in_app']);
    expect(ch.tips).toEqual(['in_app', 'email']);
  });
});

// ── Inbox ────────────────────────────────────────────────────────────────

describe('message center service', () => {
  let db: Fake;
  beforeEach(() => {
    db = createFakePrisma();
    seed(db);
  });

  it('lists newest first with a cursor, hides legacy auto-apply rows, other profiles and the other brand', async () => {
    for (let i = 0; i < 5; i += 1) note(db, { id: `n${i}`, createdAt: new Date(T0.getTime() + i * 1000) });
    note(db, { id: 'legacy', category: null, type: 'auto_apply_failed', createdAt: new Date(T0.getTime() + 99_000) });
    note(db, { id: 'other', seekerProfileId: 'sp2', userId: 'u2' });
    note(db, { id: 'go', brand: 'goapply' });
    note(db, { id: 'old', brand: null, userId: null, createdAt: new Date(T0.getTime() - 1000) });
    const svc = service(db);
    const p1 = await svc.list({ id: 'sp1', userId: 'u1' }, ROBO, { limit: 3 });
    expect(p1.items.map((i) => i.id)).toEqual(['n4', 'n3', 'n2']);
    expect(p1.cursor).toEqual(expect.any(String));
    const p2 = await svc.list({ id: 'sp1', userId: 'u1' }, ROBO, { limit: 3, cursor: p1.cursor! });
    expect(p2.items.map((i) => i.id)).toEqual(['n1', 'n0', 'old']);
    expect(p2.cursor).toBeNull();
    await expect(svc.list({ id: 'sp1', userId: 'u1' }, ROBO, { cursor: 'garbage!' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('renders a view with template params, a safe href and the invitation answer', async () => {
    note(db, { id: 'a', category: 'job_alert', templateKey: 'alerts.instant', params: { count: 3 }, deepLink: 'https://elsewhere.example' });
    note(db, { id: 'i', category: 'invitation', params: { company: 'Example Labs', response: { interested: true, at: T0.toISOString() } } });
    const { items } = await service(db).list({ id: 'sp1', userId: 'u1' }, ROBO);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.a).toMatchObject({ category: 'alert', templateKey: 'alerts.instant', params: { count: 3 }, href: null });
    expect(byId.a!.response).toBeUndefined();
    expect(byId.i).toMatchObject({ category: 'invitation', params: { company: 'Example Labs' }, response: { interested: true } });
  });

  it('counts unread, marks one and all read, and 404s a row that is not the user’s', async () => {
    note(db, { id: 'a' });
    note(db, { id: 'b' });
    note(db, { id: 'x', seekerProfileId: 'sp2' });
    note(db, { id: 'hidden', type: 'recruiter_viewed', category: null });
    const svc = service(db);
    const me = { id: 'sp1', userId: 'u1' };
    expect(await svc.unreadCount('u1', ROBO)).toBe(2);
    expect(await svc.unreadCount('nobody', ROBO)).toBe(0);
    await svc.markRead(me, ROBO, 'a');
    expect(await svc.unreadCountForProfile('sp1', ROBO)).toBe(1);
    await expect(svc.markRead(me, ROBO, 'x')).rejects.toMatchObject({ code: 'not_found' });
    expect(await svc.markAllRead(me, ROBO)).toEqual({ updated: 1 });
    expect(await svc.unreadCountForProfile('sp1', ROBO)).toBe(0);
    expect(db.$rows('seekerNotification').find((r) => r.id === 'x')!.readAt).toBeNull();
  });

  it('create() writes a row in the contract vocabulary, scoped to the profile', async () => {
    const svc = service(db);
    const { id } = await svc.create({ userId: 'u1', brand: 'roboapply', category: 'reminder', templateKey: 'tracker.followUp', params: { company: 'Example Labs' }, title: 'Follow up', href: '/applications' });
    const row = db.$rows('seekerNotification').find((r) => r.id === id)!;
    expect(row).toMatchObject({ seekerProfileId: 'sp1', userId: 'u1', category: 'reminder', type: 'reminder', deepLink: '/applications' });
    await expect(svc.create({ userId: 'ghost', brand: 'roboapply', category: 'system', title: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ── Settings ─────────────────────────────────────────────────────────────

describe('notification settings', () => {
  let db: Fake;
  beforeEach(() => {
    db = createFakePrisma();
  });

  it('applies the regional default for "Tips and reminders" and stores the region the first time', async () => {
    seed(db, { country: null });
    const svc = service(db);
    const us = await svc.getPreferences({ id: 'sp1', userId: 'u1', brand: ROBO, requestCountry: 'US' });
    expect(us).toMatchObject({ tipsReminders: true, tipsRemindersDefault: true, tipsRemindersSource: 'default' });
    expect(readCenter(db.$rows('seekerProfile')[0]!.notificationPreferences).regionCountry).toBe('US');
    // Travelling later does not move the default; the email gate (no request) agrees.
    const later = await svc.getPreferences({ id: 'sp1', userId: 'u1', brand: ROBO, requestCountry: 'DE' });
    expect(later.tipsReminders).toBe(true);
    expect(await svc.allowsEmail({ brand: ROBO, userId: 'u1', email: 'u1@example.test', list: 'tips' })).toBe(true);
  });

  it('defaults tips off in the EEA, in Canada, with no country, and on GoApply', async () => {
    seed(db, { userId: 'eu', profileId: 'sp_eu', country: 'FR' });
    seed(db, { userId: 'ca', profileId: 'sp_ca', market: null });
    seed(db, { userId: 'none', profileId: 'sp_none' });
    seed(db, { userId: 'go', profileId: 'sp_go', brand: 'goapply', country: 'US' });
    const svc = service(db);
    expect((await svc.getPreferences({ id: 'sp_eu', userId: 'eu', brand: ROBO, requestCountry: 'US' })).tipsReminders).toBe(false);
    expect((await svc.getPreferences({ id: 'sp_ca', userId: 'ca', brand: ROBO, requestCountry: 'CA' })).tipsReminders).toBe(false);
    expect((await svc.getPreferences({ id: 'sp_none', userId: 'none', brand: ROBO })).tipsReminders).toBe(false);
    expect((await svc.getPreferences({ id: 'sp_go', userId: 'go', brand: GO })).tipsReminders).toBe(false);
  });

  it('the regional default follows location, not the UI-language market (ja/zh-TW users in the EEA stay off)', async () => {
    seed(db, { userId: 'jp', profileId: 'sp_jp', market: 'jp' });
    seed(db, { userId: 'tw', profileId: 'sp_tw', market: 'tw' });
    seed(db, { userId: 'us', profileId: 'sp_us', market: 'us' });
    seed(db, { userId: 'eu', profileId: 'sp_eu', market: 'eu' });
    seed(db, { userId: 'jp2', profileId: 'sp_jp2', market: 'jp' });
    const svc = service(db);
    expect((await svc.getPreferences({ id: 'sp_jp', userId: 'jp', brand: ROBO, requestCountry: 'DE' })).tipsReminders).toBe(false);
    expect((await svc.getPreferences({ id: 'sp_tw', userId: 'tw', brand: ROBO, requestCountry: 'FR' })).tipsReminders).toBe(false);
    // A legacy 'us' market with no location is unknown (off), not the US.
    expect((await svc.getPreferences({ id: 'sp_us', userId: 'us', brand: ROBO })).tipsReminders).toBe(false);
    // The 'eu' market can only turn the default off, even when visiting from elsewhere.
    expect((await svc.getPreferences({ id: 'sp_eu', userId: 'eu', brand: ROBO, requestCountry: 'US' })).tipsReminders).toBe(false);
    expect((await svc.getPreferences({ id: 'sp_jp2', userId: 'jp2', brand: ROBO, requestCountry: 'JP' })).tipsReminders).toBe(true);
  });

  it('rememberRegion stores the first edge country once, so the default applies before Settings is opened', async () => {
    seed(db, { userId: 'n1', profileId: 'sp_n1' });
    seed(db, { userId: 'own', profileId: 'sp_own', country: 'US' });
    const svc = service(db);
    expect(await svc.allowsEmail({ brand: ROBO, userId: 'n1', email: 'n1@example.test', list: 'tips' })).toBe(false);
    expect(await svc.rememberRegion('n1', 'us')).toBe(true);
    expect(await svc.allowsEmail({ brand: ROBO, userId: 'n1', email: 'n1@example.test', list: 'tips' })).toBe(true);
    // Later countries do not move it; a profile with its own country is left alone; junk is ignored.
    expect(await svc.rememberRegion('n1', 'DE')).toBe(false);
    expect(readCenter(db.$rows('seekerProfile').find((r) => r.id === 'sp_n1')!.notificationPreferences).regionCountry).toBe('US');
    expect(await svc.rememberRegion('own', 'DE')).toBe(false);
    expect(await svc.rememberRegion('ghost', 'DE')).toBe(false);
    expect(await svc.rememberRegion('n1', 'nowhere')).toBe(false);
  });

  it('job alerts per brand: RoboApply offers alert choices; GoApply with jobs.alerts off offers none and refuses them', async () => {
    seed(db, { country: 'US' });
    seed(db, { userId: 'go', profileId: 'sp_go', brand: 'goapply', country: 'CN' });
    const robo = await service(db).getPreferences({ id: 'sp1', userId: 'u1', brand: ROBO });
    expect(robo.configurableCategories).toEqual(['alert', 'reminder', 'tips', 'invitation']);
    expect(robo.channels.alert).toEqual(['in_app', 'email']);

    const goSvc = service(db, { alerts: false });
    const go = await goSvc.getPreferences({ id: 'sp_go', userId: 'go', brand: GO });
    expect(go.configurableCategories).not.toContain('alert');
    expect(go.channels.alert).toEqual(['in_app']);
    await expect(goSvc.patchPreferences({ id: 'sp_go', userId: 'go', brand: GO }, { channels: { alert: ['in_app', 'email'] } })).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'notification_category_unavailable' },
    });
    expect(await goSvc.allowsEmail({ brand: GO, userId: 'go', email: 'go@example.test', list: 'alerts' })).toBe(false);
    expect(await goSvc.allowsEmail({ brand: GO, userId: 'go', email: 'go@example.test', list: 'digest' })).toBe(false);
    // Reminder email does not depend on `jobs.alerts`: the campus emails (网申截止, a followed company's programme) are on this list.
    expect(await goSvc.allowsEmail({ brand: GO, userId: 'go', email: 'go@example.test', list: 'reminders' })).toBe(true);
    db.$rows('rAAnonAlertSubscription').push({ id: 'a_go', brand: 'goapply', emailHash: hashEmail('anon@example.test'), status: 'confirmed' });
    expect(await goSvc.allowsEmail({ brand: GO, userId: null, email: 'anon@example.test', list: 'alerts' })).toBe(false);
  });

  it('says why email is missing: no address vs not offered on the brand', async () => {
    seed(db, { country: 'US' });
    seed(db, { userId: 'ph', profileId: 'sp_ph', placeholder: true, email: 'x@users.goapply.invalid' });
    expect((await service(db).getPreferences({ id: 'sp1', userId: 'u1', brand: ROBO })).emailUnavailableReason).toBeNull();
    expect((await service(db).getPreferences({ id: 'sp_ph', userId: 'ph', brand: ROBO })).emailUnavailableReason).toBe('no_address');
    const off = await service(db, { email: false }).getPreferences({ id: 'sp1', userId: 'u1', brand: ROBO });
    expect(off).toMatchObject({ availableChannels: ['in_app'], emailUnavailableReason: 'not_offered' });
  });

  it('the tips switch shows the consent text the record hashes (RoboApply catalog; GoApply fallback with its own name)', async () => {
    seed(db, { country: 'US' });
    seed(db, { userId: 'go', profileId: 'sp_go', brand: 'goapply', country: 'CN' });
    const svc = service(db);
    const robo = await svc.getPreferences({ id: 'sp1', userId: 'u1', brand: ROBO, locale: 'en' });
    expect(robo.tipsRemindersConsent).toEqual({ text: TIPS_PROSE_EN, locale: 'en', version: CONSENT_PROSE_VERSION });
    await svc.patchPreferences({ id: 'sp1', userId: 'u1', brand: ROBO, locale: 'en' }, { tipsReminders: false, tipsRemindersProseVersion: CONSENT_PROSE_VERSION });
    expect(db.$rows('seekerConsentRecord').at(-1)!.proseHash).toBe(
      consentProseHash({ brand: 'roboapply', type: 'tips_reminders', version: CONSENT_PROSE_VERSION, locale: 'en', text: robo.tipsRemindersConsent.text }),
    );

    const go = await svc.getPreferences({ id: 'sp_go', userId: 'go', brand: GO, locale: 'zh' });
    // WP-93: GoApply has its own catalog entry with zh prose.
    expect(go.tipsRemindersConsent.locale).toBe('zh');
    expect(go.tipsRemindersConsent.text).not.toContain('%BRAND%');
    await svc.patchPreferences({ id: 'sp_go', userId: 'go', brand: GO, locale: 'zh' }, { tipsReminders: true });
    expect(db.$rows('seekerConsentRecord').at(-1)!.proseHash).toBe(
      consentProseHash({ brand: 'goapply', type: 'tips_reminders', version: CONSENT_PROSE_VERSION, locale: 'zh', text: go.tipsRemindersConsent.text }),
    );
  });

  it('a tips change made against an older consent text is refused with 409 and writes nothing', async () => {
    seed(db, { country: 'US' });
    await expect(service(db).patchPreferences({ id: 'sp1', userId: 'u1', brand: ROBO }, { tipsReminders: true, tipsRemindersProseVersion: 'old-version' })).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect(db.$rows('seekerConsentRecord')).toHaveLength(0);
  });

  it('the stored consent wins over the default; turning tips on writes a tips_reminders record with the prose version', async () => {
    seed(db, { country: 'DE' });
    const svc = service(db);
    const on = await svc.patchPreferences({ id: 'sp1', userId: 'u1', brand: ROBO }, { tipsReminders: true });
    expect(on).toMatchObject({ tipsReminders: true, tipsRemindersDefault: false, tipsRemindersSource: 'user' });
    const rec = db.$rows('seekerConsentRecord').at(-1)!;
    expect(rec).toMatchObject({ seekerProfileId: 'sp1', consentType: 'tips_reminders', granted: true, proseVersion: CONSENT_PROSE_VERSION });
    expect(rec.proseHash).toEqual(expect.any(String));
  });

  it('GoApply tips consent is recorded even before the catalog lists it there', async () => {
    seed(db, { brand: 'goapply', country: 'CN' });
    const view = await service(db).patchPreferences({ id: 'sp1', userId: 'u1', brand: GO }, { tipsReminders: true });
    expect(view.tipsReminders).toBe(true);
    expect(db.$rows('seekerConsentRecord').at(-1)).toMatchObject({ consentType: 'tips_reminders', granted: true, proseVersion: CONSENT_PROSE_VERSION });
  });

  it('channels: email needs a real address; locked categories and unavailable channels are refused', async () => {
    seed(db, { country: 'US' });
    seed(db, { userId: 'ph', profileId: 'sp_ph', placeholder: true, email: 'x@users.goapply.invalid', brand: 'goapply' });
    const svc = service(db);
    const ph = await svc.getPreferences({ id: 'sp_ph', userId: 'ph', brand: GO });
    expect(ph.availableChannels).toEqual(['in_app']);
    expect(ph.channels.alert).toEqual(['in_app']);

    const view = await svc.patchPreferences({ id: 'sp1', userId: 'u1', brand: ROBO }, { channels: { alert: ['in_app'] } });
    expect(view.channels.alert).toEqual(['in_app']);
    expect(view.channels.reminder).toEqual(['in_app', 'email']);
    await expect(svc.patchPreferences({ id: 'sp1', userId: 'u1', brand: ROBO }, { channels: { billing: ['in_app'] } })).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'notification_category_locked' },
    });
    await expect(svc.patchPreferences({ id: 'sp1', userId: 'u1', brand: ROBO }, { channels: { alert: ['push'] } })).rejects.toMatchObject({
      details: { reason: 'notification_channel_unavailable' },
    });
  });

  it('hides the invitation row unless the capability is on, and keeps legacy JSON keys on write', async () => {
    seed(db, { country: 'US', prefs: { matchAlerts: true, weeklyDigest: false } });
    const off = await service(db, { invitations: false }).getPreferences({ id: 'sp1', userId: 'u1', brand: ROBO });
    expect(off.configurableCategories).toEqual(['alert', 'reminder', 'tips']);
    await service(db).patchPreferences({ id: 'sp1', userId: 'u1', brand: ROBO }, { quietHours: { start: '22:00', end: '07:30' } });
    const stored = db.$rows('seekerProfile')[0]!.notificationPreferences as Record<string, unknown>;
    expect(stored).toMatchObject({ matchAlerts: true, weeklyDigest: false, center: { quietHours: { start: '22:00', end: '07:30' } } });
  });
});

// ── Email preference gate ────────────────────────────────────────────────

describe('opt-in channels: an accepted prompt turns the channel on, only an explicit "off" blocks it (WP-93 #23)', () => {
  let db: Fake;
  const WECHAT = { wechat: true, email: false, alerts: false, invitations: false };
  const ctx = { id: 'sp_go', userId: 'go', brand: GO };
  const center = () => readCenter(db.$rows('seekerProfile').find((r) => r.id === 'sp_go')!.notificationPreferences);
  beforeEach(() => {
    db = createFakePrisma();
    seed(db, { userId: 'go', profileId: 'sp_go', brand: 'goapply', country: 'CN', placeholder: true });
  });

  it('no stored choice: stores the default list plus the channel, once', async () => {
    const svc = service(db, WECHAT);
    expect((await svc.preferencesFor('go', GO))!.channels.reminder).toEqual(['in_app']);
    expect(await svc.enableChannelIfDefault('go', GO, 'reminder', 'wechat')).toBe('enabled');
    expect(center().channels).toEqual({ reminder: ['in_app', 'email', 'wechat'] });
    expect((await svc.preferencesFor('go', GO))!.channels.reminder).toEqual(['in_app', 'wechat']);
    expect(await svc.enableChannelIfDefault('go', GO, 'reminder', 'wechat')).toBe('already');
    // Legacy keys beside `center` are kept.
    db.$rows('seekerProfile')[0]!.notificationPreferences = { matchAlerts: false, quietHours: { start: '22:00', end: '07:00' } };
    await svc.enableChannelIfDefault('go', GO, 'alert', 'wechat');
    expect(db.$rows('seekerProfile')[0]!.notificationPreferences).toMatchObject({ matchAlerts: false, quietHours: { start: '22:00', end: '07:00' } });
    // The legacy "no match alerts" choice still keeps alert email off: only the new channel is added to it.
    expect(center().channels!.alert).toEqual(['in_app', 'wechat']);
  });

  it('a stored list that never had the channel gets it added and keeps the rest (email off stays off)', async () => {
    db.$rows('seekerProfile')[0]!.notificationPreferences = { center: { v: 1, channels: { reminder: ['in_app'] }, unsubscribed: { reminders: '2026-10-01T00:00:00.000Z' } } };
    const svc = service(db, WECHAT);
    expect(await svc.enableChannelIfDefault('go', GO, 'reminder', 'wechat')).toBe('enabled');
    expect(center()).toMatchObject({ channels: { reminder: ['in_app', 'wechat'] }, unsubscribed: { reminders: '2026-10-01T00:00:00.000Z' } });
  });

  it('turning the switch off in Settings is remembered; the prompt never overrules it; turning it on again lifts it', async () => {
    const svc = service(db, WECHAT);
    await svc.enableChannelIfDefault('go', GO, 'reminder', 'wechat');
    await svc.patchPreferences(ctx, { channels: { reminder: ['in_app'] } });
    expect(center().channelsOff).toEqual({ reminder: ['wechat'] });
    expect(await svc.enableChannelIfDefault('go', GO, 'reminder', 'wechat')).toBe('off');
    // Email could not be offered to this account (no address yet), so it was not theirs to turn off: it stays stored.
    expect(center().channels!.reminder).toEqual(['in_app', 'email']);
    // Per category: reminders off says nothing about tips.
    expect(await svc.enableChannelIfDefault('go', GO, 'tips', 'wechat')).toBe('enabled');
    await svc.patchPreferences(ctx, { channels: { reminder: ['in_app', 'wechat'] } });
    expect(center().channelsOff).toBeUndefined();
    expect(await svc.enableChannelIfDefault('go', GO, 'reminder', 'wechat')).toBe('already');
  });

  it('saving a category whose channel was never on is not an "off"', async () => {
    const svc = service(db, { ...WECHAT, email: true });
    db.$rows('user')[0]!.emailIsPlaceholder = false;
    // They only turn reminder email off; WeChat was never on for them.
    await svc.patchPreferences(ctx, { channels: { reminder: ['in_app'] } });
    expect(center().channelsOff).toBeUndefined();
    expect(await svc.enableChannelIfDefault('go', GO, 'reminder', 'wechat')).toBe('enabled');
  });

  it('a save while the channel is not offered is not an "off": the stored choice is kept', async () => {
    // WeChat accepted earlier, then the brand's WeChat notices become unavailable (credentials missing).
    db.$rows('seekerProfile')[0]!.notificationPreferences = { center: { v: 1, channels: { reminder: ['in_app', 'email', 'wechat'] } } };
    db.$rows('user')[0]!.emailIsPlaceholder = false;
    const down = service(db, { ...WECHAT, wechat: false, email: true });
    // The page shows inbox and email only; the person turns reminder email off.
    const view = await down.patchPreferences(ctx, { channels: { reminder: ['in_app'] } });
    expect(view.channels.reminder).toEqual(['in_app']);
    expect(center().channelsOff).toBeUndefined();
    expect(center().channels!.reminder).toEqual(['in_app', 'wechat']);
    // WeChat is back: still on, and a newly accepted prompt is not answered "off".
    const up = service(db, { ...WECHAT, email: true });
    expect((await up.preferencesFor('go', GO))!.channels.reminder).toEqual(['in_app', 'wechat']);
    expect(await up.enableChannelIfDefault('go', GO, 'reminder', 'wechat')).toBe('already');

    // Same when the stored list never had WeChat: a later prompt turns it on.
    db.$rows('seekerProfile')[0]!.notificationPreferences = { center: { v: 1, channels: { reminder: ['in_app', 'email'] } } };
    await down.patchPreferences(ctx, { channels: { reminder: ['in_app'] } });
    expect(center().channelsOff).toBeUndefined();
    expect(await up.enableChannelIfDefault('go', GO, 'reminder', 'wechat')).toBe('enabled');

    // An explicit "off" recorded earlier survives a save made while the channel is not offered.
    db.$rows('seekerProfile')[0]!.notificationPreferences = { center: { v: 1, channels: { reminder: ['in_app'] }, channelsOff: { reminder: ['wechat'] } } };
    await down.patchPreferences(ctx, { channels: { reminder: ['in_app', 'email'] } });
    expect(center().channelsOff).toEqual({ reminder: ['wechat'] });
    expect(await up.enableChannelIfDefault('go', GO, 'reminder', 'wechat')).toBe('off');
  });

  it('a carried-over email channel does not undo an email unsubscribe', async () => {
    // Email is in the stored list and the reminders list is unsubscribed; email is not offered at the time of the save.
    db.$rows('seekerProfile')[0]!.notificationPreferences = { center: { v: 1, channels: { reminder: ['in_app', 'email'] }, unsubscribed: { reminders: '2026-10-01T00:00:00.000Z' } } };
    const svc = service(db, WECHAT); // email not offered
    await svc.patchPreferences(ctx, { channels: { reminder: ['in_app', 'wechat'] } });
    expect(center()).toMatchObject({ channels: { reminder: ['in_app', 'wechat', 'email'] }, unsubscribed: { reminders: '2026-10-01T00:00:00.000Z' } });
    // Choosing email in a save is what re-subscribes.
    db.$rows('user')[0]!.emailIsPlaceholder = false;
    await service(db, { ...WECHAT, email: true }).patchPreferences(ctx, { channels: { reminder: ['in_app', 'email', 'wechat'] } });
    expect(center().unsubscribed?.reminders).toBeUndefined();
  });

  it('nothing to choose: locked categories and accounts without a profile', async () => {
    const svc = service(db, WECHAT);
    expect(await svc.enableChannelIfDefault('go', GO, 'billing', 'wechat')).toBe('not_applicable');
    expect(await svc.enableChannelIfDefault('ghost', GO, 'reminder', 'wechat')).toBe('not_applicable');
    expect(center().channels).toBeUndefined();
  });

  it('readCenter keeps only real opt-in channels in channelsOff', () => {
    expect(readCenter({ center: { channelsOff: { reminder: ['wechat', 'email', 'nope', 'wechat'], bogus: ['push'], tips: 'x', alert: [] } } }).channelsOff).toEqual({ reminder: ['wechat'] });
  });
});

describe('email preference gate (allowsEmail)', () => {
  let db: Fake;
  beforeEach(() => {
    db = createFakePrisma();
    seed(db, { country: 'US' });
  });

  it('alerts follow the alert email channel; marketing needs a granted consent', async () => {
    const svc = service(db);
    const ask = (list: 'alerts' | 'digest' | 'reminders' | 'marketing' | 'tips') => svc.allowsEmail({ brand: ROBO, userId: 'u1', email: 'u1@example.test', list });
    expect(await ask('alerts')).toBe(true);
    expect(await ask('marketing')).toBe(false);
    await svc.patchPreferences({ id: 'sp1', userId: 'u1', brand: ROBO }, { channels: { alert: ['in_app'] } });
    expect(await ask('alerts')).toBe(false);
    expect(await ask('digest')).toBe(false);
    expect(await ask('reminders')).toBe(true);
    db.$rows('seekerConsentRecord').push({ seekerProfileId: 'sp1', consentType: 'marketing_email', granted: true, createdAt: T0 });
    expect(await ask('marketing')).toBe(true);
  });

  it('a "Tips and reminders" email is never allowed with the preference off', async () => {
    const svc = service(db);
    await svc.patchPreferences({ id: 'sp1', userId: 'u1', brand: ROBO }, { tipsReminders: false });
    expect(await svc.allowsEmail({ brand: ROBO, userId: 'u1', email: 'u1@example.test', list: 'tips' })).toBe(false);
  });

  it('no email when the capability is off; logged-out alerts only to a confirmed subscription', async () => {
    expect(await service(db, { email: false }).allowsEmail({ brand: ROBO, userId: 'u1', email: 'u1@example.test', list: 'alerts' })).toBe(false);
    const svc = service(db);
    expect(await svc.allowsEmail({ brand: ROBO, userId: null, email: 'anon@example.test', list: 'alerts' })).toBe(false);
    db.$rows('rAAnonAlertSubscription').push({ id: 'a1', brand: 'roboapply', emailHash: hashEmail('Anon@Example.test'), status: 'confirmed' });
    expect(await svc.allowsEmail({ brand: ROBO, userId: null, email: 'anon@example.test', list: 'alerts' })).toBe(true);
    expect(await svc.allowsEmail({ brand: ROBO, userId: null, email: 'anon@example.test', list: 'tips' })).toBe(false);
  });

  it('the gate fails closed on errors', async () => {
    const broken = createFakePrisma({ failOn: { 'seekerProfile.findUnique': new Error('db down') } });
    const gate = service(broken).emailPreferenceGate();
    expect(await gate({ brand: ROBO, userId: 'u1', email: 'u1@example.test', category: 'alert', list: 'alerts', template: 'alerts.instant' })).toBe(false);
  });
});

// ── Routes ───────────────────────────────────────────────────────────────

describe('routes', () => {
  let h: RouteHarness;
  let db: Fake;
  const noLimit: RequestHandler = (_req, _res, next) => next();
  const ENV = { ...SECRET_ENV, FLAG_ROBOAPPLY_INVITATIONS: 'true', FLAG_GOAPPLY_INVITATIONS: 'false' };

  beforeAll(async () => {
    db = createFakePrisma();
    const svc = new NotificationCenterService({ db: db as unknown as NotificationsDb, env: ENV, now: () => T0, capabilities: async () => ALL_CAPS });
    const unsubscribe = new UnsubscribeService({ db: db as unknown as NotificationsDb, center: svc, env: ENV, now: () => T0 });
    const auth = [fakeAuth((req) => (req.headers['x-test-user'] ? { id: String(req.headers['x-test-user']) } : null))];
    h = await startRouteHarness({
      env: ENV,
      mounts: [
        ['/api/v1/roboapply/notifications', createNotificationsRouter({ seekerAuth: auth, service: svc, env: ENV })],
        ['/api/v1/public/email', createEmailPublicRouter({ service: svc, unsubscribe, env: ENV, surveyLimiter: noLimit })],
      ],
    });
  });
  afterAll(() => h.close());
  beforeEach(() => {
    for (const t of ['user', 'seekerProfile', 'seekerNotification', 'seekerConsentRecord', 'rAProfile', 'rAAnonAlertSubscription']) db.$rows(t).length = 0;
    seed(db, { country: 'US' });
  });

  const N = '/api/v1/roboapply/notifications';
  const as = (user = 'u1') => ({ headers: { 'x-test-user': user } });

  it('every seeker route needs a session', async () => {
    for (const [m, p] of [
      ['GET', N],
      ['GET', `${N}/unread-count`],
      ['POST', `${N}/read-all`],
      ['GET', `${N}/preferences`],
      ['PATCH', `${N}/preferences`],
      ['POST', `${N}/n1/read`],
      ['POST', `${N}/n1/respond`],
    ] as const) {
      expect((await h.request(m, p)).status, `${m} ${p}`).toBe(401);
    }
  });

  it('lists, counts and marks read', async () => {
    note(db, { id: 'n1' });
    note(db, { id: 'n2', category: 'job_alert' });
    const list = await h.request<{ data: NotificationsResponse }>('GET', `${N}?limit=1`, as());
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect((await h.request<{ data: { count: number } }>('GET', `${N}/unread-count`, as())).body.data).toEqual({ count: 2 });
    expect((await h.request('POST', `${N}/n1/read`, as())).status).toBe(200);
    expect((await h.request<{ data: { count: number } }>('GET', `${N}/unread-count`, as())).body.data.count).toBe(1);
    expect((await h.request<{ code: string }>('POST', `${N}/missing/read`, as())).status).toBe(404);
    expect((await h.request<{ data: { updated: number } }>('POST', `${N}/read-all`, as())).body.data).toEqual({ updated: 1 });
    expect((await h.request('GET', `${N}?limit=500`, as())).status).toBe(422);
  });

  it('the unread-count poll stores the edge country once for the tips default', async () => {
    seed(db, { userId: 'u9', profileId: 'sp9' });
    const res = await h.request<{ data: { count: number } }>('GET', `${N}/unread-count`, { headers: { 'x-test-user': 'u9', 'x-vercel-ip-country': 'jp' } });
    expect(res.status).toBe(200);
    const stored = () => readCenter(db.$rows('seekerProfile').find((r) => r.id === 'sp9')!.notificationPreferences).regionCountry;
    expect(stored()).toBe('JP');
    await h.request('GET', `${N}/unread-count`, { headers: { 'x-test-user': 'u9', 'x-vercel-ip-country': 'DE' } });
    expect(stored()).toBe('JP');
  });

  it('a user without a seeker profile gets 403', async () => {
    expect((await h.request('GET', `${N}/unread-count`, as('stranger'))).status).toBe(403);
  });

  it('GET/PATCH preferences with the edge country', async () => {
    const get = await h.request<{ data: NotificationPreferencesView }>('GET', `${N}/preferences`, as());
    expect(get.status).toBe(200);
    expect(get.body.data).toMatchObject({ tipsReminders: true, availableChannels: ['in_app', 'email'], lockedCategories: ['billing', 'system'], quietHours: { start: '21:00', end: '08:00' } });
    const patch = await h.request<{ data: NotificationPreferencesView }>('PATCH', `${N}/preferences`, { ...as(), body: { tipsReminders: false, channels: { reminder: ['in_app'] } } });
    expect(patch.status).toBe(200);
    expect(patch.body.data).toMatchObject({ tipsReminders: false, tipsRemindersSource: 'user', channels: { reminder: ['in_app'] } });
    expect((await h.request('PATCH', `${N}/preferences`, { ...as(), body: { quietHours: { start: '25:00', end: '08:00' } } })).status).toBe(422);
    expect((await h.request('PATCH', `${N}/preferences`, { ...as(), body: { surprise: 1 } })).status).toBe(422);
  });

  // FIX-8 finding 4: the web client sends `X-Robo-Locale` (from the `robo_locale` cookie). The route read
  // `x-ra-locale` / `NEXT_LOCALE`, which nothing sends, so the "Tips and reminders" sentence was always the
  // brand default: English for a RoboApply user reading 日本語 or 繁體中文.
  it('the "Tips and reminders" sentence follows the language the client sends (X-Robo-Locale, else the robo_locale cookie)', async () => {
    const tips = async (init: { headers?: Record<string, string>; cookies?: Record<string, string> }) =>
      (await h.request<{ data: NotificationPreferencesView }>('GET', `${N}/preferences`, { ...init, headers: { 'x-test-user': 'u1', ...(init.headers ?? {}) } })).body.data.tipsRemindersConsent;
    const ja = tipsConsentProse(ROBO, 'ja');
    expect(ja.text).toBe('保存した求人や始めた練習に関するヒントとリマインダーを受け取る。');
    expect(await tips({ headers: { 'X-Robo-Locale': 'ja' } })).toMatchObject({ text: ja.text, locale: 'ja' });
    expect(await tips({ headers: { 'X-Robo-Locale': 'zh-TW' } })).toMatchObject({ text: tipsConsentProse(ROBO, 'zh-TW').text, locale: 'zh-TW' });
    expect(await tips({ cookies: { robo_locale: 'zh' } })).toMatchObject({ text: tipsConsentProse(ROBO, 'zh').text, locale: 'zh' });
    // The header (what the page is rendered in) wins over the cookie; no language at all = the brand default.
    expect(await tips({ headers: { 'X-Robo-Locale': 'ja' }, cookies: { robo_locale: 'de' } })).toMatchObject({ locale: 'ja' });
    expect(await tips({})).toMatchObject({ text: 'Send me tips and reminders about jobs I saved and practice I started.', locale: 'en' });

    // Turning it on records the hash of the sentence that was shown — the Japanese one.
    const patch = await h.request('PATCH', `${N}/preferences`, { headers: { 'x-test-user': 'u1', 'X-Robo-Locale': 'ja' }, body: { tipsReminders: true, tipsRemindersProseVersion: ja.version } });
    expect(patch.status).toBe(200);
    const row = db.$rows('seekerConsentRecord').filter((r) => r.consentType === 'tips_reminders').at(-1)!;
    expect(row).toMatchObject({ granted: true, proseVersion: ja.version, proseHash: ja.hash });
    expect(ja.hash).toBe(consentProseHash({ brand: 'roboapply', type: 'tips_reminders', version: CONSENT_PROSE_VERSION, locale: 'ja', text: ja.text }));
  });

  it('responds to an invitation once (flag on); other messages refuse; the flag off answers feature_disabled', async () => {
    note(db, { id: 'inv', category: 'invitation', params: { company: 'Example Labs' } });
    note(db, { id: 'sys' });
    const ok = await h.request<{ data: { response: { interested: boolean } } }>('POST', `${N}/inv/respond`, { ...as(), body: { interested: true } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.response).toMatchObject({ interested: true });
    expect((await h.request('POST', `${N}/inv/respond`, { ...as(), body: { interested: false } })).status).toBe(409);
    expect((await h.request('POST', `${N}/sys/respond`, { ...as(), body: { interested: true } })).status).toBe(422);
    const off = await h.request<{ code: string }>('POST', `${N}/inv/respond`, { ...as(), host: 'goapply.localhost:3621', body: { interested: true } });
    expect(off.status).toBe(404);
    expect(off.body.code).toBe('feature_disabled');
  });

  describe('public unsubscribe (no login)', () => {
    const P = '/api/v1/public/email/unsubscribe';
    const tok = (list: 'alerts' | 'tips' | 'marketing' | 'reminders' | 'digest', brand: 'roboapply' | 'goapply' = 'roboapply', userId = 'u1') =>
      createUnsubscribeToken({ brand, list, userId, template: 'alerts.instant', env: SECRET_ENV });

    it('previews without changing anything; a browser is sent to the page', async () => {
      const token = tok('alerts');
      const res = await h.request<{ data: UnsubscribePreview }>('GET', `${P}?token=${encodeURIComponent(token)}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ category: 'alerts', alreadyUnsubscribed: false, hasAccount: true });
      expect(readCenter(db.$rows('seekerProfile')[0]!.notificationPreferences).channels).toBeUndefined();
      const browser = await fetch(`${h.baseUrl}${P}?token=${encodeURIComponent(token)}`, { headers: { accept: 'text/html,application/xhtml+xml' }, redirect: 'manual' });
      expect(browser.status).toBe(303);
      expect(browser.headers.get('location')).toBe(`/unsubscribe/${encodeURIComponent(token)}`);
    });

    it('RFC 8058 one-click POST (form body) turns alert email off and is idempotent', async () => {
      const token = tok('alerts');
      const send = () =>
        fetch(`${h.baseUrl}${P}?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
        });
      const first = await send();
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ success: true, data: { category: 'alerts', unsubscribed: true } });
      expect((await send()).status).toBe(200);
      const center = readCenter(db.$rows('seekerProfile')[0]!.notificationPreferences);
      expect(center.channels?.alert).toEqual(['in_app']);
      expect(center.unsubscribed?.alerts).toBe(T0.toISOString());
      const preview = await h.request<{ data: UnsubscribePreview }>('GET', `${P}?token=${encodeURIComponent(token)}`);
      expect(preview.body.data.alreadyUnsubscribed).toBe(true);
    });

    it('tips withdraws the consent; marketing withdraws marketing_email', async () => {
      expect((await h.request('POST', `${P}?token=${encodeURIComponent(tok('tips'))}`, { body: {} })).status).toBe(200);
      expect((await h.request('POST', `${P}?token=${encodeURIComponent(tok('marketing'))}`, { body: {} })).status).toBe(200);
      const recs = db.$rows('seekerConsentRecord').map((r) => [r.consentType, r.granted]);
      expect(recs).toEqual([
        ['tips_reminders', false],
        ['marketing_email', false],
      ]);
      expect(db.$rows('seekerProfile')[0]!.weeklyNudgeOptOut).toBe(true);
    });

    it('turning email back on in settings clears the unsubscribe mark', async () => {
      await h.request('POST', `${P}?token=${encodeURIComponent(tok('reminders'))}`, { body: {} });
      await h.request('PATCH', `${N}/preferences`, { ...as(), body: { channels: { reminder: ['in_app', 'email'] } } });
      expect(readCenter(db.$rows('seekerProfile')[0]!.notificationPreferences).unsubscribed?.reminders).toBeUndefined();
    });

    it('"already unsubscribed" follows the live consent: a marketing grant made elsewhere shows Unsubscribe again', async () => {
      const token = tok('marketing');
      const preview = async () => (await h.request<{ data: UnsubscribePreview }>('GET', `${P}?token=${encodeURIComponent(token)}`)).body.data;
      db.$rows('seekerConsentRecord').push({ seekerProfileId: 'sp1', consentType: 'marketing_email', granted: true, createdAt: new Date('2026-01-01T00:00:00Z') });
      expect((await preview()).alreadyUnsubscribed).toBe(false);
      await h.request('POST', `${P}?token=${encodeURIComponent(token)}`, { body: {} });
      expect((await preview()).alreadyUnsubscribed).toBe(true);
      // Granted again through the compliance consent route (WP-13): the stale mark does not matter.
      db.$rows('seekerConsentRecord').push({ seekerProfileId: 'sp1', consentType: 'marketing_email', granted: true, createdAt: new Date('2099-01-01T00:00:00Z') });
      expect(readCenter(db.$rows('seekerProfile')[0]!.notificationPreferences).unsubscribed?.marketing).toBeDefined();
      expect((await preview()).alreadyUnsubscribed).toBe(false);
    });

    it('"already unsubscribed" for tips follows the consent and the legacy nudge opt-out', async () => {
      const token = tok('tips');
      const preview = async () => (await h.request<{ data: UnsubscribePreview }>('GET', `${P}?token=${encodeURIComponent(token)}`)).body.data;
      expect((await preview()).alreadyUnsubscribed).toBe(false);
      await h.request('POST', `${P}?token=${encodeURIComponent(token)}`, { body: {} });
      expect((await preview()).alreadyUnsubscribed).toBe(true);
      db.$rows('seekerConsentRecord').push({ seekerProfileId: 'sp1', consentType: 'tips_reminders', granted: true, createdAt: new Date('2099-01-01T00:00:00Z') });
      expect((await preview()).alreadyUnsubscribed).toBe(false);
    });

    it('"already unsubscribed" for alerts follows the alert email channel', async () => {
      const token = tok('digest');
      const preview = async () => (await h.request<{ data: UnsubscribePreview }>('GET', `${P}?token=${encodeURIComponent(token)}`)).body.data;
      await h.request('PATCH', `${N}/preferences`, { ...as(), body: { channels: { alert: ['in_app'] } } });
      expect((await preview()).alreadyUnsubscribed).toBe(true);
      await h.request('PATCH', `${N}/preferences`, { ...as(), body: { channels: { alert: ['in_app', 'email'] } } });
      expect((await preview()).alreadyUnsubscribed).toBe(false);
    });

    it('rejects a forged token and a token for the other brand with one plain error', async () => {
      const forged = `${tok('alerts').slice(0, -4)}AAAA`;
      for (const t of [forged, tok('alerts', 'goapply')]) {
        const res = await h.request<{ code: string; details: { reason: string } }>('POST', `${P}?token=${encodeURIComponent(t)}`, { body: {} });
        expect(res.status).toBe(422);
        expect(res.body.details.reason).toBe('unsubscribe_token_invalid');
      }
      expect(db.$rows('seekerConsentRecord')).toHaveLength(0);
    });

    it('a logged-out alert token marks the subscription unsubscribed', async () => {
      db.$rows('rAAnonAlertSubscription').push({ id: 'a1', brand: 'roboapply', emailHash: hashEmail('anon@example.test'), status: 'confirmed', unsubscribedAt: null });
      const token = createUnsubscribeToken({ brand: 'roboapply', list: 'alerts', email: 'anon@example.test', env: SECRET_ENV });
      const before = await h.request<{ data: UnsubscribePreview }>('GET', `${P}?token=${encodeURIComponent(token)}`);
      expect(before.body.data).toEqual({ category: 'alerts', alreadyUnsubscribed: false, hasAccount: false });
      expect((await h.request('POST', `${P}?token=${encodeURIComponent(token)}`, { body: {} })).status).toBe(200);
      expect(db.$rows('rAAnonAlertSubscription')[0]).toMatchObject({ status: 'unsubscribed', unsubscribedAt: T0 });
    });

    it('stores the optional survey answer on the profile (last five)', async () => {
      const token = tok('alerts');
      for (let i = 0; i < 6; i += 1) {
        const res = await h.request('POST', `${P}/survey`, { body: { token, reason: 'too_many', note: `note ${i}` } });
        expect(res.status).toBe(200);
      }
      const fb = readCenter(db.$rows('seekerProfile')[0]!.notificationPreferences).feedback!;
      expect(fb).toHaveLength(5);
      expect(fb.at(-1)).toEqual({ list: 'alerts', reason: 'too_many', note: 'note 5', at: T0.toISOString() });
      expect((await h.request('POST', `${P}/survey`, { body: { token, reason: 'because' } })).status).toBe(422);
    });
  });
});

describe('preferencesFor (crons and delivery channels)', () => {
  it('resolves the same view as the settings page without writing, and null without a profile', async () => {
    const db = createFakePrisma();
    seed(db, { country: 'DE' });
    const svc = service(db);
    const view = await svc.preferencesFor('u1', ROBO);
    expect(view).toMatchObject({ tipsReminders: false, tipsRemindersDefault: false, availableChannels: ['in_app', 'email'] });
    expect(db.$rows('seekerProfile')[0]!.notificationPreferences).toBeNull();
    expect(await svc.preferencesFor('ghost', ROBO)).toBeNull();
  });
});
