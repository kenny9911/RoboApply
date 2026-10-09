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

import { z } from 'zod';

export const WECHAT_TEMPLATE_KEYS = ['deadline_reminder', 'report_ready', 'payment_success'] as const;
export type WechatTemplateKey = (typeof WECHAT_TEMPLATE_KEYS)[number];

/** POST /notify-cn/subscribe-messages — the user accepted subscribe messages at a "remind me" tap. */
export const SubscribeMessagesBodySchema = z
  .object({
    templateKeys: z.array(z.enum(WECHAT_TEMPLATE_KEYS)).min(1).max(3),
    scene: z.enum(['campus_deadline', 'practice_report', 'payment']),
    eventId: z.string().min(1).max(64).optional(),
    /** Per-template result from wx.requestSubscribeMessage: 'accept' | 'reject' | 'ban'. */
    results: z.record(z.string(), z.enum(['accept', 'reject', 'ban', 'filter'])),
  })
  .strict();

/** GET /notify-cn/js-sdk-signature?url= — JS-SDK config for the share card. */
export const JsSdkSignatureQuerySchema = z.object({ url: z.string().url().max(2000) });
export interface JsSdkSignatureResponse {
  appId: string;
  timestamp: number;
  nonceStr: string;
  signature: string;
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
