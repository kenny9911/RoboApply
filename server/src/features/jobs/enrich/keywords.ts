// server/src/features/jobs/enrich/keywords.ts
//
// The `RAKeywordExtraction` row (ARCHITECTURE.md §4.5 step 3; SM-6, MATCH
// 4.6): the keywords of a posting, at most 30. A keyword is a concrete,
// canonical term and nothing else:
//   (a) a skill of the posting that has a canonical id and is a hard skill or
//       a certification: importance `high` when required, `medium` otherwise.
//       A skill whose id is a machine guess (`via: 'embedding'`) is not one:
//       it is shown on the card from `skillsDetail`, and no keyword may answer
//       "not in your resume" on the strength of a guess;
//   (b) a term of the posting's own text that the vocabulary resolves to a
//       REVIEWED hard skill or certification: importance `low`. The TF-IDF
//       terms come first, best first; then the names those terms cannot hold,
//       found by the vocabulary's own scan of the text: several words written
//       once ("REST APIs"), "C++", and a Chinese name the word segmenter cuts
//       in two (机器学习).
// Everything else is dropped at the source: generic words ("software
// engineering", "communication"), soft skills, a skill the vocabulary does not
// hold, and phrases of the text with no canonical id ("shared backend
// systems"). One skill is one keyword, whatever its spellings (`skillId`).
//
// The terms of (b) are TF-IDF terms. One job has no corpus, so the
// "documents" for IDF are the posting's own sentences: a term that appears in
// every sentence ("we", "team") scores low, a term concentrated in a few
// sentences scores high. Score = (1 + ln tf) × ln(1 + N / df). Words come from
// `Intl.Segmenter` (ICU word boundaries, which also segments Chinese), minus
// stopwords and numbers; Latin bigrams seen at least twice ("machine
// learning") compete as well. Deterministic for a given text: ties break pair
// first, then alphabetically. The vocabulary is read synchronously
// (`idOf`): no model and no embedding call is made here.

import { splitSentences } from './scamSignals.js';
import type { SkillKind } from '../../skills/index.js';

export const MAX_KEYWORDS = 30;

export type KeywordImportance = 'high' | 'medium' | 'low';

/** `RAKeywordExtraction.keywords` entry. */
export interface JobKeyword {
  /** The term as the posting writes it (lower case). Readers label it from the vocabulary by `skillId`. */
  keyword: string;
  importance: KeywordImportance;
  /** Occurrences in the posting text (0 when a skill is named only in provider fields). */
  frequency: number;
  /** The canonical skill (RASkill id). Every keyword written since ENRICH_VERSION 3 has one. */
  skillId: string;
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
    'every day days time full part based within environment level levels high highly key ' +
    // Generic posting words that are never part of a skill (FIX-3): hiring boilerplate, pay, equal-opportunity wording and filler.
    'ideal ideally successful seeking seek hiring hire hired responsible responsibility duties duty tasks task requirement ' +
    'qualification nice bonus salary pay range hourly onsite on-site relocation equal opportunity affirmative gender race ' +
    'religion age origin sexual protected disability veteran veterans status orientation reasonable regard without ' +
    'applicable eligible about us overview description summary values ' +
    'person individual individuals will shall need needed want wants should would could also both either neither often ' +
    'always never ever much many various several multiple different other others another etc e.g i.e eg ie including ' +
    'included includes such like understanding understand familiar familiarity proficient proficiency proficiently ' +
    'demonstrated proven excellent exceptional outstanding stronger best better effective effectively efficiently ' +
    'successfully ensuring providing supporting helping assist assisting contribute contributing participate drive driving ' +
    'manage managing develop developing create creating maintain maintaining worked collaborate collaborating collaboration ' +
    'closely cross cross-functional fast paced fast-paced growing world class world-class industry-leading ' +
    'degree bachelor bachelors bachelor’s masters master’s phd diploma www http https com org'
  ).split(/\s+/),
);

/**
 * Words that say nothing on their own in a posting ("remote", "benefits",
 * "office", "growth", "lead") but are part of real terms: "paid search",
 * "growth marketing", "Microsoft Office", "identity management", "functional
 * programming", "deep learning", "computer vision", "customer success",
 * "compensation and benefits". They are never a keyword alone; in a pair the
 * posting repeats, with the word right next to them, they are kept. They stay
 * in the token stream, so the pairs can form.
 */
const EN_ALONE_STOPWORDS = new Set(
  (
    'paid growth functional office offices identity compensation benefit benefits employment employer employers ' +
    'employee employees staff travel field fields people culture remote hybrid lead leading build building action location ' +
    'locations accommodation accommodations national eligibility annual ' +
    'mission vision member members needs success dynamic industry master deep solid'
  ).split(/\s+/),
);

const ZH_STOPWORDS = new Set([
  '的', '了', '和', '与', '與', '及', '或', '在', '是', '有', '等', '对', '對', '为', '為', '以', '并', '並', '能', '会', '會', '将', '將',
  '我们', '我們', '你', '您', '公司', '岗位', '崗位', '职位', '職位', '工作', '负责', '負責', '相关', '相關', '以上', '优先', '優先',
  '具有', '具备', '具備', '良好', '能力', '经验', '經驗', '要求', '任职', '任職', '职责', '職責', '熟悉', '进行', '進行', '团队', '團隊',
  '一定', '以及', '包括', '可以', '需要', '提供', '我', '他', '她', '其', '者', '中', '上', '下', '年', '个', '個',
  // Section headings and boilerplate of Chinese postings (FIX-3; Simplified and Traditional): never a skill.
  '岗位职责', '崗位職責', '工作职责', '工作職責', '职位描述', '職位描述', '岗位描述', '崗位描述', '工作内容', '工作內容', '职位要求', '職位要求',
  '任职要求', '任職要求', '任职资格', '任職資格', '岗位要求', '崗位要求', '职位信息', '職位資訊', '工作地点', '工作地點', '工作时间', '工作時間',
  '薪资', '薪資', '薪酬', '待遇', '福利', '福利待遇', '薪资福利', '薪資福利', '五险一金', '五險一金', '带薪', '帶薪', '年假', '年终奖', '年終獎', '奖金', '獎金', '补贴', '補貼',
  '学历', '學歷', '本科', '大专', '大專', '硕士', '碩士', '博士', '以上学历', '以上學歷', '专业', '專業', '相关专业', '相關專業', '毕业', '畢業', '应届', '應屆',
  '工作经验', '工作經驗', '年以上', '以上经验', '以上經驗', '优先考虑', '優先考慮', '者优先', '者優先', '加分', '加分项', '加分項',
  '能够', '能夠', '较强', '較強', '较好', '較好', '优秀', '優秀', '熟练', '熟練', '掌握', '了解', '精通', '具有', '拥有', '擁有', '善于', '善於', '积极', '積極', '认真', '認真',
  '完成', '参与', '參與', '协助', '協助', '配合', '支持', '保证', '保證', '确保', '確保', '根据', '根據', '通过', '通過', '按照', '以及', '或者', '并且', '並且', '同时', '同時',
  '我们', '我們', '你将', '你將', '您将', '您將', '欢迎', '歡迎', '加入', '投递', '投遞', '简历', '簡歷', '履歷', '面试', '面試', '招聘', '招募', '人才', '员工', '員工', '同事',
  '企业', '企業', '行业', '行業', '平台', '业务', '業務', '部门', '部門', '项目', '項目', '专案', '專案', '日常', '其他', '其它', '以下', '如下', '例如', '方面', '方向', '内容', '內容', '情况', '情況',
  '描述', '地点', '地點', '时间', '時間', '资格', '資格', '信息', '資訊', '考虑', '考慮', '职能', '職能', '类别', '類別', '性质', '性質', '人数', '人數', '若干',
  '沟通能力', '溝通能力', '团队合作', '團隊合作', '团队协作', '團隊協作', '责任心', '責任心', '学习能力', '學習能力', '抗压能力', '抗壓能力', '执行力', '執行力',
  // More of the same (SM-6): requirement and preference wording, and generic qualities. None of it names a tool, a method or a certificate.
  '相关经验', '相關經驗', '相关工作', '相關工作', '相关工作经验', '相關工作經驗', '相关领域', '相關領域', '从业经验', '從業經驗', '实际经验', '實際經驗', '项目经验', '項目經驗', '專案經驗',
  '任职条件', '任職條件', '应聘要求', '應聘要求', '招聘要求', '基本要求', '岗位说明', '崗位說明', '职位详情', '職位詳情', '职责描述', '職責描述', '工作要求', '职位职责', '職位職責',
  '优先条件', '優先條件', '加分条件', '加分條件', '优先录用', '優先錄用', '优先录取', '優先錄取', '者优先考虑', '者優先考慮', '尤佳', '为佳', '為佳', '更佳', '不限',
  '我们希望', '我們希望', '我们提供', '我們提供', '我们需要', '我們需要', '你需要', '您需要', '希望你', '希望您', '如果你', '如果您', '期待', '期望',
  '及以上', '或以上', '以上者', '左右', '至少', '不少于', '不少於', '不低于', '不低於', '若干名', '数名', '數名',
  '团队精神', '團隊精神', '团队意识', '團隊意識', '合作精神', '协作能力', '協作能力', '协调能力', '協調能力', '沟通协调', '溝通協調', '表达能力', '表達能力', '逻辑思维', '邏輯思維',
  '责任感', '責任感', '吃苦耐劳', '吃苦耐勞', '积极主动', '積極主動', '工作认真', '工作認真', '认真负责', '認真負責', '踏实', '踏實', '细心', '細心', '耐心', '热情', '熱情', '主动性', '主動性', '自驱', '自驅',
  '快速学习', '快速學習', '抗压', '抗壓', '综合素质', '綜合素質', '职业素养', '職業素養', '敬业', '敬業', '诚信', '誠信', '上进心', '上進心',
  // The word segmenter cuts most of the phrases above in two, so their halves are listed too.
  '条件', '條件', '录用', '錄用', '录取', '錄取', '从业', '從業', '希望', '精神', '责任', '責任', '意识', '意識', '逻辑', '邏輯', '思维', '思維',
  '吃苦', '耐劳', '耐勞', '主动', '主動', '表达', '表達', '协调', '協調', '沟通', '溝通', '合作', '协作', '協作', '素质', '素質', '素养', '素養',
  '领域', '領域', '实际', '實際', '丰富', '豐富', '扎实', '紮實', '突出', '出色', '持有', '证书', '證書', '职业', '職業', '综合', '綜合', '快速', '学习', '學習',
  '一年', '两年', '兩年', '二年', '三年', '四年', '五年', '六年', '八年', '十年', '多年',
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

interface Token {
  word: string;
  /**
   * Something other than a space stood between this word and the kept word
   * before it: punctuation, a number, or a dropped word that is not a plain
   * connective ("and", "or", "of", "&", "-", "/").
   */
  apart: boolean;
}

const CONNECTIVES = new Set(['and', 'or', 'of']);

function tokens(text: string): Token[] {
  const locale = CJK.test(text) ? 'zh' : 'en';
  const out: Token[] = [];
  let apart = false;
  for (const seg of segmenter(locale).segment(text.normalize('NFKC'))) {
    if (!seg.isWordLike) {
      if (!/^[\s&\-/+]*$/.test(seg.segment)) apart = true;
      continue;
    }
    const w = seg.segment.toLowerCase().replace(/^[-'.]+|[-'.]+$/g, '');
    const dropped = !w || /^\d+([.,]\d+)?$/.test(w) || w.length < 2 || (CJK.test(w) ? ZH_STOPWORDS.has(w) : EN_STOPWORDS.has(w));
    if (dropped) {
      if (!CONNECTIVES.has(w)) apart = true;
      continue;
    }
    out.push({ word: w, apart });
    apart = false;
  }
  return out;
}

/**
 * Word tokens of a sentence (lower case, stopwords and numbers removed), in
 * order. Words that only count inside a phrase (`EN_ALONE_STOPWORDS`) are
 * kept here; `tfidfTerms` leaves them out as keywords of their own.
 */
export function tokenize(text: string): string[] {
  return tokens(text).map((t) => t.word);
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
    const toks = tokens(sentence.text);
    const terms: string[] = toks.map((t) => t.word).filter((w) => !EN_ALONE_STOPWORDS.has(w));
    for (let i = 0; i + 1 < toks.length; i++) {
      const a = toks[i]!.word;
      const b = toks[i + 1]!.word;
      if (CJK.test(a) || CJK.test(b)) continue;
      // A word that only counts inside a phrase pairs with the word truly next to it
      // ("paid search", "compensation and benefits"), not across a comma or a dropped
      // word ("gender identity, national origin" is not "identity national").
      if (toks[i + 1]!.apart && (EN_ALONE_STOPWORDS.has(a) || EN_ALONE_STOPWORDS.has(b))) continue;
      terms.push(`${a} ${b}`);
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
  // On a tie the pair goes first, so the single word it covers is dropped below ("microsoft office", not "microsoft").
  const isPair = (t: string) => (t.includes(' ') ? 1 : 0);
  scored.sort((a, b) => b.score - a.score || isPair(b.term) - isPair(a.term) || a.term.localeCompare(b.term));
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
  /**
   * The canonical id enrichment mapped the skill to; null when the vocabulary
   * holds none. Left out (a row not yet enriched at version 3, or a pass that
   * stopped before the mapping): the vocabulary is asked by exact alias.
   */
  skillId?: string | null;
  /** The skill's kind when its id is given; else the vocabulary's. */
  kind?: SkillKind;
  /** How the id was found (`skillsDetail[].via`). `embedding` is a machine guess: never a keyword. */
  via?: 'alias' | 'embedding' | 'new' | 'none';
}

/** What the keyword list reads of the vocabulary: synchronous lookups only. */
export interface KeywordVocabulary {
  /** The id of the skill a LISTED term names, in any spelling or script. */
  idOf(term: string): string | null;
  /**
   * The skills a term taken from a SENTENCE names, by the vocabulary's own
   * rule for running text: a name that is also an ordinary word ("go", "rest",
   * "ML") names nothing there, and two words whose letters spell a tool are
   * not that tool ("work day"). Default: `idOf` of the whole term. Given a
   * whole posting it answers every skill the text names, in order of first
   * appearance.
   */
  idsInText?(term: string): string[];
  kindOf(id: string): SkillKind | null;
  reviewed(id: string): boolean;
  /** The skill's name in a locale ('' when it has none there). Used to write a keyword the scan of the whole text found. */
  label?(id: string, locale: string): string;
}

const isConcrete = (kind: SkillKind | null | undefined): boolean => kind === 'hard' || kind === 'certification';

/**
 * The keywords of a posting, at most MAX_KEYWORDS: its hard skills and
 * certifications that have a canonical id (required → high, preferred →
 * medium), then the terms of its text that name a reviewed hard skill or
 * certification (low). One entry per canonical skill. Without a vocabulary
 * only skills that carry their id and kind are kept.
 */
export function buildKeywords(text: string, skills: readonly KeywordSkillInput[], vocabulary: KeywordVocabulary | null = null, limit: number = MAX_KEYWORDS): JobKeyword[] {
  const out: JobKeyword[] = [];
  const seen = new Set<string>();
  const ordered = [...skills.filter((s) => s.required), ...skills.filter((s) => !s.required)];
  for (const s of ordered) {
    const key = s.skill.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || s.via === 'embedding') continue;
    const skillId = s.skillId === undefined ? (vocabulary?.idOf(key) ?? null) : s.skillId;
    if (!skillId || seen.has(skillId)) continue;
    const kind = s.skillId === undefined ? vocabulary?.kindOf(skillId) : (s.kind ?? vocabulary?.kindOf(skillId));
    if (!isConcrete(kind)) continue;
    seen.add(skillId);
    out.push({ keyword: key, importance: s.required ? 'high' : 'medium', frequency: countOccurrences(text, key), skillId });
    if (out.length >= limit) return out;
  }
  if (!vocabulary) return out;
  const idsOf = (term: string): string[] => {
    if (vocabulary.idsInText) return vocabulary.idsInText(term);
    const id = vocabulary.idOf(term);
    return id ? [id] : [];
  };
  for (const t of tfidfTerms(text, limit * 2)) {
    for (const skillId of idsOf(t.term)) {
      if (seen.has(skillId)) continue;
      if (!vocabulary.reviewed(skillId) || !isConcrete(vocabulary.kindOf(skillId))) continue;
      seen.add(skillId);
      // A pair of words that only contains the skill ("kafka pipelines") is listed by the word that names it.
      const naming = t.term.includes(' ') && vocabulary.idOf(t.term) !== skillId ? (t.term.split(' ').find((w) => idsOf(w).includes(skillId)) ?? t.term) : t.term;
      out.push({ keyword: naming, importance: 'low', frequency: countOccurrences(text, naming) || t.tf, skillId });
      if (out.length >= limit) return out;
    }
  }
  // Names the terms above cannot hold. Listed by the name the posting uses when it uses one of the skill's own.
  if (!vocabulary.idsInText) return out;
  for (const skillId of vocabulary.idsInText(text)) {
    if (seen.has(skillId)) continue;
    if (!vocabulary.reviewed(skillId) || !isConcrete(vocabulary.kindOf(skillId))) continue;
    seen.add(skillId);
    const names = ['zh', 'zh-TW', 'en'].map((locale) => (vocabulary.label?.(skillId, locale) ?? '').normalize('NFKC').toLowerCase().trim()).filter(Boolean);
    const written = names.find((name) => countOccurrences(text, name) > 0);
    const keyword = written ?? names[names.length - 1] ?? skillId;
    out.push({ keyword, importance: 'low', frequency: Math.max(1, countOccurrences(text, keyword)), skillId });
    if (out.length >= limit) break;
  }
  return out;
}
