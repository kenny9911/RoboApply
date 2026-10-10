// @vitest-environment node
//
// WP-73 service, routes and delivery channel. The repo is in memory, the
// WeChat API and the notification preferences are fakes: no network, no DB.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sms from '../../platform/sms/index.js';
import { getBrand } from '../../platform/brand/registry.js';
import { deliverMessage, deliveryChannels, resetDeliveryChannelsForTests, type DeliverDeps } from '../alerts/index.js';
import type { NotificationPreferencesView } from '../notifications/index.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { createWechatMpChannel, registerWechatMpChannel, WECHAT_MP_CHANNEL_ID } from './channel.js';
import { grantKind, MAX_LIVE_GRANTS, type ClaimedGrant, type GrantInput, type NotifyCnRepo } from './repo.js';
import { createNotifyCnRouter, createWechatMpWebhookRouter } from './routes.js';
import { NotifyCnService, safePath, wechatChosen } from './service.js';
import { encryptMessage, msgSignature, serverSignature } from './signature.js';
import { WechatMpApiError, type WechatMpApi } from './wechatApi.js';
import type { WechatTemplateKey } from './contract.js';

// Acceptance 2: any SMS service created while these tests run is a failure.
vi.mock('../../platform/sms/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/sms/index.js')>();
  return { ...actual, createSmsService: vi.fn(actual.createSmsService) };
});

const NOW = new Date('2026-10-10T08:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const ENV = {
  WECHAT_MP_APP_ID: 'wx_mp_app',
  WECHAT_MP_APP_SECRET: 'mp_secret',
  WECHAT_MP_TOKEN: 'mp_token',
  WECHAT_MP_TEMPLATE_DEADLINE: 'Tpl_Deadline_01',
  WECHAT_MP_TEMPLATE_PAYMENT: 'Tpl_Pay_000001',
  CANONICAL_ORIGIN: 'https://ignored.example',
  CN_CANONICAL_ORIGIN: 'https://www.goapply.top',
};
const GOAPPLY = 'goapply.localhost:3621';

// ── In-memory repo ──

interface GrantRow extends GrantInput {
  id: string;
  userId: string;
  brand: string;
  consumedAt: Date | null;
  createdAt: number;
  paired: boolean;
}

function memRepo(links: Record<string, string> = {}) {
  const grants: GrantRow[] = [];
  const delivered: string[] = [];
  let seq = 0;
  const repo: NotifyCnRepo = {
    async mpOpenId(userId, _brand, appId) {
      return appId === ENV.WECHAT_MP_APP_ID ? (links[userId] ?? null) : null;
    },
    async userForOpenId(openid) {
      return Object.entries(links).find(([, o]) => o === openid)?.[0] ?? null;
    },
    // Mirrors the Prisma adapter: a report from the other source pairs instead of adding a row.
    async addGrants(userId, brand, input) {
      const out: Partial<Record<WechatTemplateKey, number>> = {};
      for (const g of input) {
        const source = g.source ?? 'client';
        if (g.dedupeKey && grants.some((r) => r.dedupeKey === g.dedupeKey)) {
          out[g.templateKey] = (out[g.templateKey] ?? 0) + 1;
          continue;
        }
        const partner = grants.find(
          (r) => r.userId === userId && r.templateKey === g.templateKey && (r.source ?? 'client') !== source && !r.paired && r.templateId === g.templateId,
        );
        if (partner) {
          partner.paired = true;
          if (source === 'client') Object.assign(partner, { scene: g.scene ?? null, eventId: g.eventId ?? null });
          if (g.dedupeKey) partner.dedupeKey = g.dedupeKey;
          out[g.templateKey] = (out[g.templateKey] ?? 0) + 1;
          continue;
        }
        const live = grants.filter((r) => r.userId === userId && r.templateKey === g.templateKey && !r.consumedAt).length;
        if (live >= MAX_LIVE_GRANTS) continue;
        grants.push({ ...g, source, id: `g${++seq}`, userId, brand, consumedAt: null, createdAt: seq, paired: false });
        out[g.templateKey] = (out[g.templateKey] ?? 0) + 1;
      }
      return out;
    },
    async claimGrant(userId, _brand, key, now, eventId): Promise<ClaimedGrant | null> {
      const rows = grants.filter((r) => r.userId === userId && r.templateKey === key && !r.consumedAt).sort((a, b) => a.createdAt - b.createdAt);
      const row = (eventId ? rows.find((r) => r.eventId === eventId) : undefined) ?? rows[0];
      if (!row) return null;
      row.consumedAt = now;
      return { id: row.id, templateId: row.templateId };
    },
    async releaseGrant(id) {
      const row = grants.find((r) => r.id === id);
      if (row) row.consumedAt = null;
    },
    async revokeGrants(userId, _brand, key, now) {
      let n = 0;
      for (const r of grants) if (r.userId === userId && r.templateKey === key && !r.consumedAt) (r.consumedAt = now), (n += 1);
      return n;
    },
    async markDelivered(id) {
      delivered.push(id);
    },
  };
  const live = (userId: string, key: WechatTemplateKey) => grants.filter((r) => r.userId === userId && r.templateKey === key && !r.consumedAt).length;
  return { repo, grants, delivered, live };
}

function fakeApi(send: WechatMpApi['sendSubscribeMessage'] = async () => 'm1') {
  const api: WechatMpApi = {
    accessToken: vi.fn(async () => 'AT'),
    jsapiTicket: vi.fn(async () => 'TICKET'),
    sendSubscribeMessage: vi.fn(send),
  };
  return api;
}

function prefsWith(channels: Partial<Record<string, string[]>>): NotificationPreferencesView {
  return { channels } as unknown as NotificationPreferencesView;
}
const WECHAT_ON = prefsWith({ reminder: ['in_app', 'wechat'], billing: ['in_app', 'wechat'] });
const WECHAT_OFF = prefsWith({ reminder: ['in_app'], billing: ['in_app', 'wechat'] });

function makeService(opts: { links?: Record<string, string>; env?: Record<string, string>; prefs?: NotificationPreferencesView | null; api?: WechatMpApi } = {}) {
  const mem = memRepo(opts.links ?? { u1: 'openid_u1' });
  const api = opts.api ?? fakeApi();
  const preferences = vi.fn(async () => (opts.prefs === undefined ? WECHAT_ON : opts.prefs));
  const service = new NotifyCnService({ repo: mem.repo, api, env: opts.env ?? ENV, now: () => NOW, preferences });
  return { service, api, preferences, ...mem };
}

const goapply = getBrand('goapply');
const roboapply = getBrand('roboapply');
const DEADLINE_PARAMS = { company: '某公司', program: '2027届校园招聘', closesAt: '2026-10-31T15:59:00.000Z', days: 3 };

// ── recordSubscribe ──

describe('recordSubscribe (POST /subscribe-messages)', () => {
  it('stores one grant per accepted, configured template of the tap scene', async () => {
    const s = makeService();
    const res = await s.service.recordSubscribe('u1', goapply, {
      templateKeys: ['deadline_reminder'],
      scene: 'campus_deadline',
      eventId: 'ev_1',
      results: { deadline_reminder: 'accept' },
    });
    expect(res).toEqual({ recorded: ['deadline_reminder'], canDeliver: true, wechatChannelOn: true });
    expect(s.grants).toHaveLength(1);
    expect(s.grants[0]).toMatchObject({ templateKey: 'deadline_reminder', templateId: 'Tpl_Deadline_01', scene: 'campus_deadline', eventId: 'ev_1' });
  });

  it('stores nothing when the account is not linked to the 公众号 (nothing could be delivered)', async () => {
    const s = makeService({ links: {} });
    const res = await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } });
    expect(res).toEqual({ recorded: [], canDeliver: false, wechatChannelOn: false });
    expect(s.grants).toHaveLength(0);
  });

  it('ignores rejected answers, templates without an id and templates of another scene', async () => {
    const s = makeService();
    const res = await s.service.recordSubscribe('u1', goapply, {
      templateKeys: ['deadline_reminder', 'report_ready', 'payment_success'],
      scene: 'campus_deadline',
      results: { deadline_reminder: 'reject', report_ready: 'accept', payment_success: 'accept' },
    });
    expect(res.recorded).toEqual([]);
    expect(s.grants).toHaveLength(0);
    // report_ready has no WECHAT_MP_TEMPLATE_REPORT: even in its own scene nothing is kept.
    const r2 = await s.service.recordSubscribe('u1', goapply, { templateKeys: ['report_ready'], scene: 'practice_report', results: { report_ready: 'accept' } });
    expect(r2.recorded).toEqual([]);
  });

  it('says when the person’s settings keep WeChat off for the category', async () => {
    const s = makeService({ prefs: WECHAT_OFF });
    const res = await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } });
    expect(res).toEqual({ recorded: ['deadline_reminder'], canDeliver: true, wechatChannelOn: false });
  });

  it('"ban" voids the remaining grants for that template', async () => {
    const s = makeService();
    await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } });
    expect(s.live('u1', 'deadline_reminder')).toBe(1);
    await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'ban' } });
    expect(s.live('u1', 'deadline_reminder')).toBe(0);
  });

  it('caps live grants per template', async () => {
    const s = makeService();
    for (let i = 0; i < MAX_LIVE_GRANTS + 3; i += 1) {
      await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } });
    }
    expect(s.live('u1', 'deadline_reminder')).toBe(MAX_LIVE_GRANTS);
  });

  it('is GoApply-only and off without credentials', async () => {
    await expect(makeService().service.recordSubscribe('u1', roboapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: {} })).rejects.toMatchObject({ code: 'feature_disabled' });
    await expect(
      makeService({ env: {} }).service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: {} }),
    ).rejects.toMatchObject({ code: 'feature_disabled' });
  });
});

// ── jsSdkConfig ──

describe('jsSdkConfig (GET /js-sdk-signature)', () => {
  it('signs a GoApply page and lists the configured template ids', async () => {
    const s = makeService();
    const res = await s.service.jsSdkConfig('u1', goapply, 'https://www.goapply.top/campus?y=2027#list');
    expect(res.appId).toBe('wx_mp_app');
    expect(res.timestamp).toBe(Number(TS));
    expect(res.nonceStr).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(res.signature).toMatch(/^[0-9a-f]{40}$/);
    expect(res.templates).toEqual({ deadline_reminder: 'Tpl_Deadline_01', payment_success: 'Tpl_Pay_000001' });
    expect(res.canDeliver).toBe(true);
    expect((await makeService({ links: {} }).service.jsSdkConfig('u1', goapply, 'https://goapply.top/')).canDeliver).toBe(false);
  });

  it('refuses pages on other hosts, other schemes and credentials in the URL', async () => {
    const s = makeService();
    for (const url of ['https://evil.example/campus', 'https://www.roboapply.io/jobs', 'http://www.goapply.top/', 'https://u:p@www.goapply.top/', 'ftp://goapply.top/']) {
      await expect(s.service.jsSdkConfig('u1', goapply, url), url).rejects.toMatchObject({ code: 'invalid_request' });
    }
    // The local GoApply host may use http (development only).
    await expect(s.service.jsSdkConfig('u1', goapply, 'http://goapply.localhost:3611/campus')).resolves.toMatchObject({ appId: 'wx_mp_app' });
  });

  it('answers a plain error when WeChat does not give a ticket', async () => {
    const api = fakeApi();
    api.jsapiTicket = vi.fn(async () => {
      throw new WechatMpApiError('network');
    });
    await expect(makeService({ api }).service.jsSdkConfig('u1', goapply, 'https://www.goapply.top/')).rejects.toMatchObject({ code: 'internal_error' });
  });
});

// ── sendNotice ──

describe('sendNotice', () => {
  async function withGrant(opts: Parameters<typeof makeService>[0] = {}) {
    const s = makeService(opts);
    await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } });
    return s;
  }

  it('sends a filled subscribe message to the linked openid, uses the grant and stamps the in-app row', async () => {
    const s = await withGrant();
    const out = await s.service.sendNotice({ userId: 'u1', template: 'deadline_reminder', params: DEADLINE_PARAMS, href: '/campus/acme', notificationId: 'n1' });
    expect(out).toEqual({ delivered: true, providerRef: 'm1' });
    expect(s.api.sendSubscribeMessage).toHaveBeenCalledWith(
      { appId: 'wx_mp_app', secret: 'mp_secret' },
      {
        touser: 'openid_u1',
        template_id: 'Tpl_Deadline_01',
        page: 'https://www.goapply.top/campus/acme',
        data: { thing1: { value: '2027届校园招聘' }, thing2: { value: '某公司' }, time3: { value: '2026年10月31日 23:59' } },
      },
    );
    expect(s.delivered).toEqual(['n1']);
    expect(s.live('u1', 'deadline_reminder')).toBe(0);
    // One acceptance, one message.
    expect(await s.service.sendNotice({ userId: 'u1', template: 'deadline_reminder', params: DEADLINE_PARAMS, href: null })).toEqual({ delivered: false, skippedReason: 'no_subscription' });
  });

  it('skips with a reason, in order, and never calls WeChat', async () => {
    const cases: Array<[string, Parameters<typeof makeService>[0], Record<string, unknown>, string]> = [
      ['credentials missing', { env: {} }, DEADLINE_PARAMS, 'feature_disabled'],
      ['template id unset', { env: { ...ENV, WECHAT_MP_TEMPLATE_DEADLINE: '' } }, DEADLINE_PARAMS, 'template_unset'],
      ['params incomplete', {}, { company: '某公司', closesAt: DEADLINE_PARAMS.closesAt }, 'missing_params'],
      ['not linked', { links: {} }, DEADLINE_PARAMS, 'not_linked'],
      ['settings keep WeChat off', { prefs: WECHAT_OFF }, DEADLINE_PARAMS, 'preference_off'],
      ['no preferences (no seeker profile)', { prefs: null }, DEADLINE_PARAMS, 'preference_off'],
    ];
    for (const [label, opts, params, reason] of cases) {
      const s = await withGrant(opts).catch(() => makeService(opts));
      const out = await s.service.sendNotice({ userId: 'u1', template: 'deadline_reminder', params: params as never, href: '/campus/acme' });
      expect(out, label).toEqual({ delivered: false, skippedReason: reason });
      expect(s.api.sendSubscribeMessage, label).not.toHaveBeenCalled();
    }
    const none = makeService();
    expect(await none.service.sendNotice({ userId: 'u1', template: 'deadline_reminder', params: DEADLINE_PARAMS, href: null })).toEqual({ delivered: false, skippedReason: 'no_subscription' });
  });

  it('billing notices follow the billing category (always every available channel)', async () => {
    const s = makeService({ prefs: WECHAT_OFF });
    await s.service.recordSubscribe('u1', goapply, { templateKeys: ['payment_success'], scene: 'payment', results: { payment_success: 'accept' } });
    const out = await s.service.sendNotice({
      userId: 'u1',
      template: 'payment_success',
      params: { planName: '7天通行证', amountFen: 1990, paidAt: '2026-10-10T08:00:00.000Z', orderNo: 'GA2026101001' },
      href: '/settings/billing',
    });
    expect(out.delivered).toBe(true);
  });

  it('WeChat 43101 uses the grant up; any other failure gives it back', async () => {
    const refused = await withGrant({ api: fakeApi(async () => Promise.reject(new WechatMpApiError(43101, 'user refuse'))) });
    expect(await refused.service.sendNotice({ userId: 'u1', template: 'deadline_reminder', params: DEADLINE_PARAMS, href: null })).toEqual({ delivered: false, skippedReason: 'no_subscription' });
    expect(refused.live('u1', 'deadline_reminder')).toBe(0);

    const down = await withGrant({ api: fakeApi(async () => Promise.reject(new WechatMpApiError('network'))) });
    expect(await down.service.sendNotice({ userId: 'u1', template: 'deadline_reminder', params: DEADLINE_PARAMS, href: null })).toEqual({ delivered: false, skippedReason: 'send_failed' });
    expect(down.live('u1', 'deadline_reminder')).toBe(1);
  });

  it('grants given for an older template id are used up, not sent with the new id', async () => {
    const s = await withGrant({ env: { ...ENV, WECHAT_MP_TEMPLATE_DEADLINE: 'Tpl_Old_00001' } });
    const svc = new NotifyCnService({ repo: s.repo, api: s.api, env: ENV, now: () => NOW, preferences: async () => WECHAT_ON });
    expect(await svc.sendNotice({ userId: 'u1', template: 'deadline_reminder', params: DEADLINE_PARAMS, href: null })).toEqual({ delivered: false, skippedReason: 'no_subscription' });
    expect(s.api.sendSubscribeMessage).not.toHaveBeenCalled();
    expect(s.live('u1', 'deadline_reminder')).toBe(0);
  });

  it('spends the grant given for the same event first, so another event cannot use it up', async () => {
    const s = makeService();
    for (const eventId of ['ev_A', 'ev_B']) {
      await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', eventId, results: { deadline_reminder: 'accept' } });
    }
    expect((await s.service.sendNotice({ userId: 'u1', template: 'deadline_reminder', params: DEADLINE_PARAMS, href: null, eventId: 'ev_B' })).delivered).toBe(true);
    expect(s.grants.find((g) => g.eventId === 'ev_B')?.consumedAt).toEqual(NOW);
    expect(s.grants.find((g) => g.eventId === 'ev_A')?.consumedAt).toBeNull();
    // An event with no grant of its own falls back to the pool.
    expect((await s.service.sendNotice({ userId: 'u1', template: 'deadline_reminder', params: DEADLINE_PARAMS, href: null, eventId: 'ev_C' })).delivered).toBe(true);
    expect(s.live('u1', 'deadline_reminder')).toBe(0);
  });

  it('links only to same-site paths', () => {
    expect(safePath('/campus/a')).toBe('/campus/a');
    for (const bad of ['//evil.example', 'https://evil.example', '/a\\b', null, '']) expect(safePath(bad as string)).toBeNull();
    expect(wechatChosen(null, 'reminder')).toBe(false);
    expect(wechatChosen(WECHAT_ON, 'unknown')).toBe(false);
  });
});

// ── WeChat server endpoint ──

function signed(nonce = 'n1', ts = TS) {
  return { signature: serverSignature(ENV.WECHAT_MP_TOKEN, ts, nonce), timestamp: ts, nonce };
}
const changeEvent = (openid: string, templateId: string, status: string) =>
  `<xml><ToUserName><![CDATA[gh_x]]></ToUserName><FromUserName><![CDATA[${openid}]]></FromUserName><CreateTime>${TS}</CreateTime>` +
  `<MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe_msg_change_event]]></Event>` +
  `<SubscribeMsgChangeEvent><List><TemplateId><![CDATA[${templateId}]]></TemplateId><SubscribeStatusString><![CDATA[${status}]]></SubscribeStatusString></List></SubscribeMsgChangeEvent></xml>`;

const popupEvent = (openid: string, items: Array<[templateId: string, status: string]>) =>
  `<xml><ToUserName><![CDATA[gh_x]]></ToUserName><FromUserName><![CDATA[${openid}]]></FromUserName><CreateTime>${TS}</CreateTime>` +
  `<MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe_msg_popup_event]]></Event><SubscribeMsgPopupEvent>` +
  items
    .map(([id, status]) => `<List><TemplateId><![CDATA[${id}]]></TemplateId><SubscribeStatusString><![CDATA[${status}]]></SubscribeStatusString><PopupScene>2</PopupScene></List>`)
    .join('') +
  `</SubscribeMsgPopupEvent></xml>`;

describe('WeChat server endpoint', () => {
  it('WeChat’s own popup event records an accepted prompt (also when the page never reported it)', async () => {
    const s = makeService();
    const body = popupEvent('openid_u1', [
      ['Tpl_Deadline_01', 'accept'],
      ['Tpl_Pay_000001', 'reject'],
      ['Tpl_Unknown_99', 'accept'],
    ]);
    expect(await s.service.handleServerMessage(signed(), Buffer.from(body))).toBe('success');
    expect(s.grants).toHaveLength(1);
    expect(s.grants[0]).toMatchObject({ templateKey: 'deadline_reminder', templateId: 'Tpl_Deadline_01', source: 'wechat', paired: false });
    // Someone not linked to an account: nothing is stored.
    await s.service.handleServerMessage(signed(), Buffer.from(popupEvent('stranger', [['Tpl_Deadline_01', 'accept']])));
    expect(s.grants).toHaveLength(1);
    // The grant can be spent.
    expect((await s.service.sendNotice({ userId: 'u1', template: 'deadline_reminder', params: DEADLINE_PARAMS, href: null })).delivered).toBe(true);
  });

  it('the page’s report and WeChat’s event of one tap make one grant, in either order', async () => {
    const tap = { templateKeys: ['deadline_reminder' as const], scene: 'campus_deadline' as const, eventId: 'ev_1', results: { deadline_reminder: 'accept' as const } };
    const pageFirst = makeService();
    await pageFirst.service.recordSubscribe('u1', goapply, tap);
    await pageFirst.service.handleServerMessage(signed(), Buffer.from(popupEvent('openid_u1', [['Tpl_Deadline_01', 'accept']])));
    expect(pageFirst.live('u1', 'deadline_reminder')).toBe(1);
    expect(pageFirst.grants[0]).toMatchObject({ source: 'client', paired: true, eventId: 'ev_1' });

    const wechatFirst = makeService();
    await wechatFirst.service.handleServerMessage(signed(), Buffer.from(popupEvent('openid_u1', [['Tpl_Deadline_01', 'accept']])));
    const res = await wechatFirst.service.recordSubscribe('u1', goapply, tap);
    expect(res.recorded).toEqual(['deadline_reminder']);
    expect(wechatFirst.live('u1', 'deadline_reminder')).toBe(1);
    expect(wechatFirst.grants[0]).toMatchObject({ source: 'wechat', paired: true, eventId: 'ev_1', scene: 'campus_deadline' });

    // Two taps, two acceptances: two grants.
    await wechatFirst.service.recordSubscribe('u1', goapply, tap);
    expect(wechatFirst.live('u1', 'deadline_reminder')).toBe(2);
  });

  it('a retried popup event (same CreateTime) is recorded once', async () => {
    const s = makeService();
    const body = Buffer.from(popupEvent('openid_u1', [['Tpl_Deadline_01', 'accept']]));
    await s.service.handleServerMessage(signed(), body);
    await s.service.handleServerMessage(signed('n2'), body);
    expect(s.live('u1', 'deadline_reminder')).toBe(1);
    // …also after it was paired with the page's report.
    await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } });
    await s.service.handleServerMessage(signed('n3'), body);
    expect(s.live('u1', 'deadline_reminder')).toBe(1);
  });

  it('URL verification echoes echostr only with a valid, fresh signature', () => {
    const s = makeService();
    expect(s.service.verifyServerUrl({ ...signed(), echostr: 'echo123' })).toBe('echo123');
    expect(() => s.service.verifyServerUrl({ ...signed(), signature: 'f'.repeat(40), echostr: 'x' })).toThrow(expect.objectContaining({ code: 'forbidden' }));
    const stale = String(Number(TS) - 3600);
    expect(() => s.service.verifyServerUrl({ ...signed('n1', stale), echostr: 'x' })).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });

  it('a "turned off" change event voids that template’s grants for the linked person', async () => {
    const s = makeService();
    await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } });
    expect(await s.service.handleServerMessage(signed(), Buffer.from(changeEvent('openid_u1', 'Tpl_Deadline_01', 'accept')))).toBe('success');
    expect(s.live('u1', 'deadline_reminder')).toBe(1);
    expect(await s.service.handleServerMessage(signed(), Buffer.from(changeEvent('someone_else', 'Tpl_Deadline_01', 'reject')))).toBe('success');
    expect(s.live('u1', 'deadline_reminder')).toBe(1);
    expect(await s.service.handleServerMessage(signed(), Buffer.from(changeEvent('openid_u1', 'Tpl_Deadline_01', 'reject')))).toBe('success');
    expect(s.live('u1', 'deadline_reminder')).toBe(0);
  });

  it('refuses a bad signature before reading the body; acks junk and plain messages', async () => {
    const s = makeService();
    await expect(s.service.handleServerMessage({ ...signed(), signature: '0'.repeat(40) }, Buffer.from('<xml/>'))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await s.service.handleServerMessage(signed(), Buffer.from('not xml'))).toBe('success');
    expect(await s.service.handleServerMessage(signed(), Buffer.from('<xml><MsgType><![CDATA[text]]></MsgType><Content>hi</Content></xml>'))).toBe('success');
  });

  it('安全模式: checks msg_signature, decrypts with the AES key, then handles the event', async () => {
    const env = { ...ENV, WECHAT_MP_ENCODING_AES_KEY: AES_KEY };
    const s = makeService({ env });
    await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } });
    const enc = encryptMessage(AES_KEY, changeEvent('openid_u1', 'Tpl_Deadline_01', 'reject'), ENV.WECHAT_MP_APP_ID);
    const body = Buffer.from(`<xml><ToUserName><![CDATA[gh_x]]></ToUserName><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`);
    const q = { ...signed(), encrypt_type: 'aes' };
    await expect(s.service.handleServerMessage({ ...q, msg_signature: '0'.repeat(40) }, body)).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.live('u1', 'deadline_reminder')).toBe(1);
    expect(await s.service.handleServerMessage({ ...q, msg_signature: msgSignature(ENV.WECHAT_MP_TOKEN, TS, 'n1', enc) }, body)).toBe('success');
    expect(s.live('u1', 'deadline_reminder')).toBe(0);
    // Encrypted for another appid: refused.
    const foreign = encryptMessage(AES_KEY, changeEvent('openid_u1', 'Tpl_Deadline_01', 'reject'), 'wx_other');
    const fBody = Buffer.from(`<xml><Encrypt><![CDATA[${foreign}]]></Encrypt></xml>`);
    await expect(s.service.handleServerMessage({ ...q, msg_signature: msgSignature(ENV.WECHAT_MP_TOKEN, TS, 'n1', foreign) }, fBody)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

// ── Delivery channel ──

describe('wechat_mp delivery channel', () => {
  afterEach(() => resetDeliveryChannelsForTests());

  it('registers once with WP-39a for GoApply only', () => {
    resetDeliveryChannelsForTests();
    const ch = registerWechatMpChannel();
    expect(registerWechatMpChannel()).toBe(ch);
    expect(deliveryChannels('goapply').map((c) => c.id)).toEqual([WECHAT_MP_CHANNEL_ID]);
    expect(deliveryChannels('roboapply')).toEqual([]);
  });

  it('maps the campus deadline message and skips messages without a WeChat template', async () => {
    const s = makeService();
    await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } });
    const ch = createWechatMpChannel({ service: () => s.service });
    expect(ch.isConfigured()).toBe(true);
    expect(createWechatMpChannel({ service: () => makeService({ env: {} }).service }).isConfigured()).toBe(false);
    const base = { userId: 'u1', brand: 'goapply' as const, locale: 'zh', kind: 'reminder' as const, category: 'reminder', href: '/campus/acme', notificationId: 'n9' };
    expect(await ch.deliver({ ...base, templateKey: 'notify.job_alert_instant', params: {} })).toEqual({ delivered: false, skippedReason: 'no_wechat_template' });
    expect(await ch.deliver({ ...base, templateKey: 'notify.campus_deadline', params: DEADLINE_PARAMS })).toEqual({ delivered: true, providerRef: 'm1' });
    expect(s.delivered).toEqual(['n9']);
  });

  it('runs inside alerts.deliverMessage after the in-app row (each channel isolated)', async () => {
    const s = makeService();
    await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } });
    const ch = createWechatMpChannel({ service: () => s.service });
    const deps: DeliverDeps = {
      createInApp: vi.fn(async () => ({ id: 'n42' })),
      markEmailed: vi.fn(async () => undefined),
      sendEmail: vi.fn(async () => ({ status: 'suppressed' }) as never),
      channels: () => [ch],
      emailEnabled: () => false,
    };
    const out = await deliverMessage(
      {
        recipient: { userId: 'u1', seekerProfileId: 'sp1', brand: 'goapply', email: null, locale: 'zh' } as never,
        kind: 'reminder',
        category: 'reminder',
        templateKey: 'notify.campus_deadline',
        params: DEADLINE_PARAMS,
        href: '/campus/acme',
        prefs: { center: { v: 1, channels: { reminder: ['in_app', 'wechat'] } } } as never,
      },
      deps,
    );
    expect(out.notificationId).toBe('n42');
    expect(out.channels.wechat_mp).toEqual({ delivered: true, providerRef: 'm1' });
    expect(s.delivered).toEqual(['n42']);
  });
});

// ── Routes ──

describe('routes', { timeout: 30_000 }, () => {
  const auth = [fakeAuth((req) => (req.headers['x-test-user'] ? { id: String(req.headers['x-test-user']) } : null))];
  let h: RouteHarness;
  let hOff: RouteHarness;
  let s: ReturnType<typeof makeService>;

  beforeAll(async () => {
    s = makeService();
    const raw = express.raw({ type: '*/*', limit: '1mb' });
    h = await startRouteHarness({
      env: ENV,
      mounts: [
        ['/api/v1/webhooks', raw],
        ['/api/v1/roboapply/notify-cn', createNotifyCnRouter({ seekerAuth: auth, env: ENV, service: s.service })],
        ['/api/v1/webhooks/wechat-mp', createWechatMpWebhookRouter({ env: ENV, service: s.service })],
        // A mount without the raw parser (the mount-order bug the POST guards against).
        ['/parsed/wechat-mp', createWechatMpWebhookRouter({ env: ENV, service: s.service })],
      ],
    });
    hOff = await startRouteHarness({
      env: {},
      mounts: [
        ['/api/v1/webhooks', raw],
        ['/api/v1/roboapply/notify-cn', createNotifyCnRouter({ seekerAuth: auth, env: {}, service: s.service })],
        ['/api/v1/webhooks/wechat-mp', createWechatMpWebhookRouter({ env: {}, service: s.service })],
      ],
    });
  });
  afterAll(async () => {
    await h.close();
    await hOff.close();
    resetDeliveryChannelsForTests();
  });
  beforeEach(() => vi.clearAllMocks());

  const as = (user: string | null) => ({ host: GOAPPLY, headers: user ? { 'x-test-user': user } : {} });

  it('seeker routes need a session', async () => {
    expect((await h.request('POST', '/api/v1/roboapply/notify-cn/subscribe-messages', { ...as(null), body: {} })).status).toBe(401);
    expect((await h.request('GET', '/api/v1/roboapply/notify-cn/js-sdk-signature?url=https%3A%2F%2Fwww.goapply.top%2F', as(null))).status).toBe(401);
  });

  it('every route answers 404 feature_disabled without WECHAT_MP_* (and on RoboApply)', async () => {
    const q = `?${new URLSearchParams({ ...signed(), echostr: 'e' }).toString()}`;
    for (const [harness, host] of [
      [hOff, GOAPPLY],
      [h, 'localhost:3621'],
    ] as const) {
      const r1 = await harness.request<{ code: string }>('POST', '/api/v1/roboapply/notify-cn/subscribe-messages', { host, headers: { 'x-test-user': 'u1' }, body: {} });
      const r2 = await harness.request<{ code: string }>('GET', '/api/v1/roboapply/notify-cn/js-sdk-signature?url=x', { host, headers: { 'x-test-user': 'u1' } });
      const r3 = await harness.request<{ code: string }>('GET', `/api/v1/webhooks/wechat-mp${q}`, { host });
      for (const r of [r1, r2, r3]) {
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('feature_disabled');
      }
    }
  });

  it('POST /subscribe-messages validates and records', async () => {
    const bad = await h.request<{ code: string }>('POST', '/api/v1/roboapply/notify-cn/subscribe-messages', { ...as('u1'), body: { templateKeys: ['nope'], scene: 'campus_deadline', results: {} } });
    expect(bad.status).toBe(422);
    const res = await h.request<{ success: boolean; data: unknown }>('POST', '/api/v1/roboapply/notify-cn/subscribe-messages', {
      ...as('u1'),
      body: { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ recorded: ['deadline_reminder'], canDeliver: true, wechatChannelOn: true });
  });

  it('GET /js-sdk-signature returns a no-store config for GoApply pages only', async () => {
    const ok = await h.request<{ data: { appId: string; signature: string } }>(
      'GET',
      `/api/v1/roboapply/notify-cn/js-sdk-signature?url=${encodeURIComponent('https://www.goapply.top/campus')}`,
      as('u1'),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.body.data.appId).toBe('wx_mp_app');
    const other = await h.request('GET', `/api/v1/roboapply/notify-cn/js-sdk-signature?url=${encodeURIComponent('https://evil.example/')}`, as('u1'));
    expect(other.status).toBe(422);
  });

  it('webhook GET echoes echostr as plain text after the signature check; 403 otherwise', async () => {
    const good = await fetch(`${h.baseUrl}/api/v1/webhooks/wechat-mp?${new URLSearchParams({ ...signed(), echostr: 'abc123' })}`, { headers: { 'x-forwarded-host': GOAPPLY } });
    expect(good.status).toBe(200);
    expect(good.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await good.text()).toBe('abc123');
    const bad = await fetch(`${h.baseUrl}/api/v1/webhooks/wechat-mp?${new URLSearchParams({ ...signed(), signature: 'a'.repeat(40), echostr: 'abc123' })}`, {
      headers: { 'x-forwarded-host': GOAPPLY },
    });
    expect(bad.status).toBe(403);
    expect(await bad.text()).not.toContain('abc123');
  });

  it('webhook POST reads the raw XML body and answers "success"', async () => {
    await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } });
    const before = s.live('u1', 'deadline_reminder');
    expect(before).toBeGreaterThan(0);
    const res = await fetch(`${h.baseUrl}/api/v1/webhooks/wechat-mp?${new URLSearchParams(signed())}`, {
      method: 'POST',
      headers: { 'x-forwarded-host': GOAPPLY, 'content-type': 'text/xml' },
      body: changeEvent('openid_u1', 'Tpl_Deadline_01', 'reject'),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('success');
    expect(s.live('u1', 'deadline_reminder')).toBe(0);
    const forged = await fetch(`${h.baseUrl}/api/v1/webhooks/wechat-mp?${new URLSearchParams({ ...signed(), signature: 'b'.repeat(40) })}`, {
      method: 'POST',
      headers: { 'x-forwarded-host': GOAPPLY, 'content-type': 'text/xml' },
      body: '<xml></xml>',
    });
    expect(forged.status).toBe(403);
  });

  it('webhook POST refuses a body that was parsed instead of raw', async () => {
    const res = await h.request<{ code: string }>('POST', `/parsed/wechat-mp?${new URLSearchParams(signed())}`, { host: GOAPPLY, body: { a: 1 } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_request');
  });
});

describe('repo kinds', () => {
  it('one token kind per template', () => {
    expect(grantKind('deadline_reminder')).toBe('wechat_sub:deadline_reminder');
  });
});

// ── Acceptance 2: SMS is never used ──

describe('no SMS for WeChat notices', () => {
  it('no notify-cn source imports an SMS sender', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const imports = readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .filter((l) => /^\s*(import|export)\b.*from\s+['"]|import\(/.test(l));
      for (const line of imports) {
        expect(line, `${file}: ${line}`).not.toMatch(/platform\/sms|auth-cn|SmsService|aliyun|tencent|dysmsapi/i);
      }
    }
  });

  it('a skipped notice (no WeChat template, no grant, send failed) runs no other channel', async () => {
    const createSms = vi.mocked(sms.createSmsService);
    createSms.mockClear();
    const s = makeService({ api: fakeApi(async () => Promise.reject(new WechatMpApiError('network'))) });
    const ch = createWechatMpChannel({ service: () => s.service });
    const base = { userId: 'u1', brand: 'goapply' as const, locale: 'zh', kind: 'reminder' as const, category: 'reminder', href: '/campus/acme', notificationId: 'n1' };
    expect(await ch.deliver({ ...base, templateKey: 'notify.job_alert_instant', params: {} })).toEqual({ delivered: false, skippedReason: 'no_wechat_template' });
    expect(await ch.deliver({ ...base, templateKey: 'notify.campus_deadline', params: DEADLINE_PARAMS })).toEqual({ delivered: false, skippedReason: 'no_subscription' });
    await s.service.recordSubscribe('u1', goapply, { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } });
    expect(await ch.deliver({ ...base, templateKey: 'notify.campus_deadline', params: DEADLINE_PARAMS })).toEqual({ delivered: false, skippedReason: 'send_failed' });
    // WeChat was the only thing tried, once; nothing else was created or sent.
    expect(s.api.sendSubscribeMessage).toHaveBeenCalledTimes(1);
    expect(createSms).not.toHaveBeenCalled();
    expect(s.delivered).toEqual([]);
  });
});
