// server/src/features/notify-cn/format.ts — fill a subscribe-message template from a producer's params (WP-73).
//
// WeChat checks each keyword by its type prefix (`thing1`, `time2`, …) and
// refuses a message whose value breaks the type's rule, so values are shaped
// here: `thing` ≤ 20 characters, `name` ≤ 10, `phrase` ≤ 5, `character_string`
// ≤ 32 of [A-Za-z0-9_-.], `number` digits, `time`/`date` in Beijing time,
// `amount` in 元 with two decimals. Every value comes from the producer (D3):
// a keyword whose source is missing or does not fit makes the whole message
// unsendable (null), never a guessed or placeholder value.

import type { TemplateConfig } from './config.js';
import { NOTICE_PARAM_SCHEMAS, type WechatTemplateKey } from './contract.js';

export const BEIJING_TZ = 'Asia/Shanghai';

type SourceValue = { kind: 'text'; value: string } | { kind: 'time'; value: Date } | { kind: 'fen'; value: number } | { kind: 'int'; value: number };

/** The template's source values from validated params, or null when the params do not validate. */
export function sourceValues(key: WechatTemplateKey, params: unknown): Record<string, SourceValue> | null {
  const parsed = NOTICE_PARAM_SCHEMAS[key].safeParse(params);
  if (!parsed.success) return null;
  const p = parsed.data as Record<string, unknown>;
  const text = (v: unknown): SourceValue => ({ kind: 'text', value: String(v).trim() });
  const time = (v: unknown): SourceValue => ({ kind: 'time', value: new Date(String(v)) });
  switch (key) {
    case 'deadline_reminder':
      return {
        program: text(p.program),
        company: text(p.company),
        closesAt: time(p.closesAt),
        ...(typeof p.days === 'number' ? { days: { kind: 'int', value: p.days } as SourceValue } : {}),
      };
    case 'report_ready':
      return { title: text(p.title), completedAt: time(p.completedAt) };
    case 'payment_success':
      return { planName: text(p.planName), amount: { kind: 'fen', value: Number(p.amountFen) }, paidAt: time(p.paidAt), orderNo: text(p.orderNo) };
  }
}

function clip(s: string, max: number): string {
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max - 1).join('')}…`;
}

function beijingParts(d: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BEIJING_TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** "2026年10月31日 23:59" (Beijing time). */
export function wechatTime(d: Date): string {
  const p = beijingParts(d);
  return `${p.year}年${p.month}月${p.day}日 ${p.hour}:${p.minute}`;
}

/** "2026年10月31日" (Beijing time). */
export function wechatDate(d: Date): string {
  const p = beijingParts(d);
  return `${p.year}年${p.month}月${p.day}日`;
}

/** One keyword's value, or null when the source cannot honestly fill it. */
export function formatKeyword(keyword: string, src: SourceValue | undefined): string | null {
  if (!src) return null;
  const type = keyword.replace(/\d+$/, '');
  if (src.kind === 'time' && Number.isNaN(src.value.getTime())) return null;
  switch (type) {
    case 'time':
      return src.kind === 'time' ? wechatTime(src.value) : null;
    case 'date':
      return src.kind === 'time' ? wechatDate(src.value) : null;
    case 'amount':
      return src.kind === 'fen' && src.value > 0 ? `${(src.value / 100).toFixed(2)}元` : null;
    case 'number':
      return src.kind === 'int' || src.kind === 'fen' ? String(Math.trunc(src.value)).slice(0, 32) : null;
    case 'character_string': {
      if (src.kind !== 'text') return null;
      const v = src.value.replace(/[^A-Za-z0-9_.-]/g, '');
      return v && v.length <= 32 ? v : null;
    }
    case 'phrase':
      return src.kind === 'text' && [...src.value].length <= 5 && src.value ? src.value : null;
    case 'name':
      return src.kind === 'text' && src.value ? clip(src.value, 10) : null;
    case 'thing':
    default:
      if (src.kind === 'text') return src.value ? clip(src.value, 20) : null;
      if (src.kind === 'time') return wechatTime(src.value);
      return null;
  }
}

/** The bizsend `data` for a template, or null when any mapped keyword cannot be filled. */
export function templateData(cfg: TemplateConfig, params: unknown): Record<string, { value: string }> | null {
  const sources = sourceValues(cfg.key, params);
  if (!sources) return null;
  const data: Record<string, { value: string }> = {};
  for (const [keyword, source] of Object.entries(cfg.fields)) {
    const value = formatKeyword(keyword, sources[source]);
    if (value === null) return null;
    data[keyword] = { value };
  }
  return data;
}
