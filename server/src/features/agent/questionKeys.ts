// server/src/features/agent/questionKeys.ts — canonical application-question
// keys for the answer bank (WP-52; PRODUCT F-AGENT-03; ARCH §2.10).
//
// `RAAnswerBankItem.questionKey` is one of these keys, a per-currency variant
// (`salary_expectation:EUR`), or `custom:<hash>` for a question the user
// added. The extension (WP-55a) reads the bank through `agentService.answerBank`
// and matches form questions to these keys; `protectedType` names the
// extension's PROTECTED_QUESTION_TYPES entry the key answers — those are
// filled only from the bank or the profile, never by AI.
//
// GoApply keys include the optional 家庭成员 / 政治面貌 (CN plan): they are
// `sensitive`, never sent to a model (TASK_PLAN §2.2: prompts never contain
// 政治面貌 or family members), and stay optional.

import { createHash } from 'node:crypto';
import type { Market } from '../../platform/brand/registry.js';
import type { QuestionKeyView } from './contract.js';

export interface QuestionKeyDef {
  key: string;
  markets: readonly Market[];
  /** Default question text per language (stored as `questionText` when the user does not supply one). */
  text: Readonly<Record<string, string>>;
  optional: boolean;
  sensitive: boolean;
  protectedType: string | null;
  perCurrency: boolean;
}

const BOTH: readonly Market[] = ['intl', 'cn'];
const INTL: readonly Market[] = ['intl'];
const CN: readonly Market[] = ['cn'];

function q(
  key: string,
  markets: readonly Market[],
  text: Record<string, string>,
  opts: Partial<Pick<QuestionKeyDef, 'optional' | 'sensitive' | 'protectedType' | 'perCurrency'>> = {},
): QuestionKeyDef {
  return {
    key,
    markets,
    text,
    optional: opts.optional ?? true,
    sensitive: opts.sensitive ?? false,
    protectedType: opts.protectedType ?? null,
    perCurrency: opts.perCurrency ?? false,
  };
}

/** The canonical keys. Order = the order the setup step shows them. */
export const QUESTION_KEYS: readonly QuestionKeyDef[] = [
  q('why_this_company', BOTH, { en: 'Why do you want to work at this company?', zh: '你为什么想加入这家公司？' }),
  q('why_this_role', BOTH, { en: 'Why are you interested in this role?', zh: '你为什么对这个岗位感兴趣？' }),
  q('notice_period', INTL, { en: 'What is your notice period?' }, { protectedType: 'notice_period' }),
  q('start_date', BOTH, { en: 'When can you start?', zh: '最快到岗时间' }),
  q('salary_expectation', BOTH, { en: 'What are your salary expectations?', zh: '期望薪资' }, { protectedType: 'salary_expectation', perCurrency: true }),
  q('work_authorization', INTL, { en: 'Are you legally authorized to work in this country?' }, { protectedType: 'work_authorization' }),
  q('sponsorship', INTL, { en: 'Will you now or in the future require visa sponsorship?' }, { protectedType: 'sponsorship' }),
  q('relocation', BOTH, { en: 'Are you willing to relocate?', zh: '是否接受异地工作？' }),
  q('work_model_preference', INTL, { en: 'Which work arrangement do you prefer (remote, hybrid, on-site)?' }),
  q('how_did_you_hear', INTL, { en: 'How did you hear about this job?' }),
  q('additional_information', BOTH, { en: 'Is there anything else you would like us to know?', zh: '其他补充信息' }),
  // GoApply 网申 fields
  q('internship_duration', CN, { zh: '可实习时长', en: 'How long can you intern?' }),
  q('internship_days_per_week', CN, { zh: '每周可实习天数', en: 'How many days a week can you intern?' }),
  q('accept_reassignment', CN, { zh: '是否服从调剂', en: 'Will you accept a different position or location?' }),
  q('preferred_cities', CN, { zh: '期望工作城市', en: 'Preferred work cities' }),
  q('self_evaluation', CN, { zh: '自我评价', en: 'Self-evaluation' }),
  q('awards', CN, { zh: '获奖情况', en: 'Awards' }),
  q('family_members', CN, { zh: '家庭成员', en: 'Family members' }, { sensitive: true }),
  q('political_status', CN, { zh: '政治面貌', en: 'Political status' }, { sensitive: true }),
];

const BY_KEY = new Map(QUESTION_KEYS.map((d) => [d.key, d]));
const CUSTOM_RE = /^custom:[a-f0-9]{8,40}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** The canonical definition behind a stored key (`salary_expectation:EUR` → `salary_expectation`), or null. */
export function questionDefFor(key: string): QuestionKeyDef | null {
  const [base, variant, ...rest] = key.split(':');
  if (rest.length) return null;
  const def = BY_KEY.get(base ?? '');
  if (!def) return null;
  if (variant === undefined) return def;
  return def.perCurrency && CURRENCY_RE.test(variant) ? def : null;
}

/** A key the bank accepts on this market: canonical (incl. currency variants) or `custom:<hash>`. */
export function isValidQuestionKey(key: string, market: Market): boolean {
  if (CUSTOM_RE.test(key)) return true;
  const def = questionDefFor(key);
  return !!def && def.markets.includes(market);
}

/** `custom:<hash>` for a question the user wrote (stable for the same normalized text). */
export function customQuestionKey(questionText: string): string {
  const norm = questionText.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return `custom:${createHash('sha256').update(norm).digest('hex').slice(0, 16)}`;
}

/** True when an answer must never reach a model (sensitive keys). */
export function isSensitiveQuestionKey(key: string): boolean {
  return questionDefFor(key)?.sensitive ?? false;
}

/** The extension's protected question type a key answers, or null. */
export function protectedTypeFor(key: string): string | null {
  return questionDefFor(key)?.protectedType ?? null;
}

export function questionKeysFor(market: Market): QuestionKeyView[] {
  return QUESTION_KEYS.filter((d) => d.markets.includes(market)).map((d) => ({
    key: d.key,
    labelKey: `ready.questions.${d.key}`,
    text: { ...d.text },
    optional: d.optional,
    sensitive: d.sensitive,
    protectedType: d.protectedType,
    perCurrency: d.perCurrency,
  }));
}
