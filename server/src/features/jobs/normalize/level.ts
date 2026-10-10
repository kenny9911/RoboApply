// server/src/features/jobs/normalize/level.ts
//
// Seniority, role type, required years and employment type, by regex over the
// title, the description and provider labels (ARCH §4.4). Deterministic and
// explainable; every result says where it came from. When nothing states a
// value the result is null (an honest unknown beats a guess, D3).
//
// Seniority uses only the title and provider labels: descriptions mention
// "senior engineers" and "interns" in passing far too often to be evidence.
// Required years come from the description ("5+ years of experience",
// "3-5年工作经验", "三年以上经验"); seniority falls back to the years band
// when the title states no level.

import type { EducationLevel, EmploymentType, FieldSource, RoleType, Seniority } from './types.js';

export interface Sourced<T> {
  value: T;
  source: FieldSource;
}

// ── Seniority ──────────────────────────────────────────────────────────────

const IC_ROLE_NOUN = String.raw`(?:engineers?|scientists?|designers?|developers?|architects?|researchers?|swe|sre|product managers?)`;

const LEVEL_RULES: [Seniority, RegExp][] = [
  ['intern_newgrad', /\b(intern|internship|interns|co-?op|apprentice(ship)?|trainee|new[- ]grad(uate)?s?|graduate|campus hire|university grad(uate)?|early careers?)\b|实习|實習|应届|應屆|校招|校园招聘|校園招募|管培生|管理培训生|儲備幹部|储备干部|毕业生|畢業生/i],
  ['director_exec', /\b(director|vice president|vp|svp|evp|avp|head of|chief|c[a-z]o|president|general manager)\b|总监|總監|副总裁|副總裁|总裁|總裁|首席|总经理|總經理|事业部负责人|部门负责人|部門主管/i],
  // "Staff" and "Lead" are levels only in front of an IC role noun or as a team/tech lead:
  // "Staff Accountant", "Staff Nurse" and "Lead Generation Specialist" are not lead_staff.
  ['lead_staff', new RegExp(String.raw`\b(principal|distinguished|fellow|architect|manager)\b|\b(?:staff|lead)\s+(?:[\w+#/.-]+\s+){0,3}?${IC_ROLE_NOUN}\b|\b(?:tech|team|technical|engineering|design|data|product|software|frontend|front-end|backend|back-end|mobile|ios|android|ml|ai|research|security|platform|infrastructure|devops|qa|test|ux|ui)\s+lead\b|专家|專家|架构师|架構師|组长|組長|主管|经理|經理|负责人|負責人`, 'i')],
  ['senior', /\b(senior|sr|snr)\b|资深|資深|高级|高級/i],
  ['mid', /\b(mid|mid-level|intermediate)\b|中级|中級/i],
  ['entry', /\b(junior|jr|entry[- ]level|entry|associate)\b|初级|初級|助理|新人/i],
];

/** Roman / arabic grade suffixes: "Engineer I" → entry … "Engineer IV" → lead_staff. */
const GRADE_RE = /\b(?:engineer|developer|scientist|analyst|designer|manager|specialist|sde|swe)\s+(i{1,3}|iv|v|[1-5])$/i;
const GRADE_LEVEL: Record<string, Seniority> = { i: 'entry', '1': 'entry', ii: 'mid', '2': 'mid', iii: 'senior', '3': 'senior', iv: 'lead_staff', '4': 'lead_staff', v: 'lead_staff', '5': 'lead_staff' };

/** Product/program/project/account … managers are individual contributors. */
const IC_MANAGER_RE = /\b(product|program|programme|project|account|accounts|community|social media|case|customer success|success|relationship|partner|partnerships?|channel|content|category|campaign|brand|marketing|office|store|property|release|test|qa|delivery|portfolio|territory|sales development|key account)\s+manager\b|产品经理|產品經理|项目经理|項目經理|專案經理|客户经理|客戶經理|大客户经理|销售经理|銷售經理|品牌经理|品牌經理|渠道经理|運營經理|运营经理/i;

/** Seniority stated in a title (null when none). */
export function seniorityFromTitle(title: string): Seniority | null {
  const t = title.normalize('NFKC');
  if (!t.trim()) return null;
  // "Associate Director" is a director; "Senior Product Manager" is senior.
  for (const [level, re] of LEVEL_RULES) {
    if (!re.test(t)) continue;
    if (level === 'lead_staff' && /\bmanager\b|经理|經理/i.test(t) && !/\b(staff|principal|distinguished|fellow|lead|architect)\b|专家|專家|架构师|架構師|组长|組長|主管|负责人|負責人/i.test(t)) {
      // A bare "manager" title: people managers are lead_staff, IC managers are not levelled here.
      if (IC_MANAGER_RE.test(t)) continue;
    }
    return level;
  }
  const grade = t.trim().match(GRADE_RE);
  return grade ? GRADE_LEVEL[grade[1].toLowerCase()] : null;
}

/** A provider's level label ("Mid-Senior level", "Entry level", "Executive", "实习"). */
export function seniorityFromLabel(label: string | null | undefined): Seniority | null {
  if (!label) return null;
  const s = label.normalize('NFKC').toLowerCase().trim();
  if (!s) return null;
  if (/intern|实习|實習|new grad|graduate|campus|应届|應屆/.test(s)) return 'intern_newgrad';
  if (/exec|director|vp|chief|c-level|总监|總監|高管/.test(s)) return 'director_exec';
  if (/mid[- ]?senior/.test(s)) return 'senior';
  if (/lead|staff|principal|manager|主管|经理|經理/.test(s)) return 'lead_staff';
  if (/senior|资深|資深|高级|高級/.test(s)) return 'senior';
  if (/\bmid|intermediate|中级|中級/.test(s)) return 'mid';
  if (/entry|junior|associate|初级|初級/.test(s)) return 'entry';
  return null;
}

/** The band a stated minimum of years implies. */
export function seniorityFromYears(minYears: number | null): Seniority | null {
  if (minYears == null) return null;
  if (minYears <= 1) return 'entry';
  if (minYears <= 4) return 'mid';
  if (minYears <= 7) return 'senior';
  return 'lead_staff';
}

// ── Role type ──────────────────────────────────────────────────────────────

const MANAGER_RE = /\b(manager|head of|director|vice president|vp|svp|evp|chief|c[a-z]o|general manager|supervisor|team lead)\b|总监|總監|经理|經理|主管|负责人|負責人|组长|組長|总裁|總裁|部长|部長/i;

/** 'manager' for people-management titles, 'ic' otherwise (null for an empty title). */
export function roleTypeFromTitle(title: string): RoleType | null {
  const t = title.normalize('NFKC');
  if (!t.trim()) return null;
  if (!MANAGER_RE.test(t)) return 'ic';
  // "Product Manager", "Account Manager", 产品经理 … are individual contributors,
  // unless the title also names a people-management level ("Director of Product").
  if (IC_MANAGER_RE.test(t) && !/\b(director|head of|vice president|vp|chief|group|senior manager of)\b|总监|總監/i.test(t)) return 'ic';
  return 'manager';
}

// ── Years of experience ────────────────────────────────────────────────────

const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (s.length === 2 && s[0] === '十') return 10 + (CN_DIGITS[s[1]] ?? NaN);
  if (s.length === 1) return CN_DIGITS[s] ?? null;
  return null;
}

export interface YearsRange {
  min: number | null;
  max: number | null;
}

const EN_YEARS = /(?<![\d.])(?:(?:at least|minimum(?: of)?|min\.?|over|more than)\s+)?(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to|~)\s*(\d{1,2})\s*\+?\s*)?(?:years?|yrs?)(?:['’]s?)?\b([^.\n;]{0,60})/gi;
const EN_CONTEXT = /experience|exp\b|background|in (?:a|an|the)\b|working|professional|industry|relevant|hands-on|of\b/i;
const EN_NOT_REQUIREMENT = /\b(old|ago|history|anniversary|warranty|vesting|vest|contract|term|in business|founded|track record of the company)\b/i;
const ZH_YEARS = /(?<!\d)(\d{1,2}|[一二两兩三四五六七八九十]{1,2})\s*(?:(?:-|–|~|至|到)\s*(\d{1,2}|[一二两兩三四五六七八九十]{1,2})\s*)?(?:年|年度)\s*(以上|及以上|或以上|以下)?([^。；;\n]{0,12})/g;
const ZH_CONTEXT = /经验|經驗|工作|从业|從業|相关|相關|开发|開發|年资|年資/;

/** Required years stated in a description (smallest stated minimum; null when none). */
export function yearsFromText(text: string | null | undefined): YearsRange | null {
  if (!text) return null;
  const s = text.normalize('NFKC');
  if (/经验不限|經驗不限|无经验要求|無經驗要求|no (?:prior )?experience (?:required|necessary|needed)/i.test(s)) return { min: 0, max: null };
  const found: YearsRange[] = [];
  for (const m of s.matchAll(EN_YEARS)) {
    const after = m[3] ?? '';
    const before = s.slice(Math.max(0, (m.index ?? 0) - 25), m.index ?? 0);
    if (!EN_CONTEXT.test(after) && !/experience/i.test(before)) continue;
    if (EN_NOT_REQUIREMENT.test(after) || /\b(over the (past|last)|for the (past|last)|in the (past|last))\s*$/i.test(before)) continue;
    const min = Number(m[1]);
    const max = m[2] != null ? Number(m[2]) : null;
    found.push(max != null && max < min ? { min: max, max: min } : { min, max });
  }
  for (const m of s.matchAll(ZH_YEARS)) {
    const before = s.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0);
    const after = m[4] ?? '';
    if (!ZH_CONTEXT.test(before) && !ZH_CONTEXT.test(after)) continue;
    const a = cnNumber(m[1]);
    const b = m[2] != null ? cnNumber(m[2]) : null;
    if (a == null || Number.isNaN(a)) continue;
    if (m[3] === '以下') found.push({ min: 0, max: a });
    else found.push(b != null && !Number.isNaN(b) ? { min: Math.min(a, b), max: Math.max(a, b) } : { min: a, max: null });
  }
  const valid = found.filter((r) => r.min != null && r.min <= 30 && (r.max == null || r.max <= 40));
  if (!valid.length) return null;
  valid.sort((x, y) => (x.min ?? 0) - (y.min ?? 0));
  return valid[0];
}

/** A provider's years band ("0-2", "2-5", "5-10", "10+", "3 years") or months. */
export function yearsFromProvider(band: string | null | undefined, months?: number | null): YearsRange | null {
  if (typeof months === 'number' && Number.isFinite(months) && months >= 0) {
    return { min: Math.round(months / 12), max: null };
  }
  if (!band) return null;
  const s = band.trim();
  const range = s.match(/^(\d{1,2})\s*[-–~]\s*(\d{1,2})/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const plus = s.match(/^(\d{1,2})\s*\+/);
  if (plus) return { min: Number(plus[1]), max: null };
  const single = s.match(/^(\d{1,2})\s*(?:years?|yrs?|年)?$/i);
  if (single) return { min: Number(single[1]), max: Number(single[1]) };
  return null;
}

// ── Employment type ────────────────────────────────────────────────────────

/** Provider enums and labels → our employment type (null when unknown). */
export function employmentTypeFromLabel(raw: string | readonly string[] | null | undefined): EmploymentType | null {
  const first = Array.isArray(raw) ? raw.find((r) => typeof r === 'string' && r.trim()) : raw;
  if (typeof first !== 'string') return null;
  const s = first.normalize('NFKC').toLowerCase().replace(/[^a-z㐀-鿿]/g, '');
  if (!s) return null;
  if (s.startsWith('intern') || /实习|實習/.test(s)) return 'internship';
  if (s.startsWith('fulltime') || s === 'permanent' || s === 'regular' || /全职|全職|正职|正職/.test(s)) return 'full_time';
  if (s.startsWith('parttime') || /兼职|兼職|计时|計時/.test(s)) return 'part_time';
  if (s.startsWith('contract') || s.startsWith('temporary') || s === 'temp' || s === 'freelance' || /合同|劳务|勞務|約聘|约聘|派遣|临时|臨時|外包/.test(s)) return 'contract';
  return null;
}

/** Employment type stated in a title ("Summer Intern", "(Contract)", "Part-time", 实习). */
export function employmentTypeFromTitle(title: string): EmploymentType | null {
  const t = title.normalize('NFKC');
  if (/\b(intern|internship|co-?op)\b|实习|實習/i.test(t)) return 'internship';
  if (/\bpart[- ]?time\b|兼职|兼職/i.test(t)) return 'part_time';
  if (/\b(contract|contractor|temporary|temp|freelance|fixed[- ]term)\b|约聘|約聘|派遣|劳务|勞務/i.test(t)) return 'contract';
  if (/\bfull[- ]?time\b|全职|全職/i.test(t)) return 'full_time';
  return null;
}

// ── Education ──────────────────────────────────────────────────────────────

const EDUCATION_RANK: Readonly<Record<EducationLevel, number>> = { none: 0, associate: 1, bachelor: 2, master: 3, phd: 4 };

/**
 * A provider's education label → our level. Recruiter banks send their own
 * enum or the Chinese word ("bachelor", "associate", "本科", "不限"). A value
 * we have no level for (high school, anything unknown) is null, never a guess.
 */
export function educationFromLabel(label: string | null | undefined): EducationLevel | null {
  if (typeof label !== 'string') return null;
  const s = label.normalize('NFKC').toLowerCase().trim();
  if (!s) return null;
  if (s === 'none' || /^(不限|学历不限|學歷不限|不限学历|不限學歷|无要求|無要求)$/.test(s)) return 'none';
  if (/博士|^phd$|^ph\.d\.?$|^doctor(ate|al)?$/.test(s)) return 'phd';
  if (/硕士|碩士|研究生|^master'?s?$|^postgraduate$/.test(s)) return 'master';
  if (/本科|学士|學士|^bachelor'?s?$|^undergraduate$/.test(s)) return 'bachelor';
  if (/大专|大專|专科|專科|^associate'?s?$|^college$|^junior[ _]college$/.test(s)) return 'associate';
  return null;
}

const DEGREE_WORDS: [EducationLevel, string][] = [
  ['phd', '博士'],
  ['master', '硕士|碩士|研究生'],
  ['bachelor', '本科|学士|學士'],
  ['associate', '大专|大專|专科|專科'],
];
const ANY_DEGREE = DEGREE_WORDS.map(([, w]) => w).join('|');
/** "统招本科及以上", "全日制大专或以上学历", "本科以上": a stated minimum. */
const EDUCATION_MIN_RE = new RegExp(String.raw`(?:统招|統招|全日制)?(?:${ANY_DEGREE})(?:学历|學歷|学位|學位)?\s*(?:及|或|\(含\)|含)?\s*以上(?:学历|學歷|学位|學位)?`, 'g');
/** "学历:硕士", "学历要求：统招本科", "学历要求本科": the posting labels the level itself. */
const EDUCATION_LABELLED_RE = new RegExp(
  String.raw`(?:学历|學歷|学位|學位)(?:要求\s*[:：]?|\s*[:：])\s*(?:统招|統招|全日制)?(?:${ANY_DEGREE})`,
  'g',
);
/**
 * "本科学历", "统招本科", "博士学位": a bare level. Postings also use these
 * words about the company ("团队成员拥有硕士学历") and about benefits
 * ("在职研究生学历教育补贴"), so a bare level counts only where the posting is
 * stating a requirement (`statesRequirement`). "博士毕业" is never read: it
 * describes a person, not a requirement.
 */
const EDUCATION_BARE_RE = new RegExp(
  String.raw`(?:统招|統招|全日制)(?:${ANY_DEGREE})(?:学历|學歷|学位|學位)?|(?:${ANY_DEGREE})(?:学历|學歷|学位|學位)`,
  'g',
);
/** Words that make a clause a requirement. */
const REQUIREMENT_WORD_RE = /要求|任职|任職|资格|資格|必须|必須|需|须|須|具备|具備/;
/** Sentence and line ends: a clause never crosses one. */
const CLAUSE_END_RE = /[。；;！!？?\n\r]/;
/**
 * Section labels: "任职要求：", "一、岗位职责：", "【公司简介】", or a known
 * heading on a line of its own ("任职资格"). Group 1, 2 or 3 is the label. A
 * numbered list item ("1、专业：计算机") is not a section label.
 */
const SECTION_LABEL_RE = /(?:^|[\n\r。；;])[ \t　]*(?:[一二三四五六七八九十]+[、.．)）][ \t]*)?(?:【([^】\n\r]{2,12})】|([^\s:：。；;，,、\d【】]{2,12})[ \t]*[:：]|((?:任职|任職|岗位|崗位|职位|職位|工作|应聘|應聘|招聘|基本|公司|企业|企業|团队|團隊|薪资|薪資|薪酬|福利|关于|關於|我们|我們|加分|优先|優先)[^\s:：。；;，,、\d【】]{0,8})[ \t]*(?=[\n\r]))/g;
const REQUIREMENT_LABEL_RE = /要求|资格|資格|条件|條件/;
const NOT_REQUIREMENT_LABEL_RE = /优先|優先|加分|福利|待遇/;
/** How far below a requirement heading a bare level is still read as part of its list. */
const REQUIREMENT_SECTION_SPAN = 400;

/**
 * True when the text at [index, end) sits where the posting states a
 * requirement: its own clause says so ("要求本科学历", "需具备硕士学位"), or the
 * nearest section label above it is a requirement heading ("任职要求：\n1、
 * 本科学历"). A company introduction or a benefits list is neither.
 */
function statesRequirement(s: string, index: number, end: number): boolean {
  let from = index;
  while (from > 0 && !CLAUSE_END_RE.test(s[from - 1]!)) from -= 1;
  let to = end;
  while (to < s.length && !CLAUSE_END_RE.test(s[to]!)) to += 1;
  const clause = s.slice(from, to);
  // A label inside the clause decides it ("公司简介：…硕士学历" is not a requirement; "任职要求：本科学历" is).
  const own = /^[ \t\u3000]*(?:[一二三四五六七八九十\d]+[、.．)）][ \t]*)?(?:【([^】]{2,12})】|([^\s:：，,、\d【】]{2,12})[ \t]*[:：])/.exec(clause);
  const ownLabel = own ? (own[1] ?? own[2] ?? '') : '';
  if (ownLabel) {
    if (REQUIREMENT_LABEL_RE.test(ownLabel) && !NOT_REQUIREMENT_LABEL_RE.test(ownLabel)) return true;
    if (!/学历|學歷|学位|學位/.test(ownLabel)) return REQUIREMENT_WORD_RE.test(clause.slice(own![0].length));
  }
  if (REQUIREMENT_WORD_RE.test(clause)) return true;
  let label = '';
  let labelEnd = -1;
  for (const m of s.slice(0, from).matchAll(SECTION_LABEL_RE)) {
    label = m[1] ?? m[2] ?? m[3] ?? '';
    labelEnd = (m.index ?? 0) + m[0].length;
  }
  if (!label || index - labelEnd > REQUIREMENT_SECTION_SPAN) return false;
  return REQUIREMENT_LABEL_RE.test(label) && !NOT_REQUIREMENT_LABEL_RE.test(label);
}
const EDUCATION_ANY_RE = /学历不限|學歷不限|不限学历|不限學歷|学历要求\s*[:：]?\s*不限|學歷要求\s*[:：]?\s*不限|无学历要求|無學歷要求/;
/** A degree named as a plus ("硕士优先", "博士加分"), not as the requirement. */
const EDUCATION_PREFERRED_RE = /^[^，,。；;、\s]{0,4}(?:优先|優先|加分|更佳|为佳|為佳)/;

function levelOfPhrase(phrase: string): EducationLevel | null {
  for (const [level, words] of DEGREE_WORDS) if (new RegExp(words).test(phrase)) return level;
  return null;
}

export interface EducationFromText {
  level: EducationLevel;
  /** The posting's own words (≤ 60 characters). */
  quote: string;
}

/**
 * The lowest education a Chinese posting states it requires, with the words
 * that say so: "不限学历" → none, "大专及以上" → associate, "统招本科及以上"
 * → bachelor, "硕士及以上学历" → master, "要求博士学位" → phd. A degree named
 * only as a plus ("硕士优先") is not the requirement, and neither is a degree
 * the posting mentions about its team or its benefits. When a posting states
 * several levels the lowest one is the requirement ("本科及以上，硕士优先").
 * Null when the text states none (an honest unknown beats a guess, D3).
 */
export function educationFromText(text: string | null | undefined): EducationFromText | null {
  if (!text) return null;
  const s = text.normalize('NFKC');
  const any = s.match(EDUCATION_ANY_RE);
  const found: Array<EducationFromText & { index: number }> = [];
  // A stated minimum ("…及以上") is the requirement; then a labelled level ("学历：本科");
  // a bare level is read last, and only where the posting states a requirement.
  for (const re of [EDUCATION_MIN_RE, EDUCATION_LABELLED_RE, EDUCATION_BARE_RE]) {
    for (const m of s.matchAll(re)) {
      const index = m.index ?? 0;
      const end = index + m[0].length;
      if (EDUCATION_PREFERRED_RE.test(s.slice(end, end + 10))) continue;
      if (re === EDUCATION_BARE_RE && !statesRequirement(s, index, end)) continue;
      const level = levelOfPhrase(m[0]);
      if (level) found.push({ level, quote: m[0].trim().slice(0, 60), index });
    }
    if (found.length) break;
  }
  if (!found.length) return any ? { level: 'none', quote: any[0].trim().slice(0, 60) } : null;
  found.sort((a, b) => EDUCATION_RANK[a.level] - EDUCATION_RANK[b.level] || a.index - b.index);
  return { level: found[0]!.level, quote: found[0]!.quote };
}
