// server/src/features/jobs/enrich/scamSignals.ts
//
// Rule-based, quote-backed scam signals for international jobs (PRODUCT
// F-TRUST-04, ARCHITECTURE.md §4.5, ruling C14). Three rules:
//   - intl_fee_required      the applicant must pay a fee or deposit, or buy
//                            equipment "to be reimbursed" (the fake-cheque pattern);
//   - intl_pay_to_apply      paying is the price of applying or being considered;
//   - intl_messaging_app_only the only contact route is a messaging app
//                            (Telegram, WhatsApp, Signal …), with no email or web link.
// Each flag carries the sentence it rests on, verbatim from the posting. A
// sentence that negates the fee ("we never charge a fee", "there is no
// application fee") or puts it on the employer ("paid by the company", "we
// reimburse certification fees") does not flag, and a messaging-app mention
// about the product (an API, a bot, an integration) is not a contact route.
// No LLM; deterministic and cheap.
//
// The flags land in `RAJob.fraudFlags` (`[{ rule, evidence, at }]`). WP-32
// keeps flagged jobs out of Recommended; WP-74 lists them under "Reports to
// review". GoApply's classifier (招转培, 培训贷, MLM) is WP-41's afterEnrich hook
// and writes its own rules into the same column; `mergeFraudFlags` keeps them.

import { MAX_QUOTE_CHARS } from './schema.js';

export const INTL_SCAM_RULES = ['intl_fee_required', 'intl_pay_to_apply', 'intl_messaging_app_only'] as const;
export type IntlScamRule = (typeof INTL_SCAM_RULES)[number];

export interface ScamSignal {
  rule: IntlScamRule;
  /** The posting sentence the flag rests on (verbatim, ≤ MAX_QUOTE_CHARS). */
  quote: string;
}

/** `RAJob.fraudFlags` entry (contract: server/src/features/jobs/companies/contract.ts). */
export interface FraudFlag {
  rule: string;
  evidence: string;
  at: string;
}

// ── Sentences ───────────────────────────────────────────────────────────

interface Sentence {
  text: string;
  lower: string;
}

/** Split into sentences, keeping each one verbatim (trimmed). */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const raw of text.split(/(?<=[.!?。！？;；])\s+|\n+|(?<=[。！？；])/)) {
    const t = raw.trim();
    if (t) out.push({ text: t, lower: t.normalize('NFKC').toLowerCase() });
  }
  return out;
}

/** A quote of at most MAX_QUOTE_CHARS: the sentence, or a window around the match. */
function quoteFor(sentence: Sentence, matchIndex: number): string {
  const s = sentence.text;
  if (s.length <= MAX_QUOTE_CHARS) return s;
  const start = Math.max(0, Math.min(matchIndex - 80, s.length - MAX_QUOTE_CHARS));
  return s.slice(start, start + MAX_QUOTE_CHARS).trim();
}

/** How far before a fee match a negation still counts ("we will never ask you to pay …"). */
const NEGATION_WINDOW = 25;

/**
 * Negation words that turn a fee mention into a reassurance ("we never charge
 * a fee", "there is no application fee"). Checked in a short window ending at
 * the match, because a later "not" usually belongs to another clause.
 */
const FEE_NEGATION =
  /\b(no|never|not|without|free of charge|at no cost|won't|don't|doesn't|will not|do not|does not|nor|waived?)\b/;

const COST = '(?:fees?|costs?|charges?|deposits?|expenses?)';

/**
 * Wording that puts the cost on the employer ("visa processing fees will be
 * paid by the company", "we reimburse certification fees", "background check
 * fees are the responsibility of the company"). Checked against the WHOLE
 * sentence, since the employer usually comes after the fee. Generic "we pay"
 * only counts when a cost word follows it, so "We pay weekly; a starter kit
 * fee is required" still flags.
 */
const EMPLOYER_PAYS: RegExp[] = [
  new RegExp(`\\b(?:we|the company|our company|the employer|employer)\\b(?:\\s+(?:will|shall|also|fully|gladly|happily))*\\s+(?:pay|pays|cover|covers|reimburse|reimburses|refund|refunds)\\b[^.;]{0,50}\\b${COST}\\b`),
  new RegExp(`\\breimburse(?:s|ment(?:\\s+(?:of|for))?)?\\b[^.;]{0,50}\\b${COST}\\b`),
  /\b(?:paid|covered|reimbursed|funded|borne|handled)\s+(?:in full\s+|entirely\s+|fully\s+)?by\s+(?:us|the company|our company|the employer|your employer|the hiring company)\b/,
  /\b(?:company|employer)[- ](?:paid|funded|sponsored|covered)\b/,
  /\bresponsibility of (?:the|our) (?:company|employer)\b/,
  /\bat (?:our|the company's|the employer's) (?:expense|cost)\b/,
  new RegExp(`\\b${COST}\\b[^.;]{0,40}\\b(?:is|are|will be|get|gets)\\s+(?:fully\\s+|also\\s+|all\\s+)?(?:covered|waived)\\b`),
];

// ── Rules ───────────────────────────────────────────────────────────────

/** "Buy equipment … and be reimbursed": the fake-cheque scam. Employer-pays wording does not clear it. */
const BUY_TO_BE_REIMBURSED = /\b(purchase|buy)\b[^.]{0,50}\b(equipment|starter kit|software|laptop|supplies)\b[^.]{0,80}\breimburs/;

const FEE_PATTERNS: RegExp[] = [
  /\b(training|registration|processing|onboarding|enrol?lment|placement|background[- ]check|certification|starter[- ]kit|equipment|admin(?:istrative)?|security)\s+(fee|fees|deposit|charge)\b/,
  // "direct deposit" is how wages are paid, not a charge to the applicant.
  /\b(pay|paying|deposit|send|wire|transfer)\b[^.]{0,40}\b(fee|fees|(?<!direct )deposit|upfront)\b/,
  /\bupfront (payment|fee|cost|deposit)\b/,
  BUY_TO_BE_REIMBURSED,
  /\b(refundable|security) deposit\b/,
];

const PAY_TO_APPLY_PATTERNS: RegExp[] = [
  /\bapplication fee\b/,
  /\bpay\b[^.]{0,30}\bto (apply|be considered|get (the|this) (job|position|role)|secure (your|a|the) (spot|place|position|interview)|schedule (an|your) interview)\b/,
  /\b(fee|payment) (is )?required to (apply|be considered|interview)\b/,
];

/** Messaging apps used as a scam's only contact route. Video tools (Hangouts, Zoom, Teams) are ordinary interview tools and are not listed. */
const MESSAGING_APPS = 'telegram|whatsapp|whats app|signal app|viber|wickr|kik';
const MESSAGING_CONTACT_PATTERNS: RegExp[] = [
  new RegExp(
    `\\b(contact|text|message|reach|add|dm|chat|apply|send|interview(?:ed|s)?|connect|write)\\b[^.]{0,60}\\b(on|via|through|using|over|at|with)\\s+(${MESSAGING_APPS})\\b`,
  ),
  // The app, then an applicant-contact intent ("WhatsApp our recruiter", "Telegram for an interview").
  new RegExp(
    `\\b(${MESSAGING_APPS})\\b[^.]{0,30}\\b(interview|recruiter|hiring manager|hr|to apply|for (an|the|your) interview|to (contact|reach|message|text) (us|me|our|the))\\b`,
  ),
  new RegExp(`\\b(only|exclusively|solely)\\b[^.]{0,20}\\b(on|via|through)\\s+(${MESSAGING_APPS}|signal)\\b`),
  /\b(t\.me|wa\.me)\/\S+/,
];

/** Product / engineering wording near the app name: the job is about the app, not a contact route. */
const MESSAGING_PRODUCT_CONTEXT = /\b(api|apis|business api|integrations?|integrate|integrating|bots?|chatbots?|platforms?|sdk|webhooks?|developer|messaging channels?)\b/;
const MESSAGING_PRODUCT_WINDOW = 30;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const WEB_LINK_RE = /\bhttps?:\/\/(?!(?:t\.me|wa\.me|api\.whatsapp\.com|telegram\.me)\b)\S+/i;

type SkipMatch = (lower: string, match: RegExpExecArray, re: RegExp) => boolean;

/** A fee mention that is negated nearby, or paid for by the employer anywhere in the sentence. */
const isFeeReassurance: SkipMatch = (lower, m, re) => {
  if (FEE_NEGATION.test(lower.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index + m[0].length))) return true;
  if (re === BUY_TO_BE_REIMBURSED) return false;
  return EMPLOYER_PAYS.some((p) => p.test(lower));
};

/** A messaging-app mention that is about building on the app (API, bot, integration), not contacting the recruiter. */
const isMessagingProductMention: SkipMatch = (lower, m) =>
  MESSAGING_PRODUCT_CONTEXT.test(lower.slice(Math.max(0, m.index - MESSAGING_PRODUCT_WINDOW), m.index + m[0].length + MESSAGING_PRODUCT_WINDOW));

function firstMatch(sentences: Sentence[], patterns: RegExp[], skip: SkipMatch): ScamSignal['quote'] | null {
  for (const sentence of sentences) {
    for (const re of patterns) {
      const m = re.exec(sentence.lower);
      if (!m) continue;
      if (skip(sentence.lower, m, re)) continue;
      return quoteFor(sentence, m.index);
    }
  }
  return null;
}

/**
 * Detect the intl scam signals in a posting. `market` other than 'intl'
 * returns [] (GoApply has its own classifier, WP-41). The job's apply URL
 * does not clear the messaging-app rule: the rule reads what the posting
 * tells applicants to do.
 */
export function detectScamSignals(postingText: string, market: string = 'intl'): ScamSignal[] {
  if (market !== 'intl' || !postingText.trim()) return [];
  const sentences = splitSentences(postingText);
  const out: ScamSignal[] = [];

  const payToApply = firstMatch(sentences, PAY_TO_APPLY_PATTERNS, isFeeReassurance);
  if (payToApply) out.push({ rule: 'intl_pay_to_apply', quote: payToApply });

  const fee = firstMatch(sentences, FEE_PATTERNS, isFeeReassurance);
  if (fee && fee !== payToApply) out.push({ rule: 'intl_fee_required', quote: fee });

  const messaging = firstMatch(sentences, MESSAGING_CONTACT_PATTERNS, isMessagingProductMention);
  if (messaging) {
    const explicitOnly = /\b(only|exclusively|solely)\b/.test(messaging.toLowerCase());
    const otherChannel = EMAIL_RE.test(postingText) || WEB_LINK_RE.test(postingText);
    if (explicitOnly || !otherChannel) out.push({ rule: 'intl_messaging_app_only', quote: messaging });
  }
  return out;
}

/** The scam signals as `RAJob.fraudFlags` entries. */
export function toFraudFlags(signals: readonly ScamSignal[], at: Date): FraudFlag[] {
  return signals.map((s) => ({ rule: s.rule, evidence: s.quote, at: at.toISOString() }));
}

function isFraudFlag(v: unknown): v is FraudFlag {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as FraudFlag).rule === 'string' &&
    typeof (v as FraudFlag).evidence === 'string' &&
    typeof (v as FraudFlag).at === 'string'
  );
}

/**
 * Replace this module's intl rules in `existing` with `next`, keeping every
 * other rule (e.g. WP-41's CN classifier, an admin's report). A flag whose
 * rule and evidence are unchanged keeps its original `at`. Returns null when
 * the result is empty (the column stays NULL).
 */
export function mergeFraudFlags(existing: unknown, next: readonly FraudFlag[]): FraudFlag[] | null {
  const prior = Array.isArray(existing) ? existing.filter(isFraudFlag) : [];
  const ours = new Set<string>(INTL_SCAM_RULES);
  const kept = prior.filter((f) => !ours.has(f.rule));
  const merged = next.map((f) => prior.find((p) => p.rule === f.rule && p.evidence === f.evidence) ?? f);
  const all = [...kept, ...merged];
  return all.length ? all : null;
}
