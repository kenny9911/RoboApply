// server/src/features/notify-cn/service.ts — WeChat 公众号 notices for GoApply (WP-73).
//
//   recordSubscribe   POST /notify-cn/subscribe-messages: store each accepted
//                     one-time prompt (only for accounts linked to the 公众号;
//                     otherwise nothing could ever be delivered, so nothing is kept)
//   jsSdkConfig       GET /notify-cn/js-sdk-signature: JS-SDK config for a
//                     GoApply page URL (share card + subscribe prompt)
//   sendNotice        what producers and the `wechat_mp` delivery channel call:
//                     template id set → params fill every keyword → account
//                     linked → the person's settings list WeChat for the
//                     category → one accepted prompt left → bizsend
//   verifyServerUrl / handleServerMessage
//                     the WeChat server endpoint: signature (and, in 安全模式,
//                     msg_signature + AES) checked before anything is read;
//                     WeChat's own record of an accepted prompt
//                     (`subscribe_msg_popup_event`) adds or confirms a grant
//                     (paired with the page's report, so one acceptance is one
//                     grant); "turned off in WeChat" events use up the grants
//
// Nothing here sends SMS, and no notice carries a number the producer did not
// pass in (D3). The in-app row stays the source of truth; WeChat mirrors it.

import { getBrand, brandIdFromHost, type ProductBrand } from '../../platform/brand/registry.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { emailOrigin } from '../../platform/email/index.js';
import { isEnabledForBrand } from '../../platform/flags.js';
import { HttpError } from '../../platform/http.js';
import { logger } from '../../services/LoggerService.js';
import type { DeliveryResult } from '../alerts/index.js';
import type { NotificationPreferencesView } from '../notifications/index.js';
import { configuredTemplates, mpAesKey, mpApp, mpToken, templateConfig, templateKeyForId } from './config.js';
import {
  CATEGORY_FOR_TEMPLATE,
  SCENE_FOR_TEMPLATE,
  WECHAT_TEMPLATE_KEYS,
  type JsSdkSignatureResponse,
  type SubscribeMessagesResponse,
  type WechatNoticeInput,
  type WechatSkipReason,
  type WechatTemplateKey,
} from './contract.js';
import type { z } from 'zod';
import type { SubscribeMessagesBodySchema } from './contract.js';
import { templateData } from './format.js';
import { createPrismaNotifyCnRepo, MAX_LIVE_GRANTS, type NotifyCnRepo } from './repo.js';
import { decryptMessage, jsSdkSignature, msgSignature, nonceStr, safeEqual, timestampFresh, verifyServerSignature } from './signature.js';
import { wechatMpApi, WechatMpApiError, type WechatMpApi } from './wechatApi.js';
import { parseWechatXml } from './xml.js';

type SubscribeBody = z.output<typeof SubscribeMessagesBodySchema>;

/** WeChat: the person has no subscription left for this template (the grant is used up). */
export const ERR_NO_SUBSCRIPTION = 43101;

export interface NotifyCnServiceDeps {
  repo?: NotifyCnRepo;
  api?: WechatMpApi;
  env?: EnvSource;
  now?: () => Date;
  /** The person's notification settings (WP-39b); lazy by default. */
  preferences?: (userId: string, brand: ProductBrand) => Promise<NotificationPreferencesView | null>;
}

export type NoticeOutcome = DeliveryResult & { skippedReason?: WechatSkipReason | 'error' };

/** Is WeChat one of the person's chosen channels for this category? Unknown → no (fail closed). */
export function wechatChosen(prefs: NotificationPreferencesView | null, category: string): boolean {
  if (!prefs) return false;
  const chosen = (prefs.channels as Record<string, readonly string[] | undefined>)[category];
  return Array.isArray(chosen) && chosen.includes('wechat');
}

/** Lazy: the message-center module installs the email gate on import. */
export async function loadPreferences(userId: string, brand: ProductBrand): Promise<NotificationPreferencesView | null> {
  return (await import('../notifications/index.js')).notificationCenterService.preferencesFor(userId, brand);
}

/** Same-site path only (no scheme, no `//host`, no backslash). */
export function safePath(href: string | null | undefined): string | null {
  return typeof href === 'string' && href.startsWith('/') && !href.startsWith('//') && !href.includes('\\') && href.length <= 500 ? href : null;
}

export class NotifyCnService {
  private readonly repo: NotifyCnRepo;
  private readonly api: () => WechatMpApi;
  private readonly env: () => EnvSource;
  private readonly now: () => Date;
  private readonly preferences: (userId: string, brand: ProductBrand) => Promise<NotificationPreferencesView | null>;

  constructor(deps: NotifyCnServiceDeps = {}) {
    this.repo = deps.repo ?? createPrismaNotifyCnRepo();
    this.api = deps.api ? () => deps.api! : wechatMpApi;
    this.env = () => deps.env ?? process.env;
    this.now = deps.now ?? (() => new Date());
    this.preferences = deps.preferences ?? loadPreferences;
  }

  /** `notify.wechat` on for GoApply (credentials present). */
  configured(): boolean {
    return isEnabledForBrand('notify.wechat', getBrand('goapply'), this.env());
  }

  private app(): { appId: string; secret: string } {
    const app = mpApp(this.env());
    if (!app || !this.configured()) throw new HttpError('feature_disabled');
    return app;
  }

  // ── Seeker routes ──

  async recordSubscribe(userId: string, brand: ProductBrand, body: SubscribeBody): Promise<SubscribeMessagesResponse> {
    if (brand.market !== 'cn') throw new HttpError('feature_disabled');
    const app = this.app();
    const env = this.env();
    const now = this.now();
    const openid = await this.repo.mpOpenId(userId, brand.id, app.appId);
    if (!openid) return { recorded: [], canDeliver: false, wechatChannelOn: false };

    const requested = [...new Set(body.templateKeys)].filter((k) => SCENE_FOR_TEMPLATE[k] === body.scene);
    // "ban": the person blocked this account's prompts in WeChat; earlier grants cannot be used either.
    for (const k of requested) {
      if (body.results[k] === 'ban') await this.repo.revokeGrants(userId, brand.id, k, now);
    }
    const grants = requested
      .filter((k) => body.results[k] === 'accept')
      .map((k) => ({ key: k, cfg: templateConfig(k, env) }))
      .filter((g): g is { key: WechatTemplateKey; cfg: NonNullable<typeof g.cfg> } => g.cfg !== null)
      .map((g) => ({ templateKey: g.key, templateId: g.cfg.id, scene: body.scene, eventId: body.eventId ?? null, source: 'client' as const }));
    const stored = grants.length ? await this.repo.addGrants(userId, brand.id, grants, now) : {};
    const recorded = WECHAT_TEMPLATE_KEYS.filter((k) => (stored[k] ?? 0) > 0);

    const relevant = recorded.length ? recorded : requested;
    const prefs = relevant.length ? await this.preferences(userId, brand) : null;
    const wechatChannelOn = relevant.length > 0 && relevant.every((k) => wechatChosen(prefs, CATEGORY_FOR_TEMPLATE[k]));
    return { recorded, canDeliver: true, wechatChannelOn };
  }

  async jsSdkConfig(userId: string, brand: ProductBrand, url: string): Promise<JsSdkSignatureResponse> {
    if (brand.market !== 'cn') throw new HttpError('feature_disabled');
    const app = this.app();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError('invalid_request', 'The page address is not valid.', { where: 'query', field: 'url' });
    }
    const host = parsed.host.toLowerCase();
    const isDevHost = brand.devHosts.includes(parsed.hostname.toLowerCase());
    const ownHost = brandIdFromHost(host) === brand.id;
    const schemeOk = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isDevHost);
    if (!ownHost || !schemeOk || parsed.username || parsed.password) {
      throw new HttpError('invalid_request', 'Only pages on this site can be signed.', { where: 'query', field: 'url' });
    }
    let ticket: string;
    try {
      ticket = await this.api().jsapiTicket(app);
    } catch (err) {
      logger.warn('NOTIFY_CN', 'jsapi ticket unavailable', { error: err instanceof Error ? err.message : String(err) });
      throw new HttpError('internal_error', 'WeChat did not answer. Try again in a moment.');
    }
    const timestamp = Math.floor(this.now().getTime() / 1000);
    const nonce = nonceStr();
    const templates: Partial<Record<WechatTemplateKey, string>> = {};
    for (const t of configuredTemplates(this.env())) templates[t.key] = t.id;
    const openid = await this.repo.mpOpenId(userId, brand.id, app.appId);
    return { appId: app.appId, timestamp, nonceStr: nonce, signature: jsSdkSignature(ticket, nonce, timestamp, url), templates, canDeliver: openid !== null };
  }

  // ── Delivery ──

  /** Send one notice to one person (GoApply). Never throws for expected skips. */
  async sendNotice(input: WechatNoticeInput): Promise<NoticeOutcome> {
    const brand = getBrand('goapply');
    const env = this.env();
    const skip = (skippedReason: WechatSkipReason): NoticeOutcome => ({ delivered: false, skippedReason });
    if (!this.configured()) return skip('feature_disabled');
    const app = mpApp(env);
    if (!app) return skip('feature_disabled');
    const cfg = templateConfig(input.template, env);
    if (!cfg) return skip('template_unset');
    const data = templateData(cfg, input.params);
    if (!data) return skip('missing_params');
    const openid = await this.repo.mpOpenId(input.userId, brand.id, app.appId);
    if (!openid) return skip('not_linked');
    const prefs = await this.preferences(input.userId, brand);
    if (!wechatChosen(prefs, input.category ?? CATEGORY_FOR_TEMPLATE[input.template])) return skip('preference_off');

    const now = this.now();
    // Grants made for an older template id cannot be used for the current one: they are used up.
    // A grant given for this event (eventId) is spent first, then any other.
    const eventId = input.eventId ?? null;
    let grant = await this.repo.claimGrant(input.userId, brand.id, input.template, now, eventId);
    for (let i = 0; grant && grant.templateId && grant.templateId !== cfg.id && i < MAX_LIVE_GRANTS; i += 1) {
      grant = await this.repo.claimGrant(input.userId, brand.id, input.template, now, eventId);
    }
    if (!grant || (grant.templateId && grant.templateId !== cfg.id)) return skip('no_subscription');

    const path = safePath(input.href);
    try {
      const msgid = await this.api().sendSubscribeMessage(app, {
        touser: openid,
        template_id: cfg.id,
        ...(path ? { page: `${emailOrigin(brand, env)}${path}` } : {}),
        data,
      });
      if (input.notificationId) await this.repo.markDelivered(input.notificationId, now).catch(() => undefined);
      return msgid ? { delivered: true, providerRef: msgid } : { delivered: true };
    } catch (err) {
      const code = err instanceof WechatMpApiError ? err.errcode : 'unknown';
      if (code === ERR_NO_SUBSCRIPTION) return skip('no_subscription');
      // Anything else did not use the person's permission up: give it back.
      await this.repo.releaseGrant(grant.id).catch(() => undefined);
      logger.warn('NOTIFY_CN', 'subscribe message not sent', { template: input.template, errcode: String(code) });
      return skip('send_failed');
    }
  }

  // ── WeChat server endpoint ──

  private checkSignature(q: { signature: string; timestamp: string; nonce: string }): string {
    const token = mpToken(this.env());
    if (!token || !this.configured()) throw new HttpError('feature_disabled');
    if (!verifyServerSignature(token, q) || !timestampFresh(q.timestamp, this.now())) {
      throw new HttpError('forbidden', 'Signature check failed.');
    }
    return token;
  }

  /** GET: the URL check WeChat runs when the server address is saved. Returns `echostr`. */
  verifyServerUrl(q: { signature: string; timestamp: string; nonce: string; echostr: string }): string {
    this.checkSignature(q);
    return q.echostr;
  }

  /** POST: one server message. Returns the reply body ('success': no passive reply). */
  async handleServerMessage(
    q: { signature: string; timestamp: string; nonce: string; encrypt_type?: string; msg_signature?: string },
    raw: Buffer,
  ): Promise<'success'> {
    const token = this.checkSignature(q);
    const outer = parseWechatXml(raw.toString('utf8'));
    if (!outer) return 'success';
    let fields = outer.fields;
    let lists = outer.lists;
    if ((q.encrypt_type ?? 'raw') === 'aes') {
      const encrypt = outer.fields.Encrypt;
      if (!encrypt || !q.msg_signature || !safeEqual(msgSignature(token, q.timestamp, q.nonce, encrypt), q.msg_signature.toLowerCase())) {
        throw new HttpError('forbidden', 'Signature check failed.');
      }
      const aesKey = mpAesKey(this.env());
      const app = mpApp(this.env());
      if (!aesKey || !app) {
        logger.warn('NOTIFY_CN', 'encrypted server message but WECHAT_MP_ENCODING_AES_KEY is not set');
        return 'success';
      }
      let inner;
      try {
        inner = parseWechatXml(decryptMessage(aesKey, encrypt, app.appId));
      } catch {
        throw new HttpError('forbidden', 'Message could not be decrypted.');
      }
      if (!inner) return 'success';
      fields = inner.fields;
      lists = inner.lists;
    }
    if (fields.MsgType !== 'event') return 'success';
    const event = fields.Event ?? '';
    const openid = fields.FromUserName ?? '';
    if (event === 'subscribe_msg_popup_event' && openid) {
      await this.recordAccepted(openid, lists, fields.CreateTime ?? '');
    } else if (event === 'subscribe_msg_change_event' && openid) {
      await this.revokeTurnedOff(openid, lists);
    } else if (event === 'subscribe_msg_sent_event') {
      for (const item of lists) {
        if (item.ErrorCode && item.ErrorCode !== '0') {
          logger.info('NOTIFY_CN', 'subscribe message not delivered by WeChat', { errorCode: item.ErrorCode, status: item.ErrorStatus ?? null });
        }
      }
    }
    return 'success';
  }

  /**
   * WeChat's own record of the person's answer to a prompt (PopupScene 2 is
   * a web page's `wx-open-subscribe`). Each 'accept' for a configured
   * template is a grant; it pairs with the page's report of the same tap.
   */
  private async recordAccepted(openid: string, lists: Array<Record<string, string>>, createTime: string): Promise<void> {
    const accepted = lists.filter((i) => i.SubscribeStatusString === 'accept' && i.TemplateId);
    if (!accepted.length) return;
    const app = mpApp(this.env());
    if (!app) return;
    const brand = getBrand('goapply');
    const userId = await this.repo.userForOpenId(openid, brand.id, app.appId);
    if (!userId) return;
    const grants = accepted.flatMap((item) => {
      const key = templateKeyForId(item.TemplateId!, this.env());
      // WeChat retries an unanswered message: openid + CreateTime + template identifies this one.
      const dedupeKey = createTime ? `wx:${openid}:${createTime}:${item.TemplateId}` : null;
      return key ? [{ templateKey: key, templateId: item.TemplateId!, source: 'wechat' as const, dedupeKey }] : [];
    });
    if (grants.length) await this.repo.addGrants(userId, brand.id, grants, this.now());
  }

  /** The person turned a template off in WeChat's settings: their remaining grants for it are void. */
  private async revokeTurnedOff(openid: string, lists: Array<Record<string, string>>): Promise<void> {
    const rejected = lists.filter((i) => i.SubscribeStatusString === 'reject' && i.TemplateId);
    if (!rejected.length) return;
    const app = mpApp(this.env());
    if (!app) return;
    const brand = getBrand('goapply');
    const userId = await this.repo.userForOpenId(openid, brand.id, app.appId);
    if (!userId) return;
    const now = this.now();
    for (const item of rejected) {
      const key = templateKeyForId(item.TemplateId!, this.env());
      if (key) await this.repo.revokeGrants(userId, brand.id, key, now);
    }
  }
}

let shared: NotifyCnService | null = null;
/** The production service (lazy). */
export function notifyCnService(): NotifyCnService {
  shared ??= new NotifyCnService();
  return shared;
}
