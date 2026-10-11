// server/src/features/retrieval/lang.ts
//
// The language of a posting's text, for `RAJob.lang` (SM-7, SM-11): which
// subset of the evaluation harness a posting belongs to, and later which
// postings a language filter keeps.
//
//   'zh-Hant'  Han characters dominate and at least 2% of them are characters
//              only Traditional text uses (the fold of hantHans.ts changes them)
//   'zh-Hans'  other Han-dominant text
//   'ja'       text with kana
//   'ko'       text with Hangul
//   'en'       Latin text that reads as English
//   'other'    anything else, including Latin text in another language
//
// It never guesses AMONG European languages: Latin text is English or it is
// 'other'. English is recognised by its function words; a text too short to
// show any is called English only when it is plain ASCII.

import { isTraditionalOnly } from './hantHans.js';

export type PostingLang = 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' | 'ko' | 'other';

/** Share of Han characters that must be Traditional-only for 'zh-Hant'. */
export const HANT_MIN_SHARE = 0.02;
/** Characters read; a posting's language shows long before this. */
const SAMPLE_CHARS = 6000;
/** Latin words from which the function-word test is trusted. */
const ENGLISH_MIN_WORDS = 25;
/** Share of English function words in English prose is far above this; in other Latin languages far below. */
const ENGLISH_MIN_SHARE = 0.08;

const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  // Words other European languages do not share (no "in", "an", "on", "or", "is", "as": German, French, Dutch and Portuguese have them too).
  'the', 'and', 'of', 'to', 'for', 'with', 'are', 'you', 'your', 'our', 'we', 'will', 'that', 'this', 'have', 'from', 'their',
]);

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;

export function detectLang(text: string | null | undefined): PostingLang {
  if (typeof text !== 'string') return 'other';
  const sample = text.normalize('NFKC').slice(0, SAMPLE_CHARS);
  let han = 0;
  let hant = 0;
  let kana = 0;
  let hangul = 0;
  for (const ch of sample) {
    if (HAN.test(ch)) {
      han += 1;
      if (isTraditionalOnly(ch)) hant += 1;
    } else if (KANA.test(ch)) kana += 1;
    else if (HANGUL.test(ch)) hangul += 1;
  }
  const latinWords = sample.match(/[\p{Script=Latin}]{2,}/gu) ?? [];
  const cjk = han + kana;

  // Hangul text (Korean postings mix in Latin terms, rarely Han).
  if (hangul >= 2 && hangul > han && hangul >= latinWords.length) return 'ko';
  // Kana beyond a stray character (の in a shop name) means Japanese.
  if (kana >= 2 && kana / Math.max(1, cjk) >= 0.05 && cjk >= latinWords.length) return 'ja';
  // Han dominates when there are more Han characters than Latin words (a Chinese posting full of English tool names stays Chinese).
  if (han > 0 && han > latinWords.length) return hant / han >= HANT_MIN_SHARE ? 'zh-Hant' : 'zh-Hans';

  if (!latinWords.length) return 'other';
  const words = latinWords.map((w) => w.toLowerCase());
  if (words.length >= ENGLISH_MIN_WORDS) {
    const functionWords = words.filter((w) => ENGLISH_FUNCTION_WORDS.has(w)).length;
    return functionWords / words.length >= ENGLISH_MIN_SHARE ? 'en' : 'other';
  }
  // Too short to count function words: English when it shows one, or when it is plain ASCII (a bare title).
  if (words.some((w) => ENGLISH_FUNCTION_WORDS.has(w))) return 'en';
  return /^[\x00-\x7F]*$/.test(sample) ? 'en' : 'other';
}
