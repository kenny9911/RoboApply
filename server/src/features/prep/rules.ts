// server/src/features/prep/rules.ts — pure rules of the question bank (WP-59).
//
//   assertAttribution     D3 service check: ONLY sourceKind='user_report' may
//                         carry companyId / companyNameNormalized (ARCH §2.12).
//   screenContribution    wording screen staff see next to a contribution:
//                         possible test content under NDA, copyright, personal
//                         information, not a question. It never decides; staff do.
//   claimsCompanyAsked    drops AI-written questions that present themselves as
//                         asked by / reported at a company (AI questions are
//                         never attributed to a company).
//   isValidPeriod         'YYYY-MM' not in the future and not before 2000.
//   guessQuestionLocale   the language a shared question is written in (staff
//                         can change it before publishing).

import { HttpError } from '../../platform/http.js';
import { redactPii, type PiiKind } from '../../platform/pii/index.js';
import {
  PREP_ERROR_CODES,
  QUESTION_CATEGORIES,
  QUESTION_DIFFICULTIES,
  QUESTION_SOURCE_KINDS,
  type QuestionCategory,
  type QuestionDifficulty,
  type QuestionLocale,
  type QuestionSourceKind,
  type ScreenFlag,
} from './contract.js';

export interface AttributionFields {
  sourceKind: string;
  companyId?: string | null;
  companyNameNormalized?: string | null;
}

/** Throws 422 when a question that is not a user report names a company, or the kind is unknown. */
export function assertAttribution(q: AttributionFields): void {
  if (!(QUESTION_SOURCE_KINDS as readonly string[]).includes(q.sourceKind)) {
    throw new HttpError('invalid_request', 'Unknown question source.', { reason: 'unknown_source_kind' });
  }
  const namesCompany = Boolean(q.companyId) || Boolean(q.companyNameNormalized);
  if (namesCompany && q.sourceKind !== 'user_report') {
    throw new HttpError('invalid_request', 'Only questions shared by users may name a company.', {
      reason: PREP_ERROR_CODES.companyOnNonReport,
      sourceKind: q.sourceKind,
    });
  }
}

export function isSourceKind(v: unknown): v is QuestionSourceKind {
  return typeof v === 'string' && (QUESTION_SOURCE_KINDS as readonly string[]).includes(v);
}

export function asCategory(v: unknown, fallback: QuestionCategory = 'behavioral'): QuestionCategory {
  return typeof v === 'string' && (QUESTION_CATEGORIES as readonly string[]).includes(v) ? (v as QuestionCategory) : fallback;
}

export function asDifficulty(v: unknown): QuestionDifficulty | null {
  return typeof v === 'string' && (QUESTION_DIFFICULTIES as readonly string[]).includes(v) ? (v as QuestionDifficulty) : null;
}

// ── Contribution screen ──────────────────────────────────────────────────

/** Wording that suggests an online assessment / take-home / test item, or an NDA. */
const NDA_OR_TEST = [
  /\bnda\b/i,
  /non[- ]disclosure/i,
  /\bconfidential\b/i,
  /\bonline assessment\b/i,
  /\b(?:oa|take[- ]home)\b/i,
  /\b(?:hackerrank|codility|codesignal|hirevue|testgorilla|leetcode premium)\b/i,
  /\b(?:assessment|test) (?:question|item|problem)s?\b/i,
  /\bcopied (?:from|out of) the (?:test|assessment|exam)\b/i,
  /保密(?:协议|協議)?/,
  /笔试(?:题|原题)?|筆試(?:題|原題)?/,
  /测评(?:题|原题)?|測評(?:題|原題)?/,
  /原题|原題|真题|真題/,
];

/** Wording that suggests copied, copyrighted material. */
const COPYRIGHT = [/©|\(c\)\s*\d{4}/i, /\ball rights reserved\b/i, /\bcopyright\b/i, /版权所有|版權所有|版权|版權/];

/** Contact details and ID numbers (not topics like health, which questions may legitimately mention). */
const SCREEN_PII_KINDS: readonly PiiKind[] = ['email', 'phone', 'prc_id', 'tw_id', 'us_ssn', 'gov_id'];

/** A question reads like one: a question mark, or an imperative prompt. */
const QUESTION_SHAPE =
  /[?？]|^\s*(?:tell|describe|explain|walk|design|implement|write|how|what|why|when|which|who|give|share|talk|请|請|说说|說說|介绍|介紹|谈谈|談談|如何|为什么|為什麼|怎么|怎麼)/im;

export function screenContribution(text: string, extra: { company?: string; role?: string } = {}): ScreenFlag[] {
  const flags = new Set<ScreenFlag>();
  const all = [text, extra.company ?? '', extra.role ?? ''].join('\n');
  if (NDA_OR_TEST.some((r) => r.test(all))) flags.add('nda_or_test_content');
  if (COPYRIGHT.some((r) => r.test(all))) flags.add('copyright');
  if (redactPii(text, { kinds: SCREEN_PII_KINDS }).total > 0) flags.add('personal_info');
  if (!QUESTION_SHAPE.test(text)) flags.add('not_a_question');
  // Long verbatim blocks (e.g. a pasted test with sample cases) read as copied content.
  if (text.length > 1200 || text.split('\n').length > 25) flags.add('too_long');
  return [...flags];
}

// ── AI output ────────────────────────────────────────────────────────────

const ASKED_CLAIMS = [
  /\b(?:was|were|is|are|been|get|gets|got) (?:commonly |often |frequently |usually )?asked (?:at|by|in)\b/i,
  /\b(?:candidates|interviewees|people) (?:report|reported|say|said|were asked)\b/i,
  /\breal interview question\b/i,
  /\b(?:asked|reported) in (?:real|actual|past) interviews\b/i,
  /面试(?:官)?(?:常问|常考|真题)|面試(?:官)?(?:常問|常考|真題)/,
  /(?:候选人|候選人)(?:反馈|反饋|分享|透露)/,
];

/** True when an AI-written question claims it was asked at or reported by people at a company. */
export function claimsCompanyAsked(text: string, companyName?: string | null): boolean {
  if (ASKED_CLAIMS.some((r) => r.test(text))) return true;
  const name = companyName?.trim();
  if (!name || name.length < 2) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*(?:asks|asked|will ask|likes to ask|常问|常問|会问|會問)`, 'i').test(text);
}

// ── Periods ──────────────────────────────────────────────────────────────

export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The furthest-ahead time zone (UTC+14): its month is the latest month anyone can be in. */
const LATEST_ZONE_OFFSET_MS = 14 * 60 * 60 * 1000;

/**
 * 'YYYY-MM', not before 2000 and not in the future for anyone: the month is
 * compared with the current month at UTC+14, so a user east of UTC can pick
 * their local month in the first hours of it (the form defaults to it).
 */
export function isValidPeriod(period: string, now: Date = new Date()): boolean {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) return false;
  const year = Number(m[1]);
  if (year < 2000) return false;
  return period <= currentPeriod(new Date(now.getTime() + LATEST_ZONE_OFFSET_MS));
}

/** First line (or sentence) of a question as its title. */
export function titleFrom(text: string, max = 160): string {
  const firstLine = text.trim().split(/\n+/)[0] ?? '';
  const cut = firstLine.length > max ? `${firstLine.slice(0, max - 1).trimEnd()}…` : firstLine;
  return cut || text.trim().slice(0, max);
}

const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/;
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/;
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * The language a shared question is written in, from its script: GoApply is
 * always zh; on RoboApply kana → ja (Japanese also uses kanji, so kana is
 * checked first), Hangul → ko, other Han text → zh-TW, anything else → en.
 * A best guess only: staff confirm it on the approval form.
 */
export function guessQuestionLocale(text: string, market: 'intl' | 'cn'): QuestionLocale {
  if (market === 'cn') return 'zh';
  if (KANA.test(text)) return 'ja';
  if (HANGUL.test(text)) return 'ko';
  if (HAN.test(text)) return 'zh-TW';
  return 'en';
}
