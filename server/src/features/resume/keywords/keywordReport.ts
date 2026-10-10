// server/src/features/resume/keywords/keywordReport.ts
//
// Keyword check (PRODUCT_PLAN.md F-RES-08; ARCH §3.6): requirement rows
// (title, years, education, skills n/m, keywords n/m) for one resume against
// one job. Deterministic and free: it reads the job's stored keyword
// extraction (`RAKeywordExtraction`), the job's normalized fields and the
// MATCH row when one exists. No LLM.
//
// What counts as a keyword. The stored extraction holds the posting's skills
// first and then plain TF-IDF terms of the text ("paid", "status", "了解",
// "28k"): frequent words, not requirements. Offering those as "skills this job
// asks for" asked users to tick "curiosity" and "angeles". Only these are
// listed here:
//   - the job's own skill list (`RAJob.skills`), and extraction rows that are
//     in it or are marked required (importance 'high': only skills are);
//   - hard-skill vocabulary terms the posting text names (the only source for
//     a pasted posting). A job that has its own skill list and stored rows
//     gets no vocabulary terms on top of them, and a term that is also an
//     everyday word ("sales", "API", "招聘", "测试"; "unity", "sketch") counts
//     only when the skill list, a required row or the job title names it, or
//     when the posting writes it as a tool name ("Unity", "Sketch").
// With `casing: 'posting'` terms are shown in the posting's own casing ("SQL",
// "dbt"), and "R or Python" is met by either.
//
// No second scale: the only score shown is the 0–100 fit score from the MATCH
// row (as a Sourced value), or nothing. A requirement the posting does not
// state, or a fact the resume does not show, is `unknown` ("Not listed"),
// never a pass or a fail.

import type { KeywordReportResponse, KeywordReportRow, KeywordRowStatus, SourcedNumber } from '../contract.js';
import { containsTerm, parseResume, sectionsOf, stripMarkdown, type ParsedResume } from '../check/resumeText.js';
import { EVERYDAY_TERMS, HARD_SKILLS_CN, HARD_SKILLS_EN, NON_SKILL_TERMS, WORD_LIKE_TOOL_NAMES } from './vocabulary.js';

export interface KeywordJobInput {
  title: string;
  /** Posting text (description + qualifications), plain. */
  text: string;
  minYears?: number | null;
  /** 'none' | 'associate' | 'bachelor' | 'master' | 'phd' */
  educationLevel?: string | null;
  /** Normalized hard skills from the job record. */
  skills?: readonly string[];
}

export interface KeywordExtractionInput {
  keywords: Array<{ keyword: string; importance?: string }>;
}

export interface FitRowInput {
  score: number;
  tier: string | null;
  generatedAt: Date;
  /** The row was scored against a different version of the resume. */
  stale: boolean;
}

export interface KeywordReportInput {
  resumeMarkdown: string;
  job: KeywordJobInput;
  extraction?: KeywordExtractionInput | null;
  fit?: FitRowInput | null;
  now?: Date;
  /**
   * How terms are written in the lists: 'posting' = as the posting writes
   * them ("SQL", "Power BI", "dbt"); 'as_listed' = as the skill list or the
   * vocabulary holds them (lower case). The signed-in product asks for
   * 'posting' (features/resume/index.ts); a caller that says nothing keeps
   * the lists it had.
   */
  casing?: 'posting' | 'as_listed';
}

const MAX_KEYWORDS = 20;
const TITLE_STOP = new Set(['senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff', 'intern', 'internship', 'i', 'ii', 'iii', 'iv', 'the', 'of', 'and', 'for', 'to', 'a', 'an', 'in', 'at', 'with', 'remote', 'hybrid', 'full', 'time', 'part', 'contract']);

export const EDUCATION_RANK: Record<string, number> = { none: 0, high_school: 1, associate: 2, bachelor: 3, master: 4, phd: 5 };

const EDU_PATTERNS: Array<[string, RegExp]> = [
  ['phd', /\bph\.?\s?d\b|doctorate|doctoral|博士/i],
  ['master', /\bmaster'?s?\b|\bm\.?s\.?c?\b|\bmba\b|\bm\.?eng\b|\bm\.?a\.?\b|硕士|研究生|碩士/i],
  ['bachelor', /\bbachelor'?s?\b|\bb\.?s\.?c?\b|\bb\.?a\.?\b|\bb\.?eng\b|\bundergraduate\b|本科|学士|學士/i],
  ['associate', /\bassociate'?s? degree\b|大专|專科|专科/i],
  ['high_school', /\bhigh school\b|高中/i],
];

function ratioStatus(met: number, total: number): KeywordRowStatus {
  if (total === 0) return 'unknown';
  const r = met / total;
  if (r >= 0.7) return 'pass';
  if (r >= 0.4) return 'warn';
  return 'fail';
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim();
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

const VOCABULARY: readonly string[] = [...HARD_SKILLS_EN, ...HARD_SKILLS_CN];
const VOCABULARY_SET: ReadonlySet<string> = new Set(VOCABULARY);

const normTerm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Is the term written as a name somewhere in the text: capitalised, and either
 * inside a sentence ("experience with Unity") or leading a list ("Excel, SQL
 * and Tableau")? "Unity is one of our values." and "Sketch out ideas" are not.
 */
function writtenAsName(term: string, text: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  for (const m of text.matchAll(re)) {
    if (!/^\p{Lu}/u.test(m[0])) continue;
    const at = m.index ?? 0;
    const before = text.slice(text.lastIndexOf('\n', at - 1) + 1, at).trim();
    const sentenceStart = before === '' || /^[-*•·▪◦]$|^\d+[.)]$/.test(before) || /[.!?。！？]$/.test(before);
    if (!sentenceStart) return true;
    if (/^\s*(?:[,，、;；/&)]|\r?\n|$|\s(?:and|or)\s)/i.test(text.slice(at + m[0].length))) return true;
  }
  return false;
}

/** May a vocabulary term found in the posting text be listed as something the job asks for? */
function namedAsSkill(term: string, text: string, confirmed: ReadonlySet<string>, title: string): boolean {
  if (confirmed.has(term)) return true;
  if (EVERYDAY_TERMS.has(term)) return containsTerm(title, term);
  if (WORD_LIKE_TOOL_NAMES.has(term)) return containsTerm(title, term) || writtenAsName(term, text);
  return true;
}

/**
 * Vocabulary terms a posting names. (Repeated capitals used to count as well;
 * they were mostly the employer's initials, so they no longer do.)
 *
 * `confirmed`: normalized terms the job's skill list or a required-skill row
 * names; `title`: the job title. An everyday word of the vocabulary counts
 * only with one of those behind it (see vocabulary.ts).
 */
export function termsFromPosting(text: string, confirmed: ReadonlySet<string> = new Set(), title = ''): string[] {
  return dedupe(VOCABULARY.filter((t) => containsTerm(text, t) && namedAsSkill(t, text, confirmed, title)));
}

/** False for anything that cannot be a skill: a pay figure ("28k"), a filler word, a possessive ("children's"). */
export function plausibleSkill(term: string): boolean {
  const t = normTerm(term);
  if (!t || t.length > 60) return false;
  if (NON_SKILL_TERMS.has(t)) return false;
  if (/^[\d.,]+\s*[kw万千]?\+?$/.test(t)) return false;
  if (/^[\p{L}]+['’](?:s|re|ve|ll|d|t)$/u.test(t)) return false;
  if (t.length < 2 && !/^[cr]$/.test(t)) return false;
  return /[\p{L}]/u.test(t);
}

/** The alternatives of "R or Python" / "Java 或 Go"; a plain term is its own alternative. */
function alternatives(term: string): string[] {
  const parts = term.split(/\s+(?:or|或)\s+|或者/i).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [term];
}

/** True when the text shows the term (any alternative of an "A or B" term). */
export function showsTerm(haystack: string, term: string): boolean {
  return alternatives(term).some((alt) => containsTerm(haystack, alt));
}

/** The term as the posting writes it ("sql" → "SQL", "dbt" stays "dbt"); unchanged when the posting does not name it. */
export function displayTerm(term: string, postingText: string): string {
  const t = term.trim();
  if (!t || /[㐀-鿿]/.test(t) || !postingText) return t;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').exec(postingText);
  return m ? m[0].replace(/\s+/g, ' ') : t;
}

export function requiredYearsFrom(text: string): number | null {
  const m = text.match(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)(?:\s+of)?(?:\s+\w+){0,4}\s+experience|(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b|(\d{1,2})\s*年(?:以上|及以上)?(?:工作)?经验/i);
  const v = m ? Number(m[1] ?? m[2] ?? m[3]) : NaN;
  return Number.isFinite(v) && v > 0 && v < 40 ? v : null;
}

export function educationFrom(text: string): string | null {
  for (const [level, re] of EDU_PATTERNS) if (re.test(text)) return level;
  return null;
}

/** Highest degree in the resume's education section (or anywhere when no section). */
export function resumeEducation(r: ParsedResume): string | null {
  const edu = sectionsOf(r, 'education');
  const text = edu.length ? edu.flatMap((s) => [...s.entries, ...s.body, ...s.bullets.map((b) => b.text)]).join(' ') : '';
  return text ? educationFrom(text) : null;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

function parseDatePoint(s: string, now: Date): number | null {
  const t = s.trim().toLowerCase();
  if (/present|current|now|至今|现在|今/.test(t)) return now.getUTCFullYear() + now.getUTCMonth() / 12;
  const ym = t.match(/((?:19|20)\d{2})\s*[./年-]\s*(\d{1,2})/);
  if (ym) return Number(ym[1]) + (Number(ym[2]) - 1) / 12;
  const my = t.match(/(\d{1,2})\s*\/\s*((?:19|20)\d{2})/);
  if (my) return Number(my[2]) + (Number(my[1]) - 1) / 12;
  const mon = t.match(/([a-z]{3,4})[a-z]*\.?\s+((?:19|20)\d{2})/);
  if (mon && MONTHS[mon[1]!] !== undefined) return Number(mon[2]) + MONTHS[mon[1]!]! / 12;
  const y = t.match(/(?:19|20)\d{2}/);
  return y ? Number(y[0]) : null;
}

/**
 * Years of work experience shown by the resume's dated experience entries:
 * the union of their date ranges, in years (one decimal). Null when no entry
 * has a readable range.
 */
export function resumeYears(r: ParsedResume, now: Date): number | null {
  const ranges: Array<[number, number]> = [];
  for (const s of sectionsOf(r, 'experience')) {
    for (const entry of s.entries) {
      const parts = entry.split(/\s[–—-]\s|\s?[–—]\s?|\s+to\s+|至/i);
      if (parts.length < 2) continue;
      const end = parseDatePoint(parts[parts.length - 1]!, now);
      const start = parseDatePoint(parts[parts.length - 2]!, now);
      if (start !== null && end !== null && end >= start) ranges.push([start, end]);
    }
  }
  if (ranges.length === 0) return null;
  ranges.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = ranges[0]!;
  for (const [s, e] of ranges.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else {
      total += ce - cs;
      [cs, ce] = [s, e];
    }
  }
  total += ce - cs;
  return Math.round(total * 10) / 10;
}

function titleRow(job: KeywordJobInput, r: ParsedResume): KeywordReportRow {
  const resumeTitles = [r.name ?? '', ...r.headerLines, ...r.sections.flatMap((s) => s.entries)].join(' \n ');
  const title = stripMarkdown(job.title);
  let met = 0;
  let total = 0;
  if (/[㐀-鿿]/.test(title)) {
    const core = title.replace(/[（(].*?[)）]/g, '').replace(/实习生?|高级|资深|初级|校招|社招/g, '').trim();
    total = 1;
    if (core && resumeTitles.includes(core)) met = 1;
    else {
      const bigrams = Array.from({ length: Math.max(0, core.length - 1) }, (_, i) => core.slice(i, i + 2));
      if (bigrams.some((b) => resumeTitles.includes(b))) met = 0.5;
    }
  } else {
    const tokens = dedupe(title.toLowerCase().split(/[^\p{L}\p{N}+#.]+/u).filter((w) => w.length > 1 && !TITLE_STOP.has(w)));
    total = tokens.length;
    met = tokens.filter((t) => containsTerm(resumeTitles, t)).length;
  }
  const status: KeywordRowStatus = total === 0 ? 'unknown' : met >= total ? 'pass' : met / total >= 0.5 ? 'warn' : 'fail';
  const detail =
    status === 'pass'
      ? 'Your resume shows this job title or a close one.'
      : status === 'warn'
        ? 'Your resume shows a related title, not this one.'
        : status === 'fail'
          ? 'Your resume does not show this title. If you have done this work, name it in a heading or summary.'
          : 'Not listed.';
  return { key: 'title', status, params: { title }, label: 'Job title', detail };
}

function yearsRow(job: KeywordJobInput, r: ParsedResume, now: Date): KeywordReportRow {
  const required = job.minYears ?? requiredYearsFrom(job.text);
  const found = resumeYears(r, now);
  let status: KeywordRowStatus = 'unknown';
  if (required !== null && required !== undefined && found !== null) {
    status = found >= required ? 'pass' : found >= required - 1 ? 'warn' : 'fail';
  }
  const params: Record<string, string | number> = {};
  if (required !== null && required !== undefined) params.required = required;
  if (found !== null) params.found = found;
  const detail =
    required === null || required === undefined
      ? 'The posting does not list a number of years.'
      : found === null
        ? 'No dated experience found in your resume.'
        : `The posting asks for ${required}+ years; your dated experience adds up to about ${found}.`;
  return { key: 'years', status, params, label: 'Years of experience', detail };
}

function educationRow(job: KeywordJobInput, r: ParsedResume): KeywordReportRow {
  const required = job.educationLevel && job.educationLevel !== 'none' ? job.educationLevel : educationFrom(job.text);
  const found = resumeEducation(r);
  let status: KeywordRowStatus = 'unknown';
  if (required && found && EDUCATION_RANK[required] !== undefined && EDUCATION_RANK[found] !== undefined) {
    status = EDUCATION_RANK[found]! >= EDUCATION_RANK[required]! ? 'pass' : 'fail';
  }
  const params: Record<string, string | number> = {};
  if (required) params.required = required;
  if (found) params.found = found;
  const detail = !required
    ? 'The posting does not list an education level.'
    : !found
      ? 'No degree found in your resume.'
      : status === 'pass'
        ? 'Your degree meets the listed level.'
        : 'Your degree is below the listed level.';
  return { key: 'education', status, params, label: 'Education', detail };
}

function ratioRow(key: 'skills' | 'keywords', matched: string[], missing: string[]): KeywordReportRow {
  const total = matched.length + missing.length;
  const status = ratioStatus(matched.length, total);
  const label = key === 'skills' ? 'Hard skills' : 'Keywords';
  const detail = total === 0 ? 'Not listed.' : `${matched.length} of ${total} found in your resume.`;
  return { key, status, params: { met: matched.length, total }, label, detail };
}

export function buildKeywordReport(input: KeywordReportInput): KeywordReportResponse {
  const now = input.now ?? new Date();
  const r = parseResume(input.resumeMarkdown);
  const haystack = r.plain;

  const postingText = input.job.text ?? '';
  const cased = (t: string) => (input.casing === 'posting' ? displayTerm(t, postingText) : t);
  const show = (list: string[]) => dedupe(list.filter(plausibleSkill).map(cased));
  const jobSkills = show([...(input.job.skills ?? [])]).slice(0, 25);
  const extractionRows = (input.extraction?.keywords ?? []).filter((k) => k && typeof k.keyword === 'string');
  // What the job itself says it asks for: its skill list and its required rows.
  const skillSet = new Set((input.job.skills ?? []).map(normTerm));
  const confirmed = new Set([...skillSet, ...extractionRows.filter((k) => k.importance === 'high').map((k) => normTerm(k.keyword))]);
  const vocabulary = termsFromPosting(postingText, confirmed, input.job.title ?? '');
  const named = new Set(vocabulary.map(normTerm));
  const hardSkillList = jobSkills.length > 0 ? jobSkills : show(vocabulary);

  // Extraction rows that are skills: the job's own skill list, a required
  // skill, or a vocabulary term the posting names as one. The TF-IDF rows of
  // the same list are words of the text, not requirements, and are never shown.
  const fromExtraction = extractionRows
    .filter((k) => {
      const t = normTerm(k.keyword);
      if (confirmed.has(t)) return true;
      if (!VOCABULARY_SET.has(t)) return false;
      return named.has(t) || !(EVERYDAY_TERMS.has(t) || WORD_LIKE_TOOL_NAMES.has(t));
    })
    .sort((a, b) => importanceRank(b.importance) - importanceRank(a.importance))
    .map((k) => k.keyword);
  const keywordSource: KeywordReportResponse['keywordSource'] = extractionRows.length > 0 ? 'extraction' : 'posting';
  // The keywords row. A job with its own skill list and stored skill rows is
  // described by those: scanning its text on top of them listed whatever
  // vocabulary word the boilerplate happened to contain ("招聘", "销售",
  // "测试"). The text scan is the source only when the job has no skill list
  // (a pasted posting) or no usable row. It may repeat terms of the skills
  // row (the lists shown to the user are merged without duplicates).
  const keywordList = show(jobSkills.length > 0 && fromExtraction.length > 0 ? fromExtraction : [...fromExtraction, ...vocabulary]).slice(0, MAX_KEYWORDS);

  const split = (list: string[]) => {
    const matched: string[] = [];
    const missing: string[] = [];
    for (const k of list) (showsTerm(haystack, k) ? matched : missing).push(k);
    return { matched, missing };
  };
  const hardSkills = split(hardSkillList);
  const keywords = split(keywordList);
  const skillGaps = dedupe([...hardSkills.missing, ...keywords.missing]).slice(0, MAX_KEYWORDS);

  const rows: KeywordReportRow[] = [
    titleRow(input.job, r),
    yearsRow(input.job, r, now),
    educationRow(input.job, r),
    ratioRow('skills', hardSkills.matched, hardSkills.missing),
    ratioRow('keywords', keywords.matched, keywords.missing),
  ];

  let fit: SourcedNumber | null = null;
  let fitTier: string | null = null;
  if (input.fit && !input.fit.stale && Number.isFinite(input.fit.score)) {
    fit = { value: Math.round(input.fit.score), source: 'ai', asOf: input.fit.generatedAt.toISOString(), method: 'fit_score' };
    fitTier = input.fit.tier;
  }

  return { fit, fitTier, rows, keywords, hardSkills, skillGaps, keywordSource };
}

function importanceRank(i: string | undefined): number {
  return i === 'high' ? 3 : i === 'medium' ? 2 : i === 'low' ? 1 : 0;
}
