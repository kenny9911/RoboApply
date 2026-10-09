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

import type { EmploymentType, FieldSource, RoleType, Seniority } from './types.js';

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
  if (s.startsWith('contract') || s.startsWith('temporary') || s === 'temp' || s === 'freelance' || /合同|約聘|约聘|派遣|临时|臨時|外包/.test(s)) return 'contract';
  return null;
}

/** Employment type stated in a title ("Summer Intern", "(Contract)", "Part-time", 实习). */
export function employmentTypeFromTitle(title: string): EmploymentType | null {
  const t = title.normalize('NFKC');
  if (/\b(intern|internship|co-?op)\b|实习|實習/i.test(t)) return 'internship';
  if (/\bpart[- ]?time\b|兼职|兼職/i.test(t)) return 'part_time';
  if (/\b(contract|contractor|temporary|temp|freelance|fixed[- ]term)\b|约聘|約聘|派遣/i.test(t)) return 'contract';
  if (/\bfull[- ]?time\b|全职|全職/i.test(t)) return 'full_time';
  return null;
}
