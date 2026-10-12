// server/src/features/skills/phrase.ts
//
// How a piece of text, and a skill name, is cut into words (SM-6; MATCH 4.6
// "an alias appears as a whole word in the resume").
//
// The comparison key of keys.ts removes every space, so "in design" and
// "InDesign" have one key. That is right for comparing two skill names and
// wrong for reading a sentence: "experience in design" does not name InDesign.
// A sentence is therefore compared by PHRASE, the words in order with their
// spaces kept: "rest api", "spring boot", "ci cd", "api 设计". The vocabulary
// keeps the phrase of every name it knows as it is written (vocabulary.ts),
// and the text scan (text.ts) looks a run of words up by its phrase, never by
// the collapsed key.
//
// One tokenizer cuts both the text and the names, so the two always agree:
//   · A Latin word is letters, digits, "+", "#" and inner dots ("c++", "c#",
//     "node.js"). Its piece is its comparison key ("apis" → "api",
//     "Node.js" → "nodejs").
//   · Every Chinese character is a unit of its own (Traditional folded to
//     Simplified), so a name is found inside a run of Chinese text.
//   · Between two units there is nothing (two characters of one Chinese run),
//     a soft gap (spaces, "-", "_", "/", "&", or a change of script) or a hard
//     break (a comma, a full stop, a bracket, anything else). A name never
//     continues across a hard break.
//
// Pure functions. Nothing here reads a database or calls a model.

import { foldTwToCn } from '../jobs/normalize/index.js';
import { termKey } from './terms.js';

const TOKEN = /(\p{Script=Han}+)|((?:(?!\p{Script=Han})[\p{L}\p{N}+#.])+)/gu;
const SOFT_GAP = /^[\s\-_/&]*$/;
const HAN_RUN_OR_OTHER = /\p{Script=Han}+|[^\p{Script=Han}]+/gu;
const HAS_HAN = /\p{Script=Han}/u;
/** A dot between two letters or digits ("node.js", "asp.net"). */
const INNER_DOT = /(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu;

/** What stands between the words of a phrase. */
export const PHRASE_SEPARATOR = ' ';

/** How a unit follows the one before it. The first unit of a text follows a hard break. */
export type Gap = 'none' | 'soft' | 'hard';

export interface Unit {
  /** This unit's part of a phrase: the comparison key of a Latin word, or one Chinese character. */
  piece: string;
  han: boolean;
  /** The word as written (lower case), for the everyday-word rule. */
  raw: string;
  gap: Gap;
  /** First / last character of its run of Chinese text. */
  runStart: boolean;
  runEnd: boolean;
}

/** Text → its units, in order. */
export function unitsOf(text: string): Unit[] {
  const t = text.normalize('NFKC').toLowerCase();
  const units: Unit[] = [];
  const keyOfWord = new Map<string, string>();
  let lastEnd = 0;
  let hardBreak = true;
  for (const m of t.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const gap: Gap = !hardBreak && SOFT_GAP.test(t.slice(lastEnd, start)) ? 'soft' : 'hard';
    lastEnd = start + m[0].length;
    hardBreak = false;
    if (m[1] !== undefined) {
      const chars = [...foldTwToCn(m[1])];
      chars.forEach((ch, i) => units.push({ piece: ch, han: true, raw: ch, gap: i > 0 ? 'none' : gap, runStart: i === 0, runEnd: i === chars.length - 1 }));
      continue;
    }
    const word = m[2]!.replace(/^\.+|\.+$/g, '');
    // "…Node.js. React…": a full stop after the word ends the name.
    if (m[2]!.endsWith('.')) hardBreak = true;
    // A lone "+", "#" or "..." is punctuation, not part of a name.
    if (!/[\p{L}\p{N}]/u.test(word)) {
      hardBreak = true;
      continue;
    }
    let piece = keyOfWord.get(word);
    if (piece === undefined) {
      piece = termKey(word);
      keyOfWord.set(word, piece);
    }
    if (!piece) {
      hardBreak = true;
      continue;
    }
    units.push({ piece, han: false, raw: word, gap, runStart: false, runEnd: false });
  }
  return units;
}

/** What `unit` adds to the phrase of the units before it. */
export function phrasePart(unit: Unit, first: boolean): string {
  return first ? unit.piece : `${unit.gap === 'none' ? '' : PHRASE_SEPARATOR}${unit.piece}`;
}

function phraseOfText(text: string): string | null {
  const units = unitsOf(text);
  if (!units.length) return null;
  let phrase = '';
  for (let i = 0; i < units.length; i++) {
    // A name with a comma or a bracket in it is never found in a sentence as one name.
    if (i > 0 && units[i]!.gap === 'hard') return null;
    phrase += phrasePart(units[i]!, i === 0);
  }
  return phrase;
}

/**
 * The phrases a sentence may write a name as: the name's own words
 * ("REST APIs" → "rest api"), and, for a name with an inner dot, the same
 * words with the dot read as a space ("Node.js" → "nodejs" and "node js", so
 * "Node JS" and "Node-JS" are found).
 */
export function phrasesOfName(name: string): string[] {
  const out = new Set<string>();
  for (const form of [name, name.replace(INNER_DOT, ' ')]) {
    const phrase = phraseOfText(form);
    if (phrase) out.add(phrase);
  }
  return [...out];
}

/**
 * The phrase of a stored comparison key that has no spelling (RASkill.aliases
 * holds keys). A key with Chinese in it is its own spelling, because Chinese
 * is written without spaces: "机器学习" → "机器学习", "api设计" → "api 设计". A
 * Latin key has lost its spaces for good ("postgresdb"), so it has no phrase
 * and is found as one word only.
 */
export function phraseOfKey(key: string): string | null {
  if (!HAS_HAN.test(key)) return null;
  return (key.match(HAN_RUN_OR_OTHER) ?? []).join(PHRASE_SEPARATOR) || null;
}
