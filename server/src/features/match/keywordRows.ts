// server/src/features/match/keywordRows.ts
//
// The keyword check (PRODUCT F-RES-08; MARKET_STRATEGY 2.3 step 5; SM-6):
// requirements met / not met rows (title, years, education, skills, keywords),
// computed from the same pieces as the fit. Deterministic and free; no second
// scale (the 0–100 fit score stays the only number). Used on job detail and in
// tailoring (WP-22's keyword report and WP-36a call `keywordRows`).
//
// Every item of the skills and keywords rows has one of three states:
//
//   shown      the resume or profile names the skill itself: its canonical id
//              is among the person's, or one of its names stands in the resume
//              text as a whole word (a substring for Chinese). When the text
//              has it, the item carries the sentence it was found in.
//   related    the resume names a more specific skill that shows this broader
//              one (PostgreSQL for "relational databases"), or the person's
//              title shows the practice. `via` says what counted. The person
//              decides whether to add the exact term.
//   not_shown  neither.
//
// What is listed:
//   · A posting that carries canonical skill ids (enrichment v3): its hard
//     skills and certificates with a REVIEWED id, once per id, under the
//     vocabulary's label. A skill nobody has reviewed is not listed: nothing
//     is claimed or denied about it. `unchecked` counts those.
//   · A posting that carries no ids yet: every hard skill it lists, compared
//     by its string as before (terms.ts) and by the vocabulary when the
//     vocabulary knows the string (`listedSkillCheck`). Two spellings of one
//     skill ("Postgres", "PostgreSQL") are one item.
//   · Keywords: only a term that names a reviewed hard skill or certificate,
//     and never one the skills row already lists. A keyword enrichment v3
//     stored carries its skill id. An older one is read the way words of a
//     sentence are (`skillIdsInText`), never by a bare lookup: "go", "rest",
//     "express" and "shell" are words before they are tools, and a loose
//     phrase ("shared backend systems") is not a keyword.
//   · Soft skills are never listed here: they are not compared.
//   · Nothing is listed, in either row, for a skill whose only trace in the
//     resume is a word with another reading ("500 ml" for Machine learning):
//     it is neither claimed nor denied, and such a sentence is never quoted.
//
// The row's status counts a shown item 1 and a related one 0.5. A row that
// lists nothing because nothing in it could be checked says `not_checked`,
// never "not stated in the post".

import { current as currentVocabulary, skillIdsInText, type SkillSnapshot } from '../skills/index.js';
import { KEYWORD_QUOTE_MAX, type KeywordItem, type KeywordRow, type KeywordRowStatus, type KeywordState } from './contract.js';
import { plainQuote } from './evidence.js';
import {
  carriesSkillIds,
  degreeMeets,
  jobSkillCheck,
  jobSkillList,
  labelLocaleFor,
  listedSkillCheck,
  mentions,
  normalizeText,
  postingStringsOf,
  skillKey,
  textShowsSkill,
  titleOverlap,
  type JobSkill,
  type MatchJob,
  type MatchUser,
  type ShownSource,
  type SkillCheck,
} from './preScore.js';
import { displayTerm, termKey } from './terms.js';

export interface KeywordInput {
  keyword: string;
  importance: 'high' | 'medium' | 'low';
  /** The canonical skill enrichment v3 stored with the keyword, when the reader passes it on. */
  skillId?: string | null;
}

/** Keywords shown in the check: high and medium importance, at most this many. */
export const MAX_KEYWORDS = 15;
export const MAX_SKILLS = 20;

export { mentions, normalizeText };

/** What a related item counts in the row's status. */
export const RELATED_ITEM_POINTS = 0.5;

/** `points` = shown + 0.5 × related, of `total` items. */
export function ratioStatus(points: number, total: number): KeywordRowStatus {
  if (total === 0) return 'not_stated';
  if (points >= total) return 'met';
  if (points * 2 >= total) return 'partly';
  return 'not_met';
}

/** When the vocabulary that answers a check was read from the database (ISO); null while only the committed seed is loaded. */
export function vocabularyAsOf(): string | null {
  return currentVocabulary().asOf?.toISOString() ?? null;
}

export interface KeywordRowsJob extends MatchJob {
  minYears: number | null;
}

// ── The sentence a term was found in ──────────────────────────────────────

/** A resume as its sentences: one per line, a prose line cut at its full stops. Markdown markup is not part of a sentence. */
export function resumeSentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = plainQuote(raw);
    if (!line) continue;
    for (const part of line.split(/(?<=[.!?;])\s+|(?<=[。！？；])/u)) {
      // A semicolon separates two statements; it is not part of either.
      const sentence = part.trim().replace(/[;；]+$/u, '').trim();
      if (sentence) out.push(sentence);
    }
  }
  return out;
}

/** A line that is a list of names ("TypeScript, Go, PostgreSQL") rather than a sentence. */
function looksLikeList(sentence: string): boolean {
  const separators = (sentence.match(/[,，、|·;；]/g) ?? []).length;
  const words = sentence.split(/\s+/).filter(Boolean).length;
  return separators >= 2 && words <= (separators + 1) * 3;
}

/** `sentence`, or the part of it around `needle` when it is longer than the cap. Always a verbatim piece of the sentence. */
export function clipQuote(sentence: string, needle: string | null, max: number = KEYWORD_QUOTE_MAX): string | null {
  const chars = [...sentence];
  if (chars.length <= max) return sentence;
  const at = needle ? sentence.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  // A long sentence whose term cannot be placed is not quoted: a cut that loses the term proves nothing.
  if (at < 0) return null;
  const pos = [...sentence.slice(0, at)].length;
  const len = [...needle!].length;
  let start = Math.max(0, Math.min(pos - Math.floor((max - len) / 2), chars.length - max));
  // Start on a word when the cut falls inside one.
  if (start > 0) {
    const space = chars.slice(start, pos).findIndex((c) => /\s/.test(c));
    if (space >= 0) start += space + 1;
  }
  let end = Math.min(chars.length, start + max);
  if (end < chars.length) {
    const tail = chars.slice(pos + len, end);
    const lastSpace = tail.map((c) => /\s/.test(c)).lastIndexOf(true);
    if (lastSpace >= 0) end = pos + len + lastSpace;
  }
  return chars.slice(start, end).join('').trim() || null;
}

interface QuoteFinder {
  /**
   * The first sentence that shows the skill `id`, preferring a sentence over a
   * list line. `names`: every name of the skill; `postingStrings`: how the
   * posting writes it. A sentence that holds only a name with another reading
   * ("Administered 500 ml of saline") is never the quote (`textShowsSkill`).
   */
  ofSkill(id: string, names: readonly string[], postingStrings: readonly string[]): string | null;
  /** The first sentence that mentions `term` as a whole word (a substring for Chinese). */
  ofTerm(term: string): string | null;
}

function createQuoteFinder(resumeText: string, vocabulary: SkillSnapshot): QuoteFinder {
  let sentences: string[] | null = null;
  let byId: Map<string, number[]> | null = null;
  const all = (): string[] => (sentences ??= resumeSentences(resumeText));
  const index = (): Map<string, number[]> => {
    if (byId) return byId;
    byId = new Map();
    all().forEach((sentence, i) => {
      for (const id of skillIdsInText(sentence, { vocabulary, listOnlyWords: true })) byId!.set(id, [...(byId!.get(id) ?? []), i]);
    });
    return byId;
  };
  const best = (hits: readonly number[]): string | null => {
    if (!hits.length) return null;
    const prose = hits.find((i) => !looksLikeList(all()[i]!));
    return all()[prose ?? hits[0]!] ?? null;
  };
  const needleIn = (sentence: string, names: readonly string[]): string | null => {
    const lower = sentence.toLowerCase();
    return names.find((n) => n && lower.includes(n.toLowerCase())) ?? null;
  };
  const termHits = (term: string): number[] => {
    const hits: number[] = [];
    all().forEach((sentence, i) => {
      if (mentions(normalizeText(sentence), term)) hits.push(i);
    });
    return hits;
  };
  return {
    ofSkill(id, names, postingStrings) {
      const shows = (i: number): boolean => textShowsSkill(vocabulary, id, all()[i]!, postingStrings);
      let sentence = best((index().get(id) ?? []).filter(shows));
      // A name the scan reads differently ("C#", a spelling with punctuation) is still found as it is written.
      if (!sentence) sentence = best([...new Set(names.flatMap((n) => ([...n.trim()].length >= 2 ? termHits(n) : [])))].sort((a, b) => a - b).filter(shows));
      return sentence ? clipQuote(sentence, needleIn(sentence, names)) : null;
    },
    ofTerm(term) {
      if ([...term.trim()].length < 2) return null;
      const sentence = best(termHits(term));
      return sentence ? clipQuote(sentence, term) : null;
    },
  };
}

// ── Rows ──────────────────────────────────────────────────────────────────

const RANK: Record<KeywordState, number> = { shown: 2, related: 1, not_shown: 0 };

interface Entry {
  item: KeywordItem;
  /** Every string the posting writes the skill as, for the quote. */
  names: string[];
}

/** One item from a check; null when nothing may be said (`unscored`). */
function toItem(term: string, skillId: string | null, check: SkillCheck, required: boolean | undefined): KeywordItem | null {
  if (check.state === 'unscored') return null;
  return {
    term,
    state: check.state,
    found: check.state !== 'not_shown',
    skillId,
    ...(check.state === 'related' && check.via ? { via: check.via } : {}),
    quote: null,
    ...(required === undefined ? {} : { required }),
  };
}

/**
 * `withheld`: how many skills or keywords of the posting the row leaves out
 * because nothing may be said about them. A row that lists nothing for that
 * reason is `not_checked`: the posting does state them. The skills row also
 * says how many (`unchecked`); a count of loose keywords would say nothing.
 */
function rowOf(key: 'skills' | 'keywords', items: KeywordItem[], withheld = 0): KeywordRow {
  const shown = items.filter((i) => i.state === 'shown').length;
  const related = items.filter((i) => i.state === 'related').length;
  return {
    key,
    status: !items.length && withheld > 0 ? 'not_checked' : ratioStatus(shown + RELATED_ITEM_POINTS * related, items.length),
    need: null,
    have: null,
    found: items.length ? shown + related : null,
    total: items.length || null,
    items,
    ...(key === 'skills' && withheld > 0 ? { unchecked: withheld } : {}),
  };
}

export function buildKeywordRows(input: {
  job: KeywordRowsJob;
  user: MatchUser;
  /** Resume text (markdown) the check reads; '' when the user has none. */
  resumeText: string;
  keywords: KeywordInput[] | null;
  /** The language skill labels are written in; default: the person's, else the posting's, else the market's. */
  locale?: string | null;
}): KeywordRow[] {
  const { job, user } = input;
  const vocabulary = currentVocabulary();
  const locale = input.locale?.trim() || labelLocaleFor(job, user);
  // The resume this check was asked about (a tailoring version, or the primary): the same rule as the fit reads it by.
  const person: ShownSource = { skills: user.skills, resumeTextNorm: normalizeText(input.resumeText), recentTitle: user.recentTitle, locale };
  const skillSet = new Set(user.skills.map(skillKey));
  const quotes = createQuoteFinder(input.resumeText, vocabulary);
  const reviewedHard = (id: string | null): id is string => !!id && vocabulary.reviewed(id) && vocabulary.kindOf(id) !== 'soft';
  const labelOf = (id: string, fallback: string): string => vocabulary.label(id, locale) || displayTerm(fallback);

  // Title and level: the posting's role against the roles the person's own record shows (never the saved search).
  const overlap = titleOverlap(user, job);
  const title: KeywordRow = {
    key: 'title',
    status: overlap === null ? 'unknown' : overlap >= 1 ? 'met' : overlap >= 0.6 ? 'partly' : 'not_met',
    need: job.title,
    have: user.recentTitle ?? null,
    found: null,
    total: null,
    items: [],
  };

  const years: KeywordRow = {
    key: 'years',
    status: job.minYears === null ? 'not_stated' : user.yearsExperience === null ? 'unknown' : user.yearsExperience >= job.minYears ? 'met' : 'not_met',
    need: job.minYears,
    have: user.yearsExperience,
    found: null,
    total: null,
    items: [],
  };

  const meets = degreeMeets(user.highestDegree, job.educationLevel);
  const education: KeywordRow = {
    key: 'education',
    status: !job.educationLevel || job.educationLevel === 'none' ? 'not_stated' : meets === null ? 'unknown' : meets ? 'met' : 'not_met',
    need: job.educationLevel && job.educationLevel !== 'none' ? job.educationLevel : null,
    have: user.highestDegree,
    found: null,
    total: null,
    items: [],
  };

  // ── Skills: one item per skill ──
  const canonical = carriesSkillIds(job);
  const entries = new Map<string, Entry>();
  /** Ids of skills the row says nothing about (not reviewed, a guess, an ambiguous certificate): no keyword may answer for them either. */
  const withheld = new Set<string>();
  let unchecked = 0;
  for (const s of jobSkillList(job, locale)) {
    if (s.kind === 'soft') continue;
    // A posting without ids: the vocabulary still says which strings are one skill, and how that skill is written.
    const id = canonical ? s.skillId : vocabulary.idOf(s.term);
    if (id && vocabulary.kindOf(id) === 'soft') continue;
    // A guess of the nearest vector is not a name the vocabulary knows.
    const known = reviewedHard(id) && !s.guessed;
    // A posting that carries ids lists its reviewed skills only, each by its id: a skill nobody has reviewed, a guess
    // and a string enrichment could not map are neither claimed nor denied here. A posting without ids lists every
    // hard skill, by its string and by the vocabulary.
    const check = canonical ? (known ? jobSkillCheck(person, s, { locale, skillSet }) : null) : listedSkillCheck(person, s.skill, known ? id : null, { locale, skillSet });
    const item = check ? toItem(known ? labelOf(id, s.term) : s.skill, known ? id : null, check, s.required) : null;
    if (!item) {
      unchecked += 1;
      if (id) withheld.add(id);
      continue;
    }
    const key = known ? `id:${id}` : `term:${termKey(s.term)}`;
    const twin = entries.get(key);
    if (!twin) {
      entries.set(key, { item, names: postingStringsOf(s) });
      continue;
    }
    // The same skill under another spelling: one item, with the better of the two answers.
    twin.names.push(...postingStringsOf(s));
    twin.item.required = twin.item.required === true || s.required;
    if (RANK[item.state] > RANK[twin.item.state]) {
      twin.item.state = item.state;
      twin.item.found = item.found;
      if (item.via) twin.item.via = item.via;
      else delete twin.item.via;
    }
  }
  const skillEntries = [...entries.values()].slice(0, MAX_SKILLS);
  for (const e of skillEntries) {
    if (e.item.state !== 'shown') continue;
    e.item.quote = e.item.skillId
      ? quotes.ofSkill(e.item.skillId, [...namesOf(vocabulary, e.item.skillId), ...e.names], e.names)
      : (e.names.map((n) => quotes.ofTerm(n)).find((q) => !!q) ?? null);
  }
  const skills = rowOf('skills', skillEntries.map((e) => e.item), unchecked);

  // ── Keywords: concrete, reviewed terms only, and nothing the skills row already lists ──
  const listedIds = new Set(skillEntries.map((e) => e.item.skillId).filter((x): x is string => !!x));
  const listedTerms = new Set(skillEntries.flatMap((e) => e.names.map((n) => termKey(n))));
  const kw: KeywordItem[] = [];
  /** High and medium keywords left out because nothing may be said about them (no reviewed skill, or a trace with another reading). */
  let keywordsWithheld = 0;
  for (const k of input.keywords ?? []) {
    if (!k || typeof k.keyword !== 'string' || !k.keyword.trim() || k.importance === 'low') continue;
    if (kw.length >= MAX_KEYWORDS) break;
    // The skills row already lists it, or a reviewer ruled the string is not a skill.
    if (listedTerms.has(termKey(k.keyword)) || vocabulary.isDropped(k.keyword)) continue;
    const ids = keywordSkillIds(k, vocabulary);
    // Without a reviewed id a keyword is not listed: it is neither claimed nor denied.
    if (!ids.length) keywordsWithheld += 1;
    for (const id of ids) {
      if (kw.length >= MAX_KEYWORDS) break;
      // A soft skill is never listed; one the skills row lists, or already counted as left out, is not repeated.
      if (vocabulary.kindOf(id) === 'soft' || listedIds.has(id) || withheld.has(id)) continue;
      // The same rule as a skill of this posting: by id when the posting carries ids, else by the string and the vocabulary.
      const asSkill: JobSkill = { skill: displayTerm(k.keyword), skillId: id, required: false, kind: 'hard', term: k.keyword };
      const check = !reviewedHard(id) ? null : canonical ? jobSkillCheck(person, asSkill, { locale, skillSet }) : listedSkillCheck(person, k.keyword, id, { locale, skillSet });
      const item = check ? toItem(labelOf(id, k.keyword), id, check, undefined) : null;
      if (!item) {
        keywordsWithheld += 1;
        withheld.add(id);
        continue;
      }
      if (item.state === 'shown') item.quote = quotes.ofSkill(id, [...namesOf(vocabulary, id), k.keyword], [k.keyword]);
      listedIds.add(id);
      kw.push(item);
    }
  }
  const keywords = rowOf('keywords', kw, keywordsWithheld);

  return [title, years, education, skills, keywords];
}

/**
 * The skills a keyword names. The id enrichment v3 stored with it, when the
 * vocabulary holds that id (itself, or the skill it was merged into). A
 * keyword without one (every row written before enrichment v3 holds words by
 * frequency) is read like the words of a sentence: "postgres" and "rest apis"
 * name a skill, while "go", "rest", "express", "spring" and "shell" are
 * ordinary words first and "work day" is not Workday.
 */
function keywordSkillIds(k: KeywordInput, vocabulary: SkillSnapshot): string[] {
  const stored = typeof k.skillId === 'string' && k.skillId.trim() ? k.skillId.trim() : null;
  const id = stored ? (vocabulary.kindOf(stored) !== null ? stored : vocabulary.idOf(stored)) : null;
  return id ? [id] : skillIdsInText(k.keyword, { vocabulary });
}

/** The names the vocabulary has for a skill, as they are written. */
function namesOf(vocabulary: SkillSnapshot, id: string): string[] {
  const r = vocabulary.record(id);
  return r ? [r.labelEn, r.labelZh, r.labelZhHant, ...r.aliases].filter((n): n is string => !!n) : [];
}
