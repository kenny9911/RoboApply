// server/src/features/jobs/taxonomy/queryLabels.ts
//
// The texts a job-search provider is asked with for one role (SM-11,
// MARKET_STRATEGY 2.5 "Provider queries"). The ingest planner turns a demand
// tuple (role × country) into provider queries with this function, so a
// mainland or Taiwan search is asked in the language its postings are
// written in instead of with the English role label only.
//
//   intl          the English role label and up to two English synonyms
//   intl, TW      the same, plus the Traditional Chinese label (language
//                 'zh-TW') once the role has one. The Simplified label is
//                 never used for Taiwan: until the Taiwan labels exist the
//                 Taiwan query is English only.
//   cn            the Simplified Chinese label and up to two Chinese aliases
//                 (前端 / 服务端 …); no English text.
//
// Which synonyms: the shortest first (fewest words; for Chinese fewest
// characters), then the order of the data file, which lists the common names
// first. Left out because they make poor queries: abbreviations of three
// letters or fewer and the ambiguous one-word phrases ("pm", "ae",
// "controller", 新媒体, 行政: a provider matches them inside other titles), and a synonym
// that is the label with a level word ("senior program manager"). A head noun
// that is a catch-all ("developer", "consultant") goes last. A label that
// joins two names ("Chef or cook", 升学与职业顾问) is not something to search
// for, so the synonyms stand in for it.
// Pure; no I/O. An unknown id, or one that is not a role, gives no texts.

import { ALONE_ONLY_PHRASES, HEAD_NOUNS, normalizeTitle, stripLevelWords } from './match.js';
import { getTaxonomyNode, taxonomyLabel, type TaxonomyNode } from './taxonomy.js';

export type QueryLanguage = 'en' | 'zh-TW' | 'zh-CN';

export interface ProviderQueryLabel {
  text: string;
  language: QueryLanguage;
}

/** Synonyms added to the label, per language. */
export const MAX_QUERY_SYNONYMS = 2;

const CJK = /[㐀-鿿豈-﫿]/;
const LATIN = /[a-z]/i;
const HEAD_NOUN_SET: ReadonlySet<string> = new Set(HEAD_NOUNS);
/** A label made of two names. */
const COMPOUND_EN = /\s\/\s|\s(?:or|and)\s|,/i;
const COMPOUND_ZH = /[与或及、/]/;

function unique(texts: string[]): string[] {
  const seen = new Set<string>();
  return texts.filter((t) => {
    const key = normalizeTitle(t);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** English synonyms worth a query, best first. */
function englishSynonyms(node: TaxonomyNode): string[] {
  const label = normalizeTitle(node.en);
  const usable = node.synonyms.en
    .map((text, order) => ({ text, order, key: normalizeTitle(text) }))
    .filter(({ key }) => {
      if (!key || CJK.test(key)) return false;
      if (key === label || stripLevelWords(key) === label) return false;
      if (Object.hasOwn(ALONE_ONLY_PHRASES, key)) return false;
      // "swe", "rn", "cto": a provider finds the letters inside other words.
      if (!key.includes(' ') && key.length <= 3) return false;
      return true;
    })
    .map((s) => ({ ...s, words: s.key.split(' ').length, catchAll: HEAD_NOUN_SET.has(s.key) }));
  usable.sort((a, b) => Number(a.catchAll) - Number(b.catchAll) || a.words - b.words || a.order - b.order);
  return usable.map((s) => s.text);
}

/** Chinese aliases worth a query, best first: all-Chinese before mixed, shortest first, then data order. */
function chineseAliases(node: TaxonomyNode): string[] {
  const usable = node.synonyms.zh
    .map((text, order) => ({ text, order, mixed: LATIN.test(text) }))
    // A word that names its role only as the whole title (新媒体, 行政, 运营专员) is as poor a query as "pm".
    .filter(({ text }) => CJK.test(text) && text !== node.zh && !Object.hasOwn(ALONE_ONLY_PHRASES, normalizeTitle(text)));
  usable.sort((a, b) => Number(a.mixed) - Number(b.mixed) || a.text.length - b.text.length || a.order - b.order);
  return usable.map((s) => s.text);
}

/**
 * The query texts for a role node. `zhHantLabel` is the role's Traditional
 * Chinese label when it has one (the caller reads it from `taxonomyLabel`);
 * exported so the Taiwan rule is tested before the Taiwan labels exist.
 */
export function queryLabelsFor(node: TaxonomyNode, options: { market: 'intl' | 'cn'; country?: string | null; zhHantLabel?: string | null }): ProviderQueryLabel[] {
  if (node.level !== 3) return [];
  if (options.market === 'cn') {
    const aliases = chineseAliases(node);
    const compound = COMPOUND_ZH.test(node.zh) || !CJK.test(node.zh);
    // A label that is not Chinese text ("HRBP", "MLOps工程师" is fine) or joins two names gives way to the aliases.
    const texts = compound && aliases.length ? aliases.slice(0, MAX_QUERY_SYNONYMS + 1) : [node.zh, ...aliases.slice(0, MAX_QUERY_SYNONYMS)];
    return unique(texts)
      .filter((t) => CJK.test(t) || t === node.zh)
      .map((text) => ({ text, language: 'zh-CN' as const }));
  }
  const synonyms = englishSynonyms(node);
  const compound = COMPOUND_EN.test(node.en);
  const english = compound && synonyms.length ? synonyms.slice(0, MAX_QUERY_SYNONYMS + 1) : [node.en, ...synonyms.slice(0, MAX_QUERY_SYNONYMS)];
  const out: ProviderQueryLabel[] = unique(english).map((text) => ({ text, language: 'en' as const }));
  if (options.country?.trim().toUpperCase() === 'TW') {
    const label = options.zhHantLabel?.trim();
    // Only a real Traditional label: never the English fallback, never the Simplified label.
    if (label && CJK.test(label) && normalizeTitle(label) !== normalizeTitle(node.en)) out.push({ text: label, language: 'zh-TW' });
  }
  return out;
}

/** The texts a search provider is asked with for a role, in the market's languages. Empty for an unknown id. */
export function providerQueryLabels(roleId: string, options: { market: 'intl' | 'cn'; country?: string | null }): ProviderQueryLabel[] {
  const node = getTaxonomyNode(roleId);
  if (!node) return [];
  // `taxonomyLabel(id, 'zh-TW')` is the Traditional label once the role has one, else the English label.
  return queryLabelsFor(node, { ...options, zhHantLabel: taxonomyLabel(roleId, 'zh-TW') });
}
