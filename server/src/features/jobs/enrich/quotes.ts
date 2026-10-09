// server/src/features/jobs/enrich/quotes.ts
//
// The quote-substring guard (CitationGuard pattern, ARCHITECTURE.md §4.5) and
// the sponsorship negation rule (TASK_PLAN.md H36, PRODUCT F-FILT-02):
//   - every sponsorship / clearance / citizenship / employer-tag claim must
//     carry a quote that is a substring of the posting, or it is dropped;
//   - `not_offered` needs BOTH the model's label and a negation keyword in the
//     quote. A quote with a negation keyword labelled `offered` contradicts
//     itself and becomes `not_stated` (an honest unknown, D3);
//   - a sponsorship quote must also name a work-authorization term, so a
//     quote about something else cannot back a sponsorship badge.
// The work-authorization vocabulary is country-aware (TW-09): H-1B, the UK
// sponsor licence, Canada's LMIA, Taiwan's work permit / Employment Gold Card,
// mainland 工作签证 / 外国人工作许可.
//
// Matching is done on a normalized form (NFKC, lower case, unified quotes and
// dashes, collapsed whitespace), so a quote that differs only in spacing or
// curly quotes still counts; anything else does not.

import { MAX_QUOTE_CHARS, type SponsorshipStatus } from './schema.js';

const CJK = /[㐀-鿿豈-﫿]/;

/** NFKC, lower case, unified quotes/dashes/ellipses, collapsed whitespace. */
export function normalizeForQuote(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shortest quote worth citing: 2 CJK characters or 8 Latin characters. */
function longEnough(normalizedQuote: string): boolean {
  return CJK.test(normalizedQuote) ? normalizedQuote.replace(/\s/g, '').length >= 2 : normalizedQuote.length >= 8;
}

/**
 * The quote, trimmed and capped at MAX_QUOTE_CHARS, when it is a substring of
 * `posting`; otherwise null. Surrounding quote marks and a trailing ellipsis
 * the model may add are stripped before the check.
 */
export function verifyQuote(quote: string | null | undefined, posting: string): string | null {
  if (!quote) return null;
  let q = quote.replace(/\s+/g, ' ').trim();
  q = q.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
  q = q.replace(/(\.\.\.|…)$/, '').trim();
  const nq = normalizeForQuote(q);
  if (!nq || !longEnough(nq)) return null;
  if (!normalizeForQuote(posting).includes(nq)) return null;
  return q.length > MAX_QUOTE_CHARS ? q.slice(0, MAX_QUOTE_CHARS).trimEnd() : q;
}

// ── Negation keywords (per language) ────────────────────────────────────

/** English negations, matched as whole words on the normalized quote. */
const EN_NEGATIONS = [
  'not',
  'no',
  'unable',
  'cannot',
  "can't",
  "won't",
  "don't",
  "doesn't",
  "isn't",
  "aren't",
  'never',
  'without',
  'unavailable',
  'ineligible',
  'nor',
];
const EN_NEGATION_RE = new RegExp(`(^|[^a-z'])(${EN_NEGATIONS.join('|')})(?=$|[^a-z'])`);

/** Chinese negations (Simplified and Traditional), matched as substrings. */
const ZH_NEGATIONS = ['不', '无', '無', '没有', '沒有', '未', '恕不', '非'];

/** True when the quote contains a negation keyword (en / zh / zh-TW). */
export function hasNegation(quote: string): boolean {
  const n = normalizeForQuote(quote);
  if (EN_NEGATION_RE.test(n)) return true;
  return ZH_NEGATIONS.some((w) => n.includes(w));
}

// ── Work-authorization vocabulary (TW-09) ───────────────────────────────

const WORK_AUTH_TERMS_LATIN = [
  'sponsor', // sponsor, sponsors, sponsorship, sponsored, sponsor licence/license
  'visa',
  'h-1b',
  'h1b',
  'h1-b',
  'green card',
  'work permit',
  'work authori', // authorization / authorisation / authorized
  'right to work',
  'lmia',
  'skilled worker',
  'gold card',
  'tn status',
  'immigration',
];
const WORK_AUTH_TERMS_CJK = ['签证', '簽證', '工作许可', '工作許可', '就业金卡', '就業金卡', '外国人', '外國人', '居留', '工签', '工簽', '担保', '擔保'];

/** True when the text names a work-authorization or visa-sponsorship concept. */
export function mentionsWorkAuthorization(text: string): boolean {
  const n = normalizeForQuote(text);
  if (WORK_AUTH_TERMS_CJK.some((t) => n.includes(t))) return true;
  return WORK_AUTH_TERMS_LATIN.some((t) => n.includes(t));
}

// ── Sponsorship reconciliation ──────────────────────────────────────────

export interface SponsorshipResult {
  status: SponsorshipStatus;
  /** Verified quote; null unless status is offered / not_offered. */
  quote: string | null;
  /** Why the model's label was changed, for logs and tests. */
  corrected: null | 'quote_not_in_posting' | 'no_work_auth_term' | 'no_negation_keyword' | 'negation_in_offered_quote';
}

/**
 * Apply the quote guard and the negation rule to the model's sponsorship label.
 *   offered      → needs a verified quote that names work authorization and
 *                  has no negation keyword;
 *   not_offered  → needs a verified quote that names work authorization AND a
 *                  negation keyword (both the label and the keyword, H36);
 *   anything else → not_stated.
 */
export function reconcileSponsorship(label: SponsorshipStatus, rawQuote: string | null, posting: string): SponsorshipResult {
  if (label === 'not_stated') return { status: 'not_stated', quote: null, corrected: null };
  const quote = verifyQuote(rawQuote, posting);
  if (!quote) return { status: 'not_stated', quote: null, corrected: 'quote_not_in_posting' };
  if (!mentionsWorkAuthorization(quote)) return { status: 'not_stated', quote: null, corrected: 'no_work_auth_term' };
  const negated = hasNegation(quote);
  if (label === 'not_offered') {
    return negated ? { status: 'not_offered', quote, corrected: null } : { status: 'not_stated', quote: null, corrected: 'no_negation_keyword' };
  }
  return negated ? { status: 'not_stated', quote: null, corrected: 'negation_in_offered_quote' } : { status: 'offered', quote, corrected: null };
}

// ── Citizenship / clearance requirements ────────────────────────────────

export type RequirementField = 'citizenship' | 'clearance';

/**
 * The topic cue a requirement quote must contain. Work authorization alone is
 * not citizenship ("must be authorized to work in the US" says nothing about
 * citizenship), so it does not count.
 */
export const REQUIREMENT_TOPIC_CUES: Record<RequirementField, RegExp> = {
  citizenship: /citizen|公民|国籍|國籍/,
  clearance: /clearance|(?:^|[^a-z])secret(?:$|[^a-z])|ts\/sci|polygraph|政审|政審/,
};

/**
 * Wording that says the requirement does NOT apply ("US citizenship is not
 * required", "no clearance needed", "无需政审"). A quote with it cannot back
 * a `true` value.
 */
const NOT_REQUIRED_RE =
  /\b(?:not|never)\s+(?:be\s+)?(?:required|necessary|needed|a requirement|mandatory)\b|\b(?:does|do|will)\s+not\s+(?:need|require)\b|\b(?:doesn't|don't|won't)\s+(?:need|require)\b|\bno\s+(?:[a-z.]+\s+){0,3}(?:required|needed|necessary)\b|\bregardless of\s+(?:citizenship|nationality)\b|不需要|不需|无需|無需|不要求|不限|不必/;

/** True when the quote is about the requirement's topic. */
export function quoteMatchesRequirementTopic(field: RequirementField, quote: string): boolean {
  return REQUIREMENT_TOPIC_CUES[field].test(normalizeForQuote(quote));
}

/** Why a requirement claim was dropped (logs and tests). */
export type RequirementDrop = 'quote_not_in_posting' | 'off_topic' | 'no_negation_keyword' | 'negated_required_quote';

/**
 * A yes/no requirement (citizenship, clearance) with its quote. Kept only
 * when the quote
 *   - is a substring of the posting,
 *   - names the field's topic (REQUIREMENT_TOPIC_CUES), and
 *   - agrees with the value: `false` needs a negation keyword (mirroring the
 *     sponsorship `not_offered` rule); `true` must not say "not required".
 * Otherwise the signal is unknown (null) — never inferred from absence
 * (ruling C18).
 */
export function reconcileRequirement(
  field: RequirementField,
  signal: { value: boolean | null; quote: string | null } | null,
  posting: string,
): { value: boolean; quote: string } | { value: null; dropped: RequirementDrop } | null {
  if (!signal || signal.value === null) return null;
  const quote = verifyQuote(signal.quote, posting);
  if (!quote) return { value: null, dropped: 'quote_not_in_posting' };
  if (!quoteMatchesRequirementTopic(field, quote)) return { value: null, dropped: 'off_topic' };
  if (signal.value === false && !hasNegation(quote)) return { value: null, dropped: 'no_negation_keyword' };
  if (signal.value === true && NOT_REQUIRED_RE.test(normalizeForQuote(quote))) return { value: null, dropped: 'negated_required_quote' };
  return { value: signal.value, quote };
}

// ── GoApply employer tags ───────────────────────────────────────────────

/** The cue each employer tag's quote must contain (Simplified and Traditional). */
export const EMPLOYER_TAG_TOPIC_CUES: Record<string, RegExp> = {
  soe: /央企|中央企业|中央企業|国企|國企|国有|國有/,
  bianzhi: /编制|編制|事业编|事業編|事业单位|事業單位/,
  hukou: /落户|落戶|户口|戶口/,
  foreign: /外企|外资|外資|外商/,
};

/** A Chinese negation right before the cue ("无编制", "不提供落户", "非国企"). */
const CUE_NEGATION = /(?:不|无|無|没有|沒有|未|非)[^，。；,;.]{0,4}$/;

/**
 * True when `quote` names the tag's topic in a positive way: the cue is there
 * and is not preceded by a negation ("不解决户口" does not back `hukou`).
 */
export function quoteSupportsEmployerTag(tag: string, quote: string): boolean {
  const cue = EMPLOYER_TAG_TOPIC_CUES[tag];
  if (!cue) return false;
  const n = normalizeForQuote(quote);
  const global = new RegExp(cue.source, 'g');
  for (const m of n.matchAll(global)) {
    if (!CUE_NEGATION.test(n.slice(Math.max(0, m.index - 8), m.index))) return true;
  }
  return false;
}

/** The verified quote for an employer tag, or null (not in the posting, off topic or negated). */
export function verifyEmployerTagQuote(tag: string, quote: string | null | undefined, posting: string): string | null {
  const verified = verifyQuote(quote, posting);
  return verified && quoteSupportsEmployerTag(tag, verified) ? verified : null;
}
