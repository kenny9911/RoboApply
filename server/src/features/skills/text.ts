// server/src/features/skills/text.ts
//
// Which skills a piece of text names (SM-6; MATCH 4.6 "an alias appears as a
// whole word in the resume").
//
// The text is read once: words and Chinese characters become units
// (phrase.ts), and every run of adjacent units is looked up. The cost follows
// the length of the text, not the size of the vocabulary.
//
// The rule is the whole-word rule of `mentions` (features/match/preScore.ts):
// a name is found only where the text writes it.
//   · ONE word is looked up by its comparison key, so "NodeJS", "nodejs" and
//     "Node.js" are one name and "java" is not found in "javascript".
//   · SEVERAL words are looked up by their phrase, the words in order
//     ("rest api", "spring boot", "ci cd"), and match only a name that is
//     itself written as those words. Two ordinary words whose letters happen
//     to spell a tool are not that tool: "I am" is not IAM, "in design" is not
//     InDesign, "work day" is not Workday, "air-flow" is not Airflow. A stored
//     alias key that has no spelling is found as one word only.
//   · Words join into one name only across a space, "-", "_", "/" or "&"
//     ("REST APIs", "CI/CD", "pl/sql"), never across a comma or a full stop.
//   · A word that is also something else (keys.ts `isListOnlyWord`: rest,
//     excel, go, one letter, ML, PS, a short abbreviation nobody has cleared)
//     is not taken from a sentence, whether it stands alone or is spelled by
//     several words ("re-act"). "REST API", "Spring Boot", "React Native" are.
//   · A Chinese name of three characters or more is found anywhere in a run
//     of Chinese text. A shorter one must be the whole run: 一建 is not found
//     in 统一建设, 注会 is not found in 关注会员. Chinese characters on two
//     sides of a space are two words: 数据 库存 does not name 数据库.
//   · A Latin name next to a Chinese character is found ("熟悉Java和Python"
//     names both), which `mentions` does not do.
//
// The scan does not read meaning: "no SQL experience" names SQL, as it does
// for `mentions`.
//
// Pure functions. Nothing here reads a database or calls a model.

import { isListOnlyWord } from './keys.js';
import { phrasePart, unitsOf } from './phrase.js';
import type { SkillSnapshot } from './types.js';
import { current, hasPhrasePrefix } from './vocabulary.js';

/** A Chinese name shorter than this must be a whole run of Chinese text. */
export const MIN_HAN_SUBSTRING = 3;
/** Most units one name spans (the longest seed name in Chinese has 11 characters). */
const MAX_UNITS = 16;

export interface TextScanOptions {
  /** Default: the process-wide vocabulary. */
  vocabulary?: SkillSnapshot;
  /**
   * Also count a word that is something else too ("rest", "excel", "go",
   * "ML"). Off by default. Turn it on only when the question is about that one
   * skill (the posting asks for React and the resume says "React"), never to
   * collect a person's skills.
   */
  listOnlyWords?: boolean;
}

/** Ids of the skills `text` names, in order of first appearance. Reviewed and unreviewed alike: the caller filters. */
export function skillIdsInText(text: string | null | undefined, options: TextScanOptions = {}): string[] {
  if (!text) return [];
  const vocabulary = options.vocabulary ?? current();
  const units = unitsOf(text);
  const found = new Set<string>();
  for (let i = 0; i < units.length; i++) {
    let phrase = '';
    let joined = '';
    let allHan = true;
    for (let j = i; j < units.length && j - i < MAX_UNITS; j++) {
      const unit = units[j]!;
      if (j > i && unit.gap === 'hard') break;
      phrase += phrasePart(unit, j === i);
      joined += unit.piece;
      allHan &&= unit.han;
      const count = j - i + 1;
      // One word: by key. Several: by the phrase a name is written as. One Chinese character is never a name.
      const id = count > 1 ? vocabulary.idOfPhrase(phrase) : unit.han ? null : vocabulary.idOfKey(unit.piece);
      if (id && !found.has(id)) {
        const ok = allHan
          ? count >= MIN_HAN_SUBSTRING || (units[i]!.runStart && unit.runEnd)
          : options.listOnlyWords === true || !isListOnlyWord(count === 1 ? unit.raw : joined);
        if (ok) found.add(id);
      }
      if (!hasPhrasePrefix(vocabulary, phrase)) break;
    }
  }
  return [...found];
}
