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
// Deterministic for a given text: ties break pair first, then alphabetically.

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
