// server/src/features/skills/keys.ts
//
// The comparison key of a skill name. It is the `termKey` of
// features/match/terms.ts (NFKC, lower case, singular, no spaces or
// punctuation), with Traditional Chinese folded to Simplified first, so
// "Node.js", "nodejs" and "NodeJS" are one key, and 機器學習 and 机器学习 are
// one key. A key is for comparing only: it is never shown and never keyed a
// second time.
//
// Pure functions. Nothing here reads a database or calls a model.

import { foldTwToCn } from '../jobs/normalize/index.js';
import { EVERYDAY_WORDS, isEverydayWord, termKey } from './terms.js';

const HAN = /\p{Script=Han}/u;

/** Does the text contain a Chinese character? */
export function hasHan(text: string): boolean {
  return HAN.test(text);
}

/** The comparison key of `term` ('' for a blank term). */
export function aliasKey(term: string): string {
  const t = term.normalize('NFKC').trim();
  if (!t) return '';
  return termKey(hasHan(t) ? foldTwToCn(t) : t);
}

/**
 * Keys that name a skill and are also something else in running text. Like an
 * everyday word of terms.ts, such a name counts from a person's skill list
 * only, never from a sentence, and is never mapped by an embedding neighbour.
 * The long forms ("machine learning", "certified public accountant",
 * "Photoshop", 机器学习) still count from text.
 *
 *   node  a 5-node cluster            net   net revenue (".NET" has the key "net")
 *   ts    TS/SCI clearance            nat   a NAT gateway ("NATS" has the key "nat")
 *   ml    500 ml, 30 mL               ps    "P.S.", "PS:" (a postscript)
 *   ai    a given name (Ai Weiwei)    py    PY, prior year, in finance
 *   cpa   cost per acquisition        rag   a cleaning rag; RAG status (red, amber, green)
 *   sox   the Red Sox                 iam   "Iam", a missing space in "I am"
 *
 * A key covers the plural too ("CPAs", "RAGs").
 */
export const LIST_ONLY_KEYS: ReadonlySet<string> = new Set(['node', 'net', 'ts', 'nat', 'ml', 'ps', 'ai', 'py', 'cpa', 'rag', 'sox', 'iam']);

/** A word of at most this many letters is an abbreviation with many readings unless it is listed below. */
export const SHORT_NAME_MAX_LETTERS = 3;

/**
 * The rule for short abbreviations: a word of three letters or fewer counts
 * from a sentence only when it is listed here, that is, when it has one
 * reading in a resume. Everything else of that length (ML, PS, AR, PM, HR, an
 * abbreviation a reviewer adds next month) counts from a person's skill list
 * only, until someone has looked at it and added it here.
 *
 * Left out on purpose, each with its other reading: gcp (good clinical
 * practice), dbt (dialectical behaviour therapy), llm (the law degree LL.M.),
 * nlp (neuro-linguistic programming), cpp (Canada Pension Plan; "C++" itself
 * is found), jax (Jacksonville), ifr (instrument flight rules; "IFRS" is
 * found), and the keys of LIST_ONLY_KEYS above.
 */
export const SHORT_NAMES_WITH_ONE_READING: ReadonlySet<string> = new Set([
  // cloud and infrastructure
  'aws', 'ecs', 'eks', 'gke', 'iac', 'vpc', 'dns', 'cdn', 'tls', 'ssl', 'sso', 'jwt', 'sqs', 'sre',
  // languages, data and tooling
  'sql', 'css', 'xml', 'php', 'js', 'vue', 'git', 'svn', 'npm', 'api', 'ios', 'oop', 'tdd', 'etl',
  // business tools and certificates
  'crm', 'erp', 'seo', 'ppt', 'cfa', 'pmp',
  // design and quality
  'ui', 'ux', 'qa',
]);

/** The keys of terms.ts EVERYDAY_WORDS ("rails" and "rail" are one key). */
const EVERYDAY_KEYS: ReadonlySet<string> = new Set([...EVERYDAY_WORDS].map((w) => termKey(w)));

const LETTERS_ONLY = /^[a-z]+$/;

/**
 * Is this word too ambiguous to take from a sentence?
 *   · the rule of terms.ts (`isEverydayWord`: rest, excel, swift, go, a single
 *     letter), compared by key so the plural and the singular agree ("she
 *     excels at" is not Excel, "rail freight" is not Rails);
 *   · `LIST_ONLY_KEYS`;
 *   · a word of three letters or fewer that is not in
 *     `SHORT_NAMES_WITH_ONE_READING`. Dots are not letters: "P.S." is "ps",
 *     "LL.M." is "llm".
 * Such a word counts as a listed skill only.
 */
export function isListOnlyWord(word: string): boolean {
  const w = word.normalize('NFKC').trim().toLowerCase();
  if (!w) return true;
  const key = aliasKey(w);
  if (isEverydayWord(w) || EVERYDAY_KEYS.has(key) || LIST_ONLY_KEYS.has(key)) return true;
  const letters = w.replace(/\./g, '');
  return letters.length <= SHORT_NAME_MAX_LETTERS && LETTERS_ONLY.test(letters) && !SHORT_NAMES_WITH_ONE_READING.has(letters);
}

/** A stable id for a label: lower case, words joined by "_" ("Relational databases" → "relational_databases", "C++" → "c++"). */
export function slugOf(label: string): string {
  return label
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}
