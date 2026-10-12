// server/src/features/jobs/enrich/ageLimit.ts
//
// Does a posting state an age limit for the applicant? (MARKET_STRATEGY 2.5,
// row "Eligibility": on GoApply an age cap is flagged, never used to filter
// users.)
//
// The answer is the posting's own sentence, or null. It is read by rules, not
// by a model, so it is the same on a rules-only pass. Two uses in reconcile.ts:
//   - the part of a requirement line that states the applicant's age is never
//     stored as a requirement (an age is never an input of a score or a
//     filter, in any market); what else the line asks for stays;
//   - on GoApply the sentence is recorded as the market tag
//     `age_limit_stated` with its quote, so the card can flag the posting.
//
// A line is read clause by clause (cut at ， , ； ; 、 。). A clause can hold an
// age BOUND: an upper bound ("35岁以下", "不超过40周岁", "under 35 years old"), a
// range ("22-35岁", "aged 25 to 40"), a lower bound ("30岁以上", "at least 21
// years of age") or a birth-year bound ("1990年以后出生"). Ages are two digits,
// so "3-6岁" is never one.
//
// A bound says nothing yet about WHOSE age it is: "负责18-35岁女性护肤产品的市场
// 推广" and "Experience caring for adults 65 and older" describe the people a
// job serves. So a bound counts as the applicant's only on positive evidence,
// one of two:
//   (a) the clause says so: 年龄 (not "用户年龄", "学员年龄") leads to the bound
//       ("年龄35岁以下", "年龄要求：22-35岁"); in English "must be", "should be",
//       "applicants", "candidates" lead to it, or the bound is labelled
//       ("maximum age of 40", "age limit: 35");
//   (b) the clause holds nothing but the bound ("35周岁以下", "女性25-35岁",
//       "须年满18周岁", "Aged 22-35"), and nothing earlier in the sentence
//       introduces an audience ("目标人群：大学生、18-35岁" is not a limit).
// A bound inside a longer clause with neither is left alone: a posting the
// rule misses gets no flag, and one it flags shows its own sentence.
//
// The legal working age ("年满18周岁", "must be 18 or older") is an age clause
// (no requirement) but not a limit an employer chose: it is not flagged.
// Pure; no I/O.

import { MAX_QUOTE_CHARS } from './schema.js';
import { normalizeForQuote } from './quotes.js';
import { splitSentences } from './scamSignals.js';

/** The market tag enrichment records for a stated age limit (GoApply only). */
export const AGE_LIMIT_TAG = 'age_limit_stated';

/** The legal working age: a lower bound at or under it is not an age limit. */
const WORKING_AGE = 18;

// ── Bounds ────────────────────────────────────────────────────────────────
// Every pattern runs on a clause after `normalizeForQuote` (NFKC: full-width
// punctuation and digits are ASCII; dashes are "-"; lower case).

const AGE = '(\\d{2})\\s*(?:周|週)?\\s*[岁歲]';
const INCLUSIVE = '(?:\\(\\s*含\\s*\\)\\s*)?(?:及|含)?\\s*';
/** "1990年以后出生", "1988年1月1日之后出生", "1995年后生人". Not "2018年以后生产的设备": 生 alone must end the phrase. */
const ZH_BIRTH = /(?:19|20)\d{2}\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?\s*(?:以后|以後|之后|之後|后|後)\s*(?:出生|生(?=人|的?\s*$|[\s,。;、)]))(?:人|的)?/;
/** "22-35岁", "25至40周岁", "20岁到35岁". */
const ZH_RANGE = new RegExp(`(\\d{2})\\s*(?:周|週)?\\s*[岁歲]?\\s*(?:-|~|至|到)\\s*${AGE}`);
/** "35岁以下", "35周岁以内", "45岁(含)以下". */
const ZH_CAP = new RegExp(`${AGE}\\s*${INCLUSIVE}(?:以下|以内|以內|之内|之內)`);
/** "不超过35岁", "不大于40周岁", "限35岁", "小于30岁" (and not "限18岁以上", which is a lower bound). */
const ZH_CAP_BEFORE = new RegExp(`(?:不超过|不超過|不大于|不大於|不高于|不高於|不得超过|不得超過|小于|小於|低于|低於|限)\\s*${AGE}(?!\\s*${INCLUSIVE}以上)`);
/** "30岁以上", "年满25周岁". */
const ZH_MIN = new RegExp(`${AGE}\\s*${INCLUSIVE}以上|(?:年满|年滿|满|滿)\\s*${AGE}(?:\\s*${INCLUSIVE}以上)?`);

const EN_YEARS = '(?:\\s*(?:years?|yrs?)(?:\\s*old|\\s*of age)?)?';
/** "under 35 years old", "no older than 40", "maximum age of 35", "age limit: 35". */
const EN_CAP = new RegExp(`\\b(?:under|below|younger than|not over|not older than|no older than|(maximum age(?: of)?|age limit(?: of)?|max(?:imum)? age)\\s*:?)\\s*(\\d{2})\\b${EN_YEARS}`);
/** "aged 22-35", "age: 25 to 40", "between 22 and 35 years old", "25-40 years old". */
const EN_RANGE = new RegExp(
  `\\b(?:ages?|aged|age range|between)\\s*:?\\s*(?:of\\s*|between\\s*|from\\s*)?(\\d{2})\\s*(?:-|to|and)\\s*(\\d{2})\\b${EN_YEARS}|\\b(\\d{2})\\s*(?:-|to)\\s*(\\d{2})\\s*(?:years? old|years? of age|yrs? old)\\b`,
);
/** "at least 21 years of age", "over 18 years old", "minimum age of 25", "21 or older", "25 years old and above". */
const EN_MIN =
  /\b(?:at least|over)\s*(\d{2})\s*(?:\+\s*)?(?:years? old|years? of age|yrs? old)\b|\b(minimum age(?: of)?|min(?:imum)? age)\s*:?\s*(\d{2})\b|\b(\d{2})\s*(?:\+\s*)?(?:years? old|years? of age|yrs? old)?\s*(?:or|and)\s*(?:older|above|over)\b/;
/** The clause speaks of a person's age at all ("under 35 accounts" does not). */
const EN_AGE_WORDS = /\b(?:age|ages|aged|years? old|years? of age|yrs? old|or older|and older)\b/;

interface AgeBound {
  kind: 'cap' | 'range' | 'min' | 'birth';
  /** The lower bound, for `min`. */
  low?: number;
  /** Where the bound stands in the clause. */
  start: number;
  end: number;
  /** The bound names itself an age rule ("maximum age of 40"). */
  labelled?: boolean;
}

const span = (m: RegExpExecArray): { start: number; end: number } => ({ start: m.index, end: m.index + m[0].length });

/** The age bound a (normalized) clause states, whoever it is about; null when it states none. */
function boundOf(clause: string): AgeBound | null {
  const birth = ZH_BIRTH.exec(clause);
  if (birth) return { kind: 'birth', ...span(birth) };
  const range = ZH_RANGE.exec(clause);
  if (range && Number(range[1]) < Number(range[2])) return { kind: 'range', ...span(range) };
  const cap = ZH_CAP.exec(clause) ?? ZH_CAP_BEFORE.exec(clause);
  if (cap) return { kind: 'cap', ...span(cap) };
  const min = ZH_MIN.exec(clause);
  if (min) return { kind: 'min', low: Number(min[1] ?? min[2]), ...span(min) };
  if (!EN_AGE_WORDS.test(clause)) return null;
  const enRange = EN_RANGE.exec(clause);
  if (enRange && Number(enRange[1] ?? enRange[3]) < Number(enRange[2] ?? enRange[4])) return { kind: 'range', ...span(enRange) };
  const enCap = EN_CAP.exec(clause);
  if (enCap) return { kind: 'cap', labelled: !!enCap[1], ...span(enCap) };
  const enMin = EN_MIN.exec(clause);
  if (enMin) return { kind: 'min', low: Number(enMin[1] ?? enMin[3] ?? enMin[4]), labelled: !!enMin[2], ...span(enMin) };
  return null;
}

// ── Whose age ─────────────────────────────────────────────────────────────

/** 年龄 leading straight to the bound: "年龄", "年龄要求：", "年龄须在", "年龄原则上". */
const ZH_AGE_LEAD = /(?:年龄|年齡|年纪|年紀)(?:要求|限制|条件|條件|范围|範圍)?\s*:?\s*(?:原则上|原則上|一般)?\s*(?:必须|必須|须|須|需|应|應|要求|限|控制)?\s*(?:在|为|為)?\s*$/;
/** …unless that 年龄 belongs to the people a job serves: "用户年龄", "学员的年龄", "服务对象年龄" (not "招聘对象年龄"). */
const ZH_AGE_OWNER =
  /(?:用户|用戶|客户|客戶|顾客|顧客|学员|學員|学生|學生|患者|病人|受众|受眾|人群|群体|群體|客群|孩子|儿童|兒童|幼儿|幼兒|玩家|观众|觀眾|消费者|消費者|会员|會員|粉丝|粉絲|读者|讀者|居民|老人|长者|長者|目标|目標|平均|(?<!招聘|应聘|應聘)(?:对象|對象))的?\s*$/;
/** "must be", "applicants", "candidates who are" leading straight to the bound. */
const EN_APPLICANT_LEAD = /(?:\b(?:must|should|shall|will|needs? to|ha(?:s|ve) to|required to|is to|are to)\s+be|\b(?:applicants?|candidates?)(?:\s+(?:who are|must be|should be))?)(?:\s+aged)?\s*$/;

/** The clause itself says the bound is the applicant's. */
function leadsToBound(clause: string, bound: AgeBound): boolean {
  if (bound.labelled) return true;
  const before = clause.slice(0, bound.start);
  const zh = ZH_AGE_LEAD.exec(before);
  if (zh) return !ZH_AGE_OWNER.test(before.slice(0, zh.index));
  return EN_APPLICANT_LEAD.test(before);
}

/** Words that may stand beside a bound in a clause that says nothing else: headings, gender, "required", "preferred". */
const BESIDE_A_BOUND = new RegExp(
  [
    '(?:年龄|年齡|年纪|年紀)(?:要求|限制|条件|條件|范围|範圍)?',
    '(?:任职|任職|岗位|崗位|职位|職位|招聘|应聘|應聘|基本|其他|其它|入职|入職|录用|錄用|硬性)?(?:要求|条件|條件|资格|資格)',
    '招聘对象|招聘對象|应聘者|應聘者|申请人|申請人|候选人|候選人|求职者|求職者|应届毕业生|應屆畢業生|应届生|應屆生|毕业生|畢業生|人员|人員',
    '男女不限|性别不限|性別不限|性别|性別|男性|女性|不限',
    '原则上|原則上|一般|必须|必須|之间|之間|优先|優先|均可|为宜|為宜|为佳|為佳|即可|左右|周岁|週歲|以内|以內',
    '[男女须須需应應限为為在者的含岁歲]',
    '\\b(?:must|should|shall|will|need|needs|have|has|to|be|is|are|applicants?|candidates?|you|we|prefer|preferred|requires?|required|requirements?|only|please|age|aged|ages|years?|yrs?|old|of|the|a|an|for|this|role|position|job|apply|eligible|in|order|who)\\b',
  ].join('|'),
  'g',
);
/** What a leftover run may consist of and still say nothing: a heading, a gender note, "applicants are preferred". */
const SAYS_NOTHING = new RegExp(
  [
    '(?:年龄|年齡|年纪|年紀)(?:要求|限制|条件|條件|范围|範圍)?',
    '(?:任职|任職|岗位|崗位|职位|職位|招聘|应聘|應聘|基本|其他|其它|入职|入職|录用|錄用|硬性)?(?:要求|条件|條件|资格|資格)',
    '男女不限|性别不限|性別不限|性别|性別|男性|女性|不限|优先|優先',
    '[男女]',
    '\\b(?:applicants?|candidates?|must|should|be|is|are|preferred|required|requirements?|only|please|and|or|the|a|an)\\b',
  ].join('|'),
  'g',
);
const LETTER = /\p{L}/u;

/** Nothing is left of `text` once the words of `filler` are taken out. */
function nothingBut(text: string, filler: RegExp): boolean {
  return !LETTER.test(text.replace(filler, ' '));
}

/**
 * Words that introduce the people a job serves. A clause that is only a
 * bound, standing after one of them in the same sentence, is part of that
 * description ("目标人群：大学生、18-35岁", "programs for youth, ages 10-18").
 */
const AUDIENCE_INTRO =
  /面向|针对|針對|服务于|服務於|服务|服務|目标|目標|定位|受众|受眾|人群|客群|群体|群體|用户|用戶|客户|客戶|顾客|顧客|消费者|消費者|患者|学员|學員|玩家|观众|觀眾|会员|會員|粉丝|粉絲|\b(?:children|kids?|pupils?|students?|learners?|patients?|customers?|users?|audience|toddlers?|teens?|teenagers?|seniors?|residents?|consumers?|shoppers?|adults?|youth|clients?|members?|participants?|individuals|population|demographic|campers?)\b/;

interface Clause {
  /** Where the clause stands in the line (the separators are outside it). */
  start: number;
  end: number;
  /** The applicant's age bound the clause states, or null. */
  bound: AgeBound | null;
}

const CLAUSE_END = /[，,；;、。]/g;

/** The clauses of a line, each with the applicant's age bound it states (or none). */
function clausesOf(line: string): Clause[] {
  const out: Clause[] = [];
  let start = 0;
  let before = '';
  const push = (end: number) => {
    const raw = line.slice(start, end);
    const clause = normalizeForQuote(raw);
    let bound = clause ? boundOf(clause) : null;
    if (bound && !leadsToBound(clause, bound)) {
      const rest = `${clause.slice(0, bound.start)} ${clause.slice(bound.end)}`;
      if (!nothingBut(rest, BESIDE_A_BOUND) || AUDIENCE_INTRO.test(before)) bound = null;
    }
    out.push({ start, end, bound });
    before += ` ${clause}`;
  };
  for (const m of line.matchAll(CLAUSE_END)) {
    push(m.index);
    start = m.index + m[0].length;
  }
  push(line.length);
  return out;
}

const isLimit = (bound: AgeBound): boolean => !(bound.kind === 'min' && (bound.low ?? 0) <= WORKING_AGE);

/** What one line says about the applicant's age, and what else it says. */
export interface AgeReading {
  /** A clause of the line is about the applicant's age (the legal working age included). */
  age: boolean;
  /** A clause states a limit an employer chose (anything but the legal working age). */
  limit: boolean;
  /**
   * The line without its age clauses: each run of the other clauses, as the
   * line writes it (a substring of the line, trimmed), in order. A run that
   * says nothing ("男女不限", "Applicants", a list number) is left out. Empty
   * when the line is about age and nothing else. Without an age clause it is
   * the line itself.
   */
  rest: string[];
}

/** Read one line (a sentence of a posting, or a requirement line a model returned). */
export function readAge(line: string): AgeReading {
  const clauses = clausesOf(line);
  const aged = clauses.filter((c) => c.bound);
  if (!aged.length) return { age: false, limit: false, rest: line.trim() ? [line.trim()] : [] };
  const rest: string[] = [];
  let runStart: number | null = null;
  let runEnd = 0;
  const close = () => {
    if (runStart === null) return;
    const run = line.slice(runStart, runEnd).trim();
    if (run && !nothingBut(normalizeForQuote(run), SAYS_NOTHING)) rest.push(run);
    runStart = null;
  };
  for (const c of clauses) {
    if (c.bound) {
      close();
      continue;
    }
    runStart ??= c.start;
    runEnd = c.end;
  }
  close();
  return { age: true, limit: aged.some((c) => isLimit(c.bound!)), rest };
}

/**
 * True when `text` (one line, such as a requirement line the model returned)
 * speaks of the applicant's age, the legal working age included ("Must be 18
 * or older"): that part of a line is never a requirement a resume is checked
 * against (`readAge(text).rest` is what else the line asks for).
 */
export function isAgeLine(text: string): boolean {
  return readAge(text).age;
}

/**
 * The posting's own sentence that states an age limit for the applicant (the
 * first one, at most MAX_QUOTE_CHARS characters), or null when it states
 * none. The legal working age ("年满18周岁", "must be 18 or older") is not a
 * limit an employer chose and is not reported.
 */
export function ageLimitQuote(postingText: string): string | null {
  for (const sentence of splitSentences(postingText)) {
    if (!readAge(sentence.text).limit) continue;
    const quote = sentence.text.replace(/\s+/g, ' ').trim();
    return quote.length > MAX_QUOTE_CHARS ? quote.slice(0, MAX_QUOTE_CHARS).trimEnd() : quote;
  }
  return null;
}
