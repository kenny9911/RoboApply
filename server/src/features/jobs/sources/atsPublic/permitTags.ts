// server/src/features/jobs/sources/atsPublic/permitTags.ts — Taiwan work-
// authorization tags (TW-09; CN_TW_LAUNCH_PLAN.md §4.2 WP-TW-JOBS, §8).
//
// Deterministic and quote-backed: a tag exists only when a sentence of the
// posting says so, and that sentence (verbatim, ≤ 240 characters) is stored
// as its evidence. Nothing is inferred from silence, and a negated sentence
// ("不提供工作簽證", "we are unable to sponsor work permits") never tags.
//
//   tw_work_permit_support  the employer says it helps with / sponsors the work
//                           permit or work visa (可協助申請工作許可)
//   tw_gold_card            the posting mentions the Employment Gold Card
//                           (就業金卡), without rejecting it

import type { TwPermitTag } from './contract.js';

export const MAX_QUOTE_CHARS = 240;

export interface PermitTagEvidence {
  tag: TwPermitTag;
  evidenceQuote: string;
  evidenceUrl: string | null;
}

const WORK_PERMIT: readonly RegExp[] = [
  /(?:協助|幫忙|幫助|代為|协助|帮助|代为)(?:申請|辦理|申请|办理)[^。！？\n]{0,12}(?:工作許可|工作證|工作簽證|居留證|工作许可|工作证|工作签证|居留证)/,
  /(?:提供|支援|支持)[^。！？\n]{0,6}(?:工作許可|工作簽證|工作许可|工作签证)/,
  /(?:工作許可|工作簽證|工作许可|工作签证)[^。！？\n]{0,6}(?:由公司|公司將|公司会|公司會)?(?:協助|代辦|协助|代办)/,
  /\b(?:we|will|can|able to|happy to)\b[^.\n]{0,40}\b(?:sponsor|support|assist with|help with|help you (?:obtain|get|apply for))\b[^.\n]{0,30}\b(?:work permits?|work visas?|visas?|ARC|resident certificates?)\b/i,
  /\b(?:work permit|work visa|visa) (?:sponsorship|support|assistance) (?:is |will be )?(?:available|provided|offered)\b/i,
];

const GOLD_CARD = /就業金卡|就业金卡|\b(?:Taiwan |Employment )?Gold Card\b/i;

const NEGATION =
  /不(?:提供|協助|协助|支援|代辦|代办|接受|適用|适用)|無法(?:協助|提供)|无法(?:协助|提供)|恕不|須自行|需自行|必須已持有|必须已持有|\b(?:not|never) (?:be )?(?:able to )?(?:sponsor|provide|offer|support|accept|eligible)|\bunable to (?:sponsor|provide|offer|support)|\b(?:cannot|can't|can’t|does not|doesn't|doesn’t|do not|don't|don’t|will not|won't|won’t) (?:sponsor|provide|offer|support|accept)|\bno (?:visa |work permit |work visa )?sponsorship|\bwithout (?:the need for )?(?:visa )?sponsorship|\bmust (?:already )?(?:have|hold|possess)\b/i;

/** Sentences of a posting, each a verbatim slice. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;])|\n+|(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A verbatim quote around `index` of at most MAX_QUOTE_CHARS. */
function clip(sentence: string, index: number): string {
  if (sentence.length <= MAX_QUOTE_CHARS) return sentence;
  const start = Math.max(0, Math.min(index - 80, sentence.length - MAX_QUOTE_CHARS));
  return sentence.slice(start, start + MAX_QUOTE_CHARS).trim();
}

/** Permit tags a posting supports, each with its quote. One quote per tag (the first). */
export function extractPermitTags(postingText: string | null | undefined, evidenceUrl: string | null = null): PermitTagEvidence[] {
  if (!postingText) return [];
  const out: PermitTagEvidence[] = [];
  const add = (tag: TwPermitTag, sentence: string, index: number) => {
    if (out.some((t) => t.tag === tag)) return;
    out.push({ tag, evidenceQuote: clip(sentence, index), evidenceUrl });
  };
  for (const sentence of sentences(postingText.normalize('NFKC'))) {
    if (NEGATION.test(sentence)) continue;
    for (const re of WORK_PERMIT) {
      const m = re.exec(sentence);
      if (m) {
        add('tw_work_permit_support', sentence, m.index);
        break;
      }
    }
    const g = GOLD_CARD.exec(sentence);
    if (g) add('tw_gold_card', sentence, g.index);
  }
  return out;
}

/** True when `quote` is still a verbatim part of the posting (NFKC, whitespace-folded). */
export function quoteInPosting(quote: string, postingText: string | null | undefined): boolean {
  if (!quote || !postingText) return false;
  const fold = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return fold(postingText).includes(fold(quote));
}
