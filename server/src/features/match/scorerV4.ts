// server/src/features/match/scorerV4.ts — the numbers of scorer v4
// (MARKET_STRATEGY 2.1 point 5; SEARCH_RETRIEVE_MATCH 4.8; SM-8).
//
// Scorer v4 (RAJobMatchScorerV4Agent) fills a checklist: one anchored status
// per requirement line of the posting, with a resume quote, and three small
// judgments (level, domain, trajectory). This file turns that checklist into
// the five components of the fit. It is pure: no I/O, no model, no clock.
//
// Verification first, then arithmetic:
//
//   1. Which lines are judged. When the posting has a stored requirement list
//      (for the text it has now) the checklist IS that list: id, kind, text
//      and importance are read from the store, never from the model, and an
//      answer that leaves one of them out is refused (`ScorerV4ChecklistError`:
//      the caller answers the estimate and stores nothing). When it has none,
//      or only one of an earlier text, a line the model copied
//      is kept only when it is a verbatim substring of the posting the model
//      saw (the CitationGuard of evidence.ts); the first 12 such lines get the
//      ids r1…rN.
//      A copied line that is not in the posting disappears with whatever was
//      claimed about it. That must not move the number: a dropped "not shown"
//      line would raise the share of what is left. So a copy the server
//      cannot trust is refused like an incomplete stored answer: when more
//      than a third of the copied lines are not in the posting; when no skill
//      or experience line is left although the answer had one, or although
//      the posting itself lists skills or years of experience; when it holds
//      no line at all of a posting with a qualifications section. A copy of a
//      degree and a graduation class alone is a true answer for a posting
//      that asks for nothing else (campus postings do). And a copy is stored on
//      the job as the posting's list only when every line of it was found in
//      the posting; a copy with a line missing serves this one score and the
//      next score copies again.
//   2. What is never judged. A line about the applicant's own age, gender,
//      marital or family status, birthplace (籍贯), 户口, political status,
//      ethnicity, religion, photo, school tier, citizenship or right to work
//      cannot be "shown" by a resume that is stripped of those before the
//      prompt, and the product must not judge them. Such a line is not
//      applicable for everyone, and a copied one is not kept. Only wording
//      about the applicant counts: a line about the work ("citizenship
//      applications", "selling to top universities", 户籍管理系统) is an
//      ordinary requirement.
//   3. Quotes. A status `met` or `partly` whose evidence is not a verbatim
//      substring of the PII-stripped resume the model saw becomes `not_shown`
//      with no evidence: we never tell someone they have what the text does
//      not show, and we never keep a claim we cannot verify. A quote of one
//      or two characters is a true quote when it stands in the resume as a
//      word of its own ("Go", "C#", "R", 本科): see `shortQuoteIn`.
//
//   skills       100 × Σ points × weight ÷ Σ weight over the lines of kind
//                skill and experience. Points: met 1, partly 0.5, not shown 0;
//                not applicable is left out. Weight: must 1, preferred 0.5.
//                Not stated when the posting has no such line.
//   title_level  the distance between the level of the post and the level of
//                the resume on the six-level scale: same 100, one apart 60,
//                two 25, more 0. Halved when a required education line is not
//                shown, and on GoApply when a stated 届别 excludes the person
//                (the eligibility rule of the estimate, read from the profile;
//                a 届别 line of the checklist is decided by that rule alone, so
//                the same fact is never counted twice).
//   industry     direct 100, adjacent 60, unrelated 20; not stated otherwise.
//   career_path  toward 100, neutral 60, away 25; not stated with no history.
//   logistics    the deterministic component the caller computed. The model
//                never judges it.
//
// The total is `combineDimensions` over the stated components, as for every AI
// score. Nothing the model returns can set a component or the total directly:
// it picks statuses from fixed lists, and every status that claims something
// is checked against the two texts first.

import type {
  RAJobMatchScorerV4Output,
  ScorerV4DomainStatus,
  ScorerV4Level,
  ScorerV4TrajectoryStatus,
} from '../../roboapply/v2/agents/RAJobMatchScorerAgent.js';
import {
  JobRequirementSchema,
  MATCH_DIMENSION_KEYS,
  RequirementCheckSchema,
  TIER_HYSTERESIS_POINTS,
  tierForScore,
  type FitTierKey,
  type JobRequirement,
  type MatchDimension,
  type MatchDimensionKey,
  type MatchEvidence,
  type MatchTiers,
  type MatchWeights,
  type RequirementCheck,
} from './contract.js';
import { MIN_EVIDENCE_CHARS, guardEvidence, normalizeForGuard, plainQuote } from './evidence.js';
import type { MatchJob, MatchUser } from './preScore.js';

// ── The anchors (SEARCH_RETRIEVE_MATCH 4.8) ───────────────────────────────

/** Points of a judged requirement line. `not_applicable` has none: the line is left out. */
export const CHECKLIST_POINTS = { met: 1, partly: 0.5, not_shown: 0 } as const;
/** Weight of a line by its importance (the rule the estimate uses for required and preferred skills). */
export const IMPORTANCE_WEIGHT = { must: 1, preferred: 0.5 } as const;
/** title_level by the distance between the two levels: same, one apart, two apart, more. */
export const LEVEL_ANCHORS = [100, 60, 25, 0] as const;
export const DOMAIN_ANCHORS: Record<Exclude<ScorerV4DomainStatus, 'not_stated'>, number> = { direct: 100, adjacent: 60, unrelated: 20 };
export const TRAJECTORY_ANCHORS: Record<Exclude<ScorerV4TrajectoryStatus, 'no_history'>, number> = { toward: 100, neutral: 60, away: 25 };
/** What a stated eligibility line the person does not meet does to title_level (the estimate's factor). */
export const ELIGIBILITY_FACTOR = 0.5;
/** Requirement lines kept from a model's own copy of a posting (the cap the prompt states). */
export const CHECKLIST_EXTRACT_MAX = 12;
/**
 * The largest share of a model's copied lines that may be missing from the
 * posting before the whole answer is refused. Up to a third is a model that
 * reworded a line or two; beyond it the list is not the posting's.
 */
export const CHECKLIST_UNVERIFIED_MAX_SHARE = 1 / 3;
/** The `name` of the error the scorer v4 agent throws for an answer it cannot parse (kept equal by a test). */
export const SCORER_V4_ANSWER_ERROR = 'ScorerV4AnswerError';
/** The six levels, lowest first (SENIORITY_LEVELS of features/search; a test keeps them equal). */
export const CHECKLIST_LEVELS: readonly ScorerV4Level[] = ['intern_newgrad', 'entry', 'mid', 'senior', 'lead_staff', 'director_exec'];

/** The checklist cannot be used: the caller falls back to the estimate and stores nothing. */
export class ScorerV4ChecklistError extends Error {
  constructor(message: string) {
    super(`scorer v4 checklist: ${message}`);
    this.name = 'ScorerV4ChecklistError';
  }
}

// ── The stored list of a posting ──────────────────────────────────────────

/**
 * `RAJob.requirements` (MARKET_TASK_PLAN 3.3): written once per text of a
 * posting, by enrichment or by the first score of that text.
 */
export interface StoredRequirementsDoc {
  v: 1;
  /** `jobContentHash` of the posting the lines were copied from (computed from the row's own text and skills). */
  contentHash: string;
  /** The model that copied them. */
  model: string;
  /** ISO time. */
  extractedAt: string;
  items: JobRequirement[];
}

/**
 * The requirement lines stored on a job, or null when it has none that can be
 * used: the column is empty, another version, no valid item, or (when
 * `contentHash` is given) a list that was copied from another text of the
 * posting. Only the four fields of a requirement are read, so a field a later
 * writer adds to an item does not hide the list. An id is listed once.
 *
 * `contentHash` is the hash of the posting as it reads now (`jobContentHash`
 * computed from the row, which is also what enrichment stores with its list).
 * A list of an earlier text is not the posting's checklist any more: the
 * caller lets the model copy the lines again and replaces the stored list.
 *
 * At most `max` lines are the checklist (12, the cap of the scorer's own copy):
 * the answer has to carry every line with its quote inside the scorer's output
 * budget. A longer stored list is judged on its first 12 lines, the same 12 for
 * everyone.
 */
export function readStoredRequirements(value: unknown, options: { contentHash?: string | null; max?: number } = {}): JobRequirement[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const doc = value as { v?: unknown; items?: unknown; contentHash?: unknown };
  if (doc.v !== 1 || !Array.isArray(doc.items)) return null;
  if (options.contentHash && doc.contentHash !== options.contentHash) return null;
  const max = options.max ?? CHECKLIST_EXTRACT_MAX;
  const out: JobRequirement[] = [];
  const ids = new Set<string>();
  for (const raw of doc.items) {
    if (out.length >= max) break;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const parsed = JobRequirementSchema.safeParse({ id: r.id, kind: r.kind, text: r.text, importance: r.importance });
    if (!parsed.success || ids.has(parsed.data.id)) continue;
    ids.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out.length ? out : null;
}

/** The checklist stored with a score (`RAJobMatchScore.explanation.requirements`); [] when the row has none that parses. */
export function readRequirementChecks(value: unknown): RequirementCheck[] {
  const parsed = RequirementCheckSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

// ── Lines that are never judged ───────────────────────────────────────────
//
// Every pattern needs wording about the APPLICANT: a word that asks (要求, 限,
// "must be"), a label ("年龄：", "Nationality:"), a preference (优先,
// "preferred", "only") or a phrase that only describes a person ("authorized
// to work"). The topic word alone is not enough. "民族品牌", "党员管理系统",
// "citizenship applications", "top universities" as customers and "users aged
// 65 and older" are the work itself, and such a line stays a requirement.
// A wording outside the patterns is left to the scorer's own rule (hard rule 3
// of its prompt: such a line is not applicable and is never copied).

const HAN = '\\p{Script=Han}';
/** Chinese wording that makes what follows a condition on the applicant. "限" counts only as a word of its own (not 权限, 有限). */
const ZH_ASKS = `(?:要求|仅限|僅限|只限|(?<![${HAN}])限|须为|須為|需为|需為|必须是|必須是|必须为|必須為)`;
/** Chinese wording that makes the word before it one: a label, "no limit", a requirement, a preference. */
const ZH_ASKED = '(?:\\s*[:：]|不限|要求|限制|者?优先|者?優先)';
/** Who a user-facing age belongs to: "18岁以上用户" is the product's audience, not the applicant. */
const ZH_AUDIENCE = '(?!的?(?:用户|用戶|客户|客戶|人群|儿童|兒童|学生|學生|受众|受眾|群体|群體|消费者|消費者|患者|老人|老年|青少年))';
const ZH_YEARS_OLD = '(?:周岁|週歲|岁|歲)';
const ZH_WORK_PERMIT = '(?:工作签证|工作簽證|工作许可证?|工作許可證?)';
/** Nationalities as postings write them before "citizen". */
const NATION = '(?:u\\.?s\\.?(?:a\\.?)?|united\\s+states|american|canadian|british|u\\.?k\\.?|e\\.?u\\.?|european|australian|singaporean?|chinese|taiwanese|japanese|korean|german|french|indian|malaysian|local)';
const NATIONS = `${NATION}(?:\\s*(?:\\/|,|or|and)\\s*${NATION})*`;
/** "national" counts only after a nationality ("EU nationals"): "national accounts" is not a person. */
const STATUS_HOLDER = '(?:citizens?|permanent\\s+residents?|green\\s+card\\s+holders?)';
/** The few words that may stand between "must have" (or "valid") and "work permit": more than that and the line is about permits as the work. */
const WORK_PERMIT_WORDS = '(?:(?:a|an|the|valid|current|legal|unrestricted|full|u\\.?s\\.?|uk|eu)\\s+){0,3}';
/** What "sponsorship" is when it is something sold or run, not the applicant's visa. */
const NOT_VISA_SPONSORSHIP = '(?!\\s+(?:sales|packages?|deals?|programs?|programmes?|management|activation|revenue))';

const re = (source: string, flags = 'iu'): RegExp => new RegExp(source, flags);

const NOT_JUDGED: readonly RegExp[] = [
  // Age: a label, a limit, or an age the applicant must have. Not the age of users or customers.
  re(`(?:年龄|年齡)\\s*(?:[:：]|要求|限制|不限|不超过|不超過|在\\s*\\d|须|須|需|为|為|\\d)|${ZH_ASKS}(?:年龄|年齡)`),
  re(`\\d{2}\\s*${ZH_YEARS_OLD}\\s*(?:以下|以上|以内|以內|及以下|及以上|之间|之間|左右)${ZH_AUDIENCE}|(?:不超过|不超過|不满|不滿|未满|未滿|小于|小於|低于|低於)\\s*\\d{2}\\s*${ZH_YEARS_OLD}|\\d{2}\\s*[-–~至到]\\s*\\d{2}\\s*${ZH_YEARS_OLD}${ZH_AUDIENCE}`),
  re('(?:^|[\\s(;,])age\\s*(?:limits?|requirements?|range|cap|restrictions?)\\b|(?:^|[;,(]\\s*)age\\s*[:：]|\\b(?:maximum|minimum|max\\.?|min\\.?)\\s+age\\b'),
  re('^\\s*aged?\\s+(?:under|below|over|above|between\\s+)?\\d{2}\\b|^\\s*(?:between\\s+|under\\s+|below\\s+|over\\s+|above\\s+)?\\d{2}\\s*(?:(?:-|–|to|and)\\s*\\d{2}\\s*)?(?:years?|yrs?)[\\s-]*old\\b'),
  re('\\b(?:must|should|candidates?|applicants?)\\b[^.\\n]{0,40}?\\b(?:(?:under|below|over|above)\\s+the\\s+age\\s+of\\s+\\d{2}\\b|\\d{2}\\s*\\+?\\s*(?:years?|yrs?)[\\s-]*(?:old\\b|of\\s+age\\b)|aged?\\s+(?:under|below|over|above|between\\s+)?\\d{2}\\b|\\bbe\\s+(?:no\\s+|not\\s+)?(?:older|younger)\\s+than\\s+\\d{2}\\b)'),
  // Gender; marital and family status; appearance.
  re(`(?:性别|性別)${ZH_ASKED}|(?:仅限|僅限|只限|(?<![${HAN}])限)[男女]|[男女](?:性|士|生)?者?(?:优先|優先)|男女不限`),
  re(`婚姻状况|婚姻狀況|婚否|(?:已婚|未婚)(?:已育|未育)|(?:已婚|未婚|已育|未育)(?:者|人士)?(?:优先|優先|不限)|${ZH_ASKS}(?:已婚|未婚|已育|未育)`),
  re('形象气质|形象氣質|五官端正|身高\\s*(?:\\d{3}|要求|不低)'),
  re('\\b(?:male|female|men|women)\\s+(?:only|preferred|candidates?|applicants?)\\b|\\bmarital\\s+status\\b|\\b(?:must|should)\\s+be\\s+(?:un)?married\\b|\\b(?:un)?married\\s+(?:candidates?|applicants?|only|preferred)\\b'),
  // Birthplace, household registration, political status, ethnicity, religion.
  re(`籍贯|籍貫|政治面貌|(?:户籍|戶籍|户口|戶口)${ZH_ASKED}|${ZH_ASKS}(?:有|具有|持有|为|為|是)?[${HAN}]{0,4}(?:户籍|戶籍|户口|戶口)(?![${HAN}])`),
  re(`(?:中共)?(?:党员|黨員|团员|團員)(?:身份|者?优先|者?優先)|${ZH_ASKS}(?:是|为|為)?(?:中共)?(?:正式|预备|預備)?(?:党员|黨員|团员|團員)`),
  re(`民族${ZH_ASKED}|少数民族者?(?:优先|優先)|${ZH_ASKS}(?:汉|漢|回|满|滿|蒙古|藏|壮|壯|苗|维吾尔|維吾爾)族|(?:无|無)宗教信仰|宗教信仰${ZH_ASKED}`),
  re('\\b(?:your|applicant\'?s?|candidate\'?s?|state|indicate|specify|provide|must\\s+be(?:\\s+of)?)\\b[^.\\n]{0,20}\\b(?:ethnicity|ethnic\\s+(?:group|background|origin)|religion|religious\\s+(?:belief|affiliation)s?|place\\s+of\\s+birth|birthplace|date\\s+of\\s+birth|gender)\\b'),
  re('(?:^|[;,(]\\s*)(?:ethnicity|religion|gender|sex|date\\s+of\\s+birth|place\\s+of\\s+birth|birthplace|nationality|citizenship)\\s*[:：]'),
  // A photo of the applicant.
  re('(?:附|提供|上传|上傳|贴|貼)[^。；，,\\n]{0,6}(?:近照|证件照|證件照|生活照|免冠照|个人照片|個人照片|本人照片|[一二两兩12]寸(?:彩照|照片|照))(?!拍摄|拍攝|修图|修圖|制作|製作|服务|服務)|(?:近期)?免冠(?:照|彩照)'),
  re('\\b(?:attach|include|submit|send|enclose)\\b[^.\\n]{0,12}?\\b(?:your|a\\s+recent|recent|passport(?:-sized?)?|personal|profile)\\s+(?:\\w+\\s+)?(?:photo(?:graph)?|headshot|picture)\\b'),
  // Citizenship and the right to work: logistics and the eligibility filters decide them, from the person's own answers.
  re(`(?:国籍|國籍)${ZH_ASKED}|${ZH_ASKS}(?:为|為|是|具有|持有)?[${HAN}]{0,3}(?:国籍|國籍)(?![${HAN}])|(?:中国|中國|外国|外國|本国|本國)(?:国籍|國籍)(?!法)`),
  re(`(?:需|须|須|要求|持有?|具有|具备|具備|拥有|擁有|有效)[^。；，,\\n]{0,6}${ZH_WORK_PERMIT}(?![${HAN}])|${ZH_WORK_PERMIT}者?(?:优先|優先)|(?:不|可|能|可以|无法|無法)(?:提供|办理|辦理|协助办理|協助辦理)(?:工作)?(?:签证|簽證)`),
  re('\\b(?:legally\\s+)?(?:authori[sz]ed|permitted|eligible|entitled|allowed)\\s+to\\s+work\\b|\\b(?:right|eligibility|permission|authori[sz]ation)\\s+to\\s+work\\b'),
  re(`\\b(?:valid|current|unrestricted|proof\\s+of|must\\s+(?:have|hold|possess)|require[sd]?)\\s+${WORK_PERMIT_WORDS}work\\s+(?:authori[sz]ation|permit|visa)s?\\b|\\bwork\\s+(?:authori[sz]ation|permit|visa)s?\\s+(?:is\\s+|are\\s+)?(?:required|needed|necessary|mandatory)\\b`),
  re(`\\b(?:visa|employment|immigration)\\s+sponsorship\\b[^.\\n]{0,25}\\b(?:not|unavailable|available|provided|offered|required|needed|possible)\\b`),
  re(`\\b(?:no|not|without|unable\\s+to|cannot|can\\s?not|can't|won't|will\\s+not|do(?:es)?\\s+not|don't|doesn't)\\b[^.\\n]{0,25}?\\b(?:(?:visa|work|employment|immigration)\\s+)?sponsor(?:ship|ing)?\\b${NOT_VISA_SPONSORSHIP}`),
  re(`\\b(?:require[sd]?|requiring|needs?|needing)\\s+(?:(?:any|future|current|visa|work|employment|immigration|h-?1b)\\s+)*sponsorship\\b${NOT_VISA_SPONSORSHIP}|\\bsponsor(?:s|ing)?\\s+(?:your\\s+|a\\s+|an\\s+|the\\s+|any\\s+)?(?:work\\s+|employment\\s+)?visas?\\b`),
  re(`\\bmust\\s+be\\s+(?:an?\\s+|the\\s+)?(?:(?:${NATIONS}\\s+)?${STATUS_HOLDER}|${NATIONS}\\s+nationals?)\\b|\\b${STATUS_HOLDER}\\b[^.\\n]{0,40}\\bonly\\b|\\b${NATIONS}\\s+(?:citizens?|nationals?|citizenship)\\b[^.\\n]{0,20}\\b(?:required|preferred|only|must)\\b`),
  re('\\b(?:citizenship|nationality|permanent\\s+residen(?:ce|cy)|green\\s+card)\\s+(?:is\\s+|status\\s+is\\s+)?(?:required|needed|mandatory|a\\s+must|preferred)\\b'),
];

// School tier is never an input (ruling C15): a line that asks for a degree from a tier of schools is left out whole.
// The tier phrase alone is not enough ("selling to top universities", "211 call center systems"): the line must also
// speak of a degree or of graduating, or put a preference right after the tier.
const SCHOOL_TIER_ZH = `(?:(?<!\\d)(?:985|211)(?!\\d)|双一流|雙一流|双非|雙非|C9|重点(?:大学|院校|本科|高校)|重點(?:大學|院校|高校)|一本(?:院校|及以上|以上|学历|大学)|名校|QS\\s*(?:世界)?\\s*(?:排名)?\\s*(?:前|top)\\s*\\d+)`;
const SCHOOL_TIER: readonly RegExp[] = [
  re(SCHOOL_TIER_ZH),
  re('\\b(?:ivy\\s+league|russell\\s+group|oxbridge|(?:top|elite|prestigious|target|tier[\\s-]?(?:1|one)|top[\\s-]tier|first[\\s-]tier)[\\s-]+(?:\\d+\\s+)?(?:ranked\\s+)?(?:universit(?:y|ies)|schools?|colleges?|institutions?))\\b'),
];
const DEGREE_WORDING: readonly RegExp[] = [
  re('学历|學歷|本科|硕士|碩士|博士|研究生|毕业|畢業|学位|學位|在读|在讀|应届|應屆'),
  re('\\b(?:degrees?|graduates?|graduated|graduating|bachelor\'?s?|master\'?s?|mba|ph\\.?d|doctorate|alumn(?:i|us|a)|educat(?:ed|ion)|studied|diploma)\\b'),
  // "985/211优先", "双一流高校背景者优先": the preference follows the tier at once.
  re(`${SCHOOL_TIER_ZH}(?:\\s*[\\/、]\\s*(?:985|211))?\\s*(?:院校|高校|大学|大學)?(?:背景)?者?(?:优先|優先)`),
];

/**
 * A line the checklist never judges (see the header, point 2): wording about
 * the applicant's own age, gender, family, origin, politics, belief, photo,
 * school tier, citizenship or right to work. Ordinary requirement text does
 * not match, also when it names the same topic as the work: "manage",
 * "race conditions", "photo editing", "Visa and Mastercard networks",
 * "sponsorship sales", "女装电商运营", "ISO 27001", "citizenship
 * applications", "users aged 65 and older", "党员管理系统", "an active
 * security clearance" (a resume can show one).
 */
export function isNotJudgedRequirement(text: string): boolean {
  const t = text.normalize('NFKC');
  if (NOT_JUDGED.some((r) => r.test(t))) return true;
  return SCHOOL_TIER.some((r) => r.test(t)) && DEGREE_WORDING.some((r) => r.test(t));
}

/** A line that states a graduation class (届别). On GoApply the profile decides it, not the model. */
const CLASS_YEAR_LINE = /\d{2,4}\s*届|应届|應屆|往届|往屆|届别|屆別|毕业年份|畢業年份|毕业时间|畢業時間|\bclass\s+of\s+'?\d{2,4}\b|\bgraduat\w*\b[^.\n]{0,30}\b(?:in|by|between|from)\s+20\d{2}\b/iu;

export function isClassYearLine(text: string): boolean {
  return CLASS_YEAR_LINE.test(text.normalize('NFKC'));
}

/**
 * GoApply 届别, the estimate's eligibility rule (preScore.ts
 * `titleLevelDimension`): the posting states graduation classes, the profile
 * states one, and it is not among them. Null outside GoApply: the rule does
 * not exist there. `text` is the posting's own words for the evidence line.
 */
export function classYearEligibility(
  user: Pick<MatchUser, 'classYear'>,
  job: Pick<MatchJob, 'market' | 'classYears' | 'classYearQuote'>,
): { excluded: boolean; text: string | null } | null {
  if (job.market !== 'cn') return null;
  const excluded = job.classYears.length > 0 && user.classYear !== null && !job.classYears.includes(user.classYear);
  return { excluded, text: job.classYearQuote ?? (job.classYears.length ? job.classYears.join(', ') : null) };
}

// ── Verification ──────────────────────────────────────────────────────────

/** Decoration a model puts around a quote: quote marks and ellipses at either end (the rule of evidence.ts). */
function bareQuote(text: string): string {
  return text.replace(/^[\s"'`“”‘’「」『』]+|[\s"'`“”‘’「」『』]+$/g, '').replace(/^(?:\.\.\.|…)\s*|\s*(?:\.\.\.|…)$/g, '');
}

/** Scripts written without spaces between words. */
const UNSPACED = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const UNSPACED_CHAR = new RegExp(`[${UNSPACED}]`, 'u');
const UNSPACED_WORD = new RegExp(`^[${UNSPACED}]{2}$`, 'u');

/**
 * A quote of one or two characters as it is shown, when it is a true quote of
 * `text`; else null.
 *
 * The CitationGuard never shows a quote under three characters
 * (`MIN_EVIDENCE_CHARS`): so short a string is found in almost any text by
 * accident. Here a quote decides a number, and short quotes are ordinary ones:
 * "Go", "C#", "R", "AI", 本科, 硕士, 英语. A short quote counts when it stands
 * in the text as a word of its own:
 *   - in a script written without spaces (Han, kana, hangul): exactly two
 *     characters, found in the text (本科 in "北京大学 本科"). One such
 *     character alone is never a quote;
 *   - otherwise: it holds a letter and is not next to a letter or a digit
 *     ("Go" in "TypeScript, Go, SQL", never in "Google"), nor to a sign that
 *     would make it another name ("C" is not a quote of "C++" or "C#", "R"
 *     not of "R&D").
 */
export function shortQuoteIn(quote: string, text: string): string | null {
  const clean = bareQuote(plainQuote(bareQuote(quote.trim())));
  const needle = normalizeForGuard(clean);
  const length = [...needle].length;
  if (length < 1 || length >= MIN_EVIDENCE_CHARS) return null;
  const hay = normalizeForGuard(plainQuote(text));
  if (UNSPACED_CHAR.test(needle)) return UNSPACED_WORD.test(needle) && hay.includes(needle) ? clean : null;
  if (!/\p{L}/u.test(needle)) return null;
  const word = new RegExp(`(?<![\\p{L}\\p{N}&])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}&+#])`, 'u');
  return word.test(hay) ? clean : null;
}

/**
 * The quote as it is shown when it is a verbatim substring of `text`
 * (CitationGuard; a quote of one or two characters by `shortQuoteIn`), else
 * null.
 */
function verifiedIn(quote: string, text: string, source: 'resume' | 'posting'): string | null {
  if (!quote.trim()) return null;
  const kept = guardEvidence([{ text: quote, source }], source === 'resume' ? { resume: text, posting: '' } : { resume: '', posting: text });
  return kept[0]?.text ?? shortQuoteIn(quote, text);
}

export interface ChecklistSources {
  /** The PII-stripped resume the model saw. */
  resume: string;
  /** The posting text the model saw. */
  posting: string;
}

export interface ChecklistOptions {
  weights: MatchWeights;
  /** The deterministic location / pay / visa component (preScore.ts `logisticsDimension`). */
  logistics: MatchDimension;
  sources: ChecklistSources;
  /** The posting's stored requirement list (`readStoredRequirements`), when it has one. */
  stored?: readonly JobRequirement[] | null;
  /** `classYearEligibility(user, job)`: GoApply's 届别 rule; null or absent elsewhere. */
  classYear?: { excluded: boolean; text: string | null } | null;
  /**
   * What the posting's own fields say there is to judge. A model's own copy
   * with no skill or experience line is refused when the posting lists hard
   * skills or states years of experience; a copy with no line at all is
   * refused when the posting has a qualifications section. (A qualifications
   * section may hold a degree and a graduation class and nothing else, as
   * campus postings do: a copy of those lines is a true answer.) Not read
   * when the posting has a stored list.
   */
  posting?: { listsSkillsOrYears?: boolean; hasQualifications?: boolean };
}

export interface ChecklistResult {
  /** The five components, in the order the card lists them. */
  dimensions: MatchDimension[];
  /** The verified checklist, as it is stored with the score and shown on the card. */
  requirements: RequirementCheck[];
  level: RAJobMatchScorerV4Output['level'];
  /** Evidence is '' unless the quote was found in the resume or the posting. */
  domain: RAJobMatchScorerV4Output['domain'];
  trajectory: RAJobMatchScorerV4Output['trajectory'];
  /**
   * The requirement lines the model copied from a posting that had no stored
   * list, numbered r1…rN: what the caller stores on the job. Set only when
   * EVERY copied line was found in the posting: a copy with a line missing is
   * not the posting's list (the next score copies again). Null otherwise, and
   * when the posting already had its list.
   */
  extracted: JobRequirement[] | null;
  /** Copied lines that were not found in the posting and were left out (0 with a stored list). */
  unverified: number;
}

type Answer = Pick<RequirementCheck, 'status' | 'evidence'>;

/** One line with its verified status. */
function judged(item: JobRequirement, answer: Answer, resume: string): RequirementCheck {
  if (isNotJudgedRequirement(item.text)) return { ...item, status: 'not_applicable', evidence: '' };
  if (answer.status === 'met' || answer.status === 'partly') {
    const quote = verifiedIn(answer.evidence, resume, 'resume');
    // A claim nobody can check is not kept: the line reads "not shown", never "met".
    return quote ? { ...item, status: answer.status, evidence: quote } : { ...item, status: 'not_shown', evidence: '' };
  }
  return { ...item, status: answer.status, evidence: '' };
}

function dim(key: MatchDimensionKey, weights: MatchWeights, score: number | null, evidence: MatchEvidence[] = []): MatchDimension {
  return {
    key,
    weight: weights[key],
    score: score === null ? null : Math.max(0, Math.min(100, Math.round(score))),
    status: score === null ? 'not_stated' : 'scored',
    evidence: evidence.slice(0, 3),
  };
}

/** Levels between the post and the resume on the six-level scale. */
export function levelDistance(post: ScorerV4Level, resume: ScorerV4Level): number {
  return Math.abs(CHECKLIST_LEVELS.indexOf(post) - CHECKLIST_LEVELS.indexOf(resume));
}

/**
 * The components and the verified checklist of one scorer v4 answer.
 *
 * Throws `ScorerV4ChecklistError` when the checklist cannot be trusted to be
 * the posting's: an answer that leaves out a line of the stored list; a copy
 * of which more than a third of the lines are not in the posting; a copy with
 * no skill or experience line left although the answer had one, or although
 * the posting lists skills or years of experience; a copy with no line at all
 * of a posting that has a qualifications section. The caller then answers the
 * estimate and stores nothing.
 */
export function componentsFromChecklist(out: RAJobMatchScorerV4Output, options: ChecklistOptions): ChecklistResult {
  const { weights, sources } = options;
  const stored = options.stored?.length ? options.stored : null;
  const requirements: RequirementCheck[] = [];
  let extracted: JobRequirement[] | null = null;
  let unverified = 0;

  if (stored) {
    // The list is the posting's: every person is judged against the same lines. The model only fills status and
    // evidence; whatever else its entries carry (a kind, an importance, a reworded text) is not read.
    const answers = new Map<string, Answer>();
    for (const a of out.requirements) if (a.id && !answers.has(a.id)) answers.set(a.id, a);
    for (const item of stored) {
      const answer = answers.get(item.id);
      if (!answer) throw new ScorerV4ChecklistError(`the answer has no entry for requirement ${item.id}`);
      requirements.push(judged(item, answer, sources.resume));
    }
  } else {
    // The model's own copy of the posting's lines.
    const kept: JobRequirement[] = [];
    const seen = new Set<string>();
    /** Lines the answer offers as requirements of the candidate, one per text. */
    let copied = 0;
    /** The answer had a skill or experience line, in the posting or not. */
    let offeredCounted = false;
    for (const a of out.requirements) {
      if (kept.length >= CHECKLIST_EXTRACT_MAX) break;
      // Not a requirement of the candidate (a benefits line): nothing to judge and nothing to store.
      if (a.status === 'not_applicable') continue;
      const text = verifiedIn(a.text, sources.posting, 'posting');
      const key = normalizeForGuard(text ?? a.text);
      if (seen.has(key)) continue;
      seen.add(key);
      // Never judged, so never counted either way: not a line of the checklist and not a missing one.
      if (isNotJudgedRequirement(text ?? a.text)) continue;
      copied += 1;
      if (a.kind === 'skill' || a.kind === 'experience') offeredCounted = true;
      // A line that is not in the posting (or that says neither what kind it is nor how much it matters) disappears,
      // with whatever was claimed about it.
      if (!text || !a.kind || !a.importance) {
        unverified += 1;
        continue;
      }
      const item: JobRequirement = { id: `r${kept.length + 1}`, kind: a.kind, text, importance: a.importance };
      kept.push(item);
      requirements.push(judged(item, a, sources.resume));
    }
    // A line that disappears must not move the number. One reworded line in three is tolerated; beyond that, and
    // whenever the lines that count are gone, the copy is not the posting's checklist.
    if (unverified > copied * CHECKLIST_UNVERIFIED_MAX_SHARE + 1e-9) {
      throw new ScorerV4ChecklistError(`${unverified} of the ${copied} copied requirement lines are not in the posting`);
    }
    if (!kept.some((r) => r.kind === 'skill' || r.kind === 'experience')) {
      if (offeredCounted) throw new ScorerV4ChecklistError('no copied skill or experience line is in the posting');
      if (options.posting?.listsSkillsOrYears) throw new ScorerV4ChecklistError('the posting lists skills or years of experience and the answer has no skill or experience line');
      if (options.posting?.hasQualifications && copied === 0) throw new ScorerV4ChecklistError('the posting has a qualifications section and the answer copied no line of it');
    }
    extracted = unverified === 0 && kept.length ? kept : null;
  }

  // skills: the weighted share of the skill and experience lines the resume shows.
  let earned = 0;
  let asked = 0;
  for (const r of requirements) {
    if ((r.kind !== 'skill' && r.kind !== 'experience') || r.status === 'not_applicable') continue;
    const weight = IMPORTANCE_WEIGHT[r.importance];
    asked += weight;
    earned += weight * CHECKLIST_POINTS[r.status];
  }
  const counted = requirements.filter((r) => r.kind === 'skill' || r.kind === 'experience');
  const shown = [...counted.filter((r) => r.status === 'met'), ...counted.filter((r) => r.status === 'partly')];
  const missing = counted.find((r) => r.status === 'not_shown' && r.importance === 'must') ?? counted.find((r) => r.status === 'not_shown');
  const skills = dim('skills', weights, asked > 0 ? (100 * earned) / asked : null, [
    ...shown.slice(0, 2).map((r): MatchEvidence => ({ text: r.evidence, source: 'resume' })),
    ...(missing ? [{ text: missing.text, source: 'posting' } satisfies MatchEvidence] : []),
  ]);

  // title_level: the level distance, then the eligibility the posting states.
  let level: number = LEVEL_ANCHORS[Math.min(levelDistance(out.level.post, out.level.resume), LEVEL_ANCHORS.length - 1)]!;
  const levelEvidence: MatchEvidence[] = [];
  const classYear = options.classYear ?? null;
  // A 届别 line is decided by the profile's class year where that rule exists, so one fact is not counted twice.
  const education = requirements.find((r) => r.kind === 'education' && r.importance === 'must' && r.status === 'not_shown' && !(classYear && isClassYearLine(r.text)));
  if (education) {
    level *= ELIGIBILITY_FACTOR;
    levelEvidence.push({ text: education.text, source: 'posting' });
  }
  if (classYear?.excluded) {
    level *= ELIGIBILITY_FACTOR;
    if (classYear.text) levelEvidence.push({ text: classYear.text, source: 'posting', ref: 'class_year' });
  }
  const titleLevel = dim('title_level', weights, level, levelEvidence);

  // industry and career_path: one anchored judgment each; the quote is shown only when it is in the texts.
  const domainQuote = verifiedIn(out.domain.evidence, sources.resume, 'resume');
  const domainPostingQuote = domainQuote ? null : verifiedIn(out.domain.evidence, sources.posting, 'posting');
  const industry = dim(
    'industry',
    weights,
    out.domain.status === 'not_stated' ? null : DOMAIN_ANCHORS[out.domain.status],
    out.domain.status === 'not_stated' ? [] : domainQuote ? [{ text: domainQuote, source: 'resume' }] : domainPostingQuote ? [{ text: domainPostingQuote, source: 'posting' }] : [],
  );
  const trajectoryQuote = verifiedIn(out.trajectory.evidence, sources.resume, 'resume');
  const careerPath = dim(
    'career_path',
    weights,
    out.trajectory.status === 'no_history' ? null : TRAJECTORY_ANCHORS[out.trajectory.status],
    out.trajectory.status === 'no_history' || !trajectoryQuote ? [] : [{ text: trajectoryQuote, source: 'resume' }],
  );

  const byKey: Record<MatchDimensionKey, MatchDimension> = { title_level: titleLevel, skills, industry, logistics: options.logistics, career_path: careerPath };
  const gap = CHECKLIST_LEVELS.indexOf(out.level.post) - CHECKLIST_LEVELS.indexOf(out.level.resume);
  return {
    dimensions: MATCH_DIMENSION_KEYS.map((key) => byKey[key]),
    requirements,
    // Built from the named fields only (nothing else the answer carries is passed on); the direction is the levels' own.
    level: { post: out.level.post, resume: out.level.resume, direction: gap === 0 ? 'match' : gap > 0 ? 'post_higher' : 'post_lower' },
    domain: { status: out.domain.status, evidence: out.domain.status === 'not_stated' ? '' : (domainQuote ?? domainPostingQuote ?? '') },
    trajectory: { status: out.trajectory.status, evidence: out.trajectory.status === 'no_history' ? '' : (trajectoryQuote ?? '') },
    extracted,
    unverified,
  };
}

// ── The borderline rule (invariant I5) ────────────────────────────────────

/**
 * The tier stored with a new model result. A total within 3 points of a tier
 * edge (`TIER_HYSTERESIS_POINTS`: 3 or more past an edge is not "within") is
 * given the tier on the same side of that edge as the estimate for the same
 * inputs, so a result that lands a point or two across an edge does not move
 * the tier the person was shown, and three runs that scatter around an edge
 * store one tier. No second model call is made, and the score itself is
 * stored as computed. `edge` is the edge the rule was applied at, or null.
 *
 * With no estimate (nothing could be compared deterministically) the total's
 * own tier stands.
 */
export function borderlineTier(total: number, estimate: number | null | undefined, tiers: MatchTiers): { tier: FitTierKey; edge: number | null } {
  const own = tierForScore(total, tiers);
  if (typeof estimate !== 'number' || !Number.isFinite(estimate)) return { tier: own, edge: null };
  const edges: ReadonlyArray<readonly [number, FitTierKey, FitTierKey]> = [
    [tiers.possible, 'unlikely', 'possible'],
    [tiers.good, 'possible', 'good'],
    [tiers.great, 'good', 'great'],
  ];
  let near: (typeof edges)[number] | null = null;
  for (const edge of edges) {
    const distance = Math.abs(total - edge[0]);
    if (distance < TIER_HYSTERESIS_POINTS && (!near || distance < Math.abs(total - near[0]))) near = edge;
  }
  if (!near) return { tier: own, edge: null };
  return { tier: estimate >= near[0] ? near[2] : near[1], edge: near[0] };
}
