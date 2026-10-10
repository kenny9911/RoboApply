// components/features/agent/questions.ts — the common application questions
// the answer bank offers (PRODUCT F-AGENT-03; WP-53).
//
// The server owns the list (WP-52 `questionKeys.ts`, served by
// GET /agent/answers/questions). The editor reads it from there; this file
// is the same list, key for key, used only while that read is loading or
// unavailable, so the editor never invents a key the server would refuse.
// A test checks it against WP-52's list once that file exists here.
//
// A question the user writes is stored as `custom:<16 hex>`, the same key
// the server computes for the same text (sha256 of the normalized text). Salary expectation takes one answer
// per currency (`salary_expectation:EUR`). GoApply's 家庭成员 / 政治面貌 are
// optional and `sensitive`: never sent to a model (TASK_PLAN §2.2).

import type { QuestionKeyView } from '../../../lib/api/agent';

type Market = 'intl' | 'cn';

interface Def {
  key: string;
  markets: readonly Market[];
  text: Record<string, string>;
  sensitive?: boolean;
  protectedType?: string;
  perCurrency?: boolean;
}

const BOTH: readonly Market[] = ['intl', 'cn'];
const INTL: readonly Market[] = ['intl'];
const CN: readonly Market[] = ['cn'];

/** Mirror of WP-52's QUESTION_KEYS (same order: the order the step shows them). */
const DEFS: readonly Def[] = [
  { key: 'why_this_company', markets: BOTH, text: { en: 'Why do you want to work at this company?', zh: '你为什么想加入这家公司？' } },
  { key: 'why_this_role', markets: BOTH, text: { en: 'Why are you interested in this role?', zh: '你为什么对这个岗位感兴趣？' } },
  { key: 'notice_period', markets: INTL, text: { en: 'What is your notice period?' }, protectedType: 'notice_period' },
  { key: 'start_date', markets: BOTH, text: { en: 'When can you start?', zh: '最快到岗时间' } },
  { key: 'salary_expectation', markets: BOTH, text: { en: 'What are your salary expectations?', zh: '期望薪资' }, protectedType: 'salary_expectation', perCurrency: true },
  { key: 'work_authorization', markets: INTL, text: { en: 'Are you legally authorized to work in this country?' }, protectedType: 'work_authorization' },
  { key: 'sponsorship', markets: INTL, text: { en: 'Will you now or in the future require visa sponsorship?' }, protectedType: 'sponsorship' },
  { key: 'relocation', markets: BOTH, text: { en: 'Are you willing to relocate?', zh: '是否接受异地工作？' } },
  { key: 'work_model_preference', markets: INTL, text: { en: 'Which work arrangement do you prefer (remote, hybrid, on-site)?' } },
  { key: 'how_did_you_hear', markets: INTL, text: { en: 'How did you hear about this job?' } },
  { key: 'additional_information', markets: BOTH, text: { en: 'Is there anything else you would like us to know?', zh: '其他补充信息' } },
  { key: 'internship_duration', markets: CN, text: { zh: '可实习时长', en: 'How long can you intern?' } },
  { key: 'internship_days_per_week', markets: CN, text: { zh: '每周可实习天数', en: 'How many days a week can you intern?' } },
  { key: 'accept_reassignment', markets: CN, text: { zh: '是否服从调剂', en: 'Will you accept a different position or location?' } },
  { key: 'preferred_cities', markets: CN, text: { zh: '期望工作城市', en: 'Preferred work cities' } },
  { key: 'self_evaluation', markets: CN, text: { zh: '自我评价', en: 'Self-evaluation' } },
  { key: 'awards', markets: CN, text: { zh: '获奖情况', en: 'Awards' } },
  { key: 'family_members', markets: CN, text: { zh: '家庭成员', en: 'Family members' }, sensitive: true },
  { key: 'political_status', markets: CN, text: { zh: '政治面貌', en: 'Political status' }, sensitive: true },
];

/** The fallback list for a market, in the server's shape. Pure. */
export function questionsFor(market: Market): QuestionKeyView[] {
  return DEFS.filter((d) => d.markets.includes(market)).map((d) => ({
    key: d.key,
    labelKey: `ready.questions.${d.key}`,
    text: { ...d.text },
    optional: true,
    sensitive: d.sensitive ?? false,
    protectedType: d.protectedType ?? null,
    perCurrency: d.perCurrency ?? false,
  }));
}

/** Questions that take a long answer (a textarea). */
export const MULTILINE_KEYS: ReadonlySet<string> = new Set([
  'why_this_company',
  'why_this_role',
  'additional_information',
  'self_evaluation',
  'awards',
  'family_members',
]);

/** Questions with a hint line under `ready.answers.hints.<key>`. */
export const HINT_KEYS: ReadonlySet<string> = new Set(['why_this_company', 'salary_expectation', 'work_authorization']);

/** Currencies offered for per-currency answers (choices only, never a value). */
export const ANSWER_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'HKD', 'TWD', 'CNY', 'JPY', 'INR'] as const;

export const CUSTOM_PREFIX = 'custom:';
const CUSTOM_RE = /^custom:[a-f0-9]{8,40}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

// SHA-256 (FIPS 180-4) over UTF-8, so a question saved here gets the same key
// as one saved by the server or the extension (WP-52 `customQuestionKey`:
// sha256 of the normalized text, first 16 hex). Synchronous, no dependency.
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Hex SHA-256 of a string's UTF-8 bytes. Pure. */
export function sha256Hex(text: string): string {
  const msg = new TextEncoder().encode(text);
  const bitLen = msg.length * 8;
  const total = Math.ceil((msg.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(total - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

/**
 * Stable key for a question the user wrote — exactly WP-52's
 * `customQuestionKey`: NFKC, lower case, whitespace collapsed, trimmed, then
 * `custom:` + the first 16 hex digits of its SHA-256. Pure.
 */
export function customQuestionKey(text: string): string {
  const norm = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${CUSTOM_PREFIX}${sha256Hex(norm).slice(0, 16)}`;
}

export function isCustomKey(key: string): boolean {
  return CUSTOM_RE.test(key);
}

/** `salary_expectation:EUR` → { base: 'salary_expectation', currency: 'EUR' }; null for any other shape. */
export function currencyVariant(key: string): { base: string; currency: string } | null {
  const parts = key.split(':');
  if (parts.length !== 2) return null;
  const [base, currency] = parts as [string, string];
  return base && CURRENCY_RE.test(currency) ? { base, currency } : null;
}

/** The key of one currency's answer. */
export function currencyKey(base: string, currency: string): string {
  return `${base}:${currency}`;
}
