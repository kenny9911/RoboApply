// server/src/features/notify-cn/config.ts — WeChat 公众号 (service account) settings (WP-73).
//
//   WECHAT_MP_APP_ID / WECHAT_MP_APP_SECRET   the 公众号 (also used by WP-11's in-WeChat sign-in)
//   WECHAT_MP_TOKEN                           server-message signature token
//   WECHAT_MP_ENCODING_AES_KEY                43 chars; needed only in 安全模式 (encrypted messages)
//   WECHAT_MP_TEMPLATE_DEADLINE               网申截止提醒 subscribe-message template
//   WECHAT_MP_TEMPLATE_REPORT                 练习报告已生成 template
//   WECHAT_MP_TEMPLATE_PAYMENT                支付成功 template
//
// A template value is the template id, optionally followed by the keyword
// mapping the template was created with in the 公众号 back end:
//   WECHAT_MP_TEMPLATE_DEADLINE="AbCd…|thing1:program,thing2:company,time3:closesAt"
// Without a mapping the defaults below apply. A template with no id never sends.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { TEMPLATE_ENV, WECHAT_TEMPLATE_KEYS, type WechatTemplateKey } from './contract.js';

export interface MpApp {
  appId: string;
  secret: string;
}

/** The 公众号 credentials, or null when either is missing. */
export function mpApp(env: EnvSource = process.env): MpApp | null {
  const appId = (env.WECHAT_MP_APP_ID || '').trim();
  const secret = (env.WECHAT_MP_APP_SECRET || '').trim();
  return appId && secret ? { appId, secret } : null;
}

/** The server-message token, or null. */
export function mpToken(env: EnvSource = process.env): string | null {
  return (env.WECHAT_MP_TOKEN || '').trim() || null;
}

/** The 43-character EncodingAESKey, or null (plain-text mode only). */
export function mpAesKey(env: EnvSource = process.env): string | null {
  const v = (env.WECHAT_MP_ENCODING_AES_KEY || '').trim();
  return v.length === 43 ? v : null;
}

/** Values a template keyword can be filled from (the producer's params). */
export const TEMPLATE_SOURCES: Readonly<Record<WechatTemplateKey, readonly string[]>> = {
  deadline_reminder: ['program', 'company', 'closesAt', 'days'],
  report_ready: ['title', 'completedAt'],
  payment_success: ['planName', 'amount', 'paidAt', 'orderNo'],
};

/** Keyword → source used when the env value carries no mapping. */
export const DEFAULT_TEMPLATE_FIELDS: Readonly<Record<WechatTemplateKey, Readonly<Record<string, string>>>> = {
  deadline_reminder: { thing1: 'program', thing2: 'company', time3: 'closesAt' },
  report_ready: { thing1: 'title', time2: 'completedAt' },
  payment_success: { thing1: 'planName', amount2: 'amount', time3: 'paidAt', character_string4: 'orderNo' },
};

export interface TemplateConfig {
  key: WechatTemplateKey;
  id: string;
  /** keyword (e.g. `thing1`) → source (e.g. `program`). */
  fields: Record<string, string>;
}

const TEMPLATE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const KEYWORD = /^[a-z_]+\d+$/;

/** One template's config, or null when its id is unset or malformed (it never sends). */
export function templateConfig(key: WechatTemplateKey, env: EnvSource = process.env): TemplateConfig | null {
  const raw = (env[TEMPLATE_ENV[key]] || '').trim();
  if (!raw) return null;
  const [idPart, mapPart] = raw.split('|', 2);
  const id = (idPart ?? '').trim();
  if (!TEMPLATE_ID.test(id)) return null;
  if (!mapPart || !mapPart.trim()) return { key, id, fields: { ...DEFAULT_TEMPLATE_FIELDS[key] } };
  const fields: Record<string, string> = {};
  for (const pair of mapPart.split(',')) {
    const [kw, src] = pair.split(':').map((s) => s.trim());
    // A broken mapping must not send half-filled messages: the template is treated as unset.
    if (!kw || !src || !KEYWORD.test(kw) || !TEMPLATE_SOURCES[key].includes(src)) return null;
    fields[kw] = src;
  }
  return Object.keys(fields).length ? { key, id, fields } : null;
}

/** Every configured template. */
export function configuredTemplates(env: EnvSource = process.env): TemplateConfig[] {
  return WECHAT_TEMPLATE_KEYS.map((k) => templateConfig(k, env)).filter((t): t is TemplateConfig => t !== null);
}

/** Template id → key (for WeChat's server events, which name templates by id). */
export function templateKeyForId(templateId: string, env: EnvSource = process.env): WechatTemplateKey | null {
  return configuredTemplates(env).find((t) => t.id === templateId)?.key ?? null;
}
