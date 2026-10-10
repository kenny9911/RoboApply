// server/src/features/jobs/taxonomy/match.ts
//
// Title → role matching and the role typeahead over taxonomy v1.
//
// Matching is deterministic and explainable (no LLM): a posting title is
// normalized (case, width, punctuation, bracketed notes, tech spellings like
// C++ / C# / .NET / Node.js), then compared with every role's labels and
// synonyms twice — as written and with level words removed ("Senior", "II",
// "Intern", 高级, 资深, 校招 …) — and the best score wins:
//   - exact phrase                         1.0
//   - every synonym word appears in the title (Latin) or the synonym is a
//     substring of the title (CJK)         0.5 + 0.5 × coverage, +0.05 when contiguous
// Roles marked `generic` ("Software engineer") lose 0.15 so a specific role
// wins whenever both match. Below `minScore` (0.6) there is no match: an
// honest "unknown" beats a wrong category (D3).
//
// One word, two professions (FIX-3). "Architect" alone is the building
// profession (Design › Industrial, interior and architecture), but in a title
// beside software words ("Lead AI Architect", "Java Backend Architect",
// "Principal Architect - Machine Learning") it is a software architect. Such a
// title is matched to the software role instead (`CONTEXT_REDIRECTS`), unless
// it names the building profession outright ("Landscape Architect").

import { TAXONOMY_NODES, taxonomyAncestors, taxonomyLabel, type TaxonomyLevel, type TaxonomyNode } from './taxonomy.js';

const CJK = /[㐀-鿿豈-﫿]/;

/** Level words removed in the second pass (Latin tokens). */
const LEVEL_TOKENS = new Set([
  'senior',
  'sr',
  'junior',
  'jr',
  'staff',
  'principal',
  'lead',
  'intern',
  'internship',
  'trainee',
  'graduate',
  'grad',
  'new',
  'entry',
  'level',
  'mid',
  'experienced',
  'i',
  'ii',
  'iii',
  'iv',
  'v',
  '1',
  '2',
  '3',
  '4',
  'remote',
  'hybrid',
  'onsite',
  'contract',
  'temporary',
  'part',
  'time',
  'full',
  'fulltime',
  'parttime',
]);

/** Level words removed in the second pass (Chinese). */
const CJK_LEVEL_WORDS = ['高级', '资深', '初级', '中级', '助理级', '实习生', '实习', '校招', '社招', '应届生', '应届', '储备', '急招', '兼职', '全职'];

/** Lower-case, full-width → half-width, bracketed notes removed, tech spellings joined, punctuation → spaces. */
export function normalizeTitle(input: string): string {
  let s = input.normalize('NFKC').toLowerCase();
  s = s.replace(/[(（[【][^)）\]】]*[)）\]】]/g, ' ');
  s = s
    .replace(/c\+\+/g, 'cpp')
    .replace(/c#/g, 'csharp')
    .replace(/\.net\b/g, 'dotnet')
    .replace(/node\.js/g, 'nodejs')
    .replace(/\be-commerce\b/g, 'ecommerce')
    .replace(/&/g, ' and ');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  return s;
}

/** Remove level words (second matching pass). */
export function stripLevelWords(normalized: string): string {
  let s = normalized;
  for (const w of CJK_LEVEL_WORDS) s = s.split(w).join(' ');
  const tokens = s.split(' ').filter((t) => t && !LEVEL_TOKENS.has(t));
  return tokens.join(' ');
}

interface Phrase {
  nodeId: string;
  text: string;
  tokens: string[];
  cjk: boolean;
}

function buildPhrases(nodes: readonly TaxonomyNode[]): Phrase[] {
  const out: Phrase[] = [];
  for (const n of nodes) {
    const raw = [n.en, n.zh, ...n.synonyms.en, ...n.synonyms.zh];
    const seen = new Set<string>();
    for (const r of raw) {
      const text = normalizeTitle(r);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push({ nodeId: n.id, text, tokens: text.split(' '), cjk: CJK.test(text) });
    }
  }
  return out;
}

/** Words that make "architect" a software role. */
const SOFTWARE_CONTEXT = new Set(
  (
    'software ai ml machine learning genai llm data cloud aws azure gcp java python dotnet csharp cpp golang go javascript typescript nodejs ' +
    'backend frontend fullstack full stack web mobile ios android api apis platform platforms systems system solution solutions enterprise ' +
    'application applications app apps integration integrations infrastructure devops security cyber cybersecurity network networks it ' +
    'technical technology tech digital database databases salesforce sap oracle servicenow workday dynamics microservices kubernetes ' +
    'blockchain crypto embedded firmware iot analytics bi erp crm saas identity storage compute middleware automation'
  ).split(/\s+/),
);

/**
 * A role whose one-word name means another role beside context words. Only
 * the bare word is redirected: a longer synonym of the role ("landscape
 * architect") names it outright and stays.
 */
const CONTEXT_REDIRECTS: ReadonlyArray<{ from: string; word: string; to: string; context: ReadonlySet<string> }> = [
  // Chinese has two words (建筑师 / 架构师), so only the English word needs this.
  { from: 'architect', word: 'architect', to: 'software_architect', context: SOFTWARE_CONTEXT },
];

function redirectFor(phrase: Phrase, titleTokens: readonly string[], title: string): string | null {
  for (const r of CONTEXT_REDIRECTS) {
    if (phrase.nodeId !== r.from || phrase.text !== r.word) continue;
    if (title === phrase.text) return null; // the bare word is the role as named
    if (titleTokens.some((t) => r.context.has(t))) return r.to;
  }
  return null;
}

const ROLE_NODES = TAXONOMY_NODES.filter((n) => n.level === 3);
const ROLE_PHRASES = buildPhrases(ROLE_NODES);
const ALL_PHRASES = buildPhrases(TAXONOMY_NODES);
const NODE_BY_ID = new Map(TAXONOMY_NODES.map((n) => [n.id, n]));

function containsTokensInOrder(hay: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function scorePhrase(title: string, titleTokens: string[], phrase: Phrase): number {
  if (!title) return 0;
  if (title === phrase.text) return 1;
  if (phrase.cjk || CJK.test(title)) {
    const compactTitle = title.replace(/ /g, '');
    const compactPhrase = phrase.text.replace(/ /g, '');
    if (!compactPhrase || !compactTitle.includes(compactPhrase)) return 0;
    return 0.5 + 0.5 * (compactPhrase.length / compactTitle.length);
  }
  const set = new Set(titleTokens);
  if (!phrase.tokens.every((t) => set.has(t))) return 0;
  const coverage = phrase.tokens.length / titleTokens.length;
  const contiguous = containsTokensInOrder(titleTokens, phrase.tokens) ? 0.05 : 0;
  return Math.min(0.99, 0.5 + 0.5 * coverage + contiguous);
}

export interface TitleMatch {
  id: string;
  level: TaxonomyLevel;
  score: number;
  /** The normalized label or synonym that matched. */
  matched: string;
}

/** Ranked role matches for a posting title (best first). */
export function matchTitle(title: string, options: { limit?: number; minScore?: number } = {}): TitleMatch[] {
  const limit = options.limit ?? 3;
  const minScore = options.minScore ?? 0.6;
  const raw = normalizeTitle(title);
  if (!raw) return [];
  const stripped = stripLevelWords(raw);
  const variants = [...new Set([raw, stripped].filter(Boolean))].map((v) => ({ text: v, tokens: v.split(' ') }));
  const best = new Map<string, TitleMatch>();
  // Does the title name the building profession outright ("landscape architect", "project architect")?
  const namedOutright = new Set<string>();
  for (const phrase of ROLE_PHRASES) {
    if (!CONTEXT_REDIRECTS.some((r) => r.from === phrase.nodeId && r.word !== phrase.text)) continue;
    if (variants.some((v) => scorePhrase(v.text, v.tokens, phrase) > 0)) namedOutright.add(phrase.nodeId);
  }
  for (const phrase of ROLE_PHRASES) {
    let score = 0;
    let via = variants[0]!;
    for (const v of variants) {
      const sc = scorePhrase(v.text, v.tokens, phrase);
      if (sc > score) {
        score = sc;
        via = v;
      }
    }
    if (!score) continue;
    // "architect" beside software words is the software role, not the building one.
    const redirected = namedOutright.has(phrase.nodeId) ? null : redirectFor(phrase, via.tokens, via.text);
    const nodeId = redirected ?? phrase.nodeId;
    if (NODE_BY_ID.get(nodeId)?.generic) score -= 0.15;
    const cur = best.get(nodeId);
    if (!cur || score > cur.score) best.set(nodeId, { id: nodeId, level: 3, score: Math.round(score * 1000) / 1000, matched: phrase.text });
  }
  return [...best.values()]
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score || b.matched.length - a.matched.length || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** The single best role for a title, or null when nothing matches well enough. */
export function bestTaxonomyMatch(title: string, minScore = 0.6): TitleMatch | null {
  return matchTitle(title, { limit: 1, minScore })[0] ?? null;
}

export interface TaxonomySuggestion {
  id: string;
  level: TaxonomyLevel;
  label: string;
  /** "Role group · Category" for roles, the category for groups, null for categories. */
  context: string | null;
  matched: string;
}

/**
 * Typeahead over categories, groups and roles. Needs 2+ characters (1 for
 * Chinese). Ranking: exact > label prefix > synonym prefix > word prefix >
 * contains.
 */
export function searchTaxonomy(q: string, options: { locale?: string; limit?: number; levels?: TaxonomyLevel[] } = {}): TaxonomySuggestion[] {
  const query = normalizeTitle(q);
  if (!query || (!CJK.test(query) && query.length < 2)) return [];
  const locale = options.locale ?? 'en';
  const limit = options.limit ?? 10;
  const levels = new Set(options.levels ?? [1, 2, 3]);
  const scored = new Map<string, { score: number; matched: string }>();
  for (const phrase of ALL_PHRASES) {
    const node = NODE_BY_ID.get(phrase.nodeId)!;
    if (!levels.has(node.level)) continue;
    const isLabel = phrase.text === normalizeTitle(node.en) || phrase.text === normalizeTitle(node.zh);
    let score = 0;
    if (phrase.text === query) score = 1;
    else if (phrase.text.startsWith(query)) score = isLabel ? 0.9 : 0.8;
    else if (phrase.tokens.some((t) => t.startsWith(query)) || phrase.text.includes(` ${query}`)) score = isLabel ? 0.75 : 0.7;
    else if (phrase.text.includes(query)) score = 0.6;
    if (!score) continue;
    const cur = scored.get(node.id);
    if (!cur || score > cur.score) scored.set(node.id, { score, matched: phrase.text });
  }
  return [...scored.entries()]
    .sort(([ia, a], [ib, b]) => b.score - a.score || NODE_BY_ID.get(ia)!.level - NODE_BY_ID.get(ib)!.level || ia.localeCompare(ib))
    .slice(0, limit)
    .map(([id, s]) => {
      const node = NODE_BY_ID.get(id)!;
      const ancestors = taxonomyAncestors(id).slice(1);
      return {
        id,
        level: node.level,
        label: taxonomyLabel(id, locale)!,
        context: ancestors.length ? ancestors.map((a) => taxonomyLabel(a.id, locale)).join(' · ') : null,
        matched: s.matched,
      };
    });
}
