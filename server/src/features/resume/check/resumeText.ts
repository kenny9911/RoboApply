// server/src/features/resume/check/resumeText.ts
//
// A small, tolerant reader for the resume markdown the editor writes
// (lib/resumeStructure.ts serializes `# Name`, `*contact · line*`,
// `## Section`, `### Company · Title · 2020 – present`, `- bullet`) and for
// whatever an upload parse produced. Pure; no I/O. Used by the rules (WP-22),
// the keyword report and the AI-pass prompt builder.

import type { ResumeSectionKey } from '../contract.js';

export interface ResumeBullet {
  text: string;
  /** 0-based line index in the markdown. */
  line: number;
  /** Index of the `###` entry inside its section (experience/projects), or null. */
  entry: number | null;
}

export interface ResumeSection {
  heading: string;
  key: ResumeSectionKey;
  /** True for an internship heading (实习 / Internship). */
  internship: boolean;
  /** True for a cn self-evaluation heading (自我评价 / 个人评价 / 自我介绍). */
  selfEvaluation: boolean;
  /** `###` entry headings in order. */
  entries: string[];
  bullets: ResumeBullet[];
  /** Non-bullet, non-heading body lines (trimmed, non-empty). */
  body: string[];
}

export interface ParsedResume {
  markdown: string;
  name: string | null;
  /** Lines before the first `##` heading, without the `#` name line. */
  headerLines: string[];
  sections: ResumeSection[];
  /** Every bullet of every section, in document order. */
  bullets: ResumeBullet[];
  /** The whole text with markdown punctuation removed (for term search). */
  plain: string;
}

const HEADING_RULES: Array<{ key: ResumeSectionKey; re: RegExp }> = [
  { key: 'summary', re: /summary|profile|about|objective|自我评价|个人评价|自我介绍|个人总结|个人简介|个人优势|简介|自我評價|個人簡介|個人摘要|個人總結/i },
  { key: 'experience', re: /experience|employment|work history|career|internship|工作经历|工作经验|实习|实践经历|职业经历|工作經歷|實習/i },
  { key: 'projects', re: /project|项目|專案|項目/i },
  { key: 'education', re: /education|academic|教育|学历|學歷/i },
  { key: 'skills', re: /skill|competenc|technolog|tools|技能|证书|資格|證書|证照|證照|专业能力|专长|專長/i },
  { key: 'contact', re: /contact|基本信息|个人信息|联系方式|個人資料|聯絡/i },
];

/** Classify a `##` heading. */
export function sectionKeyOf(heading: string): ResumeSectionKey {
  for (const rule of HEADING_RULES) if (rule.re.test(heading)) return rule.key;
  return 'other';
}

const BULLET_RE = /^\s*(?:[-*•·]|\d+[.)、])\s+/;

/** Sections whose bold lines are entry heads (a role, a project, a school). */
const ENTRY_SECTIONS: ReadonlySet<ResumeSectionKey> = new Set<ResumeSectionKey>(['experience', 'projects', 'education']);

export function stripMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseResume(markdown: string): ParsedResume {
  const md = (markdown ?? '').replace(/\r\n?/g, '\n');
  const lines = md.split('\n');
  let name: string | null = null;
  const headerLines: string[] = [];
  const sections: ResumeSection[] = [];
  let current: ResumeSection | null = null;
  let entryIndex = -1;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^##\s+(.+)$/.exec(line);
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h1 && !current && name === null) {
      name = stripMarkdown(h1[1]!);
      return;
    }
    if (h2) {
      const heading = stripMarkdown(h2[1]!);
      current = {
        heading,
        key: sectionKeyOf(heading),
        internship: /intern|实习|實習/i.test(heading),
        selfEvaluation: /自我评价|个人评价|自我介绍|个人总结|自我評價/.test(heading),
        entries: [],
        bullets: [],
        body: [],
      };
      sections.push(current);
      entryIndex = -1;
      return;
    }
    if (!current) {
      if (line) headerLines.push(line);
      return;
    }
    const section: ResumeSection = current;
    if (h3) {
      section.entries.push(stripMarkdown(h3[1]!));
      entryIndex = section.entries.length - 1;
      return;
    }
    // An uploaded resume writes its entry heads in bold, not as `###`
    // ("**数据分析实习生 — 星河科技** · 2025.06 - 2025.09"). They are entries
    // too: read as body text, an upload had no roles at all, and the cn check
    // reported "no internship" for a resume with two. A labelled skills line
    // ("**Tools:** Jira") is not an entry.
    if (ENTRY_SECTIONS.has(section.key) && /^\*\*[^*]+\*\*/.test(line) && !/^\*\*[^*]*[:：]\s*\*\*/.test(line) && line.length <= 200) {
      section.entries.push(stripMarkdown(line));
      entryIndex = section.entries.length - 1;
      return;
    }
    if (BULLET_RE.test(raw)) {
      const text = raw.replace(BULLET_RE, '').trim();
      if (text) section.bullets.push({ text, line: i, entry: entryIndex >= 0 ? entryIndex : null });
      return;
    }
    if (line) section.body.push(line);
  });

  return {
    markdown: md,
    name,
    headerLines,
    sections,
    bullets: sections.flatMap((s) => s.bullets),
    plain: stripMarkdown(md),
  };
}

export function sectionsOf(r: ParsedResume, key: ResumeSectionKey): ResumeSection[] {
  return r.sections.filter((s) => s.key === key);
}

/** The summary / self-evaluation text (body lines + bullets), or ''. */
export function summaryText(r: ParsedResume): string {
  const s = r.sections.find((x) => x.key === 'summary');
  if (!s) return '';
  return [...s.body, ...s.bullets.map((b) => b.text)].join(' ').trim();
}

/** The first summary body line verbatim (what a summary fix rewrites), or null. */
export function summaryTarget(r: ParsedResume): string | null {
  const s = r.sections.find((x) => x.key === 'summary');
  if (!s) return null;
  const longest = [...s.body].sort((a, b) => b.length - a.length)[0];
  return longest ?? s.bullets[0]?.text ?? null;
}

const CJK_RE = /[㐀-鿿豈-﫿]/g;

/** Rough length unit: words for Latin text, characters for CJK. */
export function textUnits(s: string): number {
  const cjk = (s.match(CJK_RE) ?? []).length;
  const latin = s.replace(CJK_RE, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return latin + cjk;
}

export function isCjkText(s: string): boolean {
  const cjk = (s.match(CJK_RE) ?? []).length;
  return cjk > 0 && cjk >= textUnits(s) * 0.3;
}

/** Case-insensitive term search. Latin terms match on word boundaries; CJK terms as substrings. */
export function containsTerm(haystack: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  if (/[㐀-鿿]/.test(t)) return haystack.includes(t);
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(haystack);
}

// ── LLM hygiene (TASK_PLAN.md §2.2 / CN plan PII rules) ───────────────────

/**
 * Lines that must never reach a prompt: photo, 籍贯, 政治面貌, gender, birth
 * date, family members, marital status, ethnicity, ID numbers.
 */
const SENSITIVE_LINE_RE =
  /籍贯|籍貫|政治面貌|性别|性別|出生|生日|年龄|年齡|民族|婚姻|婚育|家庭成员|家庭成員|身份证|身分證|照片|\bgender\b|\bsex\b|date of birth|\bdob\b|\bbirth ?date\b|\bage\s*[:：]|marital|nationality|ethnicity|religion|family members/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
/** A label line that names the person or where they live (姓名：张三, 现居：上海…, Address: …). */
const PERSONAL_LABEL_RE =
  /(?:^|[\s|·•,，;；*_])(?:姓名|名字|地址|现居(?:地|住地)?|現居(?:地)?|住址|居住地|家庭住址|通讯地址|通訊地址|户口(?:所在地)?|戶口|(?:home\s+)?address|full\s+name)\s*[:：|]/i;
/** One date (2021, 2021.09, 2021-09-01, 2021年9月) — never a phone number. */
const DATE_PART = String.raw`(?:19|20)\d{2}(?:\s*[./年-]\s*(?:0?[1-9]|1[0-2])(?:\s*[./月-]\s*\d{1,2})?\s*[月日]?)?`;
const DATE_RUN_RE = new RegExp(String.raw`^\s*${DATE_PART}(?:\s*[-–—~至到]\s*${DATE_PART})*\s*$`);

/** True when a phone-shaped digit run is really a date or a date range. */
export function looksLikeDateRun(run: string): boolean {
  return DATE_RUN_RE.test(run) || /^\s*\d{4}\s*[-–—]\s*\d{4}\s*$/.test(run);
}

function maskContacts(line: string): string {
  return line
    .replace(EMAIL_RE, '[email]')
    .replace(PHONE_RE, (m) => (looksLikeDateRun(m) || m.replace(/\D/g, '').length < 8 ? m : '[phone]'));
}

/**
 * Resume text for a prompt: drops the name and contact header, any contact /
 * 个人信息 / 基本信息 section, every name / address label line, every
 * sensitive line and image, and masks stray emails and phone numbers. Dates
 * and date ranges (2021.09-2022.06) are kept as written.
 */
export function resumeForLlm(markdown: string): string {
  const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const firstSection = lines.findIndex((l) => /^##\s+/.test(l.trim()));
  // With headings: drop the name + contact block above the first section.
  // Without (a plain-text upload): drop the first non-empty line (the name).
  const firstText = lines.findIndex((l) => l.trim().length > 0);
  const start = firstSection >= 0 ? firstSection : firstText + 1;
  const out: string[] = [];
  let inContactSection = false;
  for (const raw of lines.slice(Math.max(0, start))) {
    const line = raw.trimEnd();
    const h2 = /^##\s+(.+)$/.exec(line.trim());
    if (h2 && !/^###/.test(line.trim())) {
      inContactSection = sectionKeyOf(stripMarkdown(h2[1]!)) === 'contact';
      if (inContactSection) continue;
    }
    if (inContactSection) continue;
    if (SENSITIVE_LINE_RE.test(line)) continue;
    if (PERSONAL_LABEL_RE.test(line)) continue;
    if (/!\[[^\]]*\]\([^)]*\)/.test(line)) continue;
    out.push(maskContacts(line));
  }
  return out.join('\n').trim();
}

/** True when a single line carries a sensitive personal detail. */
export function isSensitiveLine(line: string): boolean {
  return SENSITIVE_LINE_RE.test(line) || PERSONAL_LABEL_RE.test(line) || /!\[[^\]]*\]\([^)]*\)/.test(line);
}
