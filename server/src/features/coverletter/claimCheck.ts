// server/src/features/coverletter/claimCheck.ts
//
// The cover-letter claim checker (WP-37; PRODUCT_PLAN.md F-CL-01, §9.2;
// ruling C12; D3). Ported from the claim-checker of
// `roboapply/engine/agents/SeekerResumeTailorAgent.ts` (its adversarial
// fact-check prompt lives on in CoverLetterAgent.ts) and extended with a
// deterministic pass that runs first and is authoritative:
//
//   1. missing_citation       every body sentence cites the resume or the job post;
//   2. bad_citation           each cited line appears (verbatim, whitespace- and
//                             case-insensitive) in the source it names;
//   3. posting_as_experience  a sentence that claims the candidate's own
//                             experience must be backed by the resume — it
//                             fails when it cites only the job post, or when it
//                             names a term (skill, tool, product) that is in the
//                             job post and not in the resume;
//   4. invented_number        a number in an experience sentence must be on the
//                             resume (elsewhere: on the resume or the job post).
//
// Sentences the user wrote themselves (kept verbatim in a rewrite) are the
// user's own words and are not checked. Pure; no I/O.
//
// Limits (stated, not hidden): experience-claim detection is a heuristic for
// English and Chinese; other languages rely on the model's own `kind: experience`
// label plus the citation rules. Number words ("five") and Chinese numerals are
// not compared, only digits.

export type ModelCiteSource = 'resume' | 'posting' | 'letter';
export type SentenceKind = 'experience' | 'motivation' | 'company' | 'other';

export interface ModelCite {
  source: ModelCiteSource;
  quote: string;
}

/** One sentence as the model returned it (after `letter` cites were resolved by the caller). */
export interface LetterSentence {
  text: string;
  kind?: SentenceKind;
  cites: Array<{ source: 'resume' | 'posting'; quote: string }>;
}

export type ClaimIssueKind = 'missing_citation' | 'bad_citation' | 'posting_as_experience' | 'invented_number';

export interface ClaimIssue {
  sentenceIdx: number;
  kind: ClaimIssueKind;
  sentence: string;
  /** The term, number or quote the issue is about. */
  detail: string;
}

export interface ClaimCheckInput {
  sentences: LetterSentence[];
  /** The resume text the model was given (the ground truth for the candidate). */
  resumeText: string;
  /** The job post text the model was given. */
  postingText: string;
  companyName?: string | null;
  locale: string;
  /** Sentences the user wrote (kept verbatim in a rewrite); never checked. */
  userSentences?: readonly string[];
}

export interface ClaimCheckResult {
  passed: boolean;
  issues: ClaimIssue[];
}

// ── text helpers ─────────────────────────────────────────────────────────

/** Fold full-width digits and letters onto ASCII. */
export function foldWidth(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
}

/** Lowercase, width-folded, quote-normalized, whitespace-collapsed. */
export function normalizeText(s: string): string {
  return foldWidth(s ?? '')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”«»„]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/[*_#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Minimum length of a quote that can count as evidence. */
export const MIN_QUOTE_CHARS = 4;

/** Whitespace/case-insensitive verbatim containment (the evidence rule). */
export function quotedIn(quote: string, text: string): boolean {
  const q = normalizeText(quote).replace(/^["'\s]+|["'\s.。,，;；:：]+$/g, '');
  return q.length >= MIN_QUOTE_CHARS && normalizeText(text).includes(q);
}

export const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;
const CJK_LOCALES = new Set(['zh', 'zh-TW', 'ja']);

/** True for locales whose sentences join without spaces. */
export function isCjkLocale(locale: string): boolean {
  return CJK_LOCALES.has(locale);
}

/**
 * Split text into sentences: one per line at least, then on sentence ends
 * (. ! ? followed by a space and a capital/digit/quote; 。！？ always).
 * Empty pieces are dropped. Deterministic; used for both model output and
 * user edits, so citations re-map by sentence text.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of (text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/(?<=[.!?])\s+(?=["“'(\[]?[A-Z0-9À-ɏ])|(?<=[。！？])/u);
    for (const p of parts) {
      const s = p.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

// ── experience claims ────────────────────────────────────────────────────

const EN_FIRST_PERSON = /(?<![\p{L}'])(?:i|i've|i'm|i'd|my|me|we|our|we've)(?![\p{L}])/iu;
const EN_PAST_VERB = new RegExp(
  String.raw`(?<![\p{L}])(?:` +
    [
      'led', 'built', 'managed', 'shipped', 'designed', 'developed', 'worked', 'used', 'implemented', 'created', 'ran',
      'owned', 'launched', 'delivered', 'grew', 'reduced', 'increased', 'improved', 'wrote', 'maintained', 'migrated',
      'deployed', 'trained', 'taught', 'handled', 'supported', 'analyzed', 'analysed', 'organized', 'organised',
      'coordinated', 'automated', 'optimized', 'optimised', 'founded', 'scaled', 'negotiated', 'served', 'completed',
      'earned', 'won', 'achieved', 'mentored', 'spent', 'studied', 'graduated', 'administered', 'architected',
      'engineered', 'programmed', 'coded', 'configured', 'operated', 'oversaw', 'directed', 'headed', 'drove',
      'certified', 'specialized', 'specialised', 'practiced', 'practised',
    ].join('|') +
    String.raw`)(?![\p{L}])`,
  'iu',
);
const EN_POSSESSION =
  /(?<![\p{L}])(?:experience (?:with|in|using|of)|years of|year of|skilled (?:in|at|with)|proficient (?:in|at|with)|expert (?:in|at|with)|expertise (?:in|with)|background in|familiar with|fluent in|certified in|hands-on|track record)(?![\p{L}])|(?<![\p{L}])(?:my|our)\b[^.!?]{0,40}?\b(?:experience|skills?|expertise|background|knowledge|work|projects?|certifications?)(?![\p{L}])/iu;
const EN_NEGATION = /(?<![\p{L}])(?:not|never|haven't|hasn't|have not|has not|yet to|no prior|without)(?![\p{L}])/iu;

const ZH_FIRST_PERSON = /我|本人/;
const ZH_MARKER = /负责|負責|主导|主導|带领|帶領|参与|參與|开发|開發|设计|設計|完成|使用|运用|運用|熟悉|掌握|精通|具备|具備|拥有|擁有|曾|做过|做過|搭建|推动|推動|实现|實現|管理|实习|實習|就职|就職|任职|任職|获得|獲得|经验|經驗|擅长|擅長|组织|組織|策划|策劃|运营|運營|分析/;
const ZH_NEGATION = /没有|沒有|未曾|尚未|还没|還沒|不熟悉|并未|並未/;

const OTHER_FIRST_PERSON: Record<string, RegExp> = {
  ja: /私|僕|わたし/,
  ko: /저는|제가|저의|나는|내가/,
  es: /(?<![\p{L}])(?:yo|mi|mis|he)(?![\p{L}])/iu,
  fr: /(?<![\p{L}])(?:je|mon|ma|mes)(?![\p{L}])|(?<![\p{L}])j['’]/iu,
  pt: /(?<![\p{L}])(?:eu|meu|minha|meus|minhas)(?![\p{L}])/iu,
  de: /(?<![\p{L}])(?:ich|mein|meine|meinen|meiner)(?![\p{L}])/iu,
};

/**
 * Does this sentence claim the candidate's own experience? English and Chinese
 * by heuristic; every language also by the model's own `kind: experience`.
 * A negated sentence ("I haven't used Rust yet") is not a claim.
 */
export function isExperienceClaim(text: string, locale: string, kind?: SentenceKind): boolean {
  const t = foldWidth(text ?? '');
  if (locale === 'zh' || locale === 'zh-TW' || (!locale.startsWith('en') && CJK_RE.test(t) && ZH_FIRST_PERSON.test(t))) {
    if (ZH_NEGATION.test(t)) return false;
    if (ZH_FIRST_PERSON.test(t) && ZH_MARKER.test(t)) return true;
    return kind === 'experience';
  }
  if (locale === 'en' || locale.startsWith('en-')) {
    if (EN_FIRST_PERSON.test(t) && (EN_PAST_VERB.test(t) || EN_POSSESSION.test(t)) && !EN_NEGATION.test(t)) return true;
    return kind === 'experience' && !EN_NEGATION.test(t);
  }
  const fp = OTHER_FIRST_PERSON[locale];
  return kind === 'experience' && (!fp || fp.test(t));
}

// ── terms and numbers ────────────────────────────────────────────────────

const STOPWORDS = new Set(
  [
    'i', "i'm", "i've", "i'd", 'me', 'my', 'we', 'our', 'you', 'your', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at',
    'to', 'of', 'for', 'with', 'as', 'by', 'from', 'this', 'that', 'these', 'those', 'it', 'its', 'is', 'are', 'was', 'were',
    'dear', 'hiring', 'manager', 'team', 'sincerely', 'regards', 'thank', 'thanks', 'hello', 'hi', 'when', 'while', 'where',
    'which', 'who', 'what', 'how', 'why', 'there', 'here', 'also', 'then', 'so', 'if', 'because', 'since', 'after', 'before',
    'during', 'over', 'into', 'about', 'role', 'position', 'job', 'company', 'work', 'experience', 'years', 'year',
  ],
);

/** Candidate terms in a Latin-script sentence: capitalized/technical words that are not sentence-initial filler. */
export function significantTerms(text: string): string[] {
  const out = new Set<string>();
  const t = foldWidth(text ?? '');
  const re = /[A-Za-z0-9][A-Za-z0-9+#.\-/]*[A-Za-z0-9+#]|[A-Za-z]/g;
  const start = t.length - t.trimStart().length;
  for (const m of t.matchAll(re)) {
    const raw = m[0].replace(/[.\-/]+$/, '');
    // Only the word that opens the sentence (after any quote) is "first".
    const isFirst = /^["“'(\[]?$/.test(t.slice(start, m.index ?? 0));
    if (raw.length < 2) continue;
    const lower = raw.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (/^\d+(?:[.,]\d+)*$/.test(raw)) continue; // numbers are checked separately
    const technical = /[+#\d]/.test(raw) || /[A-Z]/.test(raw.slice(1)) || /^[A-Z]{2,}$/.test(raw);
    // A capital at the start of a sentence is grammar, not a name.
    const capitalized = /^[A-Z]/.test(raw) && !isFirst;
    if (technical || capitalized) out.add(raw);
  }
  return [...out];
}

function containsWord(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(foldWidth(haystack));
}

/** CJK runs of `n` characters that appear in the job post and not in the resume. */
function cjkPostingOnly(text: string, resume: string, posting: string, n = 6): string[] {
  const hits: string[] = [];
  const runs = foldWidth(text).match(/[㐀-鿿豈-﫿]+/g) ?? [];
  const r = foldWidth(resume);
  const p = foldWidth(posting);
  for (const run of runs) {
    for (let i = 0; i + n <= run.length; i += 1) {
      if (!p.includes(run.slice(i, i + n)) || r.includes(run.slice(i, i + n))) continue;
      // Grow the hit while it is still the post's wording, to report the whole phrase.
      let end = i + n;
      while (end < run.length && p.includes(run.slice(i, end + 1))) end += 1;
      hits.push(run.slice(i, end));
      break;
    }
  }
  return hits;
}

/**
 * Terms of the sentence that the job post names and the resume does not
 * (company name excluded). These are the employer's facts, never the
 * candidate's.
 */
export function postingOnlyTerms(text: string, resume: string, posting: string, companyName?: string | null): string[] {
  const companyWords = new Set(
    significantTerms(companyName ?? '')
      .map((w) => w.toLowerCase())
      .concat((companyName ?? '').toLowerCase().split(/\s+/).filter(Boolean)),
  );
  const out: string[] = [];
  for (const term of significantTerms(text)) {
    if (companyWords.has(term.toLowerCase())) continue;
    if (containsWord(posting, term) && !containsWord(resume, term)) out.push(term);
  }
  return [...out, ...cjkPostingOnly(text, resume, posting)];
}

/** Digit numbers in `text`, normalized ("1,200" → "1200", "30%" → "30"). */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of foldWidth(text ?? '').matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    out.push(String(Number(m[0].replace(/,/g, ''))));
  }
  return out;
}

function numberSet(...texts: string[]): Set<string> {
  const set = new Set<string>();
  for (const t of texts) {
    for (const n of numbersIn(t)) set.add(n);
    // Parts of dotted runs ("2021.09" → 2021 and 9).
    for (const m of foldWidth(t ?? '').matchAll(/\d+(?:\.\d+)+/g)) for (const part of m[0].split('.')) set.add(String(Number(part)));
  }
  return set;
}

// ── the check ────────────────────────────────────────────────────────────

export function checkLetterClaims(input: ClaimCheckInput): ClaimCheckResult {
  const issues: ClaimIssue[] = [];
  const userSet = new Set((input.userSentences ?? []).map(normalizeText));
  const resumeNumbers = numberSet(input.resumeText);
  const allNumbers = numberSet(input.resumeText, input.postingText);

  input.sentences.forEach((s, sentenceIdx) => {
    const text = (s.text ?? '').trim();
    if (!text) return;
    if (userSet.has(normalizeText(text))) return;
    const issue = (kind: ClaimIssueKind, detail: string) => issues.push({ sentenceIdx, kind, sentence: text, detail });

    const cites = (s.cites ?? []).filter((c) => (c.source === 'resume' || c.source === 'posting') && typeof c.quote === 'string');
    if (cites.length === 0) issue('missing_citation', '');
    let validResume = 0;
    for (const c of cites) {
      const src = c.source === 'resume' ? input.resumeText : input.postingText;
      if (!quotedIn(c.quote, src)) issue('bad_citation', c.quote);
      else if (c.source === 'resume') validResume += 1;
    }

    const experience = isExperienceClaim(text, input.locale, s.kind);
    if (experience) {
      if (cites.length > 0 && validResume === 0) issue('posting_as_experience', 'cited only to the job post');
      for (const term of postingOnlyTerms(text, input.resumeText, input.postingText, input.companyName)) {
        issue('posting_as_experience', term);
      }
    }
    const allowed = experience ? resumeNumbers : allNumbers;
    for (const n of numbersIn(text)) if (!allowed.has(n)) issue('invented_number', n);
  });

  return { passed: issues.length === 0, issues };
}

/** The retry note: what failed and how to fix it (English; the model writes the letter in its own language). */
export function retryNote(issues: readonly ClaimIssue[]): string {
  const lines = issues.slice(0, 12).map((i, n) => {
    switch (i.kind) {
      case 'missing_citation':
        return `${n + 1}. Sentence ${i.sentenceIdx + 1} has no citation. Cite the resume or job post line it is based on, or remove it.`;
      case 'bad_citation':
        return `${n + 1}. Sentence ${i.sentenceIdx + 1} cites a line that is not in that source: "${i.detail}". Quote the source exactly.`;
      case 'posting_as_experience':
        return `${n + 1}. Sentence ${i.sentenceIdx + 1} presents something from the JOB POST as the candidate's own experience (${i.detail}). The resume does not show it. Do not claim it; talk about what the resume does show, or say the candidate would learn it.`;
      case 'invented_number':
        return `${n + 1}. Sentence ${i.sentenceIdx + 1} uses the number ${i.detail}, which is not on the resume. Remove it or use a number the resume states.`;
    }
  });
  return `## Your previous letter failed the fact check\n${lines.join('\n')}\n\nWrite the letter again. Never present the employer's requirements as the candidate's experience.`;
}
