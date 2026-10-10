// server/src/features/notify-cn/contract.ts
//
// WeChat 公众号 notices + WeChat share card (GoApply; TASK_PLAN.md WP-73;
// capability `notify.wechat`). Mounts:
//   /api/v1/roboapply/notify-cn       (seeker)
//   /api/v1/webhooks/wechat-mp        (WeChat server: GET URL verification, POST raw XML messages)
//
// The message endpoint is signature-checked (token + timestamp + nonce) and
// reads the raw XML body (app.ts parses /api/v1/webhooks with express.raw).
// A template without a configured id never sends. Subscribe messages are
// collected at the user's "remind me" tap only.
//
// How a WeChat notice reaches someone (all four must hold):
//   1. the template has an id in env (`WECHAT_MP_TEMPLATE_{DEADLINE,REPORT,PAYMENT}`);
//   2. the person's account is linked to the 公众号 (an `RAAuthIdentity`
//      row for the 公众号 appid, written by WeChat sign-in inside WeChat);
//   3. the person accepted that template at a "remind me" tap (WeChat's own
//      one-time subscribe prompt; each acceptance allows ONE message, so a
//      producer with several reminders per event sends only the most useful
//      one to WeChat, e.g. the campus calendar's final, 1-day reminder);
//   4. the person's notification settings list WeChat for the category
//      (`preferencesFor(...).channels[category]` includes 'wechat'; billing
//      is a locked category that always uses every available channel).
//      Accepting the prompt in 3 turns this on by itself (WP-39b
//      `enableChannelIfDefault`); only a person who turned WeChat off in
//      Settings stays off.
// SMS is never used for these notices (it stays sign-in codes only).

import { z } from 'zod';

export const WECHAT_TEMPLATE_KEYS = ['deadline_reminder', 'report_ready', 'payment_success'] as const;
export type WechatTemplateKey = (typeof WECHAT_TEMPLATE_KEYS)[number];

/** Where a subscribe prompt is shown. */
export const WECHAT_SUBSCRIBE_SCENES = ['campus_deadline', 'practice_report', 'payment'] as const;
export type WechatSubscribeScene = (typeof WECHAT_SUBSCRIBE_SCENES)[number];

/** The scene a template's "remind me" tap belongs to. */
export const SCENE_FOR_TEMPLATE: Readonly<Record<WechatTemplateKey, WechatSubscribeScene>> = {
  deadline_reminder: 'campus_deadline',
  report_ready: 'practice_report',
  payment_success: 'payment',
};

/** The message-center category each notice belongs to (WP-39b `NOTIFICATION_CATEGORIES`). */
export const CATEGORY_FOR_TEMPLATE: Readonly<Record<WechatTemplateKey, 'reminder' | 'billing'>> = {
  deadline_reminder: 'reminder',
  report_ready: 'reminder',
  payment_success: 'billing',
};

/** Env var holding each template's id (optionally `id|keyword:source,…`; see config.ts). */
export const TEMPLATE_ENV: Readonly<Record<WechatTemplateKey, string>> = {
  deadline_reminder: 'WECHAT_MP_TEMPLATE_DEADLINE',
  report_ready: 'WECHAT_MP_TEMPLATE_REPORT',
  payment_success: 'WECHAT_MP_TEMPLATE_PAYMENT',
};

/** WeChat's per-template answer to a subscribe prompt. */
export const SUBSCRIBE_RESULTS = ['accept', 'reject', 'ban', 'filter'] as const;
export type SubscribeResult = (typeof SUBSCRIBE_RESULTS)[number];

/** POST /notify-cn/subscribe-messages — the user answered WeChat's subscribe prompt at a "remind me" tap. */
export const SubscribeMessagesBodySchema = z
  .object({
    templateKeys: z.array(z.enum(WECHAT_TEMPLATE_KEYS)).min(1).max(3),
    scene: z.enum(WECHAT_SUBSCRIBE_SCENES),
    eventId: z.string().min(1).max(64).optional(),
    /** Per-template result from the subscribe prompt, keyed by template key: 'accept' | 'reject' | 'ban' | 'filter'. */
    results: z.record(z.string(), z.enum(SUBSCRIBE_RESULTS)),
  })
  .strict();

export interface SubscribeMessagesResponse {
  /** Templates with one more allowed message after this tap. */
  recorded: WechatTemplateKey[];
  /** False when the account is not linked to the 公众号 (nothing can be delivered, so nothing was recorded). */
  canDeliver: boolean;
  /**
   * Whether the person's notification settings let WeChat carry the recorded
   * templates' categories. An accepted prompt turns WeChat on, so this is
   * false only when the person turned WeChat off in Settings: then the client
   * says the reminder stays in the inbox and links to the settings.
   */
  wechatChannelOn: boolean;
}

/** GET /notify-cn/js-sdk-signature?url= — JS-SDK config for the share card and the subscribe prompt. */
export const JsSdkSignatureQuerySchema = z.object({ url: z.string().url().max(2000) });
export interface JsSdkSignatureResponse {
  appId: string;
  timestamp: number;
  nonceStr: string;
  signature: string;
  /** Template ids for the subscribe prompt (`wx-open-subscribe`); a template without an id is absent. */
  templates: Partial<Record<WechatTemplateKey, string>>;
  /** True when the account is linked to the 公众号, so an accepted prompt can lead to a message. */
  canDeliver: boolean;
}

/** GET /api/v1/webhooks/wechat-mp — server URL verification. */
export const WechatServerVerifyQuerySchema = z.object({
  signature: z.string().min(1).max(128),
  timestamp: z.string().min(1).max(20),
  nonce: z.string().min(1).max(64),
  echostr: z.string().min(1).max(256),
});
/** POST /api/v1/webhooks/wechat-mp — signature in the query, raw XML body. */
export const WechatServerMessageQuerySchema = z.object({
  signature: z.string().min(1).max(128),
  timestamp: z.string().min(1).max(20),
  nonce: z.string().min(1).max(64),
  openid: z.string().max(128).optional(),
  encrypt_type: z.string().max(20).optional(),
  msg_signature: z.string().max(128).optional(),
});

// ── Notice inputs (producers: campus WP-58, practice report, WeChat Pay) ──

const IsoDate = z.iso.datetime({ offset: true });

/** Params each template is filled from. Every value is real data from the producer (D3); a missing one means no send. */
export const NOTICE_PARAM_SCHEMAS = {
  deadline_reminder: z
    .object({ company: z.string().min(1), program: z.string().min(1), closesAt: IsoDate, days: z.number().int().min(0).optional() })
    .passthrough(),
  report_ready: z.object({ title: z.string().min(1), completedAt: IsoDate }).passthrough(),
  payment_success: z
    .object({ planName: z.string().min(1), amountFen: z.number().int().positive(), paidAt: IsoDate, orderNo: z.string().min(1) })
    .passthrough(),
} as const satisfies Record<WechatTemplateKey, z.ZodType>;

export type NoticeParams<K extends WechatTemplateKey> = z.input<(typeof NOTICE_PARAM_SCHEMAS)[K]>;

export interface WechatNoticeInput<K extends WechatTemplateKey = WechatTemplateKey> {
  userId: string;
  template: K;
  params: NoticeParams<K>;
  /** Same-site path the message opens (e.g. `/campus/acme`). */
  href: string | null;
  /** The in-app row this notice mirrors (its `pushSentAt` is stamped on success). */
  notificationId?: string | null;
  /** Override the template's category (`CATEGORY_FOR_TEMPLATE`). */
  category?: string;
  /**
   * What the notice is about (e.g. the campus event id the 截止提醒 tap was
   * for). A grant given for this id is spent first, so a notice about one
   * event does not use the permission the person gave for another.
   */
  eventId?: string | null;
}

/** Why a notice did not go out. */
export type WechatSkipReason =
  | 'feature_disabled'
  | 'template_unset'
  | 'no_wechat_template'
  | 'missing_params'
  | 'not_linked'
  | 'preference_off'
  | 'no_subscription'
  | 'send_failed';
