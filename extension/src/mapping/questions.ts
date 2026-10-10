// extension/src/mapping/questions.ts — which questions are PROTECTED: they never
// get an AI answer (PRODUCT F-EXT-04; server PROTECTED_QUESTION_TYPES). They
// fill only from the answer bank or the profile, or are left to the user.

import { normalizeText } from '../adapters/_kit/options';
import type { ProtectedQuestionType } from '../shared/contract';

const SPONSORSHIP_RE = /sponsor|visa|签证|簽證|担保/;
const WORK_AUTH_RE =
  /authori[sz]ed to work|work authori[sz]ation|legally (eligible|authori[sz]ed|permitted|able) to work|right to work|eligible to work|work permit|citizenship|citizen|工作许可|工作許可|工作签|身份/;

/**
 * Grades and test scores: the same pattern as the server's
 * (server/src/features/extension/questionTypes.ts GRADES_RE;
 * test/contractParity.test.ts keeps the two equal). 成绩 and 排名 also mean
 * achievements and rankings at work, and "academic performance" or "test
 * results" turn up in open questions, so those words count only with a study
 * context next to them, or as the whole field label.
 */
export const GRADES_RE = new RegExp(
  [
    // The whole label and nothing else: "成绩", "排名情况", "Academic performance", "Exam results".
    String.raw`^[\s*:：?？()（）]*(?:成绩|成績|排名|academic\s+(?:performance|results?)|(?:test|exam(?:ination)?)\s+results?)(?:情况|情況)?[\s*:：?？()（）]*$`,
    String.raw`\bgpa\b|\bgrades\b|grade\s+(?:point|average)|class\s+rank|academic\s+(?:rank(?:ing)?|standing|record)`,
    String.raw`academic\s+(?:performance|results?)\s*[(:（：-]?\s*(?:gpa|grades?|scores?|marks?|percentage)`,
    String.raw`(?:test|exam(?:ination)?)\s+scores?|\byour\s+exam(?:ination)?\s+results?`,
    String.raw`\b(?:sat|act|gre|gmat|lsat|toeic|jlpt|hsk)\s*(?:scores?|results?|level|成绩|成績|分数|分數)`,
    String.raw`\bielts\b|\btoefl\b|\bcet[-\s]?[46]\b|\btem[-\s]?[48]\b`,
    '绩点|績點|四六级|四六級|四级|六级|四級|六級|英语等级|英語等級|雅思|托福|专四|专八|專四|專八|平均分|均分|考试分数|考試分數',
    // 成绩 with a study word in front (在校成绩, 大学期间取得的成绩), right after a subject
    // or an exam (英语成绩, 笔试成绩), or as 成绩单 / 成绩排名.
    '(?:学习|學習|在校|学业|學業|学校|學校|学期|學期|本科|硕士|碩士|博士|研究生|大学|大學|高中|高考).{0,8}成[绩績]',
    '(?:课程|課程|专业课|專業課|各科|考试|考試|笔试|筆試|英语|英語|外语|外語).{0,2}成[绩績]|成[绩績](?:单|單|排名)',
    // 排名 of a class, year or major, or given as a share ("排名前10%").
    String.raw`(?:专业|專業|年级|年級|班级|班級|综合|綜合|学业|學業|学习|學習|院系|同届|同屆|成绩|成績)排名|排名.{0,4}(?:前\s*\d|\d+\s*%|百分)`,
  ].join('|'),
  'i',
);

const RULES: Array<[ProtectedQuestionType, RegExp]> = [
  ['sponsorship', SPONSORSHIP_RE],
  ['work_authorization', WORK_AUTH_RE],
  ['criminal_history', /convicted|conviction|criminal|felony|misdemeanou?r|犯罪|刑事/],
  ['veteran', /veteran|military service|armed forces|退伍/],
  ['disability', /disabilit|残疾|殘疾|身心障礙/],
  ['eeo', /gender|sex\b|race|ethnic|hispanic|latin[oax]|sexual orientation|transgender|pronoun|民族|性别|性別/],
  // Personal facts (server 'personal', Wave 5 gate): never drafted; after EEO, as on the server.
  [
    'personal',
    /date of birth|birth ?(date|day|year)|\bdob\b|\bage\b|how old|marital|married|religio|family members?|place of (birth|origin)|national id|id (card )?number|social security|\bssn\b|passport number|health (condition|status)|政治面貌|籍贯|籍貫|出生日期|出生年月|生日|年龄|年齡|婚姻|婚否|已婚|未婚|宗教|家庭成员|家庭成員|身份证|身分證|健康状况|健康狀況|党员|黨員/,
  ],
  ['salary_history', /current (salary|compensation|pay|ctc|base)|previous (salary|compensation|ctc)|salary history|past (salary|compensation)|当前薪|目前薪|現職薪|当前年薪|目前年薪/],
  [
    'salary_expectation',
    /salary|compensation|\bctc\b|base pay|desired (base|rate|pay)|hourly rate|day rate|rate expectation|pay (expectation|range)|expected (pay|base|rate)|期望薪|期望月薪|期望年薪|薪资|薪資|薪酬|待遇/,
  ],
  ['years_of_experience', /years of (professional |relevant |work )?experience|how many years|工作年限|几年经验|幾年經驗/],
  ['clearance', /clearance/],
  // Grades and test scores (server 'grades', WP-93): the user's own record, never drafted.
  // Before certification and degree, as on the server ("CET-4 certificate score").
  ['grades', GRADES_RE],
  ['certification', /certif|licen[cs]e|证书|證照|資格/],
  ['degree', /\bdegree\b|bachelor|master'?s|ph\.?d|doctorate|highest (level of )?education|学历|學歷|学位/],
  [
    'notice_period',
    /notice period|start(ing)? date|when (can|could|would|will) you (start|begin|join)|(available|availability|able) to (start|begin|join)|earliest (start|available|availability|date)|your availability|when are you available|到岗|到崗|到職|入职|入職|可开始工作|可開始工作|何时可以|何時可以/,
  ],
];

export function protectedQuestionType(label: string): ProtectedQuestionType | null {
  const n = normalizeText(label);
  if (!n) return null;
  for (const [type, re] of RULES) if (re.test(n)) return type;
  return null;
}

/**
 * "…authorized to work … WITHOUT sponsorship?" — a Yes means "I need no
 * sponsorship", the opposite polarity of "Will you require sponsorship?".
 */
const INVERTED_SPONSORSHIP_RE =
  /without (\w+ ){0,3}?(visa )?sponsor|(do not|don't|does not|doesn't|not|never) (\w+ ){0,2}?(require|need)s? (\w+ ){0,3}?(visa )?sponsor|no (visa )?sponsorship (is )?(needed|required)|无需.{0,6}(担保|签证)|不需要.{0,6}(担保|签证)|無需.{0,6}(擔保|簽證)|不需.{0,6}(擔保|簽證)/;

/** Wording a Yes/No answer from the user's work-authorization row can answer. */
const AUTHORIZED_RE = /authori[sz]ed to work|work authori[sz]ation|legally (eligible|authori[sz]ed|permitted) to work|right to work|eligible to work|有.{0,4}(工作许可|工作許可|工作权|工作權)/;
/** "…require / need … sponsorship" (Yes = the user needs it). */
const REQUIRES_SPONSORSHIP_RE = /(require|requires|need|needs|requiring|needing)( \S+){0,8}? (visa )?sponsor|sponsorship (is )?(required|needed)|需要.{0,6}(担保|签证)|需.{0,6}(擔保|簽證)/;
/** A yes/no question, not "What is your visa status?". */
const YES_NO_RE = /^(are|do|does|can|could|is|will|would|have|has|did)\b|是否|吗|嗎/;

/** How a work-authorization / sponsorship question is phrased. */
export type AuthQuestionShape =
  /** "Are you authorized to work in X?" */
  | 'authorization'
  /** "Will you (now or in the future) require sponsorship?" — Yes = needs sponsorship. */
  | 'sponsorship'
  /** "Can you work in X without sponsorship?" — Yes = authorized and needs none. */
  | 'without_sponsorship'
  /** Asks both at once, asks about citizenship or visa type, or is not a yes/no question: left to the user. */
  | 'unclear';

export function authQuestionShape(label: string): AuthQuestionShape {
  const n = normalizeText(label);
  if (!n) return 'unclear';
  if (!/[?？]/.test(label) && !YES_NO_RE.test(n)) return 'unclear';
  if (INVERTED_SPONSORSHIP_RE.test(n)) return 'without_sponsorship';
  const sponsorship = SPONSORSHIP_RE.test(n);
  const authorization = WORK_AUTH_RE.test(n);
  if (sponsorship && authorization) return 'unclear';
  if (sponsorship) return REQUIRES_SPONSORSHIP_RE.test(n) ? 'sponsorship' : 'unclear';
  if (authorization) return AUTHORIZED_RE.test(n) && !/citizen/.test(n) ? 'authorization' : 'unclear';
  return 'unclear';
}
