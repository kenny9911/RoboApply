// extension/src/adapters/cn/fields.ts — what each field on a mainland 网申 form
// is, and the user's own value for it (一键填表).
//
// Section-aware: the same label means different things in different sections
// ("姓名" in 基本信息 is the user; in 家庭成员 / 主要社会关系 it is a family
// member; in 紧急联系人 / 推荐人 it is someone else), and repeated row blocks
// map to the n-th education / experience / family entry.
//
// Another person's details are never filled from the user's own: a 紧急联系人,
// 推荐人 or 证明人 block (or a label naming such a person) is left for the user,
// and under a heading this file does not know, 姓名 / 手机 / 邮箱 are the
// user's only the first time the form asks for them.
//
// Values come ONLY from what the user entered:
//   - the profile (name, phone, email, education, experience, GoApply cnFields);
//   - the encrypted sensitive answers (籍贯 / 政治面貌 / 家庭成员), which the
//     server sends only with the user's `autofill_sensitive` consent;
//   - the user's saved answers (生源地, 户口, 微信号 … exact question only).
// Personal details the profile does not hold (性别, 出生日期, 身份证, 民族 …)
// are never guessed and never drafted: they stay "Needs you".

import { normalizeText } from '../_kit/options';
import type { FieldHandle, FieldValue } from '../types';
import { bankAnswerFor, profileValue, type Resolution } from '../../mapping/resolve';
import type { AutofillProfile } from '../../shared/contract';
import type { CnAdapter } from './kit';

export type CnSection = 'basic' | 'education' | 'experience' | 'family' | 'contact' | 'other';

export const CN_FIELD_KEYS = [
  'name',
  'phone',
  'email',
  'wechat',
  // Personal details: filled only from a saved answer, never drafted.
  'gender',
  'birthDate',
  'idNumber',
  'ethnicity',
  'marital',
  'health',
  'photo',
  // Optional details, filled only from what the user entered (sensitive store or saved answers).
  'nativePlace',
  'politicalStatus',
  'sourcePlace',
  'hukou',
  // Study and availability (GoApply profile fields).
  'graduation',
  'availableFrom',
  'internDays',
  'internMonths',
  // Rows.
  'school',
  'degree',
  'major',
  'eduStart',
  'eduEnd',
  'company',
  'title',
  'expStart',
  'expEnd',
  'familyRelation',
  'familyName',
  'familyEmployer',
  'familyTitle',
] as const;
export type CnFieldKey = (typeof CN_FIELD_KEYS)[number];

/** Never generated and never guessed: only a saved answer of the user fills them. */
export const CN_PERSONAL_KEYS: ReadonlySet<CnFieldKey> = new Set(['gender', 'birthDate', 'idNumber', 'ethnicity', 'marital', 'health', 'photo']);
/** Details shown highlighted for review when filled (籍贯, 政治面貌, family). */
export const CN_SENSITIVE_KEYS: ReadonlySet<CnFieldKey> = new Set([
  ...CN_PERSONAL_KEYS,
  'nativePlace',
  'politicalStatus',
  'sourcePlace',
  'hukou',
  'familyRelation',
  'familyName',
  'familyEmployer',
  'familyTitle',
]);

/** Filled from the encrypted optional details, which the server sends only with the `autofill_sensitive` consent. */
export const CN_SENSITIVE_STORE_KEYS: ReadonlySet<CnFieldKey> = new Set(['nativePlace', 'politicalStatus', 'familyRelation', 'familyName', 'familyEmployer', 'familyTitle']);

export interface CnPlanEntry {
  key: CnFieldKey | null;
  section: CnSection;
  /** The n-th entry of a repeated block (education / experience / family), from 0. */
  row: number;
  /** A personal detail: never drafted, filled only from a saved answer. */
  personal: boolean;
  /** No AI draft for this field (personal details, family rows, another person, grades and scores). */
  noDraft: boolean;
  /**
   * Left for the user whatever the profile holds: `other_person` (an emergency
   * contact, referee …), `check_whose` (asked again under a heading we do not
   * know, so it may be about someone else).
   */
  leave?: 'other_person' | 'check_whose';
}

// ── sections ────────────────────────────────────────────────────────────────

const SECTION_RULES: Array<[RegExp, CnSection]> = [
  // 主要社会关系 is how many state-owned employers title the family block.
  [/家庭|亲属|親屬|社会关系|社會關係|配偶/, 'family'],
  // Someone other than the user: never filled from the profile.
  [/紧急联系人|緊急聯絡人|紧急联络人|^联系人(信息|资料)?$|^聯絡人(資訊|資料)?$|推荐人|推薦人|内推|內推|证明人|證明人|担保人|擔保人|介绍人|介紹人/, 'contact'],
  [/教育|学习经历|學習經歷|学历|學歷|学业|學業/, 'education'],
  // "实习经历" holds rows; "实习意向" / "实习信息" (days a week, start date) do not.
  [/(实习|實習|工作|实践|實踐|职业|職業|任职|任職)(经历|經歷|经验|經驗|履历|履歷)/, 'experience'],
  [/基本信息|个人信息|個人資料|个人资料|基本資料|個人資訊|基础信息|基礎資訊|联系方式|联系信息|聯絡資訊|报名信息|報名資訊|申请人信息|申請人資訊|应聘信息|應聘資訊/, 'basic'],
];

export function sectionKind(title: string | null): CnSection {
  if (!title) return 'basic';
  const n = normalizeText(title);
  for (const [re, kind] of SECTION_RULES) if (re.test(n)) return kind;
  return 'other';
}

// ── labels ──────────────────────────────────────────────────────────────────
// Patterns run on normalizeText(label) without spaces; anchored where a label
// IS the field ("专业"), not where it merely mentions it.

const PERSONAL_RULES: Array<[RegExp, CnFieldKey]> = [
  [/^性别$|^性別$/, 'gender'],
  [/出生(日期|年月|年份)|^生日$|^年龄$|^年齡$/, 'birthDate'],
  [/身份证|身分證|证件号|證件號|证件类型|證件類型|护照号/, 'idNumber'],
  [/^民族$/, 'ethnicity'],
  [/婚姻|婚否|婚育/, 'marital'],
  [/健康|身高|体重|體重|宗教|血型/, 'health'],
  [/照片|证件照|證件照|头像|頭像|生活照/, 'photo'],
];

const COMMON_RULES: Array<[RegExp, CnFieldKey]> = [
  [/^籍贯$|^籍貫$/, 'nativePlace'],
  [/^政治面貌$|^政治面貌状态$/, 'politicalStatus'],
  [/^生源地$|^生源所在地$/, 'sourcePlace'],
  [/户口|戶口|户籍|戶籍/, 'hukou'],
  [/^微信(号|號)?$|^微信id$/, 'wechat'],
  [/到岗时间|到崗時間|可到岗|最快到岗|可入职时间|最快入职|入职时间|可开始实习时间/, 'availableFrom'],
  [/每周(可)?(实习|到岗|出勤)(天数)?|每週(可)?(實習|到崗)(天數)?/, 'internDays'],
  [/实习(时长|期限|周期|月数)|實習(時長|期限)|可实习(时长|月数|多久)/, 'internMonths'],
];

const BASIC_RULES: Array<[RegExp, CnFieldKey]> = [
  [/^(真实|中文)?姓名$|^(真實|中文)?姓名$|^名字$/, 'name'],
  [/^(手机|手機)(号码|號碼|号)?$|^联系(电话|方式)$|^聯絡電話$|^移动电话$|^电话(号码)?$/, 'phone'],
  [/^(电子)?邮箱(地址)?$|^(電子)?郵箱(地址)?$|^电子邮件$|^電子郵件$|^e-?mail$|^email地址$/, 'email'],
  [/^(预计)?毕业(时间|年份|日期|年月)$|^(預計)?畢業(時間|年份)$|^届别$|^屆別$|^毕业届别$/, 'graduation'],
  [/^(毕业)?(学校|院校)(名称)?$|^毕业院校$/, 'school'],
  [/^(最高)?(学历|學歷)$|^学位$|^學位$/, 'degree'],
  [/^(所学)?专业(名称)?$|^(所學)?專業$/, 'major'],
];

const EDUCATION_RULES: Array<[RegExp, CnFieldKey]> = [
  [/^(毕业)?(学校|院校|學校)(名称)?$|^毕业院校$/, 'school'],
  [/^(学历|學歷|学位|學位)$/, 'degree'],
  [/^(所学)?(专业|專業)(名称)?$/, 'major'],
  [/^(入学|入學)(时间|時間|年月)$|^(开始|起始)(时间|年月)$|^开始日期$/, 'eduStart'],
  [/^(毕业|畢業)(时间|時間|年月|日期)$|^(结束|結束)(时间|時間|年月|日期)$/, 'eduEnd'],
];

const EXPERIENCE_RULES: Array<[RegExp, CnFieldKey]> = [
  [/^(公司|单位|單位|实习单位|實習單位|工作单位|企业)(名称)?$/, 'company'],
  [/^(职位|職位|岗位|崗位|职务|職務|担任职位)(名称)?$/, 'title'],
  [/^(开始|起始|入职|入職)(时间|時間|日期|年月)$/, 'expStart'],
  [/^(结束|結束|离职|離職)(时间|時間|日期|年月)$/, 'expEnd'],
];

const FAMILY_RULES: Array<[RegExp, CnFieldKey]> = [
  [/^(关系|關係|与本人关系|與本人關係|称谓|稱謂|家庭关系)$/, 'familyRelation'],
  [/^(姓名|成员姓名|成員姓名)$/, 'familyName'],
  [/^(工作单位|工作單位|单位|單位|所在单位)$/, 'familyEmployer'],
  [/^(职务|職務|职位|職位|职业|職業)$/, 'familyTitle'],
];

/** A label naming someone other than the user ("紧急联系人电话", "证明人", "父亲姓名"). */
const OTHER_PERSON_RE =
  /紧急联系人|緊急聯絡人|紧急联络人|联系人(姓名|电话|手机|关系|方式)|聯絡人(姓名|電話|手機|關係)|推荐人|推薦人|内推人|內推人|证明人|證明人|担保人|擔保人|介绍人|介紹人|导师|導師|辅导员|輔導員|指导老师|指導老師|父亲|父親|母亲|母親|配偶|爱人|愛人/;

/** Grades, ranks and test scores: only the user knows them, so no AI draft is ever offered. */
const SCORE_RE = /gpa|绩点|績點|排名|成绩|成績|分数|分數|四级|六级|四級|六級|cet|雅思|托福|ielts|toefl|gre|gmat/i;

function compact(label: string): string {
  return normalizeText(label).replace(/\s+/g, '');
}

function firstMatch(rules: Array<[RegExp, CnFieldKey]>, label: string): CnFieldKey | null {
  for (const [re, key] of rules) if (re.test(label)) return key;
  return null;
}

/** The cn key for one label in one section, or null. */
export function classifyCnLabel(label: string, section: CnSection): CnFieldKey | null {
  const n = compact(label);
  if (!n || n.length > 24) return null;
  if (section === 'contact') return null;
  if (section === 'family') return firstMatch(FAMILY_RULES, n);
  const personal = firstMatch(PERSONAL_RULES, n);
  if (personal) return personal;
  if (section === 'education') return firstMatch(EDUCATION_RULES, n) ?? firstMatch(COMMON_RULES, n);
  if (section === 'experience') return firstMatch(EXPERIENCE_RULES, n) ?? firstMatch(COMMON_RULES, n);
  return firstMatch(COMMON_RULES, n) ?? firstMatch(BASIC_RULES, n);
}

const ROW_SECTIONS: ReadonlySet<CnSection> = new Set(['education', 'experience', 'family']);
/** Sections whose every field the cn layer owns (another person's details included). */
const OWNED_SECTIONS: ReadonlySet<CnSection> = new Set(['education', 'experience', 'family', 'contact']);
/** The user's identity: under an unknown heading, theirs only the first time the form asks. */
const IDENTITY_KEYS: ReadonlySet<CnFieldKey> = new Set(['name', 'phone', 'email']);
/** Keys that belong to the n-th education / experience entry wherever they repeat. */
const ROW_KEYS: ReadonlySet<CnFieldKey> = new Set(['school', 'degree', 'major', 'eduStart', 'eduEnd', 'company', 'title', 'expStart', 'expEnd']);

/**
 * One plan entry per field the cn layer owns. Fields it does not know in the
 * basic/other sections are left to the shared mapping (email, links, resume …);
 * in a row section (education / experience / family) and in a 紧急联系人 /
 * 推荐人 block every field is owned, so another person's "姓名" never receives
 * the user's own name.
 */
export function planCnFields(adapter: CnAdapter, fields: readonly FieldHandle[]): Map<string, CnPlanEntry> {
  const plan = new Map<string, CnPlanEntry>();
  const seen = new Map<string, number>();
  const identitySeen = new Set<CnFieldKey>();
  const next = (counter: string) => {
    const row = seen.get(counter) ?? 0;
    seen.set(counter, row + 1);
    return row;
  };
  for (const f of fields) {
    const section = sectionKind(adapter.cn.sectionTitle(f.element));
    const label = compact(f.label);
    // A file input is a resume / cover letter (shared mapping) unless it asks for a photo.
    if (f.kind === 'file') {
      if (classifyCnLabel(f.label, 'basic') === 'photo') plan.set(f.id, { key: 'photo', section, row: 0, personal: true, noDraft: true });
      continue;
    }
    // Another person's details: owned, never filled, never drafted.
    if (section === 'contact' || (section !== 'family' && OTHER_PERSON_RE.test(label))) {
      plan.set(f.id, { key: null, section, row: 0, personal: false, noDraft: true, leave: 'other_person' });
      continue;
    }
    let key = classifyCnLabel(f.label, section);
    const score = !key && SCORE_RE.test(label);
    if (!key && !score && !OWNED_SECTIONS.has(section)) continue;

    let leave: CnPlanEntry['leave'];
    let row = 0;
    if (ROW_SECTIONS.has(section)) {
      row = next(`${section}:${key ?? `?${f.label}`}`);
    } else if (key && ROW_KEYS.has(key)) {
      // "学校名称" repeated under a heading we do not know: the n-th degree, not the first one again.
      row = next(`${section}:${key}`);
    } else if (key && section === 'other') {
      // Asked again under an unknown heading: it may be about someone else.
      const again = next(`other:${key}`) > 0 || (IDENTITY_KEYS.has(key) && identitySeen.has(key));
      if (again) {
        leave = 'check_whose';
        key = null;
      }
    } else if (key && (key === 'name' || key === 'email') && identitySeen.has(key)) {
      // A second 姓名 / 邮箱 even in 基本信息 (a form without headings) is not the user's own again.
      // (A second phone is common there: 手机 + 联系电话.)
      leave = 'check_whose';
      key = null;
    }
    if (key && IDENTITY_KEYS.has(key)) identitySeen.add(key);

    const personal = key !== null && CN_PERSONAL_KEYS.has(key);
    const noDraft = personal || score || Boolean(leave) || section === 'family' || (key !== null && CN_SENSITIVE_KEYS.has(key));
    plan.set(f.id, { key, section, row, personal, noDraft, ...(leave ? { leave } : {}) });
  }
  return plan;
}

// ── values ──────────────────────────────────────────────────────────────────

function str(obj: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const CJK_RE = /[㐀-鿿]/;

/** 姓名: family name first, no space, for Chinese names; "First Last" otherwise. */
export function cnFullName(p: AutofillProfile): string | null {
  const first = str(p.profile, 'firstName');
  const last = str(p.profile, 'lastName');
  if (first && last && (CJK_RE.test(first) || CJK_RE.test(last))) return `${last}${first}`;
  return profileValue('fullName', p);
}

/** 手机: a mainland number without the +86 prefix (forms expect 11 digits); others unchanged. */
export function cnPhone(p: AutofillProfile): string | null {
  const raw = str(p.profile, 'phoneE164', 'phone');
  if (!raw) return null;
  const m = raw.replace(/[\s-]/g, '').match(/^(?:\+?86)(1\d{10})$/);
  return m ? m[1] : raw;
}

const DEGREE_ZH: Record<string, string> = { dazhuan: '大专', bachelor: '本科', master: '硕士', phd: '博士' };
const INTERN_MONTHS_ZH: Record<string, string> = { '1-2': '1-2个月', '3': '3个月', '6+': '6个月' };

/** A 'YYYY-MM' value in the shape the field expects; null when it would need a day we do not have. */
export function formatMonth(field: FieldHandle, ym: string | null): string | null {
  if (!ym) return null;
  const m = ym.match(/^(\d{4})-(\d{1,2})/);
  if (!m) return ym;
  const year = m[1];
  const month = m[2].padStart(2, '0');
  const type = (field.element.getAttribute('type') ?? '').toLowerCase();
  if (type === 'date' || type === 'datetime-local') return null;
  if (type === 'month') return `${year}-${month}`;
  const hint = `${field.element.getAttribute('placeholder') ?? ''}`;
  if (/年/.test(hint)) return `${year}年${month}月`;
  if (/\//.test(hint)) return `${year}/${month}`;
  if (/\./.test(hint)) return `${year}.${month}`;
  return `${year}-${month}`;
}

function asValue(field: FieldHandle, text: string): FieldValue {
  return field.kind === 'select' || field.kind === 'radio' || field.kind === 'combobox' ? { kind: 'option', option: text } : { kind: 'text', text };
}

function cnFields(p: AutofillProfile): Record<string, unknown> | null {
  return obj(p.profile.cnFields);
}

function sensitiveCn(p: AutofillProfile): Record<string, unknown> | null {
  return obj(p.sensitive?.cn);
}

function graduation(field: FieldHandle, p: AutofillProfile): string | null {
  const cf = cnFields(p);
  const year = cf?.graduationClass;
  const month = cf?.graduationMonth;
  if (/届|屆/.test(field.label) && typeof year === 'number') return field.kind === 'text' ? `${year}届` : String(year);
  const end = str(p.education[0] ?? null, 'endDate');
  if (end) return formatMonth(field, end);
  if (typeof year === 'number' && typeof month === 'number') return formatMonth(field, `${year}-${String(month).padStart(2, '0')}`);
  if (typeof year === 'number' && (field.kind === 'select' || field.kind === 'combobox' || field.kind === 'radio')) return String(year);
  return null;
}

function degree(p: AutofillProfile, row: number): string | null {
  const own = str(p.education[row] ?? null, 'degree');
  if (own) return DEGREE_ZH[own] ?? own;
  if (row !== 0) return null;
  const code = str(cnFields(p), 'degree');
  return code ? (DEGREE_ZH[code] ?? null) : null;
}

function rowValue(key: CnFieldKey, field: FieldHandle, row: number, p: AutofillProfile): string | null {
  const edu = (p.education[row] as Record<string, unknown> | undefined) ?? null;
  const exp = (p.experience[row] as Record<string, unknown> | undefined) ?? null;
  switch (key) {
    case 'school':
      return str(edu, 'school') ?? (row === 0 ? str(cnFields(p), 'schoolName') : null);
    case 'degree':
      return degree(p, row);
    case 'major':
      return str(edu, 'major', 'discipline') ?? (row === 0 ? str(cnFields(p), 'major') : null);
    case 'eduStart':
      return formatMonth(field, str(edu, 'startDate'));
    case 'eduEnd':
      return formatMonth(field, str(edu, 'endDate'));
    case 'company':
      return str(exp, 'company');
    case 'title':
      return str(exp, 'title');
    case 'expStart':
      return formatMonth(field, str(exp, 'startDate'));
    case 'expEnd': {
      const end = str(exp, 'endDate');
      if (end) return formatMonth(field, end);
      // "至今" is what the user told us (current role), and only a text box can take it.
      return exp?.current === true && (field.kind === 'text' || field.kind === 'combobox' || field.kind === 'select') ? '至今' : null;
    }
    default:
      return null;
  }
}

function familyValue(key: CnFieldKey, row: number, p: AutofillProfile): string | null {
  const members = sensitiveCn(p)?.familyMembers;
  const m = Array.isArray(members) ? obj(members[row]) : null;
  switch (key) {
    case 'familyRelation':
      return str(m, 'relation');
    case 'familyName':
      return str(m, 'name');
    case 'familyEmployer':
      return str(m, 'employer');
    case 'familyTitle':
      return str(m, 'title');
    default:
      return null;
  }
}

/** The text value the user's profile gives a cn key (null: the profile does not have it). */
export function cnProfileValue(key: CnFieldKey, field: FieldHandle, entry: Pick<CnPlanEntry, 'row'>, p: AutofillProfile): string | null {
  const cf = cnFields(p);
  switch (key) {
    case 'name':
      return cnFullName(p);
    case 'phone':
      return cnPhone(p);
    case 'email':
      return profileValue('email', p);
    case 'graduation':
      return graduation(field, p);
    case 'availableFrom':
      return str(cf, 'availableFrom');
    case 'internDays': {
      const n = cf?.internshipDaysPerWeek;
      return typeof n === 'number' ? (field.kind === 'text' ? `${n}天` : String(n)) : null;
    }
    case 'internMonths': {
      const code = str(cf, 'internshipMonths');
      return code ? (INTERN_MONTHS_ZH[code] ?? null) : null;
    }
    case 'nativePlace':
      return str(sensitiveCn(p), 'nativePlace');
    case 'politicalStatus':
      return str(sensitiveCn(p), 'politicalStatus');
    case 'familyRelation':
    case 'familyName':
    case 'familyEmployer':
    case 'familyTitle':
      return familyValue(key, entry.row, p);
    case 'school':
    case 'degree':
    case 'major':
    case 'eduStart':
    case 'eduEnd':
    case 'company':
    case 'title':
    case 'expStart':
    case 'expEnd':
      return rowValue(key, field, entry.row, p);
    default:
      // wechat, sourcePlace, hukou and personal details: saved answers only.
      return null;
  }
}

/** Saved-answer keys some users store these details under. */
const BANK_KEYS: Partial<Record<CnFieldKey, string[]>> = {
  wechat: ['wechat', '微信', '微信号'],
  sourcePlace: ['sourcePlace', 'studentOrigin', '生源地'],
  hukou: ['hukou', '户口', '户口所在地'],
  nativePlace: ['nativePlace', '籍贯'],
  politicalStatus: ['politicalStatus', '政治面貌'],
  gender: ['gender', '性别'],
  ethnicity: ['ethnicity', '民族'],
};

function bankByKey(key: CnFieldKey, p: AutofillProfile): string | null {
  const names = BANK_KEYS[key];
  if (!names) return null;
  const want = new Set(names.map((n) => n.toLowerCase()));
  const hit = p.answers.find((a) => want.has(a.questionKey.toLowerCase()) || want.has(compact(a.questionText)));
  return hit?.answer.trim() || null;
}

export type CnResolution = Resolution | null;

/**
 * The user's own value for a planned field, or null (left for the user).
 * Never returns generated text; never fills a family row from the user's own
 * details; personal details only from a saved answer to the same question.
 */
export function resolveCnField(field: FieldHandle, entry: CnPlanEntry, p: AutofillProfile): CnResolution {
  if (!entry.key || entry.key === 'photo' || entry.leave) return null;
  const sensitive = CN_SENSITIVE_KEYS.has(entry.key);
  // Saved answers are per question, not per row: never in a repeated block.
  const bank = () => {
    if (entry.section === 'family' || entry.section === 'education' || entry.section === 'experience') return null;
    const exact = bankAnswerFor(field.label, p.answers, { exactOnly: true })?.answer ?? bankByKey(entry.key!, p);
    return exact ? { value: asValue(field, exact), source: 'bank' as const, sensitive } : null;
  };
  if (entry.personal) return bank();
  const v = cnProfileValue(entry.key, field, entry, p);
  if (v) return { value: asValue(field, v), source: 'profile', sensitive };
  return bank();
}
