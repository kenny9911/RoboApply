// server/src/features/cn/jobs/text.ts — posting text helpers for the GoApply
// classifiers (fraud keywords, 届别 tags): plain text of a job, sentence
// splitting that keeps each sentence verbatim, quote windows ≤ MAX_QUOTE_CHARS,
// and a whitespace-insensitive quote check for model output.

/** Quote cap; equal to WP-17's MAX_QUOTE_CHARS (a test keeps them in step). */
export const MAX_QUOTE_CHARS = 240;

export interface Sentence {
  /** Verbatim (trimmed). */
  text: string;
  /** NFKC + lower-case, for matching. Same length mapping is not assumed. */
  norm: string;
}

/** NFKC, lower-case, full-width → half-width (NFKC does that). */
export function normalizeText(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|div|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Everything the posting says, as plain text: title, then the description
 * (plain text preferred) and the qualification / responsibility / benefit
 * sections when they are not already inside it.
 */
export function postingText(job: Record<string, unknown>): string {
  const description = str(job.descriptionPlain) || stripHtml(str(job.description));
  const parts = [str(job.title), description];
  for (const key of ['qualifications', 'responsibilities', 'benefits'] as const) {
    const v = str(job[key]).trim();
    if (v && !description.includes(v)) parts.push(v);
  }
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n');
}

/** Split into sentences on Chinese and Latin sentence ends and line breaks, keeping each verbatim. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const raw of text.split(/\n+|(?<=[。！？；!?;])|(?<=[.])\s+/)) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t) out.push({ text: t, norm: normalizeText(t) });
  }
  return out;
}

/** The sentence, or a window of at most MAX_QUOTE_CHARS around `index` (an index into `sentence.norm`). */
export function quoteAround(sentence: Sentence, index: number): string {
  const s = sentence.text;
  if (s.length <= MAX_QUOTE_CHARS) return s;
  // NFKC can change lengths slightly; clamp the window into the verbatim text.
  const start = Math.max(0, Math.min(index - 60, s.length - MAX_QUOTE_CHARS));
  return s.slice(start, start + MAX_QUOTE_CHARS).trim();
}

const squash = (s: string): string => normalizeText(s).replace(/[\s　]+/g, '');

/** True when `quote` appears in `text`, ignoring whitespace, width and case. */
export function quoteInText(quote: string, text: string): boolean {
  const q = squash(quote);
  return q.length >= 2 && squash(text).includes(q);
}

/** Company name key for blacklist matching: NFKC, lower-case, no spaces or punctuation, no common legal suffix. */
export function employerKey(name: string): string {
  return normalizeText(name)
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/(股份有限公司|有限责任公司|有限公司|集团公司|分公司|公司|co\.?ltd|limited|ltd|inc)$/u, '');
}
