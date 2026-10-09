// server/src/features/jobs/enrich/keywords.ts
//
// The `RAKeywordExtraction` row (ARCHITECTURE.md §4.5 step 3): the top 30
// keywords of a posting, from the extracted skills first (required → high,
// preferred → medium) and then TF-IDF over the description.
//
// One job has no corpus, so the "documents" for IDF are the posting's own
// sentences: a term that appears in every sentence ("we", "team") scores low,
// a term concentrated in a few sentences scores high. Score =
// (1 + ln tf) × ln(1 + N / df). Words come from `Intl.Segmenter` (ICU word
// boundaries, which also segments Chinese), minus stopwords and numbers;
// Latin bigrams seen at least twice ("machine learning") compete as well.
// Deterministic for a given text: ties break alphabetically.

import { splitSentences } from './scamSignals.js';

export const MAX_KEYWORDS = 30;

export type KeywordImportance = 'high' | 'medium' | 'low';

/** `RAKeywordExtraction.keywords` entry. */
export interface JobKeyword {
  keyword: string;
  importance: KeywordImportance;
  /** Occurrences in the posting text (0 when a skill is named only in provider fields). */
  frequency: number;
}

const CJK = /[㐀-鿿豈-﫿]/;

const EN_STOPWORDS = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before being below between both but by can ' +
    'could did do does doing down during each etc few for from further had has have having he her here hers him his how i if in into ' +
    'is it its itself just me more most my no nor not of off on once only or other our ours out over own per same she should so some ' +
    'such than that the their theirs them then there these they this those through to too under until up us very was we were what ' +
    'when where which while who whom why will with would you your yours within across including include includes etc via ' +
    'able ability must may might new well using use used like work working works job jobs role roles position positions team teams ' +
    'company companies candidate candidates experience experienced years year year’s strong excellent good great plus preferred ' +
    'required requirements responsibilities qualifications skills skill knowledge looking join help make ensure provide support ' +
    'opportunity opportunities apply applicants applicant please related relevant equivalent minimum least one two three four five ' +
    'every day days time full part based within environment level levels high highly key'
  ).split(/\s+/),
);

const ZH_STOPWORDS = new Set([
  '的', '了', '和', '与', '與', '及', '或', '在', '是', '有', '等', '对', '對', '为', '為', '以', '并', '並', '能', '会', '會', '将', '將',
  '我们', '我們', '你', '您', '公司', '岗位', '崗位', '职位', '職位', '工作', '负责', '負責', '相关', '相關', '以上', '优先', '優先',
  '具有', '具备', '具備', '良好', '能力', '经验', '經驗', '要求', '任职', '任職', '职责', '職責', '熟悉', '进行', '進行', '团队', '團隊',
  '一定', '以及', '包括', '可以', '需要', '提供', '我', '他', '她', '其', '者', '中', '上', '下', '年', '个', '個',
]);

const segmenters = new Map<string, Intl.Segmenter>();
function segmenter(locale: string): Intl.Segmenter {
  let s = segmenters.get(locale);
  if (!s) {
    s = new Intl.Segmenter(locale, { granularity: 'word' });
    segmenters.set(locale, s);
  }
  return s;
}

/** Word tokens of a sentence (lower case, stopwords and numbers removed), in order. */
export function tokenize(text: string): string[] {
  const locale = CJK.test(text) ? 'zh' : 'en';
  const out: string[] = [];
  for (const seg of segmenter(locale).segment(text.normalize('NFKC'))) {
    if (!seg.isWordLike) continue;
    const w = seg.segment.toLowerCase().replace(/^[-'.]+|[-'.]+$/g, '');
    if (!w || /^\d+([.,]\d+)?$/.test(w)) continue;
    if (CJK.test(w)) {
      if (w.length < 2 || ZH_STOPWORDS.has(w)) continue;
    } else if (w.length < 2 || EN_STOPWORDS.has(w)) {
      continue;
    }
    out.push(w);
  }
  return out;
}

interface Scored {
  term: string;
  tf: number;
  score: number;
}

/** TF-IDF terms of a posting, best first. */
export function tfidfTerms(text: string, limit: number = MAX_KEYWORDS): Scored[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  const tf = new Map<string, number>();
  const df = new Map<string, number>();
  for (const sentence of sentences) {
    const tokens = tokenize(sentence.text);
    const terms: string[] = [...tokens];
    for (let i = 0; i + 1 < tokens.length; i++) {
      const a = tokens[i]!;
      const b = tokens[i + 1]!;
      if (!CJK.test(a) && !CJK.test(b)) terms.push(`${a} ${b}`);
    }
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of new Set(terms)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = sentences.length;
  const scored: Scored[] = [];
  for (const [term, count] of tf) {
    if (term.includes(' ') && count < 2) continue;
    const idf = Math.log(1 + n / (df.get(term) ?? 1));
    scored.push({ term, tf: count, score: (1 + Math.log(count)) * idf });
  }
  scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  // Drop a single word that only ever appears inside a kept bigram (same count).
  const kept: Scored[] = [];
  for (const s of scored) {
    if (!s.term.includes(' ')) {
      const coveredBy = kept.find((k) => k.term.includes(' ') && k.term.split(' ').includes(s.term) && k.tf === s.tf);
      if (coveredBy) continue;
    }
    kept.push(s);
    if (kept.length >= limit) break;
  }
  return kept;
}

/** Occurrences of `phrase` in `text` (case-insensitive; word-bounded for Latin). */
export function countOccurrences(text: string, phrase: string): number {
  const p = phrase.normalize('NFKC').toLowerCase().trim();
  if (!p) return 0;
  const hay = text.normalize('NFKC').toLowerCase();
  if (CJK.test(p)) return hay.split(p).length - 1;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9+#])${escaped}(?=$|[^a-z0-9+#])`, 'g');
  return [...hay.matchAll(re)].length;
}

export interface KeywordSkillInput {
  skill: string;
  required: boolean;
}

/**
 * Top MAX_KEYWORDS keywords: skills first (required → high, preferred →
 * medium), then TF-IDF terms not already covered (tf ≥ 3 → medium, else low).
 */
export function buildKeywords(text: string, skills: readonly KeywordSkillInput[], limit: number = MAX_KEYWORDS): JobKeyword[] {
  const out: JobKeyword[] = [];
  const seen = new Set<string>();
  const ordered = [...skills.filter((s) => s.required), ...skills.filter((s) => !s.required)];
  for (const s of ordered) {
    const key = s.skill.normalize('NFKC').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ keyword: key, importance: s.required ? 'high' : 'medium', frequency: countOccurrences(text, key) });
    if (out.length >= limit) return out;
  }
  for (const t of tfidfTerms(text, limit * 2)) {
    if (seen.has(t.term)) continue;
    seen.add(t.term);
    out.push({ keyword: t.term, importance: t.tf >= 3 ? 'medium' : 'low', frequency: t.tf });
    if (out.length >= limit) break;
  }
  return out;
}
